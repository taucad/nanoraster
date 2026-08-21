import type { WasmPixels } from './wasm-renderer';

/**
 * The false-colour pass the raw-pixels example states, run on the bytes the
 * renderer returned: an `ImageData` reads `rgba` in place — no copy, no
 * decode — then one loop maps each pixel's luma through a heat ramp over that
 * same memory. `Uint8ClampedArray` rounds and clamps, so the ramp needs no
 * bounds of its own, and alpha is left as the renderer wrote it.
 *
 * Kept identical to the fence beside it on the page, because the point of that
 * tile is that the picture came out of arithmetic on the array.
 */
export const falseColour = ({ rgba, width, height }: WasmPixels): ImageData => {
  const frame = new ImageData(new Uint8ClampedArray(rgba.buffer), width, height);
  const { data } = frame;

  for (let index = 0; index < data.length; index += 4) {
    const luma = (0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2]) / 255;
    data[index] = 255 * Math.min(1, luma * 2.4);
    data[index + 1] = 255 * (luma * 1.8 - 0.6);
    data[index + 2] = 255 * (0.7 - Math.abs(luma - 0.25) * 2.4);
  }

  return frame;
};
