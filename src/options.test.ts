import { describe, expect, it } from 'vitest';
import type { RenderImageOptions, RenderImagesOptions } from '#options.js';
import {
  createRenderImageOptions,
  createRenderImagesOptions,
  imageFileName,
  imageViewFileName,
  toImageRequestJson,
  toImagesRequestJson,
} from '#options.js';

const parse = (json: string): Record<string, unknown> => JSON.parse(json) as Record<string, unknown>;

describe('image request serialization', () => {
  it('should omit undefined fields and serialize disabled includes', () => {
    expect(
      parse(
        toImageRequestJson({ format: 'webp', includeAxes: false, includeLabel: false, includeScale: false }),
      ),
    ).toEqual({
      format: 'webp',
      includeAxes: false,
      includeLabel: false,
      includeScale: false,
    });
  });

  it('should serialize every singular option and normalize a hex background', () => {
    const options: RenderImageOptions = {
      format: 'jpeg',
      width: 1920,
      height: 1080,
      quality: 0.8,
      phi: 45,
      theta: 90,
      margin: 0.25,
      up: 'z',
      projection: 'orthographic',
      background: '#FF800040',
      label: 'Front',
      includeAxes: true,
      includeLabel: true,
      includeScale: true,
    };

    expect(parse(toImageRequestJson(options))).toEqual({
      format: 'jpeg',
      width: 1920,
      height: 1080,
      quality: 0.8,
      phi: 45,
      theta: 90,
      margin: 0.25,
      up: 'z',
      projection: 'orthographic',
      background: [1, 128 / 255, 0, 64 / 255],
      label: 'Front',
      includeAxes: true,
      includeLabel: true,
      includeScale: true,
    });
  });

  it('should serialize ordered plural views and shared settings', () => {
    expect(
      parse(
        toImagesRequestJson({
          format: 'png',
          projection: 'orthographic',
          includeLabel: true,
          views: [
            { id: 'front', label: 'Front', phi: 90, theta: 0 },
            { id: 'top', label: 'Top', phi: 0, theta: 0 },
          ],
        }),
      ),
    ).toEqual({
      format: 'png',
      projection: 'orthographic',
      includeLabel: true,
      views: [
        { id: 'front', label: 'Front', phi: 90, theta: 0 },
        { id: 'top', label: 'Top', phi: 0, theta: 0 },
      ],
    });
  });

  it('should reject invalid values and unknown keys', () => {
    const invalid: unknown[] = [
      null,
      [],
      { format: 'gif' },
      { format: 'png', width: 15 },
      { format: 'png', width: 4097 },
      { format: 'png', height: 4097 },
      { format: 'png', quality: -0.1 },
      { format: 'png', margin: 0.6 },
      { format: 'png', phi: Number.NaN },
      { format: 'png', theta: 'north' },
      { format: 'png', up: 'north' },
      { format: 'png', projection: 'parallel' },
      { format: 'png', background: '#fff' },
      { format: 'png', background: 0 },
      { format: 'png', background: [0, 0, 0] },
      { format: 'png', background: [0, 0, 0, '1'] },
      { format: 'png', background: [0, 0, 0, Number.NaN] },
      { format: 'png', background: [0, 0, 0, -0.1] },
      { format: 'png', background: [0, 0, 0, 1.1] },
      { format: 'png', includeAxes: 'yes' },
      { format: 'png', includeScale: 'yes' },
      { format: 'png', includeLabel: true },
      { format: 'png', includeScale: true, width: 191 },
      { format: 'png', label: ' ' },
      { format: 'png', label: 'x'.repeat(65) },
      { format: 'png', label: 'snowman ☃' },
      { format: 'png', extra: true },
    ];
    for (const options of invalid) {
      expect(() => toImageRequestJson(options as RenderImageOptions)).toThrow(TypeError);
    }
  });

  it('should reject invalid plural views', () => {
    const invalid = [
      null,
      [],
      [null],
      [{ id: 1, phi: 90, theta: 0 }],
      [{ id: '../front', phi: 90, theta: 0 }],
      [
        { id: 'front', phi: 90, theta: 0 },
        { id: 'front', phi: 0, theta: 0 },
      ],
      [{ id: 'front', phi: Number.POSITIVE_INFINITY, theta: 0 }],
      [{ id: 'front', phi: 90, theta: 0, format: 'png' }],
    ];
    for (const views of invalid) {
      expect(() => toImagesRequestJson({ format: 'png', views } as unknown as RenderImagesOptions)).toThrow(
        TypeError,
      );
    }
    expect(() => toImagesRequestJson(null as unknown as RenderImagesOptions)).toThrow(
      'options must be an object',
    );
  });

  it('should preserve tuple literals in the option helpers', () => {
    const singular = createRenderImageOptions({ format: 'png', width: 256 });
    const plural = createRenderImagesOptions({
      format: 'png',
      views: [{ id: 'front', phi: 90, theta: 0 }] as const,
    });

    expect(singular).toEqual({ format: 'png', width: 256 });
    expect(plural.views[0].id).toBe('front');
  });

  it('should normalize opaque hex and preserve tuple backgrounds', () => {
    expect(parse(toImageRequestJson({ format: 'png', background: '#0080FF' }))['background']).toEqual([
      0,
      128 / 255,
      1,
      1,
    ]);
    expect(parse(toImageRequestJson({ format: 'png', background: [0, 0.25, 0.5, 1] }))['background']).toEqual(
      [0, 0.25, 0.5, 1],
    );
  });

  it('should reject a missing batch label with a precise path', () => {
    expect(() =>
      toImagesRequestJson({
        format: 'png',
        includeLabel: true,
        views: [{ id: 'front', phi: 90, theta: 0 }],
      } as unknown as RenderImagesOptions),
    ).toThrow('views[0].label is required when includeLabel is true');
  });
});

describe('image filenames', () => {
  it('should derive singular and identified names', () => {
    expect(imageFileName('webp')).toBe('thumbnail.webp');
    expect(imageViewFileName('front', 'png')).toBe('thumbnail-front.png');
  });
});
