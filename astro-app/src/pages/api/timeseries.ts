import type { APIRoute } from "astro";
import { tail } from "../../lib/store.ts";
import { ACTIVE_DOMAINS } from "../../lib/probe.ts";

export const prerender = false;

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const isBad = (p: any): boolean => {
  if (p.layer === "dns") return p.result !== "resolved";
  if (p.layer === "https") return !p.ok || p.http_code === 0 || (p.http_code >= 500);
  if (p.layer === "tcp") return !p.ok;
  return false;
};

const probeMs = (p: any): number => {
  if (p.layer === "dns") return Number(p.took_ms ?? 0);
  if (p.layer === "https") return Math.round(Number(p.total_s ?? 0) * 1000);
  if (p.layer === "tcp") return Math.round(Number(p.total_s ?? 0) * 1000);
  return 0;
};

// Bucket recent probes into N evenly-spaced windows. For each bucket
// per (domain, layer) we emit: ts_iso (bucket center), avg_ms, n, bad_n.
// Used by index.astro to render sparkline graphs with red outage backgrounds.
export const GET: APIRoute = async ({ url }) => {
  const hoursRaw = url.searchParams.get("hours");
  const hours = Math.max(1, Math.min(168, Number(hoursRaw) || 24));
  const bucketsCount = Math.max(20, Math.min(288, Number(url.searchParams.get("buckets")) || 144));

  const now = Date.now();
  const since = now - hours * 3600 * 1000;
  const sinceIso = new Date(since).toISOString().slice(0, 19) + "Z";
  const bucketMs = (hours * 3600 * 1000) / bucketsCount;

  const probes = await tail(16 * 1024 * 1024, (p: any) => p.ts >= sinceIso && ACTIVE_DOMAINS.has(p.domain));

  // Map<key, Array<{sum_ms,n,bad_n}>>
  type Bin = { sum_ms: number; n: number; bad_n: number };
  const series = new Map<string, Bin[]>();
  for (const p of probes as any[]) {
    const ts = Date.parse(p.ts);
    if (!Number.isFinite(ts) || ts < since) continue;
    const idx = Math.min(bucketsCount - 1, Math.floor((ts - since) / bucketMs));
    const key = `${p.domain}::${p.layer}`;
    let arr = series.get(key);
    if (!arr) {
      arr = Array.from({ length: bucketsCount }, () => ({ sum_ms: 0, n: 0, bad_n: 0 }));
      series.set(key, arr);
    }
    const bin = arr[idx];
    bin.n++;
    bin.sum_ms += probeMs(p);
    if (isBad(p)) bin.bad_n++;
  }

  const out: Record<string, { ts_ms: number; avg_ms: number; n: number; bad_n: number }[]> = {};
  for (const [key, arr] of series) {
    out[key] = arr.map((bin, i) => ({
      ts_ms: Math.round(since + (i + 0.5) * bucketMs),
      avg_ms: bin.n > 0 ? Math.round(bin.sum_ms / bin.n) : 0,
      n: bin.n,
      bad_n: bin.bad_n,
    }));
  }

  return json({
    since: sinceIso,
    hours,
    buckets: bucketsCount,
    bucket_seconds: Math.round(bucketMs / 1000),
    series: out,
  });
};
