import type { APIRoute } from "astro";
import { ACTIVE_DOMAINS, categoryFor } from "../../lib/probe.ts";
import { summary, whenReady } from "../../lib/rollup.ts";

export const prerender = false;

const json = (body: unknown, maxAge: number) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": `public, max-age=${maxAge}` },
  });

// Per (domain, layer) over a window, from the rollups (lib/rollup.ts): counts, average
// latency, last bad, longest outage. `hours` = span (1..720), `end` = epoch ms to look
// back in time (omit for live). Streaks are measured in whole bins (1 min, or 5 min
// past 48 h), so they read to the minute rather than the second.
export const GET: APIRoute = async ({ url }) => {
  await whenReady();
  const hours = Math.max(1, Math.min(720, Number(url?.searchParams?.get("hours")) || 24));
  const endRaw = url?.searchParams?.get("end");
  const live = !endRaw;
  const nowMs = endRaw ? Math.min(Date.now(), Number(endRaw) || Date.now()) : Date.now();
  const sinceMs = nowMs - hours * 3600 * 1000;
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 19) + "Z";
  const rows = summary(sinceMs, nowMs, live, (key) => ACTIVE_DOMAINS.has(key.split("::")[0]));
  const buckets = rows.map(({ key, ...r }) => {
    const [domain, layer] = key.split("::");
    return { domain, layer, category: categoryFor(domain), ...r };
  });
  buckets.sort((a, b) => (a.current === "bad" ? -1 : 1) - (b.current === "bad" ? -1 : 1) || a.domain.localeCompare(b.domain));
  return json({ buckets, since: iso(sinceMs), end: iso(nowMs), hours }, live ? 20 : 300);
};
