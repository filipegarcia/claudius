# build/appimage-runtime-x86_64

Statically-linked AppImage `type2-runtime` for x86_64, used by
`scripts/appimage-fuseless.mjs` to replace the runtime electron-builder embeds
(which dynamically links `libfuse.so.2`). Ubuntu 23.10+/24.04 ship libfuse3 and
dropped libfuse2 from the default install, so the stock runtime fails at launch
with `dlopen(): error loading libfuse.so.2`. This static runtime bundles its own
squashfuse and needs no system FUSE2 library.

Source: https://github.com/AppImage/type2-runtime — release asset
`runtime-x86_64` (static-pie ELF, ~944 KB). BuildID sha1
db3b55acc50bd9baa1ff659711ef9ab111d8f4bb.

To update: download a fresh `runtime-x86_64`, replace this file, and re-run the
release `linux-smoke` job to confirm the AppImage still launches without
libfuse2 on a stock Ubuntu runner.
