import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const nativePackage = {
  'darwin-arm64': 'nanoraster-darwin-arm64',
  'linux-x64': 'nanoraster-linux-x64-gnu',
  'win32-x64': 'nanoraster-win32-x64-msvc',
}[`${process.platform}-${process.arch}`];

if (!nativePackage) throw new Error(`unsupported benchmark host: ${process.platform}-${process.arch}`);

const native = createRequire(import.meta.url)(nativePackage);
const glb = readFileSync(new URL('../tests/fixtures/gear-12.glb', import.meta.url));
const options = JSON.stringify({ width: 512, height: 384, format: 'png' });
const iterations = 15;

const fnv64 = (bytes) => {
  let hash = 0xcbf2_9ce4_8422_2325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x0000_0100_0000_01b3n);
  }
  return hash.toString(16).padStart(16, '0');
};

await native.renderImage(glb, options);
const durations = [];
let output;
for (let index = 0; index < iterations; index += 1) {
  const started = performance.now();
  output = await native.renderImage(glb, options);
  durations.push(performance.now() - started);
}
durations.sort((left, right) => left - right);

const report = {
  // v2: R8/R9 retuned the studio preset (ACES tone map + diffuse environment
  // irradiance), so every pixel — and therefore outputFnv — changed on purpose.
  // v3: the vendored image-webp update that added lossy encoding also revised
  // its lossless encoder, so codecConformance's webp fingerprints changed on
  // purpose (pixels and PNG output are untouched).
  name: 'gear-parse-raster-encode-512x384-v3',
  adapter: native.describeAdapter(),
  codecConformance: JSON.parse(native.codecConformance()),
  iterations,
  medianMs: Math.round(durations[Math.floor(iterations / 2)] * 1_000) / 1_000,
  outputBytes: output.length,
  outputFnv: fnv64(output),
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

const maximum = Number(process.env['MAX_MEDIAN_MS']);
if (Number.isFinite(maximum) && report.medianMs > maximum) {
  throw new Error(`benchmark median ${report.medianMs}ms exceeds ${maximum}ms`);
}
