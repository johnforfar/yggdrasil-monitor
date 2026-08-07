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

## Storage

JSON Lines at `/var/lib/yggdrasil-monitor/probes.jsonl`. Append-only. Single Node process (probe loop + HTTP server in the same Astro standalone server) — no separate timer needed.

## API

- `GET /` — current bucket summary (HTML status page)
- `GET /api/probes?since=24h&domain=example.com&layer=dns` — recent raw probes
- `GET /api/summary` — last-24 h bucket per (domain, layer): current status, ok/bad counts, worst contiguous bad-streak, avg latency
- `GET /api/timeseries?hours=24` — bucketed series behind the sparklines
- `GET /api/host-metrics` — Own1 load / memory / swap, pushed in by `own1-metrics-push.service`

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
