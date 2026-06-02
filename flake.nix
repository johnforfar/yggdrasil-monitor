{
  description = "yggdrasil-monitor — external-vantage uptime monitor for the buildooors / openxai / openmesh fleet";

  inputs = {
    xnodeos.url = "github:Openmesh-Network/xnodeos/v1";
    nixpkgs.follows = "xnodeos/nixpkgs";
  };

  outputs = inputs: {
    packages.x86_64-linux.default =
      inputs.nixpkgs.legacyPackages.x86_64-linux.callPackage ./nix/package.nix { };

    nixosModules.default =
      { pkgs, ... }:
      {
        imports = [
          inputs.xnodeos.nixosModules.app
          ./nix/nixos-module.nix
        ];
      };
  };
}
