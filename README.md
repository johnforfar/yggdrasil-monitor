# yggdrasil-monitor

External-vantage uptime monitor for a fixed list of domains.

Probes DNS + HTTPS every 60 s and stores per-probe results as JSON Lines on disk.

## Layers probed

| Layer | What | Resolvers / endpoint |
|---|---|---|
| `dns` | A / AAAA / CNAME per resolver | 1.1.1.1, 8.8.8.8, 9.9.9.9 |
| `https` | top-level HTTPS reachability + status | `fetch()` (Node) |

Each probe records: timestamp, layer, domain, took_ms, outcome, optional answer string. CNAME chains that dead-end at an unresolved yggdrasil-encoded subdomain are tagged `result: "cname_only"` so outage attribution is unambiguous.

## Storage

JSON Lines at `/var/lib/yggdrasil-monitor/probes.jsonl`. Append-only. Single Node process (probe loop + HTTP server in the same Astro standalone server) — no separate timer needed.

## API

- `GET /` — current bucket summary (HTML status page)
- `GET /api/probes?since=24h&domain=example.com&layer=dns` — recent raw probes
- `GET /api/summary` — last-24 h bucket per (domain, layer): current status, ok/bad counts, worst contiguous bad-streak, avg latency

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `YGG_MONITOR_JSONL` | `/var/lib/yggdrasil-monitor/probes.jsonl` | JSONL append path |
| `YGG_MONITOR_INTERVAL_S` | `60` | Probe cadence in seconds |
| `PORT` | `4321` | Astro server port |
| `HOST` | `127.0.0.1` | Listen interface |

## Deploy

```
om profile use xnode-1-v10
om app deploy --flake github:johnforfar/yggdrasil-monitor yggdrasil-monitor
om app expose --domain <subdomain> --port 4321 yggdrasil-monitor
```

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
