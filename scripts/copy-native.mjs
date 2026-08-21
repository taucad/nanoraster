import { copyFile, mkdir } from 'node:fs/promises';

const artifacts = {
  'darwin-arm64': ['librender_napi.dylib', 'darwin-arm64', 'nanoraster.darwin-arm64.node'],
  'linux-x64': ['librender_napi.so', 'linux-x64-gnu', 'nanoraster.linux-x64-gnu.node'],
  'win32-x64': ['render_napi.dll', 'win32-x64-msvc', 'nanoraster.win32-x64-msvc.node'],
};
const artifact = artifacts[`${process.platform}-${process.arch}`];

if (artifact === undefined) {
  throw new Error(`unsupported native target: ${process.platform}-${process.arch}`);
}

const [sourceName, packageDirectory, destinationName] = artifact;
// An argument diverts the addon to a scratch directory under a fixed name:
// how the feature-enabled benchmark sibling stays out of the platform package.
const scratch = process.argv[2];
const destination = new URL(`../${scratch ?? `npm/${packageDirectory}`}/`, import.meta.url);
await mkdir(destination, { recursive: true });
await copyFile(
  new URL(`../rust/target/release/${sourceName}`, import.meta.url),
  new URL(scratch ? 'nanoraster.node' : destinationName, destination),
);
// The license ships beside the addon in the platform package only.
if (!scratch) {
  await copyFile(new URL('../license', import.meta.url), new URL('license', destination));
}
