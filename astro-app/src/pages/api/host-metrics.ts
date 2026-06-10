import type { APIRoute } from "astro";
import { appendFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { tail } from "../../lib/store.ts";

// Host-metrics ingestion + read endpoint.
//
// Operators run a small push agent on their node (cron / systemd timer) that
// POSTs runtime metrics (load_avg, mem, swap, bench-worker state) every ~60 s.
// We persist as JSONL alongside probes so the dashboard can correlate host
// load with probe latency (e.g. "load 64 → ssh drops → HTTPS bad").
//
// Auth: shared secret in METRICS_INGEST_SECRET env. POSTs without a valid
// Authorization: Bearer <secret> header are rejected. Per-node secrets can
// be added later if more nodes report.

const METRICS_PATH = process.env.YGG_MONITOR_METRICS_JSONL ?? "/var/lib/yggdrasil-monitor/host-metrics.jsonl";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const ensureDir = () => {
  const dir = dirname(METRICS_PATH);
  if (!existsSync(dir)) {
    try { mkdirSync(dir, { recursive: true }); } catch { /* readonly fs in dev = ok */ }
  }
};

const append = async (obj: unknown): Promise<void> => {
  ensureDir();
  try {
    await appendFile(METRICS_PATH, JSON.stringify(obj) + "\n", "utf-8");
  } catch (e) {
    console.error("[ygg-monitor host-metrics] append failed:", e);
  }
};

// We reuse the existing store helpers' `tail()` for read but with a custom path.
// Easier path: re-implement tail-like read scoped to METRICS_PATH.
import { open, stat } from "node:fs/promises";
const tailMetrics = async (maxBytes: number, predicate?: (o: any) => boolean): Promise<any[]> => {
  if (!existsSync(METRICS_PATH)) return [];
  const fh = await open(METRICS_PATH, "r");
  try {
    const st = await stat(METRICS_PATH);
    const start = st.size > maxBytes ? st.size - maxBytes : 0;
    const buf = Buffer.alloc(st.size - start);
    await fh.read(buf, 0, buf.length, start);
    const text = buf.toString("utf-8");
    const startIdx = start === 0 ? 0 : text.indexOf("\n") + 1;
    const lines = text.slice(startIdx).split("\n");
    const out: any[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (!predicate || predicate(o)) out.push(o);
      } catch { /* skip malformed */ }
    }
    return out;
  } finally {
    await fh.close();
  }
};

export const prerender = false;

// POST /api/host-metrics — ingest a sample.
// Body: { ts: ISO8601, node: string, load_1m: number, load_5m?: number,
//         load_15m?: number, mem_avail_kb: number, mem_total_kb: number,
//         swap_used_kb?: number, bench_worker?: { state, runs_session, ... } }
export const POST: APIRoute = async ({ request }) => {
  const expected = process.env.METRICS_INGEST_SECRET;
  if (!expected) {
    return json({ error: "ingestion disabled (no METRICS_INGEST_SECRET)" }, 503);
  }
  const auth = request.headers.get("authorization") ?? "";
  const presented = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (presented !== expected) {
    return json({ error: "unauthorized" }, 401);
  }
  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  if (typeof body?.node !== "string" || typeof body?.load_1m !== "number") {
    return json({ error: "missing node or load_1m" }, 400);
  }
  // Server-side timestamp wins over client-claimed one — single clock.
  const record = {
    ts: new Date().toISOString().slice(0, 19) + "Z",
    client_ts: typeof body.ts === "string" ? body.ts : null,
    node: body.node,
    load_1m: body.load_1m,
    load_5m: typeof body.load_5m === "number" ? body.load_5m : null,
    load_15m: typeof body.load_15m === "number" ? body.load_15m : null,
    mem_avail_kb: typeof body.mem_avail_kb === "number" ? body.mem_avail_kb : null,
    mem_total_kb: typeof body.mem_total_kb === "number" ? body.mem_total_kb : null,
    swap_used_kb: typeof body.swap_used_kb === "number" ? body.swap_used_kb : null,
    bench_worker: body.bench_worker ?? null,
  };
  await append(record);
  return json({ ok: true, ts: record.ts });
};

// GET /api/host-metrics?node=own1&since=1h — read recent samples.
// Defaults: node=own1 (only node so far), since=24h.
export const GET: APIRoute = async ({ url }) => {
  const node = url.searchParams.get("node") ?? "own1";
  const sinceArg = url.searchParams.get("since") ?? "24h";
  const m = sinceArg.match(/^(\d+)([mhd])$/);
  let sinceMs = 24 * 3600 * 1000;
  if (m) {
    const n = parseInt(m[1], 10);
    const unit = m[2];
    sinceMs = unit === "m" ? n * 60 * 1000 : unit === "h" ? n * 3600 * 1000 : n * 86400 * 1000;
  }
  const sinceIso = new Date(Date.now() - sinceMs).toISOString().slice(0, 19) + "Z";
  const samples = await tailMetrics(8 * 1024 * 1024, (s: any) => s.ts >= sinceIso && s.node === node);
  return json({ samples, count: samples.length, node, since: sinceIso });
};
