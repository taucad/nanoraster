import { describe, expect, it } from 'vitest';

import { falseColour } from './false-colour';

/**
 * The browser's own `ImageData` under Node: the constructor keeps the array it
 * is handed, which is the property the pass depends on — the clamping under
 * test is `Uint8ClampedArray`'s own, not a stand-in's.
 */
class FakeImageData {
  public constructor(
    public readonly data: Uint8ClampedArray,
    public readonly width: number,
    public readonly height: number,
  ) {}
}
globalThis.ImageData = FakeImageData as unknown as typeof ImageData;

/** Two pixels: black and white, opaque, plus a half-transparent grey. */
const frame = (): Uint8Array<ArrayBuffer> =>
  new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255, 128, 128, 128, 40]);

describe('falseColour', () => {
  it('maps luma through the ramp the example states', () => {
    const painted = falseColour({ rgba: frame(), width: 3, height: 1 });

    // Black sits at the ramp's foot: no red, no green, a little blue.
    expect(painted.data.slice(0, 3)).toEqual(new Uint8ClampedArray([0, 0, 25]));
    // White sits at its head, with green and blue clamped rather than bounded.
    expect(painted.data.slice(4, 7)).toEqual(new Uint8ClampedArray([255, 255, 0]));
    // Mid grey lands between the two ends, which is what a ramp is for.
    expect(painted.data.slice(8, 11)).toEqual(new Uint8ClampedArray([255, 77, 24]));
  });

  it('leaves alpha alone and paints the very bytes it was given', () => {
    const rgba = frame();
    const painted = falseColour({ rgba, width: 3, height: 1 });

    expect([painted.data[3], painted.data[7], painted.data[11]]).toEqual([255, 255, 40]);
    // No copy: the pass wrote through the renderer's own buffer.
    expect(painted.data.buffer).toBe(rgba.buffer);
    expect(rgba.slice(0, 3)).toEqual(new Uint8Array([0, 0, 25]));
  });
});
