#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { readNapiTargets } from './lib/napi-targets.mjs';

const TOOL_OUTPUT_LIMIT = 64 * 1024 * 1024;
const EF_ARM_ABI_FLOAT_HARD = 0x400;
const ANDROID_API_LEVEL = 24;
const GLIBC_FLOOR = '2.17';
const WINDOWS_SUBSYSTEM_VERSION_FLOOR = '6.0';

// The lowest deployment target each macOS slice can carry. `clang` clamps arm64
// to macOS 11.0 whatever `MACOSX_DEPLOYMENT_TARGET` says, and Rust's
// `x86_64-apple-darwin` defaults to 10.12, so a pin below a slice's floor never
// lowers it. Observed on 2026-08-22: the host `napi build` emits 11.0 for
// darwin-arm64 with no deployment target set.
const MACOS_SLICE_FLOOR = {
  'darwin-arm64': '11.0',
  'darwin-x64': '10.12',
};

// Observed dynamic-dependency allow-lists. They are seeded from what the
// toolchains actually link and are meant to be diffed against the inventory
// this script prints after each assembly; a new entry is a deliberate
// admission, not a silent pass.
const DEPENDENCY_ALLOW_LIST = {
  android: ['libc.so', 'libdl.so', 'liblog.so', 'libm.so'],
  darwin: [/^\/System\/Library\/Frameworks\//u, /^\/usr\/lib\//u],
  freebsd: [
    'libc++.so.1',
    'libc.so.7',
    'libcxxrt.so.1',
    'libexecinfo.so.1',
    'libgcc_s.so.1',
    'libm.so.5',
    'libthr.so.3',
  ],
  glibc: ['libc.so.6', 'libdl.so.2', 'libgcc_s.so.1', 'libm.so.6', 'libpthread.so.0', 'librt.so.1'],
  musl: [/^ld-musl-[\w-]+\.so\.1$/u, /^libc\.musl-[\w-]+\.so\.1$/u, 'libc.so'],
  windows: [
    /^api-ms-win-[\w-]+\.dll$/u,
    'advapi32.dll',
    'bcrypt.dll',
    'crypt32.dll',
    'd3d12.dll',
    'd3dcompiler_47.dll',
    'dbghelp.dll',
    'dxcore.dll',
    'dxgi.dll',
    'gdi32.dll',
    'kernel32.dll',
    'msvcp140.dll',
    // N-API addons import the Node symbols they call from the host executable.
    'node.exe',
    'ntdll.dll',
    'ole32.dll',
    'oleaut32.dll',
    'powrprof.dll',
    'propsys.dll',
    'secur32.dll',
    'shell32.dll',
    'synchronization.dll',
    'ucrtbase.dll',
    'user32.dll',
    'userenv.dll',
    'vcruntime140.dll',
    'vcruntime140_1.dll',
    'winmm.dll',
    'ws2_32.dll',
  ],
};

// `lld` marks a `/dll /noentry` image WINDOWS_GUI while the MSVC linker marks a
// Rust cdylib WINDOWS_CUI. Both are inert for a DLL, so both are admitted.
const WINDOWS_SUBSYSTEMS = ['IMAGE_SUBSYSTEM_WINDOWS_CUI', 'IMAGE_SUBSYSTEM_WINDOWS_GUI'];

const ELF_MACHINE_BY_CPU = {
  arm: 'EM_ARM',
  arm64: 'EM_AARCH64',
  ppc64: 'EM_PPC64',
  s390x: 'EM_S390',
  x64: 'EM_X86_64',
};
const MACHO_CPU_TYPE_BY_CPU = { arm64: 'Arm64', x64: 'X86-64' };
const PE_MACHINE_BY_CPU = {
  arm64: 'IMAGE_FILE_MACHINE_ARM64',
  ia32: 'IMAGE_FILE_MACHINE_I386',
  x64: 'IMAGE_FILE_MACHINE_AMD64',
};
const THIRTY_TWO_BIT_CPUS = new Set(['arm', 'ia32']);

const byText = (left, right) => Number(left > right) - Number(left < right);

const expectedFormat = (target) => (target.os === 'darwin' ? 'macho' : target.os === 'win32' ? 'pe' : 'elf');

const libcFamily = (target) => {
  if (target.os === 'android') return 'android';
  if (target.os === 'freebsd') return 'freebsd';
  return target.triple.includes('-musl') ? 'musl' : 'glibc';
};

const compareVersions = (left, right) => {
  const parse = (value) => String(value).split('.').map(Number);
  const [a, b] = [parse(left), parse(right)];
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

const admits = (entry, allowList, { caseInsensitive = false } = {}) => {
  const candidate = caseInsensitive ? entry.toLowerCase() : entry;
  return allowList.some((allowed) =>
    allowed instanceof RegExp ? allowed.test(candidate) : allowed === candidate,
  );
};

// ---------------------------------------------------------------------------
// Parsers. Each takes one tool invocation's text and returns plain data, so the
// assertions below can be exercised against recorded output.
// ---------------------------------------------------------------------------

export const detectBinaryFormat = (bytes) => {
  if (bytes.length < 4) return null;
  const magic = bytes.subarray(0, 4).toString('hex');
  if (magic === '7f454c46') return 'elf';
  if (['cffaedfe', 'cefaedfe', 'feedface', 'feedfacf'].includes(magic)) return 'macho';
  if (bytes.subarray(0, 2).toString('latin1') === 'MZ') return 'pe';
  return null;
};

export const parseElfHeader = (text) => {
  const header = text.slice(text.indexOf('ElfHeader {'));
  const read = (pattern) => pattern.exec(header)?.[1];
  const machine = read(/^ {2}Machine: (\S+)/mu);
  if (!machine) return null;
  return {
    class: read(/^ {4}Class: (\S+)/mu),
    endianness: read(/^ {4}DataEncoding: (\S+)/mu),
    flags: Number.parseInt(read(/^ {2}Flags \[ \((0x[\dA-Fa-f]+)\)/mu) ?? '0', 16),
    machine,
  };
};

export const parseProgramHeaderTypes = (text) =>
  [...text.matchAll(/^\s*Type: (PT_\w+)/gmu)].map(([, type]) => type);

export const parseNeededLibraries = (text) => {
  const start = text.indexOf('NeededLibraries [');
  if (start === -1) return [];
  const body = text.slice(start + 'NeededLibraries ['.length);
  return body
    .slice(0, body.indexOf('\n]'))
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
};

export const parseMaxGlibcVersion = (text) => {
  const versions = [...text.matchAll(/\bGLIBC_(\d+(?:\.\d+)+)\b/gu)].map(([, version]) => version);
  if (versions.length === 0) return null;
  return versions.reduce((highest, version) => (compareVersions(version, highest) > 0 ? version : highest));
};

export const parseAndroidApiLevel = (text) => {
  const note = /Name: \.note\.android\.ident[\s\S]*?Description data \(\s*\n\s*0000: ([\dA-Fa-f]{8})/u.exec(
    text,
  );
  return note ? Buffer.from(note[1], 'hex').readUInt32LE(0) : null;
};

export const parseMachHeader = (text) => {
  const header = text.slice(text.indexOf('MachHeader {'));
  const cpuType = /^ {2}CpuType: (\S+)/mu.exec(header)?.[1];
  if (!cpuType) return null;
  return {
    class: /^ {2}Magic: Magic64/mu.test(header) ? '64-bit' : '32-bit',
    cpuType,
  };
};

export const parseMachoVersionMin = (text) => {
  const command = /^ {2}Cmd: (\S+)/mu.exec(text)?.[1];
  if (!command) return null;
  return {
    command,
    platform: /^ {2}Platform: (\S+)/mu.exec(text)?.[1],
    version: /^ {2}Version: (\S+)/mu.exec(text)?.[1],
  };
};

export const parseDylibId = (text) => {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.at(-1) ?? null;
};

export const parsePeHeader = (text) => {
  const machine = /^ {2}Machine: (\S+)/mu.exec(text)?.[1];
  if (!machine) return null;
  const major = /^ {2}MajorSubsystemVersion: (\d+)/mu.exec(text)?.[1];
  const minor = /^ {2}MinorSubsystemVersion: (\d+)/mu.exec(text)?.[1];
  return {
    class: /^AddressSize: 64bit/mu.test(text) ? '64-bit' : '32-bit',
    machine,
    subsystem: /^ {2}Subsystem: (\S+)/mu.exec(text)?.[1],
    subsystemVersion: `${major}.${minor}`,
  };
};

export const parseCoffImports = (text) => [...text.matchAll(/^ {2}Name: (\S+)/gmu)].map(([, name]) => name);

// ---------------------------------------------------------------------------
// Assertions.
// ---------------------------------------------------------------------------

/**
 * Compare one inspected binary against the expectations its target implies.
 * Returns a finding per violation so a whole assembly reports at once.
 */
export const binaryFindings = (
  target,
  observed,
  { macosDeploymentTarget = process.env['MACOSX_DEPLOYMENT_TARGET'] } = {},
) => {
  const findings = [];
  const note = (message) => findings.push(`${target.suffix}: ${message}`);
  const format = expectedFormat(target);
  if (observed.format !== format) {
    return [`${target.suffix}: expected a ${format} binary, found ${observed.format}`];
  }

  const machine =
    format === 'elf'
      ? ELF_MACHINE_BY_CPU[target.cpu]
      : format === 'macho'
        ? MACHO_CPU_TYPE_BY_CPU[target.cpu]
        : PE_MACHINE_BY_CPU[target.cpu];
  if (observed.machine !== machine) {
    note(`expected machine ${machine}, found ${observed.machine}`);
  }

  const wordSize = THIRTY_TWO_BIT_CPUS.has(target.cpu) ? '32-bit' : '64-bit';
  if (observed.class !== wordSize) {
    note(`expected class ${wordSize}, found ${observed.class}`);
  }

  if (format === 'elf') {
    const endianness = target.cpu === 's390x' ? 'BigEndian' : 'LittleEndian';
    if (observed.endianness !== endianness) {
      note(`expected data encoding ${endianness}, found ${observed.endianness}`);
    }
    if (
      target.triple.endsWith('eabihf') &&
      (observed.flags & EF_ARM_ABI_FLOAT_HARD) !== EF_ARM_ABI_FLOAT_HARD
    ) {
      note(`expected the EF_ARM_ABI_FLOAT_HARD flag, found flags 0x${(observed.flags ?? 0).toString(16)}`);
    }
    if ((observed.programHeaders ?? []).includes('PT_INTERP')) {
      note('carries a PT_INTERP program header');
    }
  }

  const family = format === 'elf' ? libcFamily(target) : format === 'macho' ? 'darwin' : 'windows';
  if (family === 'glibc') {
    if (observed.glibcMax === null) {
      note('requires no versioned glibc symbol, so the 2.17 floor is unproven');
    } else if (compareVersions(observed.glibcMax, GLIBC_FLOOR) > 0) {
      note(`requires GLIBC_${observed.glibcMax}, above the ${GLIBC_FLOOR} floor`);
    }
  }

  if (family === 'android') {
    if (observed.apiLevel === null) {
      note('has no .note.android.ident API level');
    } else if (observed.apiLevel !== ANDROID_API_LEVEL) {
      note(`expected Android API level ${ANDROID_API_LEVEL}, found ${observed.apiLevel}`);
    }
  }

  if (format === 'macho') {
    if (observed.platform !== undefined && observed.platform !== 'macos') {
      note(`expected the macos build platform, found ${observed.platform}`);
    }
    const floor = MACOS_SLICE_FLOOR[target.suffix];
    const expected =
      macosDeploymentTarget && compareVersions(macosDeploymentTarget, floor) > 0
        ? macosDeploymentTarget
        : floor;
    if (observed.minOs !== expected) {
      note(`expected LC_BUILD_VERSION minos ${expected}, found ${observed.minOs}`);
    }
  }

  if (format === 'pe') {
    if (observed.subsystem !== undefined && !WINDOWS_SUBSYSTEMS.includes(observed.subsystem)) {
      note(`expected a DLL subsystem, found ${observed.subsystem}`);
    }
    if (compareVersions(observed.minOs, WINDOWS_SUBSYSTEM_VERSION_FLOOR) < 0) {
      note(`expected subsystem version ${WINDOWS_SUBSYSTEM_VERSION_FLOOR} or later, found ${observed.minOs}`);
    }
  }

  for (const dependency of observed.needed ?? []) {
    if (!admits(dependency, DEPENDENCY_ALLOW_LIST[family], { caseInsensitive: family === 'windows' })) {
      note(`unexpected dynamic dependency ${dependency}`);
    }
  }

  return findings;
};

/**
 * Assert the set of inspected binaries: one per configured target, nothing
 * else, and no two targets sharing bytes.
 */
export const inventoryFindings = ({ inventory, npmDir = 'npm', packages, stray }) => {
  const findings = [];
  for (const target of packages) {
    if (!inventory[target.suffix]) {
      findings.push(`${target.suffix}: ${npmDir}/${target.suffix}/${target.binary} is missing`);
    }
  }
  for (const path of stray) {
    findings.push(`${path} is not a configured target binary`);
  }

  const bySha = new Map();
  for (const [suffix, entry] of Object.entries(inventory)) {
    bySha.set(entry.sha256, [...(bySha.get(entry.sha256) ?? []), suffix]);
  }
  for (const [sha256, suffixes] of bySha) {
    if (suffixes.length > 1) {
      findings.push(`${suffixes.sort(byText).join(', ')}: share the identical binary ${sha256}`);
    }
  }
  return findings;
};

// ---------------------------------------------------------------------------
// Tool plumbing and CLI.
// ---------------------------------------------------------------------------

const resolveToolDirectory = (cwd) => {
  if (process.env['LLVM_TOOLS_DIR']) return process.env['LLVM_TOOLS_DIR'];
  // `rust-toolchain.toml` pins the compiler, and its `llvm-tools-preview`
  // component is where llvm-readobj/llvm-objdump live. `RUSTC` follows cargo's
  // own override so a wrapper or an absolute path still resolves.
  const compiler = process.env['RUSTC'] ?? 'rustc';
  const run = (args) => execFileSync(compiler, args, { cwd, encoding: 'utf8' });
  const sysroot = run(['--print', 'sysroot']).trim();
  const host = run(['-vV'])
    .split('\n')
    .find((line) => line.startsWith('host: '))
    ?.slice('host: '.length)
    .trim();
  if (!host) throw new Error('rustc -vV did not report a host triple');
  return join(sysroot, 'lib', 'rustlib', host, 'bin');
};

const readObject = (toolDirectory, file, ...args) =>
  execFileSync(join(toolDirectory, 'llvm-readobj'), [...args, file], {
    encoding: 'utf8',
    maxBuffer: TOOL_OUTPUT_LIMIT,
  });

const dumpObject = (toolDirectory, file, ...args) =>
  execFileSync(join(toolDirectory, 'llvm-objdump'), [...args, file], {
    encoding: 'utf8',
    maxBuffer: TOOL_OUTPUT_LIMIT,
  });

const inspectBinary = (toolDirectory, file, target) => {
  const bytes = readFileSync(file);
  const observed = {
    apiLevel: null,
    bytes: bytes.length,
    class: null,
    endianness: null,
    format: detectBinaryFormat(bytes),
    glibcMax: null,
    machine: null,
    minOs: null,
    needed: parseNeededLibraries(readObject(toolDirectory, file, '--needed-libs')),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };

  if (observed.format === 'elf') {
    Object.assign(observed, parseElfHeader(readObject(toolDirectory, file, '--file-headers')));
    observed.programHeaders = parseProgramHeaderTypes(readObject(toolDirectory, file, '--program-headers'));
    if (libcFamily(target) === 'glibc') {
      observed.glibcMax = parseMaxGlibcVersion(readObject(toolDirectory, file, '--version-info'));
    }
    if (target.os === 'android') {
      observed.apiLevel = parseAndroidApiLevel(readObject(toolDirectory, file, '--notes'));
    }
  } else if (observed.format === 'macho') {
    const header = parseMachHeader(readObject(toolDirectory, file, '--file-headers'));
    const version = parseMachoVersionMin(readObject(toolDirectory, file, '--macho-version-min'));
    const installName = parseDylibId(dumpObject(toolDirectory, file, '--macho', '--dylib-id'));
    observed.class = header?.class ?? null;
    observed.machine = header?.cpuType ?? null;
    observed.minOs = version?.version ?? null;
    observed.platform = version?.platform;
    // `--needed-libs` reports LC_ID_DYLIB alongside the load commands, and a
    // Rust cdylib's install name is its absolute build path.
    observed.needed = observed.needed.filter((library) => library !== installName);
  } else if (observed.format === 'pe') {
    const header = parsePeHeader(readObject(toolDirectory, file, '--file-headers'));
    observed.class = header?.class ?? null;
    observed.machine = header?.machine ?? null;
    observed.minOs = header?.subsystemVersion ?? null;
    observed.subsystem = header?.subsystem;
    observed.needed = parseCoffImports(readObject(toolDirectory, file, '--coff-imports'));
  }

  return observed;
};

const collectNativeBinaries = (npmDirectory) => {
  if (!existsSync(npmDirectory)) return [];
  const found = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.node')) found.push(path);
    }
  };
  walk(npmDirectory);
  return found;
};

export const inspectNative = ({ cwd = process.cwd(), npmDir = 'npm', packageJsonPath } = {}) => {
  const root = resolve(cwd);
  const npmDirectory = resolve(root, npmDir);
  const { packages } = readNapiTargets(resolve(root, packageJsonPath ?? 'package.json'));
  const toolDirectory = resolveToolDirectory(root);

  const expected = new Map(
    packages.map((target) => [resolve(npmDirectory, target.suffix, target.binary), target]),
  );
  const stray = [];
  const inventory = {};
  const findings = [];

  for (const file of collectNativeBinaries(npmDirectory).sort(byText)) {
    const target = expected.get(file);
    if (!target) {
      stray.push(relative(root, file).replaceAll('\\', '/'));
      continue;
    }
    if (!statSync(file).isFile()) continue;
    const observed = inspectBinary(toolDirectory, file, target);
    findings.push(...binaryFindings(target, observed));
    inventory[target.suffix] = {
      apiLevel: observed.apiLevel,
      bytes: observed.bytes,
      class: observed.class,
      endianness: observed.endianness,
      format: observed.format,
      glibcMax: observed.glibcMax,
      machine: observed.machine,
      minOs: observed.minOs,
      needed: observed.needed,
      sha256: observed.sha256,
    };
  }

  const ordered = Object.fromEntries(
    packages.filter((target) => inventory[target.suffix]).map((t) => [t.suffix, inventory[t.suffix]]),
  );
  return {
    findings: [...inventoryFindings({ inventory: ordered, npmDir, packages, stray }), ...findings],
    inventory: ordered,
  };
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      'npm-dir': { default: 'npm', type: 'string' },
      'package-json': { default: 'package.json', type: 'string' },
    },
  });
  try {
    const { findings, inventory } = inspectNative({
      npmDir: values['npm-dir'],
      packageJsonPath: values['package-json'],
    });
    process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
    for (const finding of findings) {
      process.stderr.write(`::error::${finding}\n`);
    }
    if (findings.length > 0) {
      process.stderr.write(`${findings.length} native binary findings\n`);
      process.exit(1);
    }
    process.stderr.write(`inspected ${Object.keys(inventory).length} native binaries with no findings\n`);
  } catch (error) {
    process.stderr.write(`::error::${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
