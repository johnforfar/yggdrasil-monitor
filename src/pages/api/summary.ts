import type { APIRoute } from "astro";
import { existsSync } from "node:fs";
import { stat, open } from "node:fs/promises";

export const prerender = false;

const JSONL_PATH = process.env.YGG_MONITOR_JSONL ?? "/var/lib/yggdrasil-monitor/probes.jsonl";

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

interface Bucket {
  domain: string;
  layer: string;
  total: number;
  ok: number;
  bad: number;
  // last-known status: "ok" | "bad" | "unknown"
  current: string;
  // ts of the last bad probe (for MTBF-ish info)
  last_bad_ts: string | null;
  // longest contiguous bad streak in seconds
  worst_streak_s: number;
  // avg took_ms / total_s
  avg_ms: number;
}

const isBad = (p: any): boolean => {
  if (p.layer === "dns") {
    return p.result !== "resolved";
  }
  if (p.layer === "https") {
    return p.http_code === 0 || (p.http_code >= 500) || p.ssl_verify !== 0;
  }
  return false;
};

const probeMs = (p: any): number => {
  if (p.layer === "dns") return Number(p.took_ms ?? 0);
  if (p.layer === "https") return Math.round(Number(p.total_s ?? 0) * 1000);
  return 0;
};

export const GET: APIRoute = async () => {
  if (!existsSync(JSONL_PATH)) {
    return json({ buckets: [], note: "no probes file yet" });
  }

  // Walk the last 24h from the file tail.
  const sinceIso = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 19) + "Z";
  const buckets = new Map<string, Bucket & { _msSum: number; _streakStart: string | null }>();

  const fh = await open(JSONL_PATH, "r");
  try {
    const st = await stat(JSONL_PATH);
    const max = 8 * 1024 * 1024;
    const start = st.size > max ? st.size - max : 0;
    const buf = Buffer.alloc(st.size - start);
    await fh.read(buf, 0, buf.length, start);
    const text = buf.toString("utf-8");
    const startIdx = start === 0 ? 0 : text.indexOf("\n") + 1;
    const lines = text.slice(startIdx).split("\n");

    for (const line of lines) {
      if (!line.trim()) continue;
      let p: any;
      try { p = JSON.parse(line); } catch { continue; }
      if (p.ts < sinceIso) continue;
      const key = `${p.domain}::${p.layer}`;
      let b = buckets.get(key);
      if (!b) {
        b = {
          domain: p.domain, layer: p.layer,
          total: 0, ok: 0, bad: 0, current: "unknown",
          last_bad_ts: null, worst_streak_s: 0, avg_ms: 0,
          _msSum: 0, _streakStart: null,
        };
        buckets.set(key, b);
      }
      b.total++;
      b._msSum += probeMs(p);
      const bad = isBad(p);
      if (bad) {
        b.bad++;
        b.last_bad_ts = p.ts;
        if (!b._streakStart) b._streakStart = p.ts;
        b.current = "bad";
      } else {
        b.ok++;
        if (b._streakStart) {
          const dur = (Date.parse(p.ts) - Date.parse(b._streakStart)) / 1000;
          if (dur > b.worst_streak_s) b.worst_streak_s = dur;
          b._streakStart = null;
        }
        b.current = "ok";
      }
    }
  } finally {
    await fh.close();
  }

  const out: Bucket[] = [];
  for (const b of buckets.values()) {
    // Close out an open bad streak with "now" as the end.
    if (b._streakStart) {
      const dur = (Date.now() - Date.parse(b._streakStart)) / 1000;
      if (dur > b.worst_streak_s) b.worst_streak_s = dur;
    }
    b.avg_ms = b.total > 0 ? Math.round(b._msSum / b.total) : 0;
    const { _msSum, _streakStart, ...clean } = b;
    out.push(clean);
  }
  // Sort: bad first, then by domain
  out.sort((a, b) => (a.current === "bad" ? -1 : 1) - (b.current === "bad" ? -1 : 1) || a.domain.localeCompare(b.domain));
  return json({ buckets: out, since: sinceIso });
};
