import type { APIRoute } from "astro";
import { existsSync } from "node:fs";
import { stat, open } from "node:fs/promises";

export const prerender = false;

const JSONL_PATH = process.env.YGG_MONITOR_JSONL ?? "/var/lib/yggdrasil-monitor/probes.jsonl";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

// Parse a "since" query like "24h" / "60m" / "7d" into a Date.
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
  if (!existsSync(JSONL_PATH)) {
    return json({ probes: [], note: "no probes file yet" });
  }
  const since = parseSince(url.searchParams.get("since"));
  const sinceIso = since.toISOString().slice(0, 19) + "Z";
  const domain = url.searchParams.get("domain");
  const layer = url.searchParams.get("layer"); // dns | https

  const probes: unknown[] = [];
  // Stream-read line-by-line. The file can be ~50 MB in 24h at default cadence.
  const fh = await open(JSONL_PATH, "r");
  try {
    const st = await stat(JSONL_PATH);
    // Heuristic: probes append, so most-recent are at the tail. Read the
    // last ~2 MB which is generous for 24h at our cadence (≈3 MB/24h).
    const max = 4 * 1024 * 1024;
    const start = st.size > max ? st.size - max : 0;
    const buf = Buffer.alloc(st.size - start);
    await fh.read(buf, 0, buf.length, start);
    const text = buf.toString("utf-8");
    // Skip partial first line if we sliced mid-line.
    const startIdx = start === 0 ? 0 : text.indexOf("\n") + 1;
    const lines = text.slice(startIdx).split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.ts < sinceIso) continue;
        if (domain && obj.domain !== domain) continue;
        if (layer && obj.layer !== layer) continue;
        probes.push(obj);
      } catch { /* skip malformed */ }
    }
  } finally {
    await fh.close();
  }

  return json({ probes, count: probes.length, since: sinceIso });
};
