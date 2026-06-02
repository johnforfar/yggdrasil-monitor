import { defineConfig } from "astro/config";
import node from "@astrojs/node";

export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  server: {
    host: process.env.HOST ?? "0.0.0.0",
    port: Number(process.env.PORT ?? 8080),
  },
});
