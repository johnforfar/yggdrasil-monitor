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
  // Per-server relay probes: the hostname above round-robins to BOTH peer IPs,
  // so a single-peer outage can hide behind the healthy one. Probe each directly.
  { name: "23.227.167.191",           category: "relay",     tcp_port: RELAY_TLS_PORT }, // peer-us (hvvc.us)
  { name: "46.232.249.203",           category: "relay",     tcp_port: RELAY_TLS_PORT }, // peer-eu (ultrasrv.de)
  { name: "ai.buildooors.com",        category: "yggdrasil" },
  { name: "network.buildooors.com",   category: "yggdrasil" },
  { name: "dashboard.buildooors.com", category: "yggdrasil" },
  { name: "desktop.buildooors.com",   category: "yggdrasil" },
  { name: "llm.plopmenz.com",         category: "yggdrasil" },
  // Own1 demo (moved off buildooors.com → Ashton's ownx.co) + Sam's box, all
  // ygg-routed via the relays above — so the monitor pins the full demo path.
  // The three demo boxes sit in different regions and resolve to DIFFERENT relays
  // (john → 23.227.167.191 US, sam → 46.232.249.203 EU), which is why the
  // per-relay probes above matter: a one-relay outage takes down one box, not all.
  { name: "john.demo.ownx.co",        category: "yggdrasil" }, // Own1, ASIA
  { name: "sam.demo.ownx.co",         category: "yggdrasil" }, // Sam's demo container, EU
  // Ashton's box (ME) is listed on demo.ownx.co but has NO DNS record yet, so this
  // WILL read down until one is created. That is deliberate — a red row is a
  // standing reminder the record is missing, which a silent omission would not be.
  { name: "ashton.demo.ownx.co",      category: "yggdrasil" }, // ME — pending DNS
  // The demo index itself. Vercel-hosted, so it is a `direct` control: if this is
  // green while the three boxes are red, the fault is the ygg path, not the site.
  { name: "demo.ownx.co",             category: "direct" },
  { name: "ownx.co",                  category: "direct" },
  { name: "community.openxnetwork.org", category: "direct" }, // was openxai.org (rebrand)
  { name: "openxnetwork.org",         category: "direct" },   // was openxai.org (rebrand)
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

// A raw IPv4/IPv6 literal — DNS resolution doesn't apply, so skip the DNS layer
// (otherwise every per-IP relay probe records a spurious "empty" DNS failure).
const isRawIp = (s: string): boolean => /^\d{1,3}(\.\d{1,3}){3}$/.test(s) || s.includes(":");

export const runOnce = async (): Promise<void> => {
  for (const d of DOMAINS) {
    if (!isRawIp(d.name)) {
      for (const r of RESOLVERS) {
        await probeDns(d, r.name, r.servers);
      }
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
