/** Material-local shading and alpha error against captured WebGL pixels. */
export const materialErrors = (reference, actual, expected) => {
  const errors = [];
  // Compare each material separately, away from MSAA-dependent silhouette pixels.
  // No registration, exposure normalization, or brightness-based exclusions.
  const scale = reference.height / reference.camera.projection.verticalSpan;
  for (const row of reference.rows)
    for (const [column, roughness] of reference.roughness.entries()) {
      const cx = reference.width / 2 + (column * 0.038 - 0.057 - reference.camera.target[0]) * scale;
      const cy = reference.height / 2 - (row * 0.038 - reference.camera.target[2]) * scale;
      const radius = 0.014 * scale - 3;
      let total = 0;
      let count = 0;
      let alpha = 0;
      for (let y = Math.ceil(cy - radius); y < cy + radius; y++)
        for (let x = Math.ceil(cx - radius); x < cx + radius; x++) {
          if ((x - cx) ** 2 + (y - cy) ** 2 > radius ** 2) continue;
          alpha += Math.abs(
            actual[(y * reference.width + x) * 4 + 3] - expected[(y * reference.width + x) * 4 + 3],
          );
          for (let channel = 0; channel < 3; channel++) {
            const index = (y * reference.width + x) * 4 + channel;
            total += Math.abs(actual[index] - expected[index]);
            count++;
          }
        }
      errors.push({ row, roughness, mae: total / count, alphaMae: alpha / (count / 3) });
    }
  return errors;
};
