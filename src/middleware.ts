// Astro middleware — runs on every request. We use the first request to
// kick off the probe loop (server-internal setInterval) so we don't need a
// separate systemd timer or bash script. Subsequent calls are no-ops thanks
// to the `loopStarted` flag inside probe.ts.
import { defineMiddleware } from "astro:middleware";
import { startProbeLoop } from "./lib/probe.ts";

const INTERVAL_S = Number(process.env.YGG_MONITOR_INTERVAL_S ?? "60");

export const onRequest = defineMiddleware((_ctx, next) => {
  startProbeLoop(INTERVAL_S);
  return next();
});
