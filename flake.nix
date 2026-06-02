{
  description = "yggdrasil-monitor — external-vantage uptime monitor (DNS + HTTPS probes)";

  inputs = {
    xnode-builders.url = "github:Openmesh-Network/xnode-builders";
    nixpkgs.follows = "xnode-builders/nixpkgs";
  };

  outputs =
    inputs:
    inputs.xnode-builders.language.auto {
      src = ./.;
      framework = "astro-node";
    };
}
