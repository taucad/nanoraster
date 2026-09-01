import { describe, expect, it } from 'vitest';
import type {
  RenderImageOptions,
  RenderImagesOptions,
  RenderOrbit,
  RenderSectionPlane,
  RenderVector3,
  RenderWorld,
  RenderWorldAxis,
} from '#options.js';
import {
  imageFileName,
  imageViewFileName,
  renderDirectionFromOrbit,
  renderOrbitFromDirection,
  toImageRequestJson,
  toImagesRequestJson,
} from '#options.js';

const parse = (json: string): Record<string, unknown> => JSON.parse(json) as Record<string, unknown>;

describe('image request serialization', () => {
  it('should omit undefined fields and serialize disabled annotations', () => {
    expect(parse(toImageRequestJson({ format: 'webp', axes: false, scaleBar: false }))).toEqual({
      format: 'webp',
      axes: false,
      scaleBar: false,
    });
  });

  it('should serialize every singular option and normalize a hex background', () => {
    const options: RenderImageOptions = {
      format: 'jpeg',
      width: 1920,
      height: 1080,
      quality: 0.8,
      camera: {
        framing: 'fixed',
        position: [4, 3, 2],
        target: [1, 0, -1],
        up: [0, 0, 1],
        projection: { kind: 'orthographic', verticalSpan: 12, zoom: 1.5 },
        clipping: { near: 0.1, far: 100 },
      },
      lineWidth: 1.25,
      surfaces: false,
      lines: true,
      visiblePrimitives: [{ nodeIndex: 2, meshIndex: 1, primitiveIndex: 0 }],
      sections: {
        planes: [{ point: [0, 0, 0], normal: [1, 0, 0] }],
        clipLines: false,
      },
      background: '#FF800040',
      label: 'Front',
      axes: true,
      scaleBar: true,
    };

    expect(parse(toImageRequestJson(options))).toEqual({
      format: 'jpeg',
      width: 1920,
      height: 1080,
      quality: 0.8,
      camera: {
        framing: 'fixed',
        position: [4, 3, 2],
        target: [1, 0, -1],
        up: [0, 0, 1],
        projection: { kind: 'orthographic', verticalSpan: 12, zoom: 1.5 },
        clipping: { near: 0.1, far: 100 },
      },
      lineWidth: 1.25,
      surfaces: false,
      lines: true,
      visiblePrimitives: [{ nodeIndex: 2, meshIndex: 1, primitiveIndex: 0 }],
      sections: {
        planes: [{ point: [0, 0, 0], normal: [1, 0, 0] }],
        clipLines: false,
      },
      background: [1, 128 / 255, 0, 64 / 255],
      label: 'Front',
      axes: true,
      scaleBar: true,
    });
  });

  it('should validate and serialize one shared caller world', () => {
    const world = { up: '+z', forward: '-y', unit: 'millimeter' } as const;
    expect(parse(toImageRequestJson({ format: 'png', world }))).toEqual({ format: 'png', world });
    expect(parse(toImagesRequestJson({ format: 'png', world, views: [{ id: 'front' }] }))).toEqual({
      format: 'png',
      world,
      views: [{ id: 'front' }],
    });

    for (const frame of [
      { up: '+x', forward: '+y' },
      { up: '-x', forward: '+z' },
      { up: '+z', forward: '-y' },
      { up: '-z', forward: '+y' },
    ] as const) {
      expect(parse(toImageRequestJson({ format: 'png', world: frame }))).toMatchObject({ world: frame });
    }
  });

  // render-core derives the caller's right as `up × forward`, which makes
  // `(right, up, forward)` right-handed for every non-collinear pair, so it
  // accepts all 24 of them. The TS mirror once rejected half of them as
  // "left-handed"; a request valid on one side has to be valid on both.
  it('should accept every one of the 24 non-collinear signed axis pairs', () => {
    const axes = ['+x', '-x', '+y', '-y', '+z', '-z'] as const;
    const pairs = axes.flatMap((up) =>
      axes.filter((forward) => forward.slice(1) !== up.slice(1)).map((forward) => ({ up, forward })),
    );
    expect(pairs).toHaveLength(24);
    for (const world of pairs) {
      expect(parse(toImageRequestJson({ format: 'png', world }))).toMatchObject({ world });
    }
    // Divergence D2: the exact pair the TS mirror used to reject on its own.
    expect(pairs).toContainEqual({ up: '+z', forward: '+y' });
    // A world may also declare only its unit, leaving both axes at the glTF
    // defaults — that is the pair supplied together, as neither.
    expect(parse(toImageRequestJson({ format: 'png', world: { unit: 'millimeter' } }))).toMatchObject({
      world: { unit: 'millimeter' },
    });
  });

  it('should reject invalid, half-declared, and per-view worlds', () => {
    const invalid: readonly (readonly [unknown, string])[] = [
      [null, 'world must be an object'],
      [{ north: '+z' }, 'world contains unknown property "north"'],
      [{ up: 'z' }, 'world.up must be +x or -x or +y or -y or +z or -z'],
      [{ up: null }, 'world.up must be +x or -x or +y or -y or +z or -z'],
      [{ forward: null }, 'world.forward must be +x or -x or +y or -y or +z or -z'],
      [{ forward: '+x', unit: 'inch' }, 'world.unit must be meter or millimeter'],
      // Divergence D1: render-core requires the pair together, so a lone axis
      // is the pair error, not a same-axis or handedness complaint.
      [{ up: '+z' }, 'world.up and world.forward must be provided together'],
      [{ up: '-x' }, 'world.up and world.forward must be provided together'],
      [{ forward: '+x' }, 'world.up and world.forward must be provided together'],
      [{ up: '+z', forward: '-z' }, 'world.up and world.forward must name different axes'],
    ];
    for (const [world, message] of invalid) {
      expect(() => toImageRequestJson({ format: 'png', world } as unknown as RenderImageOptions)).toThrow(
        message,
      );
    }
    expect(() =>
      toImagesRequestJson({
        format: 'png',
        views: [{ id: 'front', world: { up: '+y', forward: '+z' } }],
      } as unknown as RenderImagesOptions),
    ).toThrow('views[0].world is not allowed; world is shared by every view');
  });

  it('should reject invalid presentation state at its exact path', () => {
    const invalid: readonly (readonly [Record<string, unknown>, string])[] = [
      [{ surfaces: 'yes' }, 'surfaces must be a boolean'],
      [{ lines: 1 }, 'lines must be a boolean'],
      [{ visiblePrimitives: {} }, 'visiblePrimitives must be an array'],
      [{ visiblePrimitives: [null] }, 'visiblePrimitives[0] must be an object'],
      [
        { visiblePrimitives: [{ nodeIndex: 0, meshIndex: 0, primitiveIndex: -1 }] },
        'visiblePrimitives[0] indices must be non-negative safe integers',
      ],
      [
        {
          visiblePrimitives: [
            { nodeIndex: 0, meshIndex: 0, primitiveIndex: 0 },
            { nodeIndex: 0, meshIndex: 0, primitiveIndex: 0 },
          ],
        },
        'visiblePrimitives[1] duplicates an earlier primitive reference',
      ],
      [{ sections: null }, 'sections must be an object'],
      [{ sections: { planes: [] } }, 'sections.planes must contain between 1 and 8 planes'],
      [{ sections: { planes: [null] } }, 'sections.planes[0] must be an object'],
      [
        { sections: { planes: Array.from({ length: 9 }, () => ({ point: [0, 0, 0], normal: [1, 0, 0] })) } },
        'sections.planes must contain between 1 and 8 planes',
      ],
      [
        { sections: { planes: [{ point: [0, 0, 0], normal: [0, 0, 0] }] } },
        'sections.planes[0].normal must not be zero length',
      ],
      [
        { sections: { planes: [{ point: [0, 0, Number.NaN], normal: [1, 0, 0] }] } },
        'sections.planes[0].point must contain three finite numbers',
      ],
      [
        { sections: { planes: [{ point: [0, 0, 0], normal: [1, 0, 0] }], clipSurfaces: 'yes' } },
        'sections.clipSurfaces must be a boolean',
      ],
    ];
    for (const [presentation, message] of invalid) {
      expect(() => toImageRequestJson({ format: 'png', ...presentation })).toThrow(message);
    }
  });

  it('should serialize ordered plural views and shared settings', () => {
    expect(
      parse(
        toImagesRequestJson({
          format: 'png',
          views: [
            {
              id: 'front',
              label: 'Front',
              camera: {
                framing: 'fit',
                direction: [0, 0, 1],
                up: [0, 1, 0],
                projection: { kind: 'orthographic' },
              },
            },
            { id: 'top', label: 'Top' },
          ],
        }),
      ),
    ).toEqual({
      format: 'png',
      views: [
        {
          id: 'front',
          label: 'Front',
          camera: {
            framing: 'fit',
            direction: [0, 0, 1],
            up: [0, 1, 0],
            projection: { kind: 'orthographic' },
          },
        },
        { id: 'top', label: 'Top' },
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
      { format: 'png', lineWidth: 0.2 },
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
      { format: 'png', axes: 'yes' },
      { format: 'png', scaleBar: 'yes' },
      { format: 'png', scaleBar: true, width: 191 },
      { format: 'png', label: 1 },
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
      [{ id: 1 }],
      [{ id: '../front' }],
      [{ id: 'front' }, { id: 'front' }],
      [{ id: 'front', zoom: 2 }],
      [{ id: 'front', camera: { framing: 'fit', direction: [0, 0, 0] } }],
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

  it('should serialize every fitted and fixed camera projection arm', () => {
    const cameras = [
      {
        framing: 'fit',
        direction: [1, -1, 1],
        up: [0, 0, 1],
        margin: 0.2,
        projection: { kind: 'perspective', verticalFieldOfView: 60 },
      },
      {
        framing: 'fit',
        projection: { kind: 'orthographic' },
      },
      {
        framing: 'fixed',
        position: [4, 3, 2],
        target: [1, 0, -1],
        up: [0, 0, 1],
        projection: { kind: 'perspective', verticalFieldOfView: 35, zoom: 2 },
        clipping: { near: 0.05, far: 500 },
      },
      {
        framing: 'fixed',
        position: [0, 0, 10],
        target: [0, 0, 0],
        up: [0, 1, 0],
        projection: { kind: 'orthographic', verticalSpan: 20 },
      },
    ] as const;

    for (const camera of cameras) {
      expect(parse(toImageRequestJson({ format: 'png', camera }))['camera']).toEqual(camera);
    }
  });

  it('should reject invalid cameras with a precise nested path', () => {
    const invalid: readonly (readonly [unknown, string])[] = [
      [null, 'camera must be an object'],
      [{}, 'camera.framing must be fit or fixed'],
      [{ framing: 'orbit' }, 'camera.framing must be fit or fixed'],
      [{ framing: 'fit', direction: [0, 0, 0] }, 'camera.direction must not be zero length'],
      [
        { framing: 'fit', direction: [0, 1, 0], up: [0, 2, 0] },
        'camera.direction and camera.up must not be collinear',
      ],
      [
        { framing: 'fit', projection: { kind: 'perspective', zoom: 2 } },
        'camera.projection contains unknown property "zoom"',
      ],
      [
        { framing: 'fit', projection: { kind: 'panoramic' } },
        'camera.projection.kind must be perspective or orthographic',
      ],
      [{ framing: 'fit', projection: 'perspective' }, 'camera.projection must be an object'],
      [
        { framing: 'fixed', position: [0, 0, 0], target: [0, 0, 0], up: [0, 1, 0] },
        'camera.position and camera.target must not coincide',
      ],
      [
        { framing: 'fixed', position: [0, 0, 1], target: [0, 0, 0], up: [0, 0, 1] },
        'camera.view direction and camera.up must not be collinear',
      ],
      [
        {
          framing: 'fixed',
          position: [0, 0, 1],
          target: [0, 0, 0],
          up: [0, 1, 0],
          projection: { kind: 'perspective', verticalFieldOfView: 180 },
        },
        'camera.projection.verticalFieldOfView must be between 1 and 179',
      ],
      [
        {
          framing: 'fixed',
          position: [0, 0, 1],
          target: [0, 0, 0],
          up: [0, 1, 0],
          projection: { kind: 'orthographic' },
        },
        'camera.projection.verticalSpan must be a finite number',
      ],
      [
        {
          framing: 'fixed',
          position: [0, 0, 1],
          target: [0, 0, 0],
          up: [0, 1, 0],
          projection: { kind: 'orthographic', verticalSpan: 0 },
        },
        'camera.projection.verticalSpan must be greater than 0',
      ],
      [
        {
          framing: 'fixed',
          position: [0, 0, 1],
          target: [0, 0, 0],
          up: [0, 1, 0],
          clipping: { near: 1, far: 1 },
        },
        'camera.clipping.far must be greater than camera.clipping.near',
      ],
      [
        {
          framing: 'fixed',
          position: [0, 0, 1],
          target: [0, 0, 0],
          up: [0, 1, 0],
          clipping: null,
        },
        'camera.clipping must be an object',
      ],
      [
        {
          framing: 'fixed',
          position: [0, 0, 1],
          target: [0, 0, 0],
          up: [0, 1, 0],
          clipping: { near: 0, far: 1 },
        },
        'camera.clipping.near must be greater than 0',
      ],
    ];
    for (const [camera, message] of invalid) {
      expect(() => toImageRequestJson({ format: 'png', camera } as unknown as RenderImageOptions)).toThrow(
        message,
      );
    }
  });

  // render-core resolves an omitted fit `up` to `world.caller_up`. The TS
  // precheck once defaulted it to the glTF `[0, 1, 0]`, so under any other
  // world it disagreed with the authority in both directions.
  it('should default an omitted fit up to the declared world up', () => {
    const world = { up: '+z', forward: '-y' } as const;
    const collinear = 'camera.direction and camera.up must not be collinear';
    const request = (camera: unknown): string =>
      toImageRequestJson({ format: 'png', world, camera } as unknown as RenderImageOptions);

    // [0, 1, 0] is collinear with the old glTF-basis default but not with this
    // world's up, so render-core accepts it and the mirror must too.
    expect(parse(request({ framing: 'fit', direction: [0, 1, 0] }))).toMatchObject({ world });
    // A direction along the declared up is what render-core rejects instead.
    expect(() => request({ framing: 'fit', direction: [0, 0, 2] })).toThrow(collinear);
    // The glTF world keeps its historic default.
    expect(() =>
      toImageRequestJson({ format: 'png', camera: { framing: 'fit', direction: [0, 1, 0] } }),
    ).toThrow(collinear);

    // Views share the request world, so their cameras resolve in it too.
    expect(() =>
      toImagesRequestJson({
        format: 'png',
        world,
        views: [{ id: 'top', camera: { framing: 'fit', direction: [0, 0, 1] } }],
      } as unknown as RenderImagesOptions),
    ).toThrow('views[0].camera.direction and views[0].camera.up must not be collinear');
  });

  it('should name the replacement for removed angle and axis fields', () => {
    for (const removed of ['phi', 'theta', 'up', 'projection', 'margin']) {
      expect(() =>
        toImageRequestJson({ format: 'png', [removed]: 1 } as unknown as RenderImageOptions),
      ).toThrow(`options.${removed} was removed; use options.camera`);
      expect(() =>
        toImagesRequestJson({
          format: 'png',
          views: [{ id: 'front', [removed]: 1 }],
        } as unknown as RenderImagesOptions),
      ).toThrow(`views[0].${removed} was removed; use views[0].camera`);
    }
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

  it('should serialize the studio preset and omit lighting when it is absent', () => {
    expect(parse(toImageRequestJson({ format: 'png', lighting: 'studio' }))).toEqual({
      format: 'png',
      lighting: 'studio',
    });
    expect(parse(toImageRequestJson({ format: 'png' }))).toEqual({ format: 'png' });
  });

  it('should serialize a rig verbatim and drop its unset fields', () => {
    expect(
      parse(
        toImagesRequestJson({
          format: 'png',
          lighting: {
            lights: [
              { direction: [-0.45, 0.61, 0.63], color: [2.09, 2.09, 2.09] },
              { direction: [0.45, -0.61, -0.63], color: [1.45, 1.42, 1.38] },
            ],
            ambient: 0,
            environment: 'none',
            space: 'world',
            exposure: 0.01,
          },
          views: [{ id: 'front' }],
        }),
      )['lighting'],
    ).toEqual({
      lights: [
        { direction: [-0.45, 0.61, 0.63], color: [2.09, 2.09, 2.09] },
        { direction: [0.45, -0.61, -0.63], color: [1.45, 1.42, 1.38] },
      ],
      ambient: 0,
      environment: 'none',
      space: 'world',
      exposure: 0.01,
    });
    expect(parse(toImageRequestJson({ format: 'png', lighting: { lights: [] } }))['lighting']).toEqual({
      lights: [],
    });
  });

  it('should reject invalid lighting with a precise path', () => {
    const light = { direction: [0, 1, 0], color: [1, 1, 1] } as const;
    const invalid: readonly (readonly [unknown, string])[] = [
      ['sunset', 'lighting must be studio or a rig object'],
      [42, 'lighting must be studio or a rig object'],
      [{ lights: [], glow: 1 }, 'lighting contains unknown property "glow"'],
      [{}, 'lighting.lights must be an array'],
      [{ lights: Array.from({ length: 9 }, () => light) }, 'lighting.lights must contain at most 8 lights'],
      [{ lights: [null] }, 'lighting.lights[0] must be an object'],
      [{ lights: [{ ...light, intensity: 2 }] }, 'lighting.lights[0] contains unknown property "intensity"'],
      [
        { lights: [{ ...light, direction: 'up' }] },
        'lighting.lights[0].direction must contain three finite numbers',
      ],
      [
        { lights: [{ ...light, direction: [0, 1] }] },
        'lighting.lights[0].direction must contain three finite numbers',
      ],
      [
        { lights: [{ ...light, direction: [0, 1, 'z'] }] },
        'lighting.lights[0].direction must contain three finite numbers',
      ],
      [
        { lights: [{ ...light, direction: [0, Number.NaN, 1] }] },
        'lighting.lights[0].direction must contain three finite numbers',
      ],
      [
        { lights: [{ ...light, direction: [0, 0, 0] }] },
        'lighting.lights[0].direction must not be zero length',
      ],
      [
        { lights: [light, { ...light, color: [1, 1] }] },
        'lighting.lights[1].color must contain three channels between 0 and 32',
      ],
      [
        { lights: [{ ...light, color: [-1, 1, 1] }] },
        'lighting.lights[0].color must contain three channels between 0 and 32',
      ],
      [
        { lights: [{ ...light, color: [1, 33, 1] }] },
        'lighting.lights[0].color must contain three channels between 0 and 32',
      ],
      [{ lights: [], ambient: 4.1 }, 'lighting.ambient must be between 0 and 4'],
      [{ lights: [], ambient: 'dim' }, 'lighting.ambient must be a finite number'],
      [{ lights: [], exposure: 0 }, 'lighting.exposure must be between 0.01 and 16'],
      [{ lights: [], environment: 'sunset' }, 'lighting.environment must be studio or none'],
      [{ lights: [], space: 'screen' }, 'lighting.space must be view or world'],
    ];
    for (const [lighting, message] of invalid) {
      const options = { format: 'png', lighting } as unknown as RenderImageOptions;
      expect(() => toImageRequestJson(options)).toThrow(TypeError);
      expect(() => toImageRequestJson(options)).toThrow(message);
    }
  });

  it('should serialize per-view output overrides and the timings flag', () => {
    expect(
      parse(
        toImagesRequestJson({
          format: 'webp',
          quality: 0.9,
          lineWidth: 0.75,
          timings: true,
          views: [
            { id: 'card' },
            { id: 'og', width: 1536, height: 804 },
            { id: 'hero', format: 'png' },
            { id: 'exact', quality: 1 },
          ],
        }),
      ),
    ).toEqual({
      format: 'webp',
      quality: 0.9,
      lineWidth: 0.75,
      timings: true,
      views: [
        { id: 'card' },
        { id: 'og', width: 1536, height: 804 },
        { id: 'hero', format: 'png' },
        { id: 'exact', quality: 1 },
      ],
    });
  });

  it('should reject invalid per-view overrides and timings values by path', () => {
    const cases: readonly (readonly [Record<string, unknown>, string])[] = [
      [{ id: 'front', width: 15 }, 'views[0].width must be between 16 and 4096'],
      [{ id: 'front', height: 4097 }, 'views[0].height must be between 16 and 4096'],
      [{ id: 'front', format: 'gif' }, 'views[0].format must be png, webp, jpeg, jpg, or raw'],
      [{ id: 'front', quality: 1.5 }, 'views[0].quality must be between 0 and 1'],
    ];
    for (const [view, message] of cases) {
      expect(() =>
        toImagesRequestJson({ format: 'png', views: [view] } as unknown as RenderImagesOptions),
      ).toThrow(message);
    }
    expect(() =>
      toImagesRequestJson({
        format: 'png',
        axes: true,
        views: [{ id: 'front', width: 191 }],
      } as unknown as RenderImagesOptions),
    ).toThrow('views[0]: annotated images must be at least 192x192');
    expect(() =>
      toImagesRequestJson({
        format: 'png',
        timings: 'yes',
        views: [{ id: 'front' }],
      } as unknown as RenderImagesOptions),
    ).toThrow('timings must be a boolean');
    expect(() =>
      toImagesRequestJson({
        format: 'png',
        profile: true,
        views: [{ id: 'front' }],
      } as unknown as RenderImagesOptions),
    ).toThrow('options contains unknown property "profile"');
  });

  it('should judge annotated dimensions per view, not against the shared pair', () => {
    // The shared pair is a default for views that inherit it; a view that
    // overrides both is the size that gets rendered and annotated.
    expect(
      parse(
        toImagesRequestJson({
          format: 'png',
          axes: true,
          width: 128,
          height: 128,
          views: [{ id: 'front', width: 512, height: 512 }],
        }),
      )['width'],
    ).toBe(128);
    // A view that inherits the small shared pair still fails on its own size.
    expect(() =>
      toImagesRequestJson({
        format: 'png',
        axes: true,
        width: 128,
        height: 128,
        views: [{ id: 'front' }],
      }),
    ).toThrow('views[0]: annotated images must be at least 192x192');
  });

  it('should carry the raised section-plane limit of eight', () => {
    const planes: readonly [RenderSectionPlane, ...RenderSectionPlane[]] = [
      { point: [0, 0, 0], normal: [1, 0, 0] },
      { point: [0, 0, 0], normal: [-1, 0, 0] },
      { point: [0, 0, 0], normal: [0, 1, 0] },
      { point: [0, 0, 0], normal: [0, -1, 0] },
      { point: [0, 0, 0], normal: [0, 0, 1] },
      { point: [0, 0, 0], normal: [0, 0, -1] },
      { point: [1, 1, 1], normal: [1, 1, 1] },
      { point: [-1, -1, -1], normal: [-1, -1, -1] },
    ];
    expect(parse(toImageRequestJson({ format: 'png', sections: { planes } }))['sections']).toEqual({
      planes,
    });
  });

  it('should serialize a raw request and a raw per-view override', () => {
    expect(parse(toImageRequestJson({ format: 'raw', width: 640, height: 480 }))).toEqual({
      format: 'raw',
      width: 640,
      height: 480,
    });
    expect(
      parse(
        toImagesRequestJson({
          format: 'webp',
          views: [{ id: 'thumb' }, { id: 'frame', format: 'raw' }],
        }),
      )['views'],
    ).toEqual([{ id: 'thumb' }, { id: 'frame', format: 'raw' }]);
  });
});

describe('label presence as the annotation switch', () => {
  it('should draw a label from its presence alone', () => {
    expect(parse(toImageRequestJson({ format: 'png', label: 'gear' }))).toEqual({
      format: 'png',
      label: 'gear',
    });
    expect(() => toImageRequestJson({ format: 'png', label: 'gear', width: 191 })).toThrow(
      'annotated images must be at least 192x192',
    );
    expect(() =>
      toImagesRequestJson({
        format: 'png',
        views: [{ id: 'front', label: 'Front', width: 191 }],
      }),
    ).toThrow('views[0]: annotated images must be at least 192x192');
  });

  it('should leave an unlabelled view unannotated beside a labelled one', () => {
    expect(
      parse(
        toImagesRequestJson({
          format: 'png',
          views: [
            { id: 'front', label: 'Front' },
            { id: 'thumb', width: 64, height: 64 },
          ],
        }),
      )['views'],
    ).toEqual([
      { id: 'front', label: 'Front' },
      { id: 'thumb', width: 64, height: 64 },
    ]);
  });
});

// An independent oracle for the basis the helpers are supposed to build, so
// the property tests below are not checking the implementation against itself.
const axisVector = (axis: RenderWorldAxis): RenderVector3 => {
  const sign = axis.startsWith('+') ? 1 : -1;
  return [axis.endsWith('x') ? sign : 0, axis.endsWith('y') ? sign : 0, axis.endsWith('z') ? sign : 0];
};

const signedAxes: readonly RenderWorldAxis[] = ['+x', '-x', '+y', '-y', '+z', '-z'];

const legalWorlds: readonly Required<Pick<RenderWorld, 'up' | 'forward'>>[] = signedAxes.flatMap((up) =>
  signedAxes.filter((forward) => forward.slice(1) !== up.slice(1)).map((forward) => ({ up, forward })),
);

const expectVectorClose = (actual: RenderVector3, expected: RenderVector3): void => {
  for (const [index, component] of expected.entries()) {
    expect(actual[index]).toBeCloseTo(component, 9);
  }
};

describe('orbit angle conversion', () => {
  it('should place azimuth zero on world.forward and turn toward the caller right', () => {
    for (const world of legalWorlds) {
      const forward = axisVector(world.forward);
      const up = axisVector(world.up);
      const right: RenderVector3 = [
        up[1] * forward[2] - up[2] * forward[1],
        up[2] * forward[0] - up[0] * forward[2],
        up[0] * forward[1] - up[1] * forward[0],
      ];
      expectVectorClose(renderDirectionFromOrbit({ azimuth: 0, elevation: 0 }, world), forward);
      expectVectorClose(renderDirectionFromOrbit({ azimuth: 90, elevation: 0 }, world), right);
      expectVectorClose(renderDirectionFromOrbit({ azimuth: 0, elevation: 90 }, world), up);
    }
  });

  // The load-bearing property: every legal world, every angle off the poles.
  it('should round-trip every angle through all 24 legal worlds', () => {
    const azimuths = [-179.9, -135, -90, -45, -0.5, 0, 17.25, 45, 90, 135, 180];
    const elevations = [-89.5, -60, -30, -1, 0, 12.5, 30, 60, 89.5];
    for (const world of [undefined, ...legalWorlds]) {
      for (const azimuth of azimuths) {
        for (const elevation of elevations) {
          const orbit: RenderOrbit = { azimuth, elevation };
          const returned = renderOrbitFromDirection(renderDirectionFromOrbit(orbit, world), world);
          expect(returned.azimuth).toBeCloseTo(azimuth, 9);
          expect(returned.elevation).toBeCloseTo(elevation, 9);
        }
      }
    }
  });

  it('should default to the glTF world and reproduce the documented fit direction', () => {
    const direction = renderDirectionFromOrbit({ azimuth: 45, elevation: 30 });
    expectVectorClose(direction, [0.612_372_435_7, 0.5, 0.612_372_435_7]);
    expectVectorClose(direction, renderDirectionFromOrbit({ azimuth: 45, elevation: 30 }, { unit: 'meter' }));
    expect(renderOrbitFromDirection([0, 0, 1])).toEqual({ azimuth: 0, elevation: 0 });
    expect(renderOrbitFromDirection([1, 0, 0]).azimuth).toBeCloseTo(90, 9);
  });

  it('should report azimuth zero at either pole', () => {
    for (const world of legalWorlds) {
      const up = axisVector(world.up);
      const down: RenderVector3 = [-up[0], -up[1], -up[2]];
      const above = renderOrbitFromDirection(up, world);
      const below = renderOrbitFromDirection(down, world);
      // Exactly zero, not a negative zero left behind by `atan2`.
      expect(above.azimuth).toBe(0);
      expect(below.azimuth).toBe(0);
      expect(above.elevation).toBeCloseTo(90, 9);
      expect(below.elevation).toBeCloseTo(-90, 9);
    }
  });

  it('should normalize azimuth into the half-open -180 to 180 range', () => {
    // Opposite `world.forward` is the boundary: it reports 180, never -180.
    expect(renderOrbitFromDirection([0, 0, -1]).azimuth).toBeCloseTo(180, 9);
    expect(
      renderOrbitFromDirection(renderDirectionFromOrbit({ azimuth: 405, elevation: 0 })).azimuth,
    ).toBeCloseTo(45, 9);
    expect(
      renderOrbitFromDirection(renderDirectionFromOrbit({ azimuth: -270, elevation: 0 })).azimuth,
    ).toBeCloseTo(90, 9);
  });

  it('should ignore direction magnitude', () => {
    expect(renderOrbitFromDirection([0, 8, 8]).elevation).toBeCloseTo(45, 9);
    expect(renderOrbitFromDirection([0, 0.001, 0.001]).elevation).toBeCloseTo(45, 9);
  });

  it('should reject invalid orbits, directions, and worlds at their exact path', () => {
    const invalidOrbits: readonly (readonly [unknown, string])[] = [
      [null, 'orbit must be an object'],
      [[45, 30], 'orbit must be an object'],
      [{ azimuth: 0, elevation: 0, roll: 0 }, 'orbit contains unknown property "roll"'],
      [{ elevation: 0 }, 'orbit.azimuth must be a finite number'],
      [{ azimuth: Number.NaN, elevation: 0 }, 'orbit.azimuth must be a finite number'],
      [{ azimuth: 0 }, 'orbit.elevation must be a finite number'],
      [{ azimuth: 0, elevation: 90.1 }, 'orbit.elevation must be between -90 and 90'],
      [{ azimuth: 0, elevation: -90.1 }, 'orbit.elevation must be between -90 and 90'],
    ];
    for (const [orbit, message] of invalidOrbits) {
      expect(() => renderDirectionFromOrbit(orbit as RenderOrbit)).toThrow(TypeError);
      expect(() => renderDirectionFromOrbit(orbit as RenderOrbit)).toThrow(message);
    }

    const invalidDirections: readonly (readonly [unknown, string])[] = [
      [[0, 0, 0], 'direction must not be zero length'],
      [[0, 1], 'direction must contain three finite numbers'],
      ['up', 'direction must contain three finite numbers'],
      [[0, Number.NaN, 1], 'direction must contain three finite numbers'],
    ];
    for (const [direction, message] of invalidDirections) {
      expect(() => renderOrbitFromDirection(direction as RenderVector3)).toThrow(message);
    }

    // Both helpers validate the world by the same rule the request does.
    for (const world of [{ up: '-x' }, { up: '+z', forward: '+z' }, { north: '+z' }] as const) {
      expect(() => renderDirectionFromOrbit({ azimuth: 0, elevation: 0 }, world as RenderWorld)).toThrow(
        TypeError,
      );
      expect(() => renderOrbitFromDirection([0, 0, 1], world as RenderWorld)).toThrow(TypeError);
    }
  });
});

describe('image filenames', () => {
  it('should derive singular and identified names', () => {
    expect(imageFileName('webp')).toBe('render.webp');
    expect(imageViewFileName('front', 'png')).toBe('render-front.png');
  });

  it('should name raw output by the same rule', () => {
    expect(imageFileName('raw')).toBe('render.raw');
    expect(imageViewFileName('frame', 'raw')).toBe('render-frame.raw');
  });
});
