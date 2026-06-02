{
  description = "yggdrasil-monitor — external-vantage uptime monitor (DNS + HTTPS probes)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    systems.url = "github:nix-systems/default";
  };

  outputs = { self, nixpkgs, systems }:
    let
      eachSystem = f:
        nixpkgs.lib.genAttrs (import systems) (system:
          f { inherit system; pkgs = nixpkgs.legacyPackages.${system}; });
    in {
      packages = eachSystem ({ pkgs, ... }: {
        default = pkgs.callPackage ./nix/package.nix { };
      });
      nixosModules.default = { ... }: {
        imports = [ ./nix/nixos-module.nix ];
      };
    };
}
