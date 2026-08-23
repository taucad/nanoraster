// This file imports no package. `registry-verify` runs the attestation
// verifier from a checkout with no `node_modules` — it proves registry state
// rather than building anything — and every other reader is a release-assembly
// script that has to behave the same there. Two checks hold the derivation to
// what the NAPI-RS CLI itself produces: `tests/napi-targets.test.mjs` compares
// it against the pinned CLI's parser, and `check-prepared-release.mjs` compares
// it against the `npm/` tree that `napi create-npm-dirs` writes.
import { readFileSync } from 'node:fs';

/** Rust CPU names NAPI-RS rewrites into `process.arch` values. */
const CPU_TO_NODE_ARCH = {
  aarch64: 'arm64',
  armv7: 'arm',
  i686: 'ia32',
  loongarch64: 'loong64',
  powerpc64le: 'ppc64',
  riscv64gc: 'riscv64',
  x86_64: 'x64',
};

/** Rust system names NAPI-RS rewrites into `process.platform` values. */
const SYS_TO_NODE_PLATFORM = {
  darwin: 'darwin',
  freebsd: 'freebsd',
  linux: 'linux',
  ohos: 'openharmony',
  windows: 'win32',
};

/** System names a triple spells in the ABI position instead of the system one. */
const SUB_SYSTEMS = new Set(['android', 'ohos']);

/**
 * Split one Rust target triple the way NAPI-RS splits it.
 *
 * A triple reads `<arch><sub>-<vendor>-<sys>-<abi>`, with the vendor absent
 * from two-field spellings and the ABI absent from Apple ones.
 * `armv7-linux-androideabi` hides an `eabi` ABI inside its system field, and
 * `android` reaches the ABI position on triples that name no vendor, so both
 * move back before the platform and architecture are read.
 *
 * @param {string} rawTriple - Rust target triple, for example `aarch64-apple-darwin`.
 * @returns {{ abi: string | null, arch: string, platform: string, platformArchABI: string, triple: string }} Parsed target.
 */
export const parseTriple = (rawTriple) => {
  if (/^(?:wasm32|universal)-/u.test(rawTriple)) {
    throw new Error(`${rawTriple} names no single platform package`);
  }

  const parts = (rawTriple.endsWith('eabi') ? `${rawTriple.slice(0, -4)}-eabi` : rawTriple).split('-');
  const [cpu] = parts;
  let sys = parts.length === 2 ? parts[1] : parts[2];
  let abi = parts[3] ?? null;
  if (abi !== null && SUB_SYSTEMS.has(abi)) {
    sys = abi;
    abi = null;
  }

  const platform = SYS_TO_NODE_PLATFORM[sys] ?? sys;
  const arch = CPU_TO_NODE_ARCH[cpu] ?? cpu;
  return {
    abi,
    arch,
    platform,
    platformArchABI: abi ? `${platform}-${arch}-${abi}` : `${platform}-${arch}`,
    triple: rawTriple,
  };
};

/**
 * Derive the generated platform-package contract from `package.json.napi`.
 *
 * The suffix, `os`, `cpu`, and `libc` values here are the ones `napi
 * create-npm-dirs` writes. Verified against a real `create-npm-dirs` run on
 * 2026-08-22: `libc` is emitted only when the ABI is literally `gnu` or `musl`,
 * which means the two armv7 rows (`gnueabihf`, `musleabihf`) carry no `libc`
 * selector.
 *
 * @param {string | URL} packageJsonPath - Manifest holding the `napi` block.
 * @returns {{ manifest: Record<string, any>, packages: Array<Record<string, any>> }} Manifest and target packages.
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
