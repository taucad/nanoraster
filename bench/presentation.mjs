import { readFileSync } from 'node:fs';
import { closedCubeGlb, withReusableManifoldTopology } from '../tests/pbr-fixture.mjs';

const native = await import('../tests/out/native-bench/index.js');

const fixture = (name) => readFileSync(new URL(`../tests/fixtures/${name}.glb`, import.meta.url));

const repeatRootNodes = (glb, copies) => {
  const jsonLength = glb.readUInt32LE(12);
  const json = JSON.parse(
    glb
      .subarray(20, 20 + jsonLength)
      .toString()
      .trimEnd(),
  );
  const scene = json.scenes[json.scene ?? 0];
  const roots = [...scene.nodes];
  for (let copy = 1; copy < copies; copy += 1) {
    for (const rootIndex of roots) {
      const root = json.nodes[rootIndex];
      if (root.children?.length) throw new Error('heavy benchmark roots must be leaf nodes');
      const translation = root.translation ?? [0, 0, 0];
      json.nodes.push({
        ...root,
        translation: [translation[0], translation[1] + copy * 150, translation[2]],
      });
      scene.nodes.push(json.nodes.length - 1);
    }
  }
  const source = Buffer.from(JSON.stringify(json));
  const paddedLength = (source.length + 3) & ~3;
  const tail = glb.subarray(20 + jsonLength);
  const output = Buffer.alloc(20 + paddedLength + tail.length, 0x20);
  glb.copy(output, 0, 0, 12);
  output.writeUInt32LE(output.length, 8);
  output.writeUInt32LE(paddedLength, 12);
  output.writeUInt32LE(0x4e4f_534a, 16);
  source.copy(output, 20);
  tail.copy(output, 20 + paddedLength);
  return output;
};

const planetary = fixture('planetary');
const fixtures = {
  cube: fixture('cube'),
  planetary,
  'heavy-instanced-planetary': repeatRootNodes(planetary, 4),
};
const onePlane = [{ point: [0, 0, 0], normal: [1, 0, 0] }];
const sixPlanes = [
  ...onePlane,
  { point: [1_000, 0, 0], normal: [-1, 0, 0] },
  { point: [0, -1_000, 0], normal: [0, 1, 0] },
  { point: [0, 1_000, 0], normal: [0, -1, 0] },
  { point: [0, 0, -1_000], normal: [0, 0, 1] },
  { point: [0, 0, 1_000], normal: [0, 0, -1] },
];
const median = (values) => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];
const renderer = await native.createRenderer();
const renderMany = async (glb, options) => {
  const result = await renderer.renderImages(glb, JSON.stringify(options));
  return { ...result, timings: JSON.parse(result.timings) };
};

const measure = async (glb, planes) => {
  const samples = [];
  const options = {
    format: 'raw',
    width: 256,
    height: 192,
    timings: true,
    sections: { planes },
    views: [{ id: 'isometric' }],
  };
  await renderMany(glb, options);
  for (let index = 0; index < 5; index += 1) {
    const result = await renderMany(glb, options);
    const { timings } = result;
    if (timings.glbParses !== 1 || timings.presentationBuilds !== 1 || timings.sceneUploads !== 1) {
      throw new Error(`presentation plan was not shared: ${JSON.stringify(timings)}`);
    }
    samples.push(timings);
  }
  return {
    parse: median(samples.map(({ parse }) => parse)),
    capBuild: median(samples.map(({ capBuild }) => capBuild)),
    upload: median(samples.map(({ upload }) => upload)),
    render: median(samples.map(({ views }) => views[0].render)),
  };
};

const cases = {};
for (const [name, glb] of Object.entries(fixtures)) {
  cases[name] = {
    onePlane: await measure(glb, onePlane),
    sixPlanes: await measure(glb, sixPlanes),
  };
}

// 192 triangles: slightly larger than the committed 178-triangle Racing Drone reproduction.
const topologyFixture = withReusableManifoldTopology(closedCubeGlb(16));
const topologySamples = [];
for (let index = 0; index < 6; index += 1) {
  // `parse_scene` only takes the section path — the one that decodes optional
  // `EXT_mesh_manifold` — when sections are requested, so the gate has to ask
  // for one to measure the topology decode it claims to measure.
  const result = await renderMany(topologyFixture, {
    format: 'raw',
    width: 16,
    height: 16,
    timings: true,
    sections: { planes: onePlane },
    views: [{ id: 'isometric' }],
  });
  if (index > 0) topologySamples.push(result.timings.parse);
}
const topologyParse = median(topologySamples);
// The 0.5 ms this gate used to carry was measured on a request that asked for
// no sections, so it timed a parse that never decoded the extension at all.
// Now that it does, the honest baseline is what decoding costs: about 0.13 ms
// on an M-series host and 0.62 ms on a CI x86_64 runner. 2 ms clears the
// slower of those with room for a loaded runner, and still catches the
// order-of-magnitude regression a mis-shaped topology decode would produce.
const topologyCeiling = 2;
if (topologyParse > topologyCeiling) {
  throw new Error(`EXT_mesh_manifold parse median ${topologyParse}ms exceeds ${topologyCeiling}ms`);
}

const repeated = fixtures['heavy-instanced-planetary'];
const repeatOptions = {
  format: 'raw',
  width: 192,
  height: 192,
  timings: true,
  sections: { planes: sixPlanes },
  views: [{ id: 'front' }, { id: 'top' }, { id: 'isometric' }],
};
const rss = [];
for (let index = 0; index < 20; index += 1) {
  const result = await renderMany(repeated, repeatOptions);
  if (result.timings.presentationBuilds !== 1 || result.timings.views.length !== 3) {
    throw new Error(`batch rebuilt presentation state: ${JSON.stringify(result.timings)}`);
  }
  globalThis.gc?.();
  rss.push(process.memoryUsage().rss);
}
const rssGrowth = Math.max(...rss.slice(-5)) - Math.max(...rss.slice(0, 5));
if (rssGrowth > 128 * 1024 * 1024) {
  throw new Error(`warm section renders retained ${rssGrowth} RSS bytes`);
}
renderer.dispose();

process.stdout.write(
  `${JSON.stringify({ cases, extension: { parse: topologyParse }, repeat: { calls: rss.length, rssGrowth } }, null, 2)}\n`,
);
