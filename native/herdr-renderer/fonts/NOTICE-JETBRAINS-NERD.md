# Bundled renderer font

`JetBrainsMonoNerdFontMono-Regular.ttf` is an **unmodified** face from Nerd Fonts
**v3.5.1**, JetBrains Mono **2.304**:

https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/JetBrainsMono.tar.xz

It was extracted offline from an already cached public release archive, not from
an installed font or a user's font settings.

- Release archive SHA-256: `04d5e8f903693f9dd13e16f867e994834e681eb3c72c0d337a770dcda09010cf`
- Face SHA-256: `f2a5ea6cfab397445ffab00c0370927b66d61e560a05db5db271b42006381c1a`
- Copyright: 2020 The JetBrains Mono Project Authors.
- License: SIL Open Font License 1.1, retained in `JetBrainsMonoNerdFont-OFL.txt`.
- The release's unmodified attribution and icon-set license table are retained in
  `JetBrainsMonoNerdFont-README.md`.

The `herdr-renderer-font` package embeds this face in WASM; GPUI startup and its
coverage tests use those same bytes. No browser-installed Nerd Font is required.
The regular Mono face supplies ordinary text, terminal symbols and Nerd private-use
icons. Existing GPUI browser fallback still handles eligible emoji and CJK; this
face does not claim universal Unicode or all-style coverage.
