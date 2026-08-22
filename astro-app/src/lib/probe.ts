import { promises as dnsPromises } from "node:dns";
import { appendLine } from "./store.ts";

export type Category = "relay" | "yggdrasil" | "direct";

export interface DomainConfig {
  name: string;
  category: Category;
  // For relay/raw-host targets, optionally do a TCP-port probe instead
  // of HTTPS (e.g. the yggdrasil peer TLS port).
  tcp_port?: number;
  /**
   * Ask THIS host (an authoritative nameserver) to resolve `ns_query`.
   * Distinct from the `dns` layer, which asks the system resolver for a name —
   * this asks one specific server whether it is answering at all, which is the
   * question a delegation SPOF actually poses.
   */
  ns_query?: string;
  // Shown next to the name on the page. Bare IPs and bare hostnames say nothing
  // about WHERE a thing is, and "which relay just died" is the first question
  // asked during an outage.
  label?: string;
}

// The upstream openmesh yggdrasil relay. ALL yggdrasil-routed sites depend
// on it being reachable; if it's down, every *.own1.ownx.co box dies at once.
// Probing both DNS resolution AND TCP reachability on the yggdrasil-peer
// TLS port pins root cause when sites fail.
const RELAY_HOST = "peer.yggdrasil.openmesh.cloud";
const RELAY_TLS_PORT = 9003;

export const DOMAINS: DomainConfig[] = [
  { name: RELAY_HOST,                 category: "relay",     tcp_port: RELAY_TLS_PORT },
  // Per-server relay probes: the hostname above round-robins to BOTH peer IPs,
  // so a single-peer outage can hide behind the healthy one. Probe each directly.
  // Geolocation verified 2026-08-07 by rDNS + ipinfo, not guessed:
  //   23.227.167.191 → 23-227-167-191.static.hvvc.us  · Hivelocity · Los Angeles, US
  //   46.232.249.203 → …ultrasrv.de                   · netcup GmbH · Nuremberg, DE
  { name: "23.227.167.191",  category: "relay", tcp_port: RELAY_TLS_PORT, label: "US · Los Angeles (Hivelocity)" },
  // DNS layer on the US relay, added 2026-08-22. On the day this was added the
  // TLS port (9003) and port 53 were BOTH dead on this host while the EU relay
  // was fine — and the boxes resolve via different relays, so one relay dying
  // takes down some boxes and not others. Probing only :9003 says "peer down";
  // probing :53 too says "and name resolution through it is gone", which is the
  // half that actually breaks the public URLs.
  { name: "23.227.167.191",  category: "relay", tcp_port: 53, label: "US · Los Angeles — DNS :53" },
  { name: "46.232.249.203",  category: "relay", tcp_port: 53, label: "EU · Nuremberg — DNS :53" },
  { name: "46.232.249.203",  category: "relay", tcp_port: RELAY_TLS_PORT, label: "EU · Nuremberg (netcup)" },
  // ── THE DELEGATION CHAIN (added 2026-08-15) ───────────────────────────────
  // Every `yggdrasil` row below resolves through `<encoded-ygg>.yggdrasil.trustless.cloud`,
  // and until today the board measured only the SYMPTOMS. Five domains sat at a
  // uniform 4.4-5.1% while every `direct` control sat at ~0%, and the 08-07 writeup
  // concluded "the ygg-CNAME path is unreliable" because the data could not say
  // WHY. It can now.
  //
  // The chain, established 2026-08-15 by walking it:
  //   trustless.cloud            → Cloudflare (hera/terry.ns.cloudflare.com) — reliable
  //   yggdrasil.trustless.cloud  → DELEGATED, 300 s TTL, to ONE nameserver:
  //   dns1.trustless.cloud       → 92.5.225.96 — no PTR, not either dedicated peer
  //
  // Measured at the time of writing: 10/10 queries unanswered while ICMP was 4/4 at
  // 314 ms. The box is up; its DNS service is not. There is NO secondary NS, so
  // there is nothing to fail over to — which is exactly why all five domains move
  // together.
  //
  // These three rows exist so the next outage names its own cause instead of being
  // reported five times as five separate app failures.
  { name: "dns1.trustless.cloud",   category: "relay", ns_query: "201-8d88-490d-f4d4-4950-5f50-b31d-4197.yggdrasil.trustless.cloud", label: "NS · sole authority for *.yggdrasil.trustless.cloud (SPOF)" },
  // PER-BOX bridge probes, added 2026-08-22 after an outage this single query
  // could not characterise. dns1 was UP and reachable on :53, and answered
  // normally for ashton — while returning NOTHING for john and sam and SERVFAIL
  // for its own zone SOA. So the bridge does not fail as a unit: it can lose
  // INDIVIDUAL records. One query against one address cannot see that, and the
  // difference matters enormously — "the bridge is down" and "the bridge has
  // forgotten two of three boxes" have completely different responses.
  { name: "dns1.trustless.cloud", category: "relay", ns_query: "201-a2c1-2181-3b48-57eb-1f8d-9f34-4a23.yggdrasil.trustless.cloud", label: "NS · bridge record for SAM's box" },
  { name: "dns1.trustless.cloud", category: "relay", ns_query: "202-2366-5684-ad56-573b-512c-7fe4-6041.yggdrasil.trustless.cloud", label: "NS · bridge record for ASHTON's box" },
  { name: "92.5.225.96",            category: "relay", tcp_port: 53, label: "NS · dns1 raw IP — no PTR, not a dedicated peer" },
  // NO apex row for trustless.cloud: the apex has no A record (NOERROR/ANSWER:0)
  // — the zone exists to host the delegation, nothing else. Probing it would sit
  // permanently red for a non-fault, and permanent red trains you to ignore the
  // board (see the buildooors removal above). The `dns` layer of
  // dns1.trustless.cloud already IS the parent-zone control: that record lives in
  // Cloudflare's zone as delegation glue, so if it is green while the `ns` row is
  // red, the fault is below the delegation and not Cloudflare.
  // Removed 2026-08-07: ai / network / dashboard / desktop.buildooors.com.
  // Those containers were retired during the 2026-08-01 consolidation, so all four
  // sat at 100% bad indefinitely. Permanent red is worse than no row — it trains
  // you to ignore the board, and it buried the one signal that mattered (john and
  // sam diverging). ACTIVE_DOMAINS filters their historical rows out of the APIs.
  // Own1 demo (moved off buildooors.com → Ashton's ownx.co) + Sam's box, all
  // ygg-routed via the relays above — so the monitor pins the full demo path.
  // The three demo boxes sit in different regions and resolve to DIFFERENT relays
  // (john → 23.227.167.191 US, sam → 46.232.249.203 EU), which is why the
  // per-relay probes above matter: a one-relay outage takes down one box, not all.
  // Renamed 2026-08-22: demo.ownx.co → own1.ownx.co. The three boxes moved on
  // 2026-08-21 and these rows had been probing hostnames that no longer exist,
  // so they read red for a non-fault and would have masked the real outage that
  // arrived the next morning. Ashton's record now EXISTS (it did not in August),
  // so the old "no DNS record yet" note is gone with it.
  { name: "john.own1.ownx.co",   category: "yggdrasil", label: "ASIA · Own1 (Johnny)" },
  { name: "sam.own1.ownx.co",    category: "yggdrasil", label: "EU · Sam" },
  { name: "ashton.own1.ownx.co", category: "yggdrasil", label: "ME · Ashton" },
  // The demo index itself. Vercel-hosted, so it is a `direct` control: if this is
  // green while the three boxes are red, the fault is the ygg path, not the site.
  // memegen — Own1's dedicated image-generation container, live 2026-08-07.
  // Same ygg-CNAME path as the demo boxes, so it inherits the same bridge risk;
  // watched from day one rather than after the first outage nobody noticed.
  { name: "memegen.buildooors.com", category: "yggdrasil", label: "ASIA · Own1 — MEMEGEN (imagegen)" },
  // The public/community name for the same app. A SECOND row on purpose: if the
  // buildooors name is green and this one is red, the fault is that DNS record,
  // not Own1 — which is exactly the distinction that took an hour to establish
  // by hand on 2026-08-07.
  { name: "memegen.marketplace.openxnetwork.org", category: "yggdrasil", label: "MEMEGEN — public/community name" },
  // The rest of Own1's public apps. Watched for their own sake, but the probe
  // doubles as a KEEPALIVE and that is measurably the bigger win: on 2026-08-12
  // the two monitored Own1 domains answered in a flat ~1.2-1.7 s while these
  // three took 3.7-4.1 s on a cold first request before settling to the same
  // speed. Idle lets the trustless.cloud DNS entry and the ygg route go cold,
  // and the first visitor pays for re-establishing both — or, per the 24 h
  // measurements, simply fails.
  //
  // A 60 s probe from xnode-1 beats Sam's in-browser 50 s keepalive for this,
  // because it runs whether or not anyone has a page open — which is precisely
  // when a site has gone cold.
  { name: "power.buildooors.com",    category: "yggdrasil", label: "ASIA · Own1 — own-power" },
  { name: "vesper.buildooors.com",   category: "yggdrasil", label: "ASIA · Own1 — vesper" },
  { name: "comicgen.buildooors.com", category: "yggdrasil", label: "ASIA · Own1 — comicgen" },
  // The public/community (marketplace) names for vesper + comicgen — the SECOND
  // row per app, same rationale as memegen: buildooors green + marketplace red =
  // that DNS record, not Own1. The 50 s probe also keeps these names' trustless.cloud
  // registration warm, directly fighting the ~25% CNAME flap.
  { name: "vesper.marketplace.openxnetwork.org",   category: "yggdrasil", label: "VESPER — public/community name" },
  { name: "comicgen.marketplace.openxnetwork.org", category: "yggdrasil", label: "COMICGEN — public/community name" },
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
// Human label for a probe target (region + operator). Bare IPs on the page do not
// answer "which relay is down", which is the first question during an outage.
const LABEL_BY_DOMAIN: Map<string, string> = new Map(
  DOMAINS.filter((d) => d.label).map((d) => [d.name, d.label as string]),
);
export const labelFor = (domain: string): string | undefined =>
  LABEL_BY_DOMAIN.get(domain);

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

// Authoritative-NS probe: does this nameserver answer the query the whole estate
// depends on? Added 2026-08-15 after `yggdrasil.trustless.cloud` was found to be
// delegated to a SINGLE server (dns1 → 92.5.225.96, no secondary) that returned
// 0/10 while answering ICMP 4/4. Every ygg row went red together and the board
// could not say why, because it measured only the symptoms.
const probeNs = async (d: DomainConfig): Promise<void> => {
  const t0 = process.hrtime.bigint();
  let ok = false;
  let detail = "";
  try {
    const { Resolver } = await import("node:dns/promises");
    const r = new Resolver({ timeout: 4000, tries: 1 });
    // Resolve the NS hostname to an address first: setServers needs an IP, and
    // resolving it through the system resolver is itself part of the chain.
    const { lookup } = await import("node:dns/promises");
    const addr = await lookup(d.name);
    r.setServers([addr.address]);
    const ans = await r.resolve4(d.ns_query!);
    ok = Array.isArray(ans) && ans.length > 0;
    detail = ok ? ans[0] : "empty";
  } catch (e: any) {
    detail = String(e?.code ?? e?.message ?? "error").slice(0, 40);
  }
  const t1 = process.hrtime.bigint();
  await appendLine({
    ts: nowIso(), layer: "ns", domain: d.name, category: d.category,
    total_s: Number((t1 - t0) / 1000000n) / 1000, ok, detail,
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
    if (d.ns_query) {
      await probeNs(d);
    } else if (d.tcp_port) {
      await probeTcp(d);
    } else {
      await probeHttps(d);
    }
  }
};

let loopStarted = false;

export const startProbeLoop = (intervalSec = 50): void => {
  if (loopStarted) return;
  loopStarted = true;
  setTimeout(() => { void runOnce().catch(() => {}); }, 5_000);
  setInterval(() => { void runOnce().catch(() => {}); }, intervalSec * 1000);
  console.log(`[ygg-monitor] probe loop started, interval=${intervalSec}s, targets=${DOMAINS.length}`);
};
