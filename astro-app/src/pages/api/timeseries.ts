import type { APIRoute } from "astro";
import { ACTIVE_DOMAINS } from "../../lib/probe.ts";
import { timeseries, whenReady } from "../../lib/rollup.ts";

export const prerender = false;

const json = (body: unknown, maxAge: number) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": `public, max-age=${maxAge}` },
  });

// N evenly spaced buckets per (domain, layer): avg_ms, n, bad_n — the sparklines and
// their red outage bands. Read from the rollups, so a 30 d window costs the same as 1 h.
export const GET: APIRoute = async ({ url }) => {
  await whenReady();
  const hours = Math.max(1, Math.min(720, Number(url.searchParams.get("hours")) || 24));
  const bucketsCount = Math.max(20, Math.min(288, Number(url.searchParams.get("buckets")) || 144));
  const endRaw = url.searchParams.get("end");
  const now = endRaw ? Math.min(Date.now(), Number(endRaw) || Date.now()) : Date.now();
  const since = now - hours * 3600 * 1000;
  const series = timeseries(since, now, bucketsCount, (key) => ACTIVE_DOMAINS.has(key.split("::")[0]));
  return json({
    since: new Date(since).toISOString().slice(0, 19) + "Z",
    hours,
    buckets: bucketsCount,
    bucket_seconds: Math.round((hours * 3600) / bucketsCount),
    series,
  }, endRaw ? 300 : 20);
};
