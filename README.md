# yggdrasil-monitor

External-vantage uptime monitor for a fixed list of domains.

Runs DNS + HTTPS probes every 60s, stores per-probe results as JSON Lines, exposes a small read API.

## Layers probed

| Layer | What | Resolvers / endpoint |
|---|---|---|
| `dns` | A / AAAA per resolver | 1.1.1.1, 8.8.8.8, 9.9.9.9 |
| `https` | end-to-end timing + status | `curl -w` |

Each probe records: timestamp, layer, domain, took_ms, outcome, and timing breakdown (`name_s`, `connect_s`, `ttfb_s`, `total_s`).

## Storage

JSON Lines at `/var/lib/yggdrasil-monitor/probes.jsonl`. Append-only. Auto-trims to 30 days.

## API

- `GET /api/probes?since=24h&domain=example.com&layer=dns` — recent raw probes
- `GET /api/summary` — last-24h bucket per (domain, layer): current status, ok/bad counts, worst contiguous bad-streak seconds, avg latency

## Deploy

```
om profile use xnode-1-v10
om app deploy --flake github:johnforfar/yggdrasil-monitor yggdrasil-monitor
om app expose --domain <subdomain> --port 4351 yggdrasil-monitor
```

## Rollback

```
om app remove yggdrasil-monitor
```

## Local dev

```
npm install
npm run dev
```

The probe script (`scripts/probe.sh`) is normally driven by a systemd timer at 60s cadence; for local dev you can run it once by hand with `DATA_DIR=/tmp/yggm bash scripts/probe.sh`.

## License

MIT.
