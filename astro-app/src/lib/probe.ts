import { promises as dnsPromises } from "node:dns";
import { appendLine } from "./store.ts";

const DOMAINS = [
  "ai.buildooors.com",
  "network.buildooors.com",
  "dashboard.buildooors.com",
  "desktop.buildooors.com",
  "sledgit.com",
  "community.openxai.org",
  "openxai.org",
  "openmesh.network",
  "v10.build.openmesh.cloud",
];

const RESOLVERS: { name: string; servers: string[] }[] = [
  { name: "1.1.1.1", servers: ["1.1.1.1"] },
  { name: "8.8.8.8", servers: ["8.8.8.8"] },
  { name: "9.9.9.9", servers: ["9.9.9.9"] },
];

const nowIso = () => new Date().toISOString().slice(0, 19) + "Z";

// Try A then AAAA via a Resolver with a fixed upstream. Returns the joined
// answer set or empty string.
const resolveBoth = async (domain: string, servers: string[]): Promise<string[]> => {
  const r = new dnsPromises.Resolver({ timeout: 2000, tries: 1 });
  r.setServers(servers);
  // resolveAny() returns CNAME records too, which is what we want for
  // diagnosing "CNAME-only" chains.
  try {
    const records = await r.resolveAny(domain);
    return records.map((rec: any) => {
      if (rec.address) return rec.address;
      if (rec.value) return rec.value;     // CNAME
      if (rec.exchange) return rec.exchange; // MX
      return JSON.stringify(rec);
    });
  } catch {
    return [];
  }
};

const probeDns = async (domain: string, name: string, servers: string[]): Promise<void> => {
  const t0 = process.hrtime.bigint();
  const answers = await resolveBoth(domain, servers);
  const t1 = process.hrtime.bigint();
  const took_ms = Number((t1 - t0) / 1000000n);

  let result: string;
  if (answers.length === 0) {
    result = "empty";
  } else if (answers.every((a) => /\.yggdrasil\.[a-z.]+\.?$/i.test(a))) {
    // CNAME chain dead-ends at a yggdrasil-encoded subdomain that did not
    // resolve to an A or AAAA record.
    result = "cname_only";
  } else {
    result = "resolved";
  }

  await appendLine({
    ts: nowIso(),
    layer: "dns",
    domain,
    resolver: name,
    result,
    took_ms,
    answer: answers[0] ?? "",
  });
};

const probeHttps = async (domain: string): Promise<void> => {
  const t0 = process.hrtime.bigint();
  let http_code = 0;
  let ok = false;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10_000);
    const resp = await fetch(`https://${domain}`, { signal: ctl.signal, redirect: "manual" });
    clearTimeout(timer);
    http_code = resp.status;
    ok = true;
  } catch {
    // ok stays false
  }
  const t1 = process.hrtime.bigint();
  const total_s = Number((t1 - t0) / 1000000n) / 1000;

  await appendLine({
    ts: nowIso(),
    layer: "https",
    domain,
    http_code,
    total_s,
    ok,
  });
};

export const runOnce = async (): Promise<void> => {
  for (const d of DOMAINS) {
    for (const r of RESOLVERS) {
      await probeDns(d, r.name, r.servers);
    }
    await probeHttps(d);
  }
};

let loopStarted = false;

export const startProbeLoop = (intervalSec = 60): void => {
  if (loopStarted) return;
  loopStarted = true;
  // Kick off after a short delay so server has fully started.
  setTimeout(() => {
    void runOnce().catch(() => { /* swallow */ });
  }, 5_000);
  setInterval(() => {
    void runOnce().catch(() => { /* swallow */ });
  }, intervalSec * 1000);
  console.log(`[ygg-monitor] probe loop started, interval=${intervalSec}s`);
};
