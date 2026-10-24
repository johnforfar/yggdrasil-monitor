{ pkgs, lib, ... }:
let
  yggdrasil-monitor = pkgs.callPackage ./package.nix { };
in {
  users.groups.yggdrasil-monitor = { };
  users.users.yggdrasil-monitor = {
    isSystemUser = true;
    group = "yggdrasil-monitor";
  };

  systemd.services.yggdrasil-monitor = {
    description = "yggdrasil-monitor — DNS + HTTPS probes (in-process)";
    wantedBy = [ "multi-user.target" ];
    after = [ "network.target" ];
    environment = {
      HOST = "0.0.0.0";
      PORT = "8080";
      NODE_ENV = "production";
      YGG_MONITOR_JSONL = "/var/lib/yggdrasil-monitor/probes.jsonl";
      YGG_MONITOR_METRICS_JSONL = "/var/lib/yggdrasil-monitor/host-metrics.jsonl";
      YGG_MONITOR_INTERVAL_S = "60";
      # the mesh pings (probe.ts): this container has no ping wrapper of its own
      YGG_MONITOR_PING = "${pkgs.iputils}/bin/ping";
    };
    serviceConfig = {
      ExecStart = "${lib.getExe yggdrasil-monitor}";
      User = "yggdrasil-monitor";
      Group = "yggdrasil-monitor";
      Restart = "on-failure";
      RestartSec = "5s";
      StateDirectory = "yggdrasil-monitor";
      # Load operator-set secrets (om app env set) — leading `-` makes the
      # file optional so first-deploy without secrets still boots.
      EnvironmentFile = "-/xnode-config/env";
      # ICMP for those pings and nothing else
      AmbientCapabilities = [ "CAP_NET_RAW" ];
      CapabilityBoundingSet = [ "CAP_NET_RAW" ];
    };
  };

  networking.firewall.allowedTCPPorts = [ 8080 ];
}
