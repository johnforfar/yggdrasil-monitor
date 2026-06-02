{
  description = "yggdrasil-monitor — external-vantage uptime monitor (DNS + HTTPS probes)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  # om CLI overrides nixpkgs with openclaw/nixpkgs (dhcpcd-safe pin).

  outputs = inputs: {
    nixosModules.default =
      { pkgs, lib, ... }:
      let
        # buildNpmPackage produces an Astro standalone Node server.
        # Regenerate npmDepsHash with:
        #   nix run nixpkgs#prefetch-npm-deps -- ./package-lock.json
        appPkg = pkgs.buildNpmPackage {
          pname = "yggdrasil-monitor";
          version = "0.1.0";
          src = ./.;
          npmDepsHash = "sha256-GqolZZ2Z7ru2GioW7fzai7NdoKyyac+1BaIDTLLEMGg=";
          npmBuildScript = "build";

          installPhase = ''
            runHook preInstall
            mkdir -p $out/share/yggdrasil-monitor
            cp -r dist          $out/share/yggdrasil-monitor/dist
            cp -r node_modules  $out/share/yggdrasil-monitor/node_modules
            mkdir -p $out/bin
            cat > $out/bin/yggdrasil-monitor-server <<EOF
            #!${pkgs.runtimeShell}
            cd $out/share/yggdrasil-monitor
            exec ${pkgs.nodejs_22}/bin/node $out/share/yggdrasil-monitor/dist/server/entry.mjs "\$@"
            EOF
            chmod +x $out/bin/yggdrasil-monitor-server
            runHook postInstall
          '';
        };
      in
      {
        config = {
          # Canonical container-wrapper overrides per
          # ENGINEERING/2026-05-27_CONTAINER-MIGRATION-SESSION.md §2:
          # xnode-manager 1.0.1's auto-generated wrapper sets
          # `services.xnode-container.xnode-config` but NOT the older
          # `xnode.xnode-config` that `xnodeos.nixosModules.app` reads at eval
          # time. Without these three lines, every fresh deploy fails with
          # "xnode.xnode-config has no value defined" / "Unknown kernel: linux".
          xnode.xnode-config              = ./xnode-config;
          xnode.container.enable          = lib.mkForce true;
          nixpkgs.hostPlatform            = lib.mkForce "x86_64-linux";

          # ===== System user =====
          users.users.yggdrasil-monitor = {
            isSystemUser = true;
            group        = "yggdrasil-monitor";
          };
          users.groups.yggdrasil-monitor = { };

          # ===== Astro standalone server (probe loop runs inside this process) =====
          systemd.services.yggdrasil-monitor = {
            description = "yggdrasil-monitor — Astro server + in-process probe loop";
            after       = [ "network.target" ];
            wantedBy    = [ "multi-user.target" ];

            environment = {
              HOST                      = "127.0.0.1";
              PORT                      = "4321";
              YGG_MONITOR_JSONL         = "/var/lib/yggdrasil-monitor/probes.jsonl";
              YGG_MONITOR_INTERVAL_S    = "60";
              NODE_ENV                  = "production";
            };

            serviceConfig = {
              Type           = "simple";
              ExecStart      = "${appPkg}/bin/yggdrasil-monitor-server";
              Restart        = "always";
              RestartSec     = "5s";
              User           = "yggdrasil-monitor";
              Group          = "yggdrasil-monitor";
              StateDirectory = "yggdrasil-monitor";
              # Hardening
              ProtectSystem      = "strict";
              ProtectHome        = true;
              PrivateTmp         = true;
              NoNewPrivileges    = true;
              MemoryMax          = "256M";
              TasksMax           = 64;
            };
          };

          # ===== nginx — port 8080 (host owns 80) =====
          services.nginx = {
            enable                   = true;
            recommendedGzipSettings  = true;
            recommendedOptimisation  = true;
            recommendedProxySettings = true;

            virtualHosts."default" = {
              default = true;
              listen  = [ { addr = "0.0.0.0"; port = 8080; } ];

              locations."/" = {
                proxyPass   = "http://127.0.0.1:4321";
                extraConfig = ''
                  proxy_read_timeout 60s;
                  proxy_send_timeout 60s;
                '';
              };
            };
          };

          networking.firewall.allowedTCPPorts = [ 8080 ];
        };
      };
  };
}
