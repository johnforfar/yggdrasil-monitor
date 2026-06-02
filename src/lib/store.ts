import { appendFile, open, stat } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

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

export const appendLine = async (obj: unknown): Promise<void> => {
  ensure();
  try {
    await appendFile(path, JSON.stringify(obj) + "\n", "utf-8");
  } catch (e) {
    // Don't crash the server on a write failure; just log and move on.
    console.error("[ygg-monitor] append failed:", e);
  }
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
