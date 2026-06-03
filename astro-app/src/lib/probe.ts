import { promises as dnsPromises } from "node:dns";
import { appendLine } from "./store.ts";

export type Category = "relay" | "yggdrasil" | "direct";

export interface DomainConfig {
  name: string;
  category: Category;
  // For relay/raw-host targets, optionally do a TCP-port probe instead
  // of HTTPS (e.g. the yggdrasil peer TLS port).
  tcp_port?: number;
}

// The upstream openmesh yggdrasil relay. ALL yggdrasil-routed sites depend
// on it being reachable; if it's down, every buildooors.com domain dies.
// Probing both DNS resolution AND TCP reachability on the yggdrasil-peer
// TLS port pins root cause when sites fail.
const RELAY_HOST = "peer.yggdrasil.openmesh.cloud";
const RELAY_TLS_PORT = 9003;

export const DOMAINS: DomainConfig[] = [
  { name: RELAY_HOST,                 category: "relay",     tcp_port: RELAY_TLS_PORT },
  { name: "ai.buildooors.com",        category: "yggdrasil" },
  { name: "network.buildooors.com",   category: "yggdrasil" },
  { name: "dashboard.buildooors.com", category: "yggdrasil" },
  { name: "desktop.buildooors.com",   category: "yggdrasil" },
  { name: "community.openxai.org",    category: "direct" },
  { name: "openxai.org",              category: "direct" },
  { name: "openmesh.network",         category: "direct" },
  { name: "v10.build.openmesh.cloud", category: "direct" },
];

// Allow-list used by the read APIs to filter out historical probes for
// domains no longer in the active set (the JSONL file is append-only and
// retains rows from earlier configurations).
export const ACTIVE_DOMAINS: Set<string> = new Set(DOMAINS.map((d) => d.name));

// Canonical (domain -> category) map. Read APIs use this instead of trusting
// the per-probe category field, because probes written by older code versions
// don't carry one.
const CATEGORY_BY_DOMAIN: Map<string, Category> = new Map(
  DOMAINS.map((d) => [d.name, d.category]),
);
export const categoryFor = (domain: string): Category =>
  CATEGORY_BY_DOMAIN.get(domain) ?? "direct";

const RESOLVERS: { name: string; servers: string[] }[] = [
  { name: "1.1.1.1", servers: ["1.1.1.1"] },
  { name: "8.8.8.8", servers: ["8.8.8.8"] },
  { name: "9.9.9.9", servers: ["9.9.9.9"] },
];

const nowIso = () => new Date().toISOString().slice(0, 19) + "Z";

// Query A + AAAA + CNAME independently. resolveAny() is unreliable on
// Cloudflare (1.1.1.1) and Google (8.8.8.8) because RFC 8482 lets them
// return empty/HINFO for ANY queries — only Quad9 still returns full
// records, which was causing a 2/3-resolver false-positive on every
// yggdrasil-routed domain. Explicit per-type queries are immune.
const resolveBoth = async (domain: string, servers: string[]): Promise<string[]> => {
  const r = new dnsPromises.Resolver({ timeout: 2000, tries: 1 });
  r.setServers(servers);
  const out: string[] = [];
  const safe = async <T,>(p: Promise<T[]>): Promise<T[]> => {
    try { return await p; } catch { return []; }
  };
  const [v4, v6, cname] = await Promise.all([
    safe(r.resolve4(domain)),
    safe(r.resolve6(domain)),
    safe(r.resolveCname(domain)),
  ]);
  out.push(...v4, ...v6, ...cname);
  return out;
};

const probeDns = async (d: DomainConfig, name: string, servers: string[]): Promise<void> => {
  const t0 = process.hrtime.bigint();
  const answers = await resolveBoth(d.name, servers);
  const t1 = process.hrtime.bigint();
  const took_ms = Number((t1 - t0) / 1000000n);

  let result: string;
  if (answers.length === 0) result = "empty";
  else if (answers.every((a) => /\.yggdrasil\.[a-z.]+\.?$/i.test(a))) result = "cname_only";
  else result = "resolved";

  await appendLine({
    ts: nowIso(), layer: "dns", domain: d.name, category: d.category,
    resolver: name, result, took_ms, answer: answers[0] ?? "",
  });
};

const probeHttps = async (d: DomainConfig): Promise<void> => {
  const t0 = process.hrtime.bigint();
  let http_code = 0;
  let ok = false;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10_000);
    const resp = await fetch(`https://${d.name}`, { signal: ctl.signal, redirect: "manual" });
    clearTimeout(timer);
    http_code = resp.status;
    ok = true;
  } catch { /* ok stays false */ }
  const t1 = process.hrtime.bigint();
  const total_s = Number((t1 - t0) / 1000000n) / 1000;

  await appendLine({
    ts: nowIso(), layer: "https", domain: d.name, category: d.category,
    http_code, total_s, ok,
  });
};

// TCP-reach probe: connect to (host, port), measure handshake time. Used for
// the yggdrasil peer, which doesn't serve HTTPS but does answer TLS on 9003.
const probeTcp = async (d: DomainConfig): Promise<void> => {
  const port = d.tcp_port!;
  const t0 = process.hrtime.bigint();
  let ok = false;
  try {
    const { connect } = await import("node:net");
    await new Promise<void>((resolve, reject) => {
      const sock = connect({ host: d.name, port, family: 0 });
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error("timeout"));
      }, 5_000);
      sock.once("connect", () => {
        clearTimeout(timer);
        sock.end();
        ok = true;
        resolve();
      });
      sock.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  } catch { /* ok stays false */ }
  const t1 = process.hrtime.bigint();
  const total_s = Number((t1 - t0) / 1000000n) / 1000;
  await appendLine({
    ts: nowIso(), layer: "tcp", domain: d.name, category: d.category,
    port, total_s, ok,
  });
};

export const runOnce = async (): Promise<void> => {
  for (const d of DOMAINS) {
    for (const r of RESOLVERS) {
      await probeDns(d, r.name, r.servers);
    }
    if (d.tcp_port) {
      await probeTcp(d);
    } else {
      await probeHttps(d);
    }
  }
};

let loopStarted = false;

export const startProbeLoop = (intervalSec = 60): void => {
  if (loopStarted) return;
  loopStarted = true;
  setTimeout(() => { void runOnce().catch(() => {}); }, 5_000);
  setInterval(() => { void runOnce().catch(() => {}); }, intervalSec * 1000);
  console.log(`[ygg-monitor] probe loop started, interval=${intervalSec}s, targets=${DOMAINS.length}`);
};
