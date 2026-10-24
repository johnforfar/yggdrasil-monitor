import { appendFile, open, readFile, rename, rm, stat } from "node:fs/promises";
import { createReadStream, createWriteStream, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { ingest, noteAppended, setIngested, startRollup } from "./rollup.ts";

const DEFAULT_PATH = process.env.YGG_MONITOR_JSONL ?? "/var/lib/yggdrasil-monitor/probes.jsonl";

let path = DEFAULT_PATH;
let ensured = false;

const ensure = () => {
  if (ensured) return;
  const dir = dirname(path);
  if (!existsSync(dir)) {
    try { mkdirSync(dir, { recursive: true }); } catch { /* readonly fs in dev = ok */ }
  }
  ensured = true;
};

export const setPath = (p: string) => { path = p; ensured = false; };
export const getPath = () => path;

// Appends wait behind a prune, so no probe lands in the file being replaced.
let gate: Promise<void> = Promise.resolve();

export const appendLine = async (obj: unknown): Promise<void> => {
  ensure();
  const line = JSON.stringify(obj) + "\n";
  await gate;
  try {
    await appendFile(path, line, "utf-8");
    ingest(obj);
    noteAppended(Buffer.byteLength(line));
  } catch (e) {
    // Don't crash the server on a write failure; just log and move on.
    console.error("[ygg-monitor] append failed:", e);
  }
};

const RETAIN_DAYS = Number(process.env.YGG_MONITOR_RETAIN_DAYS ?? "30");

/**
 * Drop raw probes older than the retention window, streaming (never the whole file
 * in memory). Daily. The file had grown without bound since August.
 */
export const prune = async (): Promise<void> => {
  if (!existsSync(path)) return;
  let release!: () => void;
  const prev = gate;
  gate = new Promise((r) => { release = r; });
  await prev;
  try {
    const cutoff = new Date(Date.now() - RETAIN_DAYS * 86400_000).toISOString().slice(0, 19) + "Z";
    const tmp = path + ".prune";
    const out = createWriteStream(tmp);
    const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
    let kept = 0, dropped = 0;
    for await (const line of rl) {
      // ts is the first field written, so a prefix read avoids parsing every line
      const ts = /"ts":"([^"]+)"/.exec(line.slice(0, 40))?.[1];
      // a line without a leading ts is kept: dropping what we cannot date loses data
      if (!line || (ts !== undefined && ts < cutoff)) { dropped++; continue; }
      if (!out.write(line + "\n")) await new Promise((r) => out.once("drain", r));
      kept++;
    }
    await new Promise<void>((r, j) => out.end((e?: Error) => (e ? j(e) : r())));
    if (dropped) {
      await rename(tmp, path);
      setIngested((await stat(path)).size);
      console.log(`[ygg-monitor] pruned ${dropped} probes older than ${RETAIN_DAYS} d; kept ${kept}`);
    } else {
      await rm(tmp, { force: true });
    }
  } catch (e) {
    console.error("[ygg-monitor] prune failed:", e);
  } finally {
    release();
  }
};

let started = false;
/** Build the rollups from the raw file once, then prune daily. */
export const startStore = (): void => {
  if (started) return;
  started = true;
  ensure();
  void startRollup(path).then(() => prune()).catch((e) => console.error("[ygg-monitor] rollup start failed:", e));
  setInterval(() => { void prune(); }, 86400_000).unref();
};

// Read the tail of the JSONL file (last maxBytes). Returns parsed objects
// filtered by an optional predicate. Used by /api/probes + /api/summary.
export const tail = async (
  maxBytes: number,
  predicate?: (obj: any) => boolean,
): Promise<unknown[]> => {
  ensure();
  if (!existsSync(path)) return [];
  const fh = await open(path, "r");
  try {
    const st = await stat(path);
    const start = st.size > maxBytes ? st.size - maxBytes : 0;
    const buf = Buffer.alloc(st.size - start);
    await fh.read(buf, 0, buf.length, start);
    const text = buf.toString("utf-8");
    const startIdx = start === 0 ? 0 : text.indexOf("\n") + 1;
    const lines = text.slice(startIdx).split("\n");
    const out: unknown[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (!predicate || predicate(obj)) out.push(obj);
      } catch { /* skip malformed */ }
    }
    return out;
  } finally {
    await fh.close();
  }
};

// Read ALL rows whose `ts` falls in [sinceMs, endMs], optionally filtered. Used
// for "go back in time" history windows the byte-tail can't reach (an old window
// lives earlier in the file than the last maxBytes). A full scan — heavier than
// tail(), so callers use it only for explicit past windows, never the live view.
// At 60s probes × ~20 series ≈ 3.5 MB/day, a 30 d file is ~100 MB: a ~1 s scan.
export const readRange = async (
  sinceMs: number,
  endMs: number,
  predicate?: (obj: any) => boolean,
): Promise<any[]> => {
  ensure();
  if (!existsSync(path)) return [];
  const text = await readFile(path, "utf-8");
  const out: any[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      const ts = Date.parse(obj.ts);
      if (Number.isFinite(ts) && ts >= sinceMs && ts <= endMs && (!predicate || predicate(obj))) {
        out.push(obj);
      }
    } catch { /* skip malformed */ }
  }
  return out;
};
