{ pkgs }: {
  deps = [
    pkgs.nodejs-18_x
    pkgs.chromium
    pkgs.glib
    pkgs.nss
    pkgs.nspr
    pkgs.atk
    pkgs.at-spi2-atk
    pkgs.cups
    pkgs.libdrm
    pkgs.dbus
    pkgs.libxkbcommon
    pkgs.mesa
    pkgs.xorg.libXcomposite
    pkgs.xorg.libXdamage
    pkgs.xorg.libXext
    pkgs.xorg.libXfixes
    pkgs.xorg.libXrandr
    pkgs.xorg.libX11
    pkgs.xorg.libxcb      # Fixes your libxcb.so.1 error
    pkgs.pango
    pkgs.cairo
    pkgs.expat
    pkgs.alsa-lib
  ];
  env = {
    LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath [
      pkgs.glib
      pkgs.nss
      pkgs.nspr
      pkgs.atk
      pkgs.at-spi2-atk
      pkgs.cups
      pkgs.libdrm
      pkgs.dbus
      pkgs.libxkbcommon
      pkgs.mesa
      pkgs.xorg.libXcomposite
      pkgs.xorg.libXdamage
      pkgs.xorg.libXext
      pkgs.xorg.libXfixes
      pkgs.xorg.libXrandr
      pkgs.xorg.libX11
      pkgs.xorg.libxcb
      pkgs.pango
      pkgs.cairo
      pkgs.expat
      pkgs.alsa-lib
    ];
  };
}