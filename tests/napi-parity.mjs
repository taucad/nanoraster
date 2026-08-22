// S2 smoke test: load the napi addon, render the gear fixture on the native
// GPU (Metal locally; lavapipe/WARP in CI), and assert the PNG shape.
// The addon arrives through the NAPI-RS generated loader that `build:napi`
// writes beside the host binary, which is what a consumer resolves too.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The façade is imported for exactly one section: the concurrent visual
// ladder, which exists to exercise its shared one-shot renderer. Everything
// else here calls the addon directly, on purpose.
import { renderImage } from '#index.node.js';

import { withPbrFactors } from './pbr-fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const native =
  /**
   * @type {{
   *   renderImage: (glb: Buffer, optionsJson: string) => Promise<Buffer>,
   *   renderImages: (glb: Buffer, optionsJson: string) => Promise<{ images: Buffer[], timings?: string }>,
   *   createRenderer: (optionsJson?: string) => Promise<{
   *     renderImage: (glb: Buffer, optionsJson: string) => Promise<Buffer>,
   *     renderImages: (glb: Buffer, optionsJson: string) => Promise<{ images: Buffer[], timings?: string }>,
   *     dispose: () => void,
   *   }>,
   *   describeAdapter: (optionsJson?: string) => Promise<string | null>,
   * }}
   */ (await import('../src/native/index.js'));

// The benchmark surface is behind the default-off `bench` cargo feature, so the
// addon this suite loads — the one `npm pack` ships — must not carry it.
for (const gated of ['benchCodecs', 'benchMultiView', 'codecConformance']) {
  if (gated in native) throw new Error(`published addon exports the gated ${gated}`);
}

// The FFI hands the adapter over as JSON, or null where the host has none; the
// TS façade parses the same bytes.
const described = await native.describeAdapter();
const adapter = described === null ? null : JSON.parse(described);
console.log('adapter:', adapter);
if (adapter !== null) {
  if (!['metal', 'vulkan', 'dx12', 'webgpu'].includes(adapter.backend))
    throw new Error(`unexpected adapter backend: ${adapter.backend}`);
  if (typeof adapter.name !== 'string') throw new Error('adapter name is not a string');
  if (!['discrete-gpu', 'integrated-gpu', 'virtual-gpu', 'cpu', 'unknown'].includes(adapter.deviceType))
    throw new Error(`unexpected adapter device type: ${adapter.deviceType}`);
}
const lowPower = await native.describeAdapter(JSON.stringify({ powerPreference: 'low-power' }));
console.log('low-power adapter:', lowPower === null ? null : JSON.parse(lowPower));

const glb = readFileSync(join(here, 'fixtures', 'gear-12.glb'));
const interleavedGlb = readFileSync(join(here, 'fixtures', 'interleaved-instanced-lines.glb'));
const started = Date.now();
const png = await native.renderImage(glb, JSON.stringify({ width: 768, height: 432, format: 'png' }));
console.log(`rendered in ${Date.now() - started}ms, ${png.length} bytes`);

if (!(png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47)) {
  throw new Error('output is not a PNG');
}
const width = png.readUInt32BE(16);
const height = png.readUInt32BE(20);
if (width !== 768 || height !== 432) {
  throw new Error(`expected 768x432, got ${width}x${height}`);
}
const pbrOptions = JSON.stringify({ width: 192, height: 192, format: 'png' });
const matteGlb = Buffer.from(withPbrFactors(glb, { metallic: 0, roughness: 0.85 }));
const metalGlb = Buffer.from(withPbrFactors(glb, { metallic: 1, roughness: 0.05 }));
const matteFirst = await native.renderImage(matteGlb, pbrOptions);
const matteSecond = await native.renderImage(matteGlb, pbrOptions);
const metalFirst = await native.renderImage(metalGlb, pbrOptions);
const metalSecond = await native.renderImage(metalGlb, pbrOptions);
if (!matteFirst.equals(matteSecond) || !metalFirst.equals(metalSecond)) {
  throw new Error('repeated PBR renders differ');
}
if (matteFirst.equals(metalFirst)) {
  throw new Error('metallic and rough dielectric PBR renders are identical');
}
const interleavedPng = await native.renderImage(
  interleavedGlb,
  JSON.stringify({ width: 768, height: 576, format: 'png' }),
);
if (
  !(interleavedPng[0] === 0x89 && interleavedPng[1] === 0x50) ||
  interleavedPng.readUInt32BE(16) !== 768 ||
  interleavedPng.readUInt32BE(20) !== 576
) {
  throw new Error('interleaved/instanced fixture did not produce a 768x576 PNG');
}
const webp = await native.renderImage(glb, JSON.stringify({ width: 768, height: 432, format: 'webp' }));
if (webp.toString('latin1', 0, 4) !== 'RIFF' || webp.toString('latin1', 8, 12) !== 'WEBP') {
  throw new Error('webp output is not a WebP');
}

const jpeg = await native.renderImage(
  glb,
  JSON.stringify({ width: 768, height: 432, format: 'jpeg', quality: 0.85, background: [1, 1, 1, 1] }),
);
if (!(jpeg[0] === 0xff && jpeg[1] === 0xd8)) {
  throw new Error('jpeg output is not a JPEG');
}

// The taxonomy contract: jpeg on a transparent background must refuse.
let transparentJpegError = '';
try {
  await native.renderImage(glb, JSON.stringify({ width: 768, height: 432, format: 'jpeg' }));
} catch (error) {
  transparentJpegError = String(error instanceof Error ? error.message : error);
}
if (!transparentJpegError.startsWith('encode:')) {
  throw new Error(`expected encode: error for transparent jpeg, got: ${transparentJpegError || 'no error'}`);
}

const shared = { width: 768, height: 432, format: 'png' };
const views = [
  { id: 'front', phi: 90, theta: 0 },
  { id: 'top', phi: 0, theta: 0 },
];
const batch = (await native.renderImages(glb, JSON.stringify({ ...shared, views }))).images;
if (batch.length !== views.length || !Buffer.isBuffer(batch[0]) || !Buffer.isBuffer(batch[1])) {
  throw new Error('batch output is not an ordered Buffer array');
}
for (const [index, view] of views.entries()) {
  const singularView = await native.renderImage(
    glb,
    JSON.stringify({ ...shared, phi: view.phi, theta: view.theta }),
  );
  if (!batch[index].equals(singularView)) {
    throw new Error(`batch view ${view.id} differs from singular bytes`);
  }
}
const axesRequest = { ...shared, phi: 60, theta: -45, axes: true };
const explicitAxesOff = await native.renderImage(
  glb,
  JSON.stringify({ ...shared, phi: 60, theta: -45, axes: false }),
);
const axes = await native.renderImage(glb, JSON.stringify(axesRequest));
const labelA = await native.renderImage(glb, JSON.stringify({ ...shared, phi: 60, theta: -45, label: 'A' }));
const labelB = await native.renderImage(glb, JSON.stringify({ ...shared, phi: 60, theta: -45, label: 'B' }));
const axesBatch = (
  await native.renderImages(
    glb,
    JSON.stringify({ ...shared, axes: true, views: [{ id: 'isometric', phi: 60, theta: -45 }] }),
  )
).images;
if (
  !explicitAxesOff.equals(png) ||
  axes.equals(png) ||
  axesBatch.length !== 1 ||
  !axesBatch[0].equals(axes)
) {
  throw new Error('axes output must differ from axes-off and match one-view batch bytes');
}
// A label's presence is the switch: an omitted one leaves the bytes alone, and
// two different labels cannot render the same.
if (labelA.equals(png) || labelB.equals(png) || labelA.equals(labelB)) {
  throw new Error('a label must be drawn from its presence alone');
}
const annotations = await native.renderImage(
  glb,
  JSON.stringify({
    width: 768,
    height: 576,
    format: 'png',
    projection: 'orthographic',
    label: 'Front — View From +Z',
    phi: 90,
    theta: 270,
    axes: true,
    scaleBar: true,
  }),
);
// The standing regression test of the façade's one-shot queue: five renders
// launched at once, three of them huge. Concurrent one-shot renders used to
// bring up a device each and abort the process inside D3D12/WARP; the shared
// lazy renderer makes that structurally impossible, so this goes through the
// package façade (the only layer that owns the queue) rather than the addon.
const visualCases = [
  { name: '192', width: 192, height: 192, label: 'Isometric', phi: 60, theta: -45 },
  { name: '800', width: 800, height: 800, label: 'Front — View From +Z', phi: 90, theta: 270 },
  { name: '1600', width: 1600, height: 1600, label: 'Front — View From +Z', phi: 90, theta: 270 },
  { name: '4k', width: 3840, height: 2160, label: 'Front — View From +Z', phi: 90, theta: 270 },
  { name: '4096', width: 4096, height: 4096, label: 'Front — View From +Z', phi: 90, theta: 270 },
].map(async (view) => ({
  ...view,
  bytes: (
    await renderImage(Uint8Array.from(glb), {
      width: view.width,
      height: view.height,
      format: 'png',
      projection: 'orthographic',
      background: [0.94, 0.97, 0.96, 1],
      label: view.label,
      phi: view.phi,
      theta: view.theta,
      axes: true,
      scaleBar: true,
    })
  ).bytes,
}));
const resolvedVisualCases = await Promise.all(visualCases);
// Warm == cold: bytes off the shared renderer — which has by now rendered the
// 4096² case and trimmed its targets — must match a cold addon render.
const coldSmallLadder = await native.renderImage(
  glb,
  JSON.stringify({
    width: 192,
    height: 192,
    format: 'png',
    projection: 'orthographic',
    background: [0.94, 0.97, 0.96, 1],
    label: 'Isometric',
    phi: 60,
    theta: -45,
    axes: true,
    scaleBar: true,
  }),
);
if (!coldSmallLadder.equals(Buffer.from(resolvedVisualCases[0].bytes))) {
  throw new Error('shared one-shot renderer bytes differ from a cold addon render');
}

const parityViews = [
  { id: 'isometric', label: 'Isometric', phi: 60, theta: -45 },
  { id: 'front', label: 'Front — View From +Z', phi: 90, theta: 270 },
  { id: 'back', label: 'Back — View From −Z', phi: 90, theta: 90 },
  { id: 'right', label: 'Right — View From +X', phi: 90, theta: 0 },
  { id: 'left', label: 'Left — View From −X', phi: 90, theta: 180 },
  { id: 'top', label: 'Top — View From +Y', phi: 0, theta: 0 },
  { id: 'bottom', label: 'Bottom — View From −Y', phi: 180, theta: 0 },
];
let parityCases = 0;
// Labels have no flag of their own any more, so the label leg is spelled by
// keeping or stripping each view's `label`.
const annotationCombinations = [
  { axes: false, labelled: false, scaleBar: false },
  { axes: true, labelled: false, scaleBar: false },
  { axes: false, labelled: true, scaleBar: false },
  { axes: true, labelled: true, scaleBar: false },
  { axes: false, labelled: false, scaleBar: true },
  { axes: true, labelled: false, scaleBar: true },
  { axes: false, labelled: true, scaleBar: true },
  { axes: true, labelled: true, scaleBar: true },
];
const parityOptions = ['png', 'webp', 'jpeg'].flatMap((format) =>
  ['perspective', 'orthographic'].flatMap((projection) =>
    annotationCombinations.map((annotations) => ({
      format,
      projection,
      ...annotations,
    })),
  ),
);
for (const { format, projection, axes, labelled, scaleBar } of parityOptions) {
  const common = {
    width: 512,
    height: 384,
    format,
    projection,
    ...(format === 'jpeg' ? { background: [1, 1, 1, 1] } : {}),
    axes,
    scaleBar,
  };
  // `undefined` drops out of JSON.stringify, so this is an absent label.
  const views = parityViews.map((view) => (labelled ? view : { ...view, label: undefined }));
  const images = (await native.renderImages(glb, JSON.stringify({ ...common, views }))).images;
  for (const [index, view] of views.entries()) {
    const one = await native.renderImage(
      glb,
      JSON.stringify({ ...common, label: view.label, phi: view.phi, theta: view.theta }),
    );
    if (!images[index].equals(one)) {
      throw new Error(
        `${format}/${projection}/annotations=${Number(axes)}${Number(labelled)}${Number(scaleBar)} view ${view.id} differs`,
      );
    }
    parityCases += 1;
  }
  const reordered = [{ ...views[3], id: 'right-first' }, views[0], { ...views[3], id: 'right-second' }];
  const repeated = (await native.renderImages(glb, JSON.stringify({ ...common, views: reordered }))).images;
  if (!repeated[0].equals(repeated[2])) {
    throw new Error(`${format}/${projection} repeated annotated view differs`);
  }
}
const canonicalVisuals = (
  await native.renderImages(
    glb,
    JSON.stringify({
      width: 800,
      height: 800,
      format: 'png',
      projection: 'orthographic',
      background: [0.94, 0.97, 0.96, 1],
      axes: true,
      scaleBar: true,
      views: parityViews.slice(1),
    }),
  )
).images;
const isometricPerspective = await native.renderImage(
  glb,
  JSON.stringify({
    width: 800,
    height: 800,
    format: 'png',
    projection: 'perspective',
    background: [0.94, 0.97, 0.96, 1],
    label: 'Isometric',
    phi: 60,
    theta: -45,
    axes: true,
    scaleBar: true,
  }),
);

// Lighting equivalence (R1). Cross-host goldens are impossible by the
// package's own determinism claims, so the oracle is that the three spellings
// of the studio preset — omitted, named, and written out — are the same bytes.
const studioLights = [
  { direction: [-0.45, 0.61, 0.63], color: [2.09, 2.09, 2.09] },
  { direction: [0.45, -0.61, -0.63], color: [1.45, 1.42, 1.38] },
  { direction: [0.03, 0.74, 0.67], color: [0.68, 0.66, 0.62] },
];
const studioSpelledOut = {
  lights: studioLights,
  ambient: 0.02,
  environment: 'studio',
  space: 'view',
  exposure: 1,
};
const lightingBase = { width: 256, height: 256, format: 'png', phi: 60, theta: -45 };
const lightingViews = [
  { id: 'isometric', phi: 60, theta: -45 },
  { id: 'back', phi: 90, theta: 90 },
];
const renderLit = (lighting) => native.renderImage(glb, JSON.stringify({ ...lightingBase, ...lighting }));
const renderLitBatch = async (lighting) =>
  (
    await native.renderImages(
      glb,
      JSON.stringify({
        ...lightingBase,
        phi: undefined,
        theta: undefined,
        ...lighting,
        views: lightingViews,
      }),
    )
  ).images;

const studioSpellings = [
  { name: 'preset name', lighting: 'studio' },
  { name: 'spelled-out values', lighting: studioSpelledOut },
];
const studioOmitted = await renderLit({});
const studioBatchOmitted = await renderLitBatch({});
for (const { name, lighting } of studioSpellings) {
  if (!(await renderLit({ lighting })).equals(studioOmitted)) {
    throw new Error(`lighting ${name} differs from the omitted default`);
  }
  const batch = await renderLitBatch({ lighting });
  if (
    batch.length !== lightingViews.length ||
    batch.some((image, index) => !image.equals(studioBatchOmitted[index]))
  ) {
    throw new Error(`batch lighting ${name} differs from the omitted default`);
  }
}

const customRig = await renderLit({
  lighting: { lights: [{ direction: [0, 1, 0.4], color: [3, 2.4, 1.6] }], environment: 'none' },
});
const environmentOnly = await renderLit({ lighting: { lights: [] } });
const brighter = await renderLit({ lighting: { lights: studioLights, exposure: 2 } });
if (customRig.equals(studioOmitted)) throw new Error('a custom rig must not match the studio preset');
if (environmentOnly.equals(studioOmitted)) throw new Error('an empty rig must not match the studio preset');
if (brighter.equals(studioOmitted)) throw new Error('exposure 2 must not match exposure 1');

// World space pins the rig to the model, so an orbiting view sees it move.
const worldLight = { lights: [{ direction: [0.4, 0.8, 0.45], color: [3, 3, 3] }] };
const worldBack = await renderLit({ phi: 90, theta: 90, lighting: { ...worldLight, space: 'world' } });
const viewBack = await renderLit({ phi: 90, theta: 90, lighting: { ...worldLight, space: 'view' } });
if (worldBack.equals(viewBack)) {
  throw new Error('space "world" must differ from space "view" on a non-front view');
}

for (const { name, lighting, prefix } of [
  {
    name: 'nine lights',
    lighting: { lights: Array.from({ length: 9 }, () => studioLights[0]) },
    prefix: 'parse: lighting.lights: at most 8 lights, received 9',
  },
  {
    name: 'zero direction',
    lighting: { lights: [{ direction: [0, 0, 0], color: [1, 1, 1] }] },
    prefix: 'parse: lighting.lights[0].direction must be non-zero',
  },
  {
    name: 'unknown key',
    lighting: { lights: [{ direction: [0, 0, 1], colour: [1, 1, 1] }] },
    prefix: 'parse: options: unknown field `colour`',
  },
]) {
  let rejection = '';
  try {
    await renderLit({ lighting });
  } catch (error) {
    rejection = String(error instanceof Error ? error.message : error);
  }
  if (!rejection.startsWith(prefix)) {
    throw new Error(`expected ${name} to be rejected with ${prefix}, got: ${rejection || 'no error'}`);
  }
}

let validationError = '';
try {
  await native.renderImages(Buffer.from([0]), JSON.stringify({ views: [], unexpected: true }));
} catch (error) {
  validationError = String(error instanceof Error ? error.message : error);
}
if (!validationError.startsWith('parse:') || validationError.includes('GLB')) {
  throw new Error(`request validation did not precede GLB parsing: ${validationError || 'no error'}`);
}
let glbError = '';
try {
  await native.renderImage(Buffer.from([0]), JSON.stringify(shared));
} catch (error) {
  glbError = String(error instanceof Error ? error.message : error);
}
if (!glbError.startsWith('parse:')) {
  throw new Error(`invalid GLB did not produce a parse: error: ${glbError || 'no error'}`);
}
let atomicError = '';
try {
  await native.renderImages(glb, JSON.stringify({ format: 'jpeg', views: parityViews.slice(0, 2) }));
} catch (error) {
  atomicError = String(error instanceof Error ? error.message : error);
}
if (!atomicError.startsWith('encode: view "isometric":')) {
  throw new Error(`expected a view-qualified atomic batch failure, got: ${atomicError || 'no error'}`);
}

// Handles-first surface (R1): a warm renderer must produce byte-identical
// output to the one-shot sugar, and its timed counters must prove reuse.
const renderer = await native.createRenderer();
const warmPng = await renderer.renderImage(glb, JSON.stringify({ ...shared }));
if (!warmPng.equals(png)) throw new Error('warm renderer bytes differ from one-shot bytes');
const warmBatch = (await renderer.renderImages(glb, JSON.stringify({ ...shared, views }))).images;
if (warmBatch.length !== views.length || warmBatch.some((image, index) => !image.equals(batch[index]))) {
  throw new Error('warm batch bytes differ from one-shot batch bytes');
}
// R15: per-view output overrides equal their singular equivalents.
const ladder = (
  await renderer.renderImages(
    glb,
    JSON.stringify({
      format: 'png',
      width: 512,
      height: 384,
      views: [
        { id: 'base', phi: 60, theta: -45 },
        { id: 'big', phi: 60, theta: -45, width: 1024, height: 768 },
        { id: 'weblossy', phi: 60, theta: -45, format: 'webp', quality: 0.9 },
      ],
    }),
  )
).images;
const bigSingular = await renderer.renderImage(
  glb,
  JSON.stringify({ format: 'png', width: 1024, height: 768, phi: 60, theta: -45 }),
);
const lossySingular = await renderer.renderImage(
  glb,
  JSON.stringify({ format: 'webp', quality: 0.9, width: 512, height: 384, phi: 60, theta: -45 }),
);
if (!ladder[1].equals(bigSingular) || !ladder[2].equals(lossySingular)) {
  throw new Error('ladder overrides differ from their singular equivalents');
}
if (ladder[2].toString('latin1', 0, 4) !== 'RIFF') throw new Error('per-view webp override missing');
// R13: timings ride the plan call; a warm renderer reports zero device requests.
const timed = await renderer.renderImages(glb, JSON.stringify({ ...shared, timings: true, views }));
const timings = JSON.parse(timed.timings ?? '{}');
if (timings.adapterDeviceRequests !== 0 || timings.views.length !== views.length) {
  throw new Error(`warm timings must attribute zero device requests: ${timed.timings}`);
}
if (timed.images.some((image, index) => !image.equals(batch[index]))) {
  throw new Error('timed bytes differ from untimed bytes');
}
if (typeof timings.views[0].encode !== 'number' || typeof timings.parse !== 'number') {
  throw new Error(`timings fields must be suffix-less durations: ${timed.timings}`);
}
// X1: `format: "raw"` is the fourth output format, not a separate entry point.
// Its bytes are the frame the encoders compress, so they must be exactly
// `width * height * 4`, repeatable, and identical whether they arrive from a
// singular call or from a raw view inside a mixed plan.
const rawRequest = JSON.stringify({ format: 'raw', width: 192, height: 192 });
const rawOut = await renderer.renderImage(glb, rawRequest);
if (rawOut.length !== 192 * 192 * 4) {
  throw new Error(`raw output has the wrong shape: ${rawOut.length}`);
}
if (!rawOut.equals(await native.renderImage(glb, rawRequest))) {
  throw new Error('warm raw bytes differ from a cold addon raw render');
}
// One plan, two output kinds: the encoded thumbnail and the frame beside it.
const rawPlan = await renderer.renderImages(
  glb,
  JSON.stringify({
    format: 'webp',
    quality: 1,
    width: 192,
    height: 192,
    views: [
      { id: 'thumb', phi: 60, theta: -45 },
      { id: 'frame', phi: 60, theta: -45, format: 'raw' },
    ],
  }),
);
if (rawPlan.images.length !== 2 || rawPlan.images[0].toString('latin1', 0, 4) !== 'RIFF') {
  throw new Error('mixed plan did not encode its webp view');
}
if (!rawPlan.images[1].equals(rawOut)) {
  throw new Error('mixed-plan raw view differs from the singular raw bytes');
}
console.log(`raw ${rawOut.length}B matches a cold render and the mixed-plan raw view`);
// Dispose contract: later calls reject with the stable gpu taxonomy.
renderer.dispose();
let disposedError = '';
try {
  await renderer.renderImage(glb, JSON.stringify(shared));
} catch (error) {
  disposedError = String(error instanceof Error ? error.message : error);
}
if (!disposedError.startsWith('gpu: renderer disposed')) {
  throw new Error(`expected a disposed rejection, got: ${disposedError || 'no error'}`);
}
console.log('warm renderer: byte parity, ladder overrides, zero-device-request timings, raw, dispose');

// dispose() runs on the JS main thread while renders run on the libuv pool, so
// it may never wait for one: a direct addon consumer that disposes mid-render
// would otherwise stall every timer and I/O callback in the process for the
// rest of that render. The render already in flight still settles, and the
// device is torn down when it does.
const midFlight = await native.createRenderer();
const bigRender = midFlight.renderImage(glb, JSON.stringify({ width: 4096, height: 4096, format: 'png' }));
// Let the pool thread reach the render before disposing; a render this size
// outlives the wait by orders of magnitude on every supported adapter.
await new Promise((resolve) => setTimeout(resolve, 25));
const disposeStarted = Date.now();
midFlight.dispose();
const disposeMs = Date.now() - disposeStarted;
const bigBytes = await bigRender;
if (disposeMs > 50) {
  throw new Error(`dispose() blocked the event loop for ${disposeMs}ms while a render was in flight`);
}
if (!(bigBytes[0] === 0x89 && bigBytes[1] === 0x50)) {
  throw new Error('a render in flight at dispose() must still settle with its bytes');
}
let midFlightError = '';
try {
  await midFlight.renderImage(glb, JSON.stringify(shared));
} catch (error) {
  midFlightError = String(error instanceof Error ? error.message : error);
}
if (!midFlightError.startsWith('gpu: renderer disposed')) {
  throw new Error(`expected a disposed rejection after a mid-render dispose, got: ${midFlightError}`);
}
// Idempotent, and still non-blocking with nothing left to destroy.
midFlight.dispose();
console.log(`dispose() mid-render returned in ${disposeMs}ms and the in-flight render still settled`);

mkdirSync(join(here, 'out'), { recursive: true });
writeFileSync(join(here, 'out', 'napi.png'), png);
writeFileSync(join(here, 'out', 'napi.webp'), webp);
writeFileSync(join(here, 'out', 'napi.jpg'), jpeg);
writeFileSync(join(here, 'out', 'napi-axes.png'), axes);
writeFileSync(join(here, 'out', 'napi-annotations.png'), annotations);
for (const visual of resolvedVisualCases) {
  writeFileSync(join(here, 'out', `napi-annotations-${visual.name}.png`), visual.bytes);
}
for (const [index, view] of parityViews.slice(1).entries()) {
  writeFileSync(join(here, 'out', `napi-capture-${view.id}.png`), canonicalVisuals[index]);
}
writeFileSync(join(here, 'out', 'napi-capture-isometric.png'), isometricPerspective);
writeFileSync(join(here, 'out', 'napi-interleaved.png'), interleavedPng);
console.log(`webp ${webp.length}B, jpeg ${jpeg.length}B, transparent-jpeg rejected`);
console.log(`batch ${batch.length} views matches singular bytes`);
console.log('rough dielectric and polished metal repeat deterministically and remain distinguishable');
console.log(`${parityCases} singular/batch parity cases plus reordered/repeated batches passed`);
console.log('lighting: omitted = "studio" = spelled-out studio; custom/empty/exposure/world rigs all differ');
console.log('PASS → tests/out/napi.{png,webp,jpg} + napi-{axes,annotations,interleaved}.png + visual sizes');
