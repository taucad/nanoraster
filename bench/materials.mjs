// Compare warm material capture costs with an optional previously built addon.
// Usage: node bench/materials.mjs [--baseline /path/old.node] [--output report.json]
// Both backends see identical BRep GLBs/cameras; lighting pixels intentionally differ.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { baseline: { type: 'string' }, output: { type: 'string' } } });
const require = createRequire(import.meta.url);
const candidate = await import('../src/native/index.js');
const variants = values.baseline
  ? [
      ['baseline', require(resolve(values.baseline))],
      ['candidate', candidate],
    ]
  : [['candidate', candidate]];
const root = new URL('../tests/fixtures/material-parity/', import.meta.url);
const references = JSON.parse(readFileSync(new URL('reference.json', root), 'utf8'));
const distribution = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const deviation = sorted.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
  return {
    median,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    mad: deviation[Math.floor(sorted.length / 2)],
  };
};
const report = {
  name: 'physical-material-capture-v1',
  iterations: 15,
  unit: 'milliseconds',
  gpuTimestamps: false,
  runs: [],
};
for (const [variant, native] of variants) {
  for (const reference of references) {
    const glb = gunzipSync(readFileSync(new URL(`${reference.id}.glb.gz`, root)));
    const renderer = await native.createRenderer();
    try {
      const options = JSON.stringify({
        format: 'raw',
        width: reference.width,
        height: reference.height,
        world: { up: '+z', forward: '-y', unit: 'meter' },
        lines: false,
        timings: true,
        views: [{ id: 'matched', camera: reference.camera }],
      });
      const coldStart = performance.now();
      await renderer.renderImages(glb, options);
      const cold = performance.now() - coldStart;
      const wall = [];
      const raster = [];
      let timings;
      let bytes;
      for (let i = 0; i < report.iterations; i++) {
        const start = performance.now();
        const result = await renderer.renderImages(glb, options);
        wall.push(performance.now() - start);
        timings = JSON.parse(result.timings);
        raster.push(timings.views[0].render);
        bytes = result.images[0];
      }
      report.runs.push({
        variant,
        fixture: reference.id,
        adapter: JSON.parse(await native.describeAdapter()),
        width: reference.width,
        height: reference.height,
        glbSha256: reference.sha256,
        camera: reference.camera,
        cold,
        wall: distribution(wall),
        raster: distribution(raster),
        timings,
        outputSha256: createHash('sha256').update(bytes).digest('hex'),
      });
    } finally {
      renderer.dispose();
    }
  }
}
const output = JSON.stringify(report, null, 2) + '\n';
if (values.output) writeFileSync(values.output, output);
else process.stdout.write(output);
