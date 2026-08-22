import { readFileSync } from 'node:fs';

import { parseTriple } from '@napi-rs/cli';

/**
 * Derive the generated platform-package contract from `package.json.napi`.
 *
 * `parseTriple` is the pinned CLI's own target parser, so the suffix, `os`,
 * `cpu`, and `libc` values here are exactly the ones `napi create-npm-dirs`
 * writes. Verified against a real `create-npm-dirs` run on 2026-08-22: `libc`
 * is emitted only when the ABI is literally `gnu` or `musl`, which means the
 * two armv7 rows (`gnueabihf`, `musleabihf`) carry no `libc` selector.
 */
export const readNapiTargets = (packageJsonPath) => {
  const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const { binaryName, packageName, targets } = manifest.napi ?? {};
  if (!binaryName || !packageName || !Array.isArray(targets) || targets.length === 0) {
    throw new Error(`${packageJsonPath} has no napi.binaryName, napi.packageName, or napi.targets`);
  }

  return {
    manifest,
    packages: targets.map((triple) => {
      const target = parseTriple(triple);
      return {
        binary: `${binaryName}.${target.platformArchABI}.node`,
        cpu: target.arch,
        libc: target.abi === 'gnu' ? 'glibc' : target.abi === 'musl' ? 'musl' : undefined,
        name: `${packageName}-${target.platformArchABI}`,
        os: target.platform,
        suffix: target.platformArchABI,
        triple,
      };
    }),
  };
};
