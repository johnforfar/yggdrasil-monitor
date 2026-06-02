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
      YGG_MONITOR_INTERVAL_S = "60";
    };
    serviceConfig = {
      ExecStart = "${lib.getExe yggdrasil-monitor}";
      User = "yggdrasil-monitor";
      Group = "yggdrasil-monitor";
      Restart = "on-failure";
      RestartSec = "5s";
      StateDirectory = "yggdrasil-monitor";
    };
  };

  networking.firewall.allowedTCPPorts = [ 8080 ];
}
