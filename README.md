# yggdrasil-monitor

External-vantage uptime monitor for a fixed list of domains.

Probes DNS + HTTPS every 60 s and stores per-probe results as JSON Lines on disk.

## Layers probed

| Layer | What | Resolvers / endpoint |
|---|---|---|
| `dns` | A / AAAA / CNAME per resolver | 1.1.1.1, 8.8.8.8, 9.9.9.9 |
| `https` | top-level HTTPS reachability + status | `fetch()` (Node) |
| `tcp` | raw socket connect, for hosts that don't serve HTTPS | yggdrasil peer TLS port 9003 |

Each probe records: timestamp, layer, domain, took_ms, outcome, optional answer string. CNAME chains that dead-end at an unresolved yggdrasil-encoded subdomain are tagged `result: "cname_only"` so outage attribution is unambiguous.

## Reading history: rollups

The APIs never re-read the raw file:
- `astro-app/src/lib/rollup.ts` keeps per-series bins: 60 s for 48 h, 300 s for 30 d.
- Memory is fixed, about 10 MB.
- They are updated as each probe is appended and snapshotted to `probes.rollup-v2.bin` every 5 min.
- On first start the raw file is streamed once (about 640 MB in 18 s on xnode-1). A restart replays only the bytes after the snapshot.
- Raw probes older than 30 days are pruned daily, by streaming (`YGG_MONITOR_RETAIN_DAYS`).

## Storage

JSON Lines at `/var/lib/yggdrasil-monitor/probes.jsonl`. Append-only. Single Node process (probe loop + HTTP server in the same Astro standalone server) — no separate timer needed.

## API

- `GET /` — current bucket summary (HTML status page)
- `GET /api/probes?since=24h&domain=example.com&layer=dns` — recent raw probes
- `GET /api/summary?hours=1..720[&end=ms]` — per (domain, layer) over the window: current status, ok/bad counts, worst outage (whole bins), avg latency. From the rollups
- `GET /api/timeseries?hours=24` — bucketed series behind the sparklines
- `GET /api/host-metrics` — Own1 load / memory / swap / ygg reconnects / image canary / `mesh` (box→internet and box→relay pings, over the internet and over ygg), pushed in by `own1-metrics-push.service`. It is shown as the Own1 panel's `path` row: amber = ISP loss, red = the ygg session losing ≥60% while the internet is clean.

Note: this container has no route into ygg (`200::/7` unreachable); its HTTPS probes reach Own1s through a relay's HTTPS bridge. Mesh pings run on the box, not here.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `YGG_MONITOR_JSONL` | `/var/lib/yggdrasil-monitor/probes.jsonl` | JSONL append path |
| `YGG_MONITOR_INTERVAL_S` | `60` | Probe cadence in seconds |
| `PORT` | `4321` | Astro server port |
| `HOST` | `127.0.0.1` | Listen interface |

## Deploy

Build locally first — Astro needs Node >= 22.12, and a broken build deploys as a "success".

```
cd astro-app && npx astro build
git push origin main

om -p xnode-1-v10 app deploy yggdrasil-monitor \
  --flake github:johnforfar/yggdrasil-monitor \
  --update-input yggdrasil-monitor \
  --timeout 900
```

`--update-input` is required. The deployed flake tracks the branch unpinned, so without it the lock
pins the old rev, the same derivation rebuilds, and the deploy reports success without your commit.

First deploy only:

```
om app expose --domain <subdomain> --port 8080 yggdrasil-monitor
```

Port 8080, matching `PORT` in `nix/nixos-module.nix` — not Astro's 4321 default.

## Rollback

```
om app remove yggdrasil-monitor
```

## Local dev

```
npm install
YGG_MONITOR_JSONL=/tmp/probes.jsonl npm run dev
```

Open `http://localhost:4321/`.

## License

MIT.
