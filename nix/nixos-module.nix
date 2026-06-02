{ config, pkgs, lib, ... }:
let
  pname = "yggdrasil-monitor";
  port = 4351;
  dataDir = "/var/lib/${pname}";
  package = pkgs.callPackage ./package.nix { };
  probeScript = "${package}/share/${pname}/scripts/probe.sh";
in
{
  users.users.${pname} = {
    isSystemUser = true;
    group = pname;
    home = dataDir;
    createHome = false;
  };
  users.groups.${pname} = { };

  systemd.tmpfiles.rules = [
    "d ${dataDir} 0750 ${pname} ${pname} - -"
  ];

  # ---- HTTP server (Astro standalone) -----------------------------------
  systemd.services.${pname} = {
    description = "yggdrasil-monitor — HTTP read API + status page";
    wantedBy = [ "multi-user.target" ];
    after = [ "network.target" ];

    serviceConfig = {
      User = pname;
      Group = pname;
      ExecStart = "${package}/bin/${pname}-server";
      Restart = "always";
      RestartSec = "5s";

      # Bind only to loopback by default; reverse proxy via xnode-reverse-proxy.
      Environment = [
        "HOST=127.0.0.1"
        "PORT=${toString port}"
        "YGG_MONITOR_JSONL=${dataDir}/probes.jsonl"
        "NODE_ENV=production"
      ];

      # Hardening.
      ProtectSystem = "strict";
      ProtectHome = true;
      PrivateTmp = true;
      NoNewPrivileges = true;
      ReadOnlyPaths = [ "/" ];
      ReadWritePaths = [ dataDir ];
      ProtectKernelTunables = true;
      ProtectKernelModules = true;
      ProtectControlGroups = true;
      RestrictAddressFamilies = [ "AF_INET" "AF_INET6" "AF_UNIX" ];
      MemoryMax = "256M";
      TasksMax = 64;
    };
  };

  # ---- Probe systemd timer ----------------------------------------------
  systemd.services."${pname}-probe" = {
    description = "yggdrasil-monitor — single probe run (DNS + HTTPS across configured domains)";
    after = [ "network.target" ];

    path = with pkgs; [
      bash
      coreutils
      curl
      dnsutils    # provides `dig`
      gawk
      gnugrep
      gnused
    ];

    serviceConfig = {
      Type = "oneshot";
      User = pname;
      Group = pname;
      Environment = [ "DATA_DIR=${dataDir}" ];
      ExecStart = "${pkgs.bash}/bin/bash ${probeScript}";

      ProtectSystem = "strict";
      ProtectHome = true;
      PrivateTmp = true;
      NoNewPrivileges = true;
      ReadWritePaths = [ dataDir ];
      MemoryMax = "128M";
      TasksMax = 32;
      TimeoutStartSec = "120s";
    };
  };

  systemd.timers."${pname}-probe" = {
    description = "yggdrasil-monitor — fire a probe run every 60 s";
    wantedBy = [ "timers.target" ];
    timerConfig = {
      OnBootSec = "30s";
      OnUnitActiveSec = "60s";
      AccuracySec = "1s";
    };
  };
}
