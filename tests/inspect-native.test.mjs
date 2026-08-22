import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  binaryFindings,
  detectBinaryFormat,
  inventoryFindings,
  machoDependencies,
  parseAndroidApiLevel,
  parseCoffImports,
  parseDylibId,
  parseElfHeader,
  parseMachHeader,
  parseMachoVersionMin,
  parseMaxGlibcVersion,
  parseNeededLibraries,
  parsePeHeader,
  parseProgramHeaderTypes,
} from '../scripts/inspect-native.mjs';
import { readNapiTargets } from '../scripts/lib/napi-targets.mjs';
import {
  ELF_FILE_HEADERS_ANDROID_ARM_EABI,
  ELF_FILE_HEADERS_LINUX_ARM_GNUEABIHF,
  ELF_FILE_HEADERS_LINUX_ARM64_GNU,
  ELF_FILE_HEADERS_LINUX_PPC64_GNU,
  ELF_FILE_HEADERS_LINUX_S390X_GNU,
  ELF_FILE_HEADERS_LINUX_X64_GNU,
  ELF_NEEDED_LIBRARIES_LINUX_ARM64_GNU,
  ELF_NOTES_ANDROID_ARM64,
  ELF_PROGRAM_HEADERS_LINUX_X64_GNU,
  MACHO_DYLIB_ID_DARWIN_ARM64,
  MACHO_FILE_HEADERS_DARWIN_ARM64,
  MACHO_NEEDED_LIBRARIES_DARWIN_ARM64,
  MACHO_VERSION_MIN_DARWIN_ARM64,
  PE_FILE_HEADERS_WIN32_IA32_MSVC,
} from './fixtures/readobj-output.mjs';

const { packages } = readNapiTargets(new URL('../package.json', import.meta.url));
const targetFor = (suffix) => {
  const target = packages.find((candidate) => candidate.suffix === suffix);
  assert(target, `package.json napi.targets has no ${suffix} row`);
  return target;
};

// SYNTHETIC: the recorded `--version-info` output of the probe binaries has an
// empty `VersionRequirements` block, so the glibc symbol-version cases below
// substitute the documented `Dependency`/`Entry` shape into it.
const versionInfo = (...versions) => `
File: npm/linux-x64-gnu/nanoraster.linux-x64-gnu.node
Format: elf64-x86-64
Arch: x86_64
AddressSize: 64bit
VersionSymbols [
]
VersionDefinitions [
]
VersionRequirements [
  Dependency {
    Version: 1
    Count: ${versions.length}
    FileName: libc.so.6
    Entries [
${versions
  .map(
    (version) => `      Entry {
        Hash: 157882997
        Flags [
        ]
        Index: 2
        Name: GLIBC_${version}
      }`,
  )
  .join('\n')}
    ]
  }
]
`;

// SYNTHETIC: the probe DLLs import nothing, so the import cases substitute the
// documented `Import { Name: ... }` shape into the recorded header block.
const coffImports = (...dlls) => `
File: npm/win32-x64-msvc/nanoraster.win32-x64-msvc.node
Format: COFF-x86-64
Arch: x86_64
AddressSize: 64bit
${dlls
  .map(
    (dll) => `Import {
  Name: ${dll}
  ImportLookupTableRVA: 0x1F000
  ImportAddressTableRVA: 0x1F100
  Symbol: SomeExportedSymbol (0)
}`,
  )
  .join('\n')}
`;

const observation = (overrides) => ({
  apiLevel: null,
  bytes: 4_616_992,
  class: '64-bit',
  endianness: 'LittleEndian',
  flags: 0x5_000_400,
  format: 'elf',
  glibcMax: null,
  machine: 'EM_X86_64',
  minOs: null,
  needed: ['libc.so.6'],
  programHeaders: ['PT_LOAD', 'PT_DYNAMIC'],
  sha256: 'a'.repeat(64),
  ...overrides,
});

const elfFlagsOf = (text) => parseElfHeader(text).flags;

describe('llvm-readobj output parsing', () => {
  it('should read class, data encoding, machine, and flags from every recorded ELF header', () => {
    assert.deepEqual(parseElfHeader(ELF_FILE_HEADERS_LINUX_X64_GNU), {
      class: '64-bit',
      endianness: 'LittleEndian',
      flags: 0x0,
      machine: 'EM_X86_64',
    });
    assert.deepEqual(parseElfHeader(ELF_FILE_HEADERS_LINUX_ARM64_GNU), {
      class: '64-bit',
      endianness: 'LittleEndian',
      flags: 0x0,
      machine: 'EM_AARCH64',
    });
    assert.deepEqual(parseElfHeader(ELF_FILE_HEADERS_LINUX_PPC64_GNU), {
      class: '64-bit',
      endianness: 'LittleEndian',
      flags: 0x2,
      machine: 'EM_PPC64',
    });
    assert.deepEqual(parseElfHeader(ELF_FILE_HEADERS_LINUX_S390X_GNU), {
      class: '64-bit',
      endianness: 'BigEndian',
      flags: 0x0,
      machine: 'EM_S390',
    });
  });

  it('should read the ARM float ABI flag as hard for gnueabihf and soft for androideabi', () => {
    assert.equal(elfFlagsOf(ELF_FILE_HEADERS_LINUX_ARM_GNUEABIHF) & 0x400, 0x400);
    assert.equal(elfFlagsOf(ELF_FILE_HEADERS_ANDROID_ARM_EABI) & 0x400, 0);
    assert.equal(parseElfHeader(ELF_FILE_HEADERS_LINUX_ARM_GNUEABIHF).class, '32-bit');
    assert.equal(parseElfHeader(ELF_FILE_HEADERS_ANDROID_ARM_EABI).machine, 'EM_ARM');
  });

  it('should list every program header type so a present interpreter is visible', () => {
    const types = parseProgramHeaderTypes(ELF_PROGRAM_HEADERS_LINUX_X64_GNU);
    assert.deepEqual(types, [
      'PT_PHDR',
      'PT_LOAD',
      'PT_LOAD',
      'PT_LOAD',
      'PT_DYNAMIC',
      'PT_GNU_RELRO',
      'PT_GNU_STACK',
    ]);
    // SYNTHETIC: an interpreter entry substituted into the recorded output.
    const withInterpreter = ELF_PROGRAM_HEADERS_LINUX_X64_GNU.replace(
      'Type: PT_PHDR (0x6)',
      'Type: PT_INTERP (0x3)',
    );
    assert(parseProgramHeaderTypes(withInterpreter).includes('PT_INTERP'));
  });

  it('should read needed libraries for both ELF and Mach-O', () => {
    assert.deepEqual(parseNeededLibraries(ELF_NEEDED_LIBRARIES_LINUX_ARM64_GNU), ['libc.so.6']);
    assert.deepEqual(parseNeededLibraries(MACHO_NEEDED_LIBRARIES_DARWIN_ARM64), [
      '/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation',
      '/System/Library/Frameworks/CoreGraphics.framework/Versions/A/CoreGraphics',
      '/System/Library/Frameworks/Foundation.framework/Versions/C/Foundation',
      '/System/Library/Frameworks/Metal.framework/Versions/A/Metal',
      '/System/Library/Frameworks/QuartzCore.framework/Versions/A/QuartzCore',
      '/Users/runner/work/nanoraster/nanoraster/rust/target/aarch64-apple-darwin/release/deps/librender_napi.dylib',
      '/usr/lib/libSystem.B.dylib',
      '/usr/lib/libiconv.2.dylib',
      '/usr/lib/libobjc.A.dylib',
    ]);
  });

  it('should report the highest required glibc symbol version, or none', () => {
    assert.equal(parseMaxGlibcVersion(versionInfo('2.4', '2.17', '2.2.5')), '2.17');
    assert.equal(parseMaxGlibcVersion(versionInfo('2.9', '2.34')), '2.34');
    assert.equal(parseMaxGlibcVersion(versionInfo()), null);
  });

  it('should decode the Android API level from the identification note', () => {
    assert.equal(parseAndroidApiLevel(ELF_NOTES_ANDROID_ARM64), 24);
    assert.equal(parseAndroidApiLevel('NoteSections [\n]\n'), null);
  });

  it('should read the Mach-O CPU type, build version, and install name', () => {
    assert.deepEqual(parseMachHeader(MACHO_FILE_HEADERS_DARWIN_ARM64), {
      class: '64-bit',
      cpuType: 'Arm64',
    });
    assert.deepEqual(parseMachoVersionMin(MACHO_VERSION_MIN_DARWIN_ARM64), {
      command: 'LC_BUILD_VERSION',
      platform: 'macos',
      version: '11.0',
    });
    assert.equal(
      parseDylibId(MACHO_DYLIB_ID_DARWIN_ARM64),
      '/Users/runner/work/nanoraster/nanoraster/rust/target/aarch64-apple-darwin/release/deps/librender_napi.dylib',
    );
  });

  it('should read the PE machine, subsystem, and subsystem version floor', () => {
    assert.deepEqual(parsePeHeader(PE_FILE_HEADERS_WIN32_IA32_MSVC), {
      class: '32-bit',
      machine: 'IMAGE_FILE_MACHINE_I386',
      subsystem: 'IMAGE_SUBSYSTEM_WINDOWS_GUI',
      subsystemVersion: '6.0',
    });
  });

  it('should read no subsystem version from a header that prints none', () => {
    // SYNTHETIC: the recorded header with both subsystem-version lines removed,
    // which is what a stripped or truncated PE yields.
    const withoutVersion = PE_FILE_HEADERS_WIN32_IA32_MSVC.split('\n')
      .filter((line) => !/SubsystemVersion:/u.test(line))
      .join('\n');

    assert.equal(parsePeHeader(withoutVersion).subsystemVersion, null);
  });

  it('should drop the image install name from the Mach-O needed libraries', () => {
    const needed = parseNeededLibraries(MACHO_NEEDED_LIBRARIES_DARWIN_ARM64);
    const installName = parseDylibId(MACHO_DYLIB_ID_DARWIN_ARM64);

    const dependencies = machoDependencies(needed, installName);

    assert.deepEqual(
      dependencies,
      needed.filter((library) => library !== installName),
    );
    assert.equal(needed.length - dependencies.length, 1);
    assert.ok(!dependencies.includes(installName), 'the install name is not a dependency');
    assert.ok(
      dependencies.includes('/usr/lib/libSystem.B.dylib'),
      'every real load command survives the filter',
    );
  });

  it('should list every imported DLL, or none', () => {
    assert.deepEqual(parseCoffImports(coffImports('KERNEL32.dll', 'node.exe')), ['KERNEL32.dll', 'node.exe']);
    assert.deepEqual(parseCoffImports(coffImports()), []);
  });

  it('should detect the container format from the leading magic bytes', () => {
    assert.equal(detectBinaryFormat(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02])), 'elf');
    assert.equal(detectBinaryFormat(Buffer.from([0xcf, 0xfa, 0xed, 0xfe])), 'macho');
    assert.equal(detectBinaryFormat(Buffer.from([0xce, 0xfa, 0xed, 0xfe])), 'macho');
    assert.equal(detectBinaryFormat(Buffer.from([0x4d, 0x5a, 0x90, 0x00])), 'pe');
    assert.equal(detectBinaryFormat(Buffer.from([0x00, 0x61, 0x73, 0x6d])), null);
    // A truncated upload has no magic to read, so it is unformatted rather
    // than accidentally matching a two-byte prefix.
    assert.equal(detectBinaryFormat(Buffer.from([0x4d, 0x5a, 0x90])), null);
    assert.equal(detectBinaryFormat(Buffer.alloc(0)), null);
  });
});

describe('native binary assertions', () => {
  it('should accept a correctly built binary for every format family', () => {
    assert.deepEqual(
      binaryFindings(
        targetFor('linux-x64-gnu'),
        observation({ glibcMax: '2.17', needed: ['libc.so.6', 'libgcc_s.so.1'] }),
      ),
      [],
    );
    assert.deepEqual(
      binaryFindings(
        targetFor('darwin-arm64'),
        observation({
          class: '64-bit',
          endianness: null,
          format: 'macho',
          machine: 'Arm64',
          minOs: '11.0',
          needed: ['/usr/lib/libSystem.B.dylib', '/System/Library/Frameworks/Metal.framework/Metal'],
        }),
        // An exported MACOSX_DEPLOYMENT_TARGET must not decide what this case
        // expects: '' is the explicit "no pin, use the toolchain floor".
        { macosDeploymentTarget: '' },
      ),
      [],
    );
    assert.deepEqual(
      binaryFindings(
        targetFor('win32-x64-msvc'),
        observation({
          endianness: null,
          format: 'pe',
          machine: 'IMAGE_FILE_MACHINE_AMD64',
          subsystem: 'IMAGE_SUBSYSTEM_WINDOWS_CUI',
          minOs: '6.0',
          needed: ['KERNEL32.dll', 'node.exe', 'api-ms-win-crt-runtime-l1-1-0.dll'],
        }),
      ),
      [],
    );
    assert.deepEqual(
      binaryFindings(
        targetFor('android-arm64'),
        observation({
          apiLevel: 24,
          machine: 'EM_AARCH64',
          needed: ['libc.so', 'libm.so', 'libdl.so', 'liblog.so'],
        }),
      ),
      [],
    );
  });

  it('should reject a binary whose architecture does not match its target', () => {
    const findings = binaryFindings(
      targetFor('linux-arm64-gnu'),
      observation({ glibcMax: '2.17', machine: 'EM_X86_64' }),
    );
    assert.equal(findings.length, 1);
    assert.match(findings[0], /linux-arm64-gnu: expected machine EM_AARCH64, found EM_X86_64/u);
  });

  it('should reject a binary whose word size does not match its target', () => {
    const findings = binaryFindings(
      targetFor('linux-arm-gnueabihf'),
      observation({
        class: '64-bit',
        glibcMax: '2.17',
        machine: 'EM_ARM',
        needed: ['libc.so.6'],
      }),
    );
    assert.deepEqual(findings, ['linux-arm-gnueabihf: expected class 32-bit, found 64-bit']);
  });

  it('should reject a little-endian s390x binary and accept the big-endian one', () => {
    assert.deepEqual(
      binaryFindings(
        targetFor('linux-s390x-gnu'),
        observation({ endianness: 'BigEndian', glibcMax: '2.17', machine: 'EM_S390' }),
      ),
      [],
    );
    assert.deepEqual(
      binaryFindings(
        targetFor('linux-s390x-gnu'),
        observation({ endianness: 'LittleEndian', glibcMax: '2.17', machine: 'EM_S390' }),
      ),
      ['linux-s390x-gnu: expected data encoding BigEndian, found LittleEndian'],
    );
  });

  it('should reject an ARM hard-float target built without the hard-float EABI flag', () => {
    const softFloat = binaryFindings(
      targetFor('linux-arm-gnueabihf'),
      observation({
        class: '32-bit',
        flags: 0x5_000_200,
        glibcMax: '2.17',
        machine: 'EM_ARM',
      }),
    );
    assert.deepEqual(softFloat, [
      'linux-arm-gnueabihf: expected the EF_ARM_ABI_FLOAT_HARD flag, found flags 0x5000200',
    ]);
    assert.deepEqual(
      binaryFindings(
        targetFor('linux-arm-gnueabihf'),
        observation({
          class: '32-bit',
          flags: 0x5_000_400,
          glibcMax: '2.17',
          machine: 'EM_ARM',
        }),
      ),
      [],
    );
  });

  it('should reject a glibc row that requires a symbol version above 2.17', () => {
    assert.deepEqual(binaryFindings(targetFor('linux-x64-gnu'), observation({ glibcMax: '2.34' })), [
      'linux-x64-gnu: requires GLIBC_2.34, above the 2.17 floor',
    ]);
    assert.deepEqual(binaryFindings(targetFor('linux-x64-gnu'), observation({ glibcMax: '2.4' })), []);
  });

  it('should reject a dynamically linked interpreter', () => {
    const findings = binaryFindings(
      targetFor('linux-x64-gnu'),
      observation({ glibcMax: '2.17', programHeaders: ['PT_LOAD', 'PT_INTERP'] }),
    );
    assert.deepEqual(findings, ['linux-x64-gnu: carries a PT_INTERP program header']);
  });

  it('should reject a dependency outside the allow-list for its libc family', () => {
    assert.deepEqual(
      binaryFindings(
        targetFor('linux-x64-gnu'),
        observation({ glibcMax: '2.17', needed: ['libc.so.6', 'libvulkan.so.1'] }),
      ),
      ['linux-x64-gnu: unexpected dynamic dependency libvulkan.so.1'],
    );
    assert.deepEqual(
      binaryFindings(
        targetFor('android-arm64'),
        observation({ apiLevel: 24, machine: 'EM_AARCH64', needed: ['libc.so', 'libandroid.so'] }),
      ),
      ['android-arm64: unexpected dynamic dependency libandroid.so'],
    );
    assert.deepEqual(
      binaryFindings(
        targetFor('darwin-x64'),
        observation({
          class: '64-bit',
          endianness: null,
          format: 'macho',
          machine: 'X86-64',
          minOs: '10.12',
          needed: ['/opt/homebrew/lib/libpng.dylib'],
        }),
        { macosDeploymentTarget: '' },
      ),
      ['darwin-x64: unexpected dynamic dependency /opt/homebrew/lib/libpng.dylib'],
    );
    assert.deepEqual(
      binaryFindings(
        targetFor('win32-x64-msvc'),
        observation({
          endianness: null,
          format: 'pe',
          machine: 'IMAGE_FILE_MACHINE_AMD64',
          subsystem: 'IMAGE_SUBSYSTEM_WINDOWS_CUI',
          minOs: '6.0',
          needed: ['KERNEL32.dll', 'CYGWIN1.DLL'],
        }),
      ),
      ['win32-x64-msvc: unexpected dynamic dependency CYGWIN1.DLL'],
    );
  });

  it('should reject an Android binary built against the wrong NDK API level', () => {
    assert.deepEqual(
      binaryFindings(
        targetFor('android-arm64'),
        observation({ apiLevel: 21, machine: 'EM_AARCH64', needed: ['libc.so'] }),
      ),
      ['android-arm64: expected Android API level 24, found 21'],
    );
    assert.deepEqual(
      binaryFindings(
        targetFor('android-arm64'),
        observation({ apiLevel: null, machine: 'EM_AARCH64', needed: ['libc.so'] }),
      ),
      ['android-arm64: has no .note.android.ident API level'],
    );
  });

  it('should reject a macOS binary whose deployment floor differs from the pinned one', () => {
    const target = targetFor('darwin-x64');
    const macho = observation({
      class: '64-bit',
      endianness: null,
      format: 'macho',
      machine: 'X86-64',
      minOs: '10.12',
      needed: ['/usr/lib/libSystem.B.dylib'],
    });
    assert.deepEqual(binaryFindings(target, macho, { macosDeploymentTarget: '' }), []);
    assert.deepEqual(binaryFindings(target, macho, { macosDeploymentTarget: '10.13' }), [
      'darwin-x64: expected LC_BUILD_VERSION minos 10.13, found 10.12',
    ]);
    // The arm64 slice cannot go below macOS 11.0, so a lower pin never lowers it.
    assert.deepEqual(
      binaryFindings(
        targetFor('darwin-arm64'),
        observation({
          class: '64-bit',
          endianness: null,
          format: 'macho',
          machine: 'Arm64',
          minOs: '11.0',
          needed: ['/usr/lib/libSystem.B.dylib'],
        }),
        { macosDeploymentTarget: '10.13' },
      ),
      [],
    );
  });

  it('should reject a glibc row that proves no symbol-version floor at all', () => {
    // A binary that links no versioned glibc symbol cannot demonstrate it runs
    // on 2.17; silence here would publish an unproven floor.
    assert.deepEqual(binaryFindings(targetFor('linux-x64-gnu'), observation({ glibcMax: null })), [
      'linux-x64-gnu: requires no versioned glibc symbol, so the 2.17 floor is unproven',
    ]);
  });

  it('should reject a Mach-O slice built for a platform other than macOS', () => {
    assert.deepEqual(
      binaryFindings(
        targetFor('darwin-arm64'),
        observation({
          class: '64-bit',
          endianness: null,
          format: 'macho',
          machine: 'Arm64',
          minOs: '11.0',
          needed: ['/usr/lib/libSystem.B.dylib'],
          platform: 'ios',
        }),
        { macosDeploymentTarget: '' },
      ),
      ['darwin-arm64: expected the macos build platform, found ios'],
    );
  });

  it('should reject a PE image that is not linked as a library', () => {
    const pe = (overrides) =>
      binaryFindings(
        targetFor('win32-x64-msvc'),
        observation({
          endianness: null,
          format: 'pe',
          machine: 'IMAGE_FILE_MACHINE_AMD64',
          minOs: '6.0',
          needed: ['KERNEL32.dll'],
          subsystem: 'IMAGE_SUBSYSTEM_WINDOWS_CUI',
          ...overrides,
        }),
      );

    assert.deepEqual(pe({ subsystem: 'IMAGE_SUBSYSTEM_EFI_APPLICATION' }), [
      'win32-x64-msvc: expected a DLL subsystem, found IMAGE_SUBSYSTEM_EFI_APPLICATION',
    ]);
    assert.deepEqual(pe({ minOs: '5.1' }), [
      'win32-x64-msvc: expected subsystem version 6.0 or later, found 5.1',
    ]);
  });

  it('should reject a PE image whose subsystem version is absent or unparsed', () => {
    const pe = (minOs) =>
      binaryFindings(
        targetFor('win32-ia32-msvc'),
        observation({
          class: '32-bit',
          endianness: null,
          format: 'pe',
          machine: 'IMAGE_FILE_MACHINE_I386',
          minOs,
          needed: ['KERNEL32.dll'],
          subsystem: 'IMAGE_SUBSYSTEM_WINDOWS_GUI',
        }),
      );

    assert.deepEqual(pe(null), ['win32-ia32-msvc: expected a numeric subsystem version, found null']);
    // The regression: a header parsed without its version lines once produced
    // this string, which compared as NaN and passed the floor check silently.
    assert.deepEqual(pe('undefined.undefined'), [
      'win32-ia32-msvc: expected a numeric subsystem version, found undefined.undefined',
    ]);
  });

  it('should reject a binary stored in the wrong container format', () => {
    assert.deepEqual(binaryFindings(targetFor('win32-arm64-msvc'), observation({ machine: 'EM_AARCH64' })), [
      'win32-arm64-msvc: expected a pe binary, found elf',
    ]);
  });
});

describe('native package inventory assertions', () => {
  const inventoryOf = (overrides = {}) =>
    Object.fromEntries(
      packages.map((target, index) => [
        target.suffix,
        { sha256: String(index).padStart(64, '0'), ...overrides[target.suffix] },
      ]),
    );

  it('should accept sixteen distinct binaries, one per configured target', () => {
    assert.deepEqual(inventoryFindings({ inventory: inventoryOf(), packages, stray: [] }), []);
  });

  it('should reject a missing target package binary', () => {
    const inventory = inventoryOf();
    delete inventory['linux-ppc64-gnu'];
    assert.deepEqual(inventoryFindings({ inventory, packages, stray: [] }), [
      'linux-ppc64-gnu: npm/linux-ppc64-gnu/nanoraster.linux-ppc64-gnu.node is missing',
    ]);
  });

  it('should reject a stray or mis-suffixed native binary', () => {
    assert.deepEqual(
      inventoryFindings({
        inventory: inventoryOf(),
        packages,
        stray: ['npm/linux-x64-gnu/nanoraster.linux-x64-musl.node', 'npm/oops/index.node'],
      }),
      [
        'npm/linux-x64-gnu/nanoraster.linux-x64-musl.node is not a configured target binary',
        'npm/oops/index.node is not a configured target binary',
      ],
    );
  });

  it('should reject two targets that ship byte-identical binaries', () => {
    const duplicate = 'f'.repeat(64);
    const inventory = inventoryOf({
      'linux-arm64-gnu': { sha256: duplicate },
      'linux-arm64-musl': { sha256: duplicate },
    });
    assert.deepEqual(inventoryFindings({ inventory, packages, stray: [] }), [
      `linux-arm64-gnu, linux-arm64-musl: share the identical binary ${duplicate}`,
    ]);
  });
});
