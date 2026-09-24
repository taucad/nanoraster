# Neutral-room lighting assets

The default studio matches Tau's Three.js **r184** neutral-room profile.
Source identities and asset hashes are in `provenance.json`; attribution is in
`NOTICE`. All maps are initialized once per GPU device and released with it.

To reproduce from the Tau worktree:

1. Run the rendering calibration page with the **Neutral room** environment.
2. Click **Save lighting assets**. The page reads its live half-float PMREM,
   verifies equal RGB channels, and saves compressed little-endian R16 values.
3. Run `pnpm nx run ui:render-calibration-lighting -- --capture <saved.json> --output <directory>`.
4. Compare all asset hashes before replacing these files. The packer refuses
   changed upstream source fingerprints; a Three upgrade requires review.

The source capture has 512-pixel cube faces. The packed map retains its
256-pixel and coarser PMREM levels, including extra roughness levels down to
mip -2. R16 values are rounded to seven mantissa bits (three dropped bits),
then packed losslessly into a 384×1024 RGBA8 PNG. Decoding returns bytes for
a **768×1024 R16Float** texture; the PNG channels are byte storage, not colors.
This costs 290,487 embedded bytes and 1.5 MiB of GPU storage. No runtime
cubemap renders or filtering passes are required. Smooth reflections are
bounded by the 256-pixel source level; the material comparison tests measure
the resulting pixel error instead of claiming bit-exact parity.

`dfg.bin` retains the configured 16×16 RG16F lookup from r184. Its axes are
roughness and N·V. Both textures use bilinear clamp filtering.
