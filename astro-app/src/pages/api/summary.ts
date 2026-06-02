import type { APIRoute } from "astro";
import { tail } from "../../lib/store.ts";
import { ACTIVE_DOMAINS, categoryFor } from "../../lib/probe.ts";

export const prerender = false;

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

interface Bucket {
  domain: string;
  layer: string;
  category: string;
  total: number;
  ok: number;
  bad: number;
  current: string;
  last_bad_ts: string | null;
  worst_streak_s: number;
  avg_ms: number;
}

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

export const GET: APIRoute = async () => {
  const sinceIso = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 19) + "Z";
  type Acc = Bucket & { _msSum: number; _streakStart: string | null };
  const buckets = new Map<string, Acc>();

  const probes = await tail(8 * 1024 * 1024, (p: any) => p.ts >= sinceIso && ACTIVE_DOMAINS.has(p.domain));
  for (const p of probes as any[]) {
    const key = `${p.domain}::${p.layer}`;
    let b = buckets.get(key);
    if (!b) {
      b = {
        domain: p.domain, layer: p.layer, category: categoryFor(p.domain),
        total: 0, ok: 0, bad: 0, current: "unknown",
        last_bad_ts: null, worst_streak_s: 0, avg_ms: 0,
        _msSum: 0, _streakStart: null,
      };
      buckets.set(key, b);
    }
    b.total++;
    b._msSum += probeMs(p);
    if (isBad(p)) {
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

  const out: Bucket[] = [];
  for (const b of buckets.values()) {
    if (b._streakStart) {
      const dur = (Date.now() - Date.parse(b._streakStart)) / 1000;
      if (dur > b.worst_streak_s) b.worst_streak_s = dur;
    }
    b.avg_ms = b.total > 0 ? Math.round(b._msSum / b.total) : 0;
    const { _msSum, _streakStart, ...clean } = b;
    out.push(clean);
  }
  out.sort((a, b) => (a.current === "bad" ? -1 : 1) - (b.current === "bad" ? -1 : 1) || a.domain.localeCompare(b.domain));
  return json({ buckets: out, since: sinceIso });
};
