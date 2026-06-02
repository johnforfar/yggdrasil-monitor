{
  description = "yggdrasil-monitor — external-vantage uptime monitor (DNS + HTTPS probes)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  inputs.xnodeos.url = "github:Openmesh-Network/xnodeos";
  # om CLI overrides nixpkgs with openclaw/nixpkgs (dhcpcd-safe pin).

  outputs = inputs: {
    nixosModules.default = { pkgs, lib, ... }:
      let
        appPkg = pkgs.buildNpmPackage {
          pname = "yggdrasil-monitor";
          version = "0.1.0";
          src = ./.;
          # Regenerate with: nix run nixpkgs#prefetch-npm-deps -- ./package-lock.json
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
        # Import xnodeos's app module so the `xnode` option namespace is
        # declared in this module's eval scope, enabling us to set
        # `xnode.xnode-config` etc. Per
        # ENGINEERING/2026-05-27_CONTAINER-MIGRATION-SESSION.md §2.
        imports = [ inputs.xnodeos.nixosModules.app ];

        config = {
          xnode.xnode-config     = ./xnode-config;
          xnode.container.enable = lib.mkForce true;
          nixpkgs.hostPlatform   = lib.mkForce "x86_64-linux";

          users.users.yggdrasil-monitor = {
            isSystemUser = true;
            group        = "yggdrasil-monitor";
          };
          users.groups.yggdrasil-monitor = { };

          systemd.services.yggdrasil-monitor = {
            description = "yggdrasil-monitor — Astro server + in-process probe loop";
            after       = [ "network.target" ];
            wantedBy    = [ "multi-user.target" ];

            environment = {
              HOST                   = "127.0.0.1";
              PORT                   = "4321";
              YGG_MONITOR_JSONL      = "/var/lib/yggdrasil-monitor/probes.jsonl";
              YGG_MONITOR_INTERVAL_S = "60";
              NODE_ENV               = "production";
            };

            serviceConfig = {
              Type            = "simple";
              ExecStart       = "${appPkg}/bin/yggdrasil-monitor-server";
              Restart         = "always";
              RestartSec      = "5s";
              User            = "yggdrasil-monitor";
              Group           = "yggdrasil-monitor";
              StateDirectory  = "yggdrasil-monitor";
              ProtectSystem   = "strict";
              ProtectHome     = true;
              PrivateTmp      = true;
              NoNewPrivileges = true;
              MemoryMax       = "256M";
              TasksMax        = 64;
            };
          };

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
