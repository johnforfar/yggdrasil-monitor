import type { APIRoute } from "astro";
import { tail } from "../../lib/store.ts";

export const prerender = false;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const parseSince = (raw: string | null): Date => {
  const def = new Date(Date.now() - 24 * 3600 * 1000);
  if (!raw) return def;
  const m = raw.match(/^(\d+)\s*([smhd])$/i);
  if (!m) return def;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const ms = unit === "s" ? n * 1000
    : unit === "m" ? n * 60 * 1000
    : unit === "h" ? n * 3600 * 1000
    : n * 86400 * 1000;
  return new Date(Date.now() - ms);
};

export const GET: APIRoute = async ({ url }) => {
  const since = parseSince(url.searchParams.get("since"));
  const sinceIso = since.toISOString().slice(0, 19) + "Z";
  const domain = url.searchParams.get("domain");
  const layer = url.searchParams.get("layer");

  const probes = await tail(4 * 1024 * 1024, (p: any) => {
    if (p.ts < sinceIso) return false;
    if (domain && p.domain !== domain) return false;
    if (layer && p.layer !== layer) return false;
    return true;
  });

  return json({ probes, count: probes.length, since: sinceIso });
};
