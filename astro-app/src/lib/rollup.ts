// Pre-aggregated probe history: what the APIs read instead of the raw JSONL.
//
// Until 2026-10-24 every page load parsed the last 8-16 MB of probes.jsonl twice
// (summary + timeseries). At ~25 targets x 4 layers a minute that is only ~18 h of
// data, so the 7 d view showed one day and a blank week, and each load cost seconds.
// The usual monitoring answer: keep running totals in fixed time bins, update them
// as probes land, answer every query from the bins.
//
//   fine   — 60 s bins for the last 48 h   (2,880 slots per series)
//   coarse — 300 s bins for the last 30 d  (8,640 slots per series)
//
// Memory is fixed by the slot counts (~140 KB per series, ~10 MB for the board),
// however long the monitor runs. The raw file is read once, streamed, at first
// start; a binary snapshot every 5 min means a restart replays only the tail.
import { createReadStream, existsSync } from "node:fs";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

export const isBad = (p: any): boolean => {
  if (p.layer === "dns") return p.result !== "resolved";
  if (p.layer === "https") return !p.ok || p.http_code === 0 || p.http_code >= 500;
  if (p.layer === "tcp" || p.layer === "ns") return !p.ok;
  // a ping minute is bad at 3 of 5 lost; one lost first packet is a route lookup
  if (p.layer === "ping") return !p.ok || Number(p.loss_pct ?? 0) >= 60;
  return false;
};

export const probeMs = (p: any): number => {
  if (p.layer === "dns") return Number(p.took_ms ?? 0);
  if (p.layer === "ping") return Math.round(Number(p.rtt_ms ?? 0));
  return Math.round(Number(p.total_s ?? 0) * 1000);
};

interface Ring { res: number; slots: number; epoch: Int32Array; n: Uint16Array; bad: Uint16Array; sum: Float32Array }
interface Series { fine: Ring; coarse: Ring; lastTs: number; lastBad: boolean }

const FINE = { res: 60_000, slots: 2880 };
const COARSE = { res: 300_000, slots: 8640 };
const ring = (r: { res: number; slots: number }): Ring => ({
  ...r, epoch: new Int32Array(r.slots).fill(-1), n: new Uint16Array(r.slots), bad: new Uint16Array(r.slots), sum: new Float32Array(r.slots),
});

const series = new Map<string, Series>();
let ingestedBytes = 0;

const add = (r: Ring, ts: number, ms: number, bad: boolean) => {
  const bin = Math.floor(ts / r.res), i = bin % r.slots;
  if (r.epoch[i] !== bin) { r.epoch[i] = bin; r.n[i] = 0; r.bad[i] = 0; r.sum[i] = 0; }
  r.n[i]++; r.sum[i] += ms; if (bad) r.bad[i]++;
};

export const ingest = (p: any): void => {
  const ts = Date.parse(p?.ts);
  if (!Number.isFinite(ts) || !p.domain || !p.layer) return;
  if (ts < Date.now() - 30 * 86400_000) return;
  const key = `${p.domain}::${p.layer}`;
  let s = series.get(key);
  if (!s) { s = { fine: ring(FINE), coarse: ring(COARSE), lastTs: 0, lastBad: false }; series.set(key, s); }
  const bad = isBad(p), ms = probeMs(p);
  add(s.fine, ts, ms, bad);
  add(s.coarse, ts, ms, bad);
  if (ts >= s.lastTs) { s.lastTs = ts; s.lastBad = bad; }
};

/** Count a line just appended to the raw file (the snapshot replays from this offset). */
export const noteAppended = (bytes: number): void => { ingestedBytes += bytes; };
export const setIngested = (bytes: number): void => { ingestedBytes = bytes; };

export interface Bin { start: number; n: number; bad: number; sum: number }

/** The bins of one series in [since, end), at the finest resolution that holds them. */
const binsOf = (s: Series, since: number, end: number, maxRes: number): { res: number; bins: Bin[] } => {
  const fineOk = since >= Date.now() - 48 * 3600_000 && maxRes < COARSE.res;
  const r = fineOk ? s.fine : s.coarse;
  const out: Bin[] = [];
  for (let b = Math.floor(since / r.res); b * r.res < end; b++) {
    const i = ((b % r.slots) + r.slots) % r.slots;
    out.push(r.epoch[i] === b ? { start: b * r.res, n: r.n[i], bad: r.bad[i], sum: r.sum[i] } : { start: b * r.res, n: 0, bad: 0, sum: 0 });
  }
  return { res: r.res, bins: out };
};

export const keys = (): string[] => [...series.keys()];

/** Evenly spaced buckets per series, for the sparklines. */
export const timeseries = (since: number, end: number, buckets: number, keep: (key: string) => boolean) => {
  const bucketMs = (end - since) / buckets;
  const out: Record<string, { ts_ms: number; avg_ms: number; n: number; bad_n: number }[]> = {};
  for (const [key, s] of series) {
    if (!keep(key)) continue;
    const acc = Array.from({ length: buckets }, () => ({ n: 0, bad: 0, sum: 0 }));
    const { res, bins } = binsOf(s, since, end, bucketMs);
    let any = false;
    for (const b of bins) {
      if (!b.n) continue;
      const mid = b.start + res / 2;
      if (mid < since || mid >= end) continue;
      const a = acc[Math.min(buckets - 1, Math.floor((mid - since) / bucketMs))];
      a.n += b.n; a.bad += b.bad; a.sum += b.sum; any = true;
    }
    if (!any) continue;
    out[key] = acc.map((a, i) => ({ ts_ms: Math.round(since + (i + 0.5) * bucketMs), avg_ms: a.n ? Math.round(a.sum / a.n) : 0, n: a.n, bad_n: a.bad }));
  }
  return out;
};

/** Per series over [since, end): counts, latency, last bad, worst run of bad bins, current state. */
export const summary = (since: number, end: number, live: boolean, keep: (key: string) => boolean) => {
  const out: { key: string; total: number; ok: number; bad: number; current: string; last_bad_ts: string | null; worst_streak_s: number; avg_ms: number }[] = [];
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 19) + "Z";
  for (const [key, s] of series) {
    if (!keep(key)) continue;
    const { res, bins } = binsOf(s, since, end, 0);
    let total = 0, bad = 0, sum = 0, lastBad = -1, run = 0, worst = 0, cur = "unknown";
    for (const b of bins) {
      if (!b.n) { continue; }
      total += b.n; bad += b.bad; sum += b.sum;
      if (b.bad) lastBad = Math.min(end, b.start + res);
      // a bin counts toward an outage when most of its probes failed
      const down = b.bad * 2 > b.n;
      run = down ? run + res : 0;
      if (run > worst) worst = run;
      cur = down ? "bad" : "ok";
    }
    if (!total) continue;
    if (live && s.lastTs) cur = s.lastBad ? "bad" : "ok";
    out.push({ key, total, ok: total - bad, bad, current: cur, last_bad_ts: lastBad > 0 ? iso(lastBad) : null, worst_streak_s: worst / 1000, avg_ms: Math.round(sum / total) });
  }
  return out;
};

// ── snapshot: the rings as raw bytes, plus the raw-file offset they cover ──
const snapPath = (raw: string) => raw.replace(/\.jsonl$/, "") + ".rollup-v1.bin";

const saveSnapshot = async (raw: string): Promise<void> => {
  const head = Buffer.from(JSON.stringify({ v: 1, offset: ingestedBytes, keys: [...series.keys()], last: [...series.values()].map((s) => [s.lastTs, s.lastBad]) }));
  const parts: Buffer[] = [Buffer.alloc(4), head];
  parts[0].writeUInt32LE(head.length);
  for (const s of series.values()) for (const r of [s.fine, s.coarse]) for (const a of [r.epoch, r.n, r.bad, r.sum]) parts.push(Buffer.from(a.buffer, a.byteOffset, a.byteLength));
  const tmp = snapPath(raw) + ".tmp";
  await writeFile(tmp, Buffer.concat(parts));
  await rename(tmp, snapPath(raw));
};

const loadSnapshot = async (raw: string): Promise<number | null> => {
  if (!existsSync(snapPath(raw))) return null;
  const buf = await readFile(snapPath(raw));
  const len = buf.readUInt32LE(0);
  const head = JSON.parse(buf.subarray(4, 4 + len).toString());
  if (head.v !== 1) return null;
  let off = 4 + len;
  const take = <T extends Int32Array | Uint16Array | Float32Array>(Ctor: { new (n: number): T; BYTES_PER_ELEMENT: number }, n: number): T => {
    const a = new Ctor(n);
    Buffer.from(a.buffer).set(buf.subarray(off, off + n * Ctor.BYTES_PER_ELEMENT));
    off += n * Ctor.BYTES_PER_ELEMENT;
    return a;
  };
  head.keys.forEach((key: string, k: number) => {
    const mk = (r: { res: number; slots: number }): Ring => ({ ...r, epoch: take(Int32Array, r.slots), n: take(Uint16Array, r.slots), bad: take(Uint16Array, r.slots), sum: take(Float32Array, r.slots) });
    const fine = mk(FINE), coarse = mk(COARSE);
    series.set(key, { fine, coarse, lastTs: head.last[k][0], lastBad: head.last[k][1] });
  });
  return head.offset;
};

/** Stream raw lines from `from` up to `to` into the rings, a line at a time. */
const replay = async (raw: string, from: number, to: number): Promise<void> => {
  if (to <= from) return;
  const rl = createInterface({ input: createReadStream(raw, { start: from, end: to - 1 }), crlfDelay: Infinity });
  let n = 0;
  for await (const line of rl) {
    if (line) { try { ingest(JSON.parse(line)); } catch { /* a torn or malformed line */ } }
    // let the probe loop and requests in between chunks of a long first read
    if (++n % 20_000 === 0) await new Promise((r) => setImmediate(r));
  }
};

let ready: Promise<void> | null = null;

/** Load the snapshot (or stream the raw file once), then keep a snapshot every 5 min. */
export const startRollup = (raw: string): Promise<void> => {
  ready ??= (async () => {
    const t0 = Date.now();
    const size = existsSync(raw) ? (await stat(raw)).size : 0;
    // probes appended from here on are counted live, beyond `size`
    const appendedBefore = ingestedBytes;
    let from = 0;
    try {
      const off = await loadSnapshot(raw);
      if (off !== null && off <= size) from = off; else series.clear();
    } catch (e) { console.error("[ygg-monitor] rollup snapshot unreadable, rebuilding:", e); series.clear(); }
    await replay(raw, from, size);
    ingestedBytes = size + (ingestedBytes - appendedBefore);
    console.log(`[ygg-monitor] rollup ready: ${series.size} series, replayed ${((size - from) / 1e6).toFixed(1)} MB in ${Date.now() - t0} ms`);
    setInterval(() => { void saveSnapshot(raw).catch((e) => console.error("[ygg-monitor] snapshot failed:", e)); }, 5 * 60_000).unref();
    await saveSnapshot(raw).catch((e) => console.error("[ygg-monitor] snapshot failed:", e));
  })();
  return ready;
};

/** The first query waits for the rings; later ones return at once. */
export const whenReady = (): Promise<void> => ready ?? Promise.resolve();
