# Three.js physical-material oracle

These are actual Three.js 0.184.0 WebGL captures of Replicad BRep fixtures exported by
Tau's `ui:render-calibration-physical` target. `reference.json` retains the
camera, geometry and reference pixel hashes, room lighting and display
settings. AO, grids and authored edges are disabled to isolate materials.
The GLBs retain their native BRep line primitives for other comparisons.

Each matrix contains twelve radius-14 mm spheres. Columns use roughness
0.05, 0.25, 0.5 and 0.85; rows appear bottom to top:

- Metal: silver; copper; copper with anisotropy 0.8 at π/4 and clearcoat 0.7.
- Glass: IOR 1 / zero thickness; IOR 1.5 / 25 mm thickness; the same volume
  with green attenuation over 40 mm. A blue/grey unlit checkerboard is behind it.

Files are gzip-compressed GLB and raw RGBA8. Both oracles come from the
straight-alpha WebGL framebuffer, which matches its browser PNG byte-for-byte.
The native test verifies hashes and compares every material's sphere interior
separately. The gate is mean
absolute RGB error <2/255 per material, without exposure adjustment, image
registration or brightness masking. The three-pixel silhouette exclusion
isolates shading from differences between WebGL and wgpu 4× MSAA coverage.

To refresh: generate the catalog in Tau, select a fixture in the calibration
page, front orthographic camera / vertical span 0.141 m / DPR 1, then save PNG
and metadata. Export raw pixels without resizing using the existing Sharp
comparison decoder and gzip both files. A reference change must record its
new source and capture hashes; never regenerate reference pixels with Nano.
