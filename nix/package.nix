{ pkgs, lib, ... }:
pkgs.buildNpmPackage {
  pname = "yggdrasil-monitor";
  version = "0.1.0";
  src = ../astro-app;

  npmDeps = pkgs.importNpmLock {
    npmRoot = ../astro-app;
  };
  npmConfigHook = pkgs.importNpmLock.npmConfigHook;

  installPhase = ''
    runHook preInstall
    mkdir -p $out/{share/yggdrasil-monitor,bin}
    cp -rL dist          $out/share/yggdrasil-monitor/dist
    cp -rL node_modules  $out/share/yggdrasil-monitor/node_modules
    cp     package.json  $out/share/yggdrasil-monitor/package.json
    makeWrapper ${pkgs.nodejs_22}/bin/node $out/bin/yggdrasil-monitor \
      --add-flags "$out/share/yggdrasil-monitor/dist/server/entry.mjs" \
      --set-default PORT 3000 \
      --set-default HOST 0.0.0.0
    runHook postInstall
  '';

  doDist = false;
  meta.mainProgram = "yggdrasil-monitor";
}
