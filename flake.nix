{
  description = "pi-tava";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs?ref=nixos-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";

    # Keep Intel macOS on the last supported nixpkgs branch.
    nixpkgs-x86_64-darwin.url = "github:nixos/nixpkgs?ref=nixpkgs-26.05-darwin";
  };

  outputs =
    inputs@{ flake-parts, nixpkgs-x86_64-darwin, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      flake.nixosModules = rec {
        default = pi-tava;
        pi-tava = import ./nix/module.nix;
        pi-pocket = pi-tava;
      };

      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];

      perSystem =
        { pkgs, system, ... }:
        let
          pi-tava = pkgs.callPackage ./nix/package.nix { };
        in
        {
          _module.args.pkgs =
            if system == "x86_64-darwin" then
              import nixpkgs-x86_64-darwin { inherit system; }
            else
              import inputs.nixpkgs { inherit system; };

          packages = {
            default = pi-tava;
            inherit pi-tava;
            pi-pocket = pi-tava;
          };

          devShells.default = pkgs.mkShell {
            inputsFrom = [ pi-tava ];
            packages =
              with pkgs;
              [
                nodejs_24
                gitMinimal
                openssh
                ripgrep
                fd
                cloudflared
                nixfmt
              ]
              ++ pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux [ pkgs.chromium ];
          };

          checks = {
            default = pi-tava;
            extension-management = pkgs.runCommand "pi-tava-extension-management" { } ''
              ${pkgs.bash}/bin/bash ${./nix/tests/extensions.sh} ${./nix/manage-extensions.sh}
              touch "$out"
            '';
          };
          formatter = pkgs.nixfmt;
        };
    };
}
