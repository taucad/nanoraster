import { expectTypeOf } from 'vitest';
import * as nodeModule from '#index.node.js';
import * as universalModule from '#index.js';

// The Node entry point is the universal surface with the addon installed
// behind it, so any name or signature that differs is a boundary defect
// rather than a feature of one environment.
expectTypeOf<keyof typeof nodeModule>().toEqualTypeOf<keyof typeof universalModule>();
expectTypeOf(nodeModule.renderImage).toEqualTypeOf<typeof universalModule.renderImage>();
expectTypeOf(nodeModule.renderImages).toEqualTypeOf<typeof universalModule.renderImages>();
expectTypeOf(nodeModule.createRenderer).toEqualTypeOf<typeof universalModule.createRenderer>();
expectTypeOf(nodeModule.describeAdapter).toEqualTypeOf<typeof universalModule.describeAdapter>();
expectTypeOf(nodeModule.RenderError).toEqualTypeOf<typeof universalModule.RenderError>();
expectTypeOf<nodeModule.RenderImageOptions>().toEqualTypeOf<universalModule.RenderImageOptions>();
expectTypeOf<nodeModule.RenderImagesOptions>().toEqualTypeOf<universalModule.RenderImagesOptions>();
expectTypeOf<nodeModule.RenderedImageFile>().toEqualTypeOf<universalModule.RenderedImageFile>();
expectTypeOf<nodeModule.AdapterInfo>().toEqualTypeOf<universalModule.AdapterInfo>();
expectTypeOf<nodeModule.Renderer>().toEqualTypeOf<universalModule.Renderer>();

// The negative control for the equality assertions above: a boundary that only
// widened types would satisfy every `toEqualTypeOf` and still accept nonsense.
// Rejection has to be proven through the Node entry point itself.
const glb = new Uint8Array([1, 2, 3]);
// @ts-expect-error unknown output format
void nodeModule.renderImage(glb, { format: 'gif' });
void nodeModule.renderImages(glb, {
  format: 'png',
  // @ts-expect-error unknown per-view output format
  views: [{ id: 'front', phi: 90, theta: 0, format: 'gif' }],
});
// @ts-expect-error missing required format
void ({ axes: true } as const satisfies nodeModule.RenderImageOptions);
