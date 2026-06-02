{ pkgs, lib, ... }:
pkgs.buildNpmPackage rec {
  pname = "yggdrasil-monitor";
  version = "0.1.0";
  src = ../.;

  # Regenerate with: nix run nixpkgs#prefetch-npm-deps -- ./package-lock.json
  npmDepsHash = "sha256-GqolZZ2Z7ru2GioW7fzai7NdoKyyac+1BaIDTLLEMGg=";

  npmBuildScript = "build";

  installPhase = ''
    runHook preInstall

    mkdir -p $out/share/yggdrasil-monitor
    cp -r dist            $out/share/yggdrasil-monitor/dist
    cp -r node_modules    $out/share/yggdrasil-monitor/node_modules
    cp -r scripts         $out/share/yggdrasil-monitor/scripts
    chmod +x              $out/share/yggdrasil-monitor/scripts/probe.sh

    mkdir -p $out/bin
    cat > $out/bin/yggdrasil-monitor-server <<EOF
#!${pkgs.runtimeShell}
cd $out/share/yggdrasil-monitor
exec ${pkgs.nodejs_22}/bin/node $out/share/yggdrasil-monitor/dist/server/entry.mjs "\$@"
EOF
    chmod +x $out/bin/yggdrasil-monitor-server

    runHook postInstall
  '';

  meta = {
    description = "External-vantage uptime monitor (DNS + HTTPS probes, JSON Lines storage).";
    mainProgram = "yggdrasil-monitor-server";
  };
}
