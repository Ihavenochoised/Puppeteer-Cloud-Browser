{ pkgs }:

{
    deps = [
      pkgs.psmisc
        pkgs.zip
        pkgs.nodejs_20
        pkgs.chromium
        pkgs.noto-fonts-cjk-sans
    ];
}