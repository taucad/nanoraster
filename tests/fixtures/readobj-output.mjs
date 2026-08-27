// Recorded llvm-readobj / llvm-objdump output used to unit-test the parsers in
// `scripts/inspect-native.mjs` without a sixteen-target build.
//
// Every constant below is REAL output captured on 2026-08-22 from the tool
// versions the repository pinned when the fixture was captured (rustup 1.88.0
// `llvm-tools-preview`, LLVM 20.1.5). Only the leading `File:` path was
// rewritten to the assembly-time path so the fixtures read like an inspection
// run.
//
// Provenance of the inspected binaries:
//   - Mach-O arm64: the real addon from `pnpm run build:napi` on this host.
//   - ELF and PE: probe shared objects produced from one LLVM IR function with
//     the pinned `llc` and `rust-lld` for each target machine. They exercise
//     the header fields the script asserts (class, data encoding, e_machine,
//     ARM float ABI flag, program-header types, PE machine/subsystem) with
//     genuine tool output; they are not nanoraster builds and therefore carry
//     no realistic dynamic-dependency set.
//   - The Android identification note is a real `.note.android.ident` section
//     (API level 24, NDK r27c) added to the probe with `llvm-objcopy`.
//
// The negative and dependency-set cases the script must reject are derived in
// `tests/inspect-native.test.mjs` by substituting fields in these recorded
// strings; those derivations are labelled synthetic where they appear.

export const ELF_FILE_HEADERS_LINUX_X64_GNU = `
File: npm/linux-x64-gnu/nanoraster.linux-x64-gnu.node
Format: elf64-x86-64
Arch: x86_64
AddressSize: 64bit
LoadName: <Not found>
ElfHeader {
  Ident {
    Magic: (7F 45 4C 46)
    Class: 64-bit (0x2)
    DataEncoding: LittleEndian (0x1)
    FileVersion: 1
    OS/ABI: SystemV (0x0)
    ABIVersion: 0
    Unused: (00 00 00 00 00 00 00)
  }
  Type: SharedObject (0x3)
  Machine: EM_X86_64 (0x3E)
  Version: 1
  Entry: 0x0
  ProgramHeaderOffset: 0x40
  SectionHeaderOffset: 0x458
  Flags [ (0x0)
  ]
  HeaderSize: 64
  ProgramHeaderEntrySize: 56
  ProgramHeaderCount: 7
  SectionHeaderEntrySize: 64
  SectionHeaderCount: 13
  StringTableSectionIndex: 11
}
`;

export const ELF_FILE_HEADERS_LINUX_ARM64_GNU = `
File: npm/linux-arm64-gnu/nanoraster.linux-arm64-gnu.node
Format: elf64-littleaarch64
Arch: aarch64
AddressSize: 64bit
LoadName: <Not found>
ElfHeader {
  Ident {
    Magic: (7F 45 4C 46)
    Class: 64-bit (0x2)
    DataEncoding: LittleEndian (0x1)
    FileVersion: 1
    OS/ABI: SystemV (0x0)
    ABIVersion: 0
    Unused: (00 00 00 00 00 00 00)
  }
  Type: SharedObject (0x3)
  Machine: EM_AARCH64 (0xB7)
  Version: 1
  Entry: 0x0
  ProgramHeaderOffset: 0x40
  SectionHeaderOffset: 0x488
  Flags [ (0x0)
  ]
  HeaderSize: 64
  ProgramHeaderEntrySize: 56
  ProgramHeaderCount: 7
  SectionHeaderEntrySize: 64
  SectionHeaderCount: 13
  StringTableSectionIndex: 11
}
`;

export const ELF_FILE_HEADERS_LINUX_ARM_GNUEABIHF = `
File: npm/linux-arm-gnueabihf/nanoraster.linux-arm-gnueabihf.node
Format: elf32-littlearm
Arch: arm
AddressSize: 32bit
LoadName: <Not found>
ElfHeader {
  Ident {
    Magic: (7F 45 4C 46)
    Class: 32-bit (0x1)
    DataEncoding: LittleEndian (0x1)
    FileVersion: 1
    OS/ABI: SystemV (0x0)
    ABIVersion: 0
    Unused: (00 00 00 00 00 00 00)
  }
  Type: SharedObject (0x3)
  Machine: EM_ARM (0x28)
  Version: 1
  Entry: 0x0
  ProgramHeaderOffset: 0x34
  SectionHeaderOffset: 0x3DC
  Flags [ (0x5000400)
    0x400
    0x1000000
    0x4000000
  ]
  HeaderSize: 52
  ProgramHeaderEntrySize: 32
  ProgramHeaderCount: 8
  SectionHeaderEntrySize: 40
  SectionHeaderCount: 14
  StringTableSectionIndex: 12
}
`;

export const ELF_FILE_HEADERS_LINUX_S390X_GNU = `
File: npm/linux-s390x-gnu/nanoraster.linux-s390x-gnu.node
Format: elf64-s390
Arch: s390x
AddressSize: 64bit
LoadName: <Not found>
ElfHeader {
  Ident {
    Magic: (7F 45 4C 46)
    Class: 64-bit (0x2)
    DataEncoding: BigEndian (0x2)
    FileVersion: 1
    OS/ABI: SystemV (0x0)
    ABIVersion: 0
    Unused: (00 00 00 00 00 00 00)
  }
  Type: SharedObject (0x3)
  Machine: EM_S390 (0x16)
  Version: 1
  Entry: 0x0
  ProgramHeaderOffset: 0x40
  SectionHeaderOffset: 0x458
  Flags [ (0x0)
  ]
  HeaderSize: 64
  ProgramHeaderEntrySize: 56
  ProgramHeaderCount: 7
  SectionHeaderEntrySize: 64
  SectionHeaderCount: 13
  StringTableSectionIndex: 11
}
`;

export const ELF_FILE_HEADERS_LINUX_PPC64_GNU = `
File: npm/linux-ppc64-gnu/nanoraster.linux-ppc64-gnu.node
Format: elf64-powerpcle
Arch: powerpc64le
AddressSize: 64bit
LoadName: <Not found>
ElfHeader {
  Ident {
    Magic: (7F 45 4C 46)
    Class: 64-bit (0x2)
    DataEncoding: LittleEndian (0x1)
    FileVersion: 1
    OS/ABI: SystemV (0x0)
    ABIVersion: 0
    Unused: (00 00 00 00 00 00 00)
  }
  Type: SharedObject (0x3)
  Machine: EM_PPC64 (0x15)
  Version: 1
  Entry: 0x0
  ProgramHeaderOffset: 0x40
  SectionHeaderOffset: 0x4B0
  Flags [ (0x2)
    0x2
  ]
  HeaderSize: 64
  ProgramHeaderEntrySize: 56
  ProgramHeaderCount: 7
  SectionHeaderEntrySize: 64
  SectionHeaderCount: 14
  StringTableSectionIndex: 12
}
`;

export const ELF_FILE_HEADERS_ANDROID_ARM_EABI = `
File: npm/android-arm-eabi/nanoraster.android-arm-eabi.node
Format: elf32-littlearm
Arch: arm
AddressSize: 32bit
LoadName: <Not found>
ElfHeader {
  Ident {
    Magic: (7F 45 4C 46)
    Class: 32-bit (0x1)
    DataEncoding: LittleEndian (0x1)
    FileVersion: 1
    OS/ABI: SystemV (0x0)
    ABIVersion: 0
    Unused: (00 00 00 00 00 00 00)
  }
  Type: SharedObject (0x3)
  Machine: EM_ARM (0x28)
  Version: 1
  Entry: 0x0
  ProgramHeaderOffset: 0x34
  SectionHeaderOffset: 0x380
  Flags [ (0x5000200)
    0x200
    0x1000000
    0x4000000
  ]
  HeaderSize: 52
  ProgramHeaderEntrySize: 32
  ProgramHeaderCount: 8
  SectionHeaderEntrySize: 40
  SectionHeaderCount: 14
  StringTableSectionIndex: 12
}
`;

export const ELF_PROGRAM_HEADERS_LINUX_X64_GNU = `
File: npm/linux-x64-gnu/nanoraster.linux-x64-gnu.node
Format: elf64-x86-64
Arch: x86_64
AddressSize: 64bit
LoadName: <Not found>
ProgramHeaders [
  ProgramHeader {
    Type: PT_PHDR (0x6)
    Offset: 0x40
    VirtualAddress: 0x40
    PhysicalAddress: 0x40
    FileSize: 392
    MemSize: 392
    Flags [ (0x4)
      PF_R (0x4)
    ]
    Alignment: 8
  }
  ProgramHeader {
    Type: PT_LOAD (0x1)
    Offset: 0x0
    VirtualAddress: 0x0
    PhysicalAddress: 0x0
    FileSize: 636
    MemSize: 636
    Flags [ (0x4)
      PF_R (0x4)
    ]
    Alignment: 4096
  }
  ProgramHeader {
    Type: PT_LOAD (0x1)
    Offset: 0x280
    VirtualAddress: 0x1280
    PhysicalAddress: 0x1280
    FileSize: 3
    MemSize: 3
    Flags [ (0x5)
      PF_R (0x4)
      PF_X (0x1)
    ]
    Alignment: 4096
  }
  ProgramHeader {
    Type: PT_LOAD (0x1)
    Offset: 0x288
    VirtualAddress: 0x2288
    PhysicalAddress: 0x2288
    FileSize: 112
    MemSize: 3448
    Flags [ (0x6)
      PF_R (0x4)
      PF_W (0x2)
    ]
    Alignment: 4096
  }
  ProgramHeader {
    Type: PT_DYNAMIC (0x2)
    Offset: 0x288
    VirtualAddress: 0x2288
    PhysicalAddress: 0x2288
    FileSize: 112
    MemSize: 112
    Flags [ (0x6)
      PF_R (0x4)
      PF_W (0x2)
    ]
    Alignment: 8
  }
  ProgramHeader {
    Type: PT_GNU_RELRO (0x6474E552)
    Offset: 0x288
    VirtualAddress: 0x2288
    PhysicalAddress: 0x2288
    FileSize: 112
    MemSize: 3448
    Flags [ (0x4)
      PF_R (0x4)
    ]
    Alignment: 1
  }
  ProgramHeader {
    Type: PT_GNU_STACK (0x6474E551)
    Offset: 0x0
    VirtualAddress: 0x0
    PhysicalAddress: 0x0
    FileSize: 0
    MemSize: 0
    Flags [ (0x6)
      PF_R (0x4)
      PF_W (0x2)
    ]
    Alignment: 0
  }
]
`;

export const ELF_NEEDED_LIBRARIES_LINUX_ARM64_GNU = `
File: npm/linux-arm64-gnu/nanoraster.linux-arm64-gnu.node
Format: elf64-littleaarch64
Arch: aarch64
AddressSize: 64bit
LoadName: <Not found>
NeededLibraries [
  libc.so.6
]
`;

export const ELF_NOTES_ANDROID_ARM64 = `
File: npm/android-arm64/nanoraster.android-arm64.node
Format: elf64-littleaarch64
Arch: aarch64
AddressSize: 64bit
LoadName: <Not found>
NoteSections [
  NoteSection {
    Name: .note.android.ident
    Offset: 0x490
    Size: 0x98
    Notes [
      {
        Owner: Android
        Data size: 0x84
        Type: NT_ANDROID_TYPE_IDENT
        Description data (
          0000: 18000000 72323763 00000000 00000000  |....r27c........|
          0010: 00000000 00000000 00000000 00000000  |................|
          0020: 00000000 00000000 00000000 00000000  |................|
          0030: 00000000 00000000 00000000 00000000  |................|
          0040: 00000000 31323437 39303138 00000000  |....12479018....|
          0050: 00000000 00000000 00000000 00000000  |................|
          0060: 00000000 00000000 00000000 00000000  |................|
          0070: 00000000 00000000 00000000 00000000  |................|
          0080: 00000000                             |....|
        )
      }
    ]
  }
]
`;

export const MACHO_FILE_HEADERS_DARWIN_ARM64 = `
File: npm/darwin-arm64/nanoraster.darwin-arm64.node
Format: Mach-O arm64
Arch: aarch64
AddressSize: 64bit
MachHeader {
  Magic: Magic64 (0xFEEDFACF)
  CpuType: Arm64 (0x100000C)
  CpuSubType: CPU_SUBTYPE_ARM64_ALL (0x0)
  FileType: DynamicLibrary (0x6)
  NumOfLoadCommands: 22
  SizeOfLoadCommands: 2880
  Flags [ (0x900085)
    MH_DYLDLINK (0x4)
    MH_HAS_TLV_DESCRIPTORS (0x800000)
    MH_NOUNDEFS (0x1)
    MH_NO_REEXPORTED_DYLIBS (0x100000)
    MH_TWOLEVEL (0x80)
  ]
  Reserved: 0x0
}
`;

export const MACHO_NEEDED_LIBRARIES_DARWIN_ARM64 = `
File: npm/darwin-arm64/nanoraster.darwin-arm64.node
Format: Mach-O arm64
Arch: aarch64
AddressSize: 64bit
NeededLibraries [
  /System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation
  /System/Library/Frameworks/CoreGraphics.framework/Versions/A/CoreGraphics
  /System/Library/Frameworks/Foundation.framework/Versions/C/Foundation
  /System/Library/Frameworks/Metal.framework/Versions/A/Metal
  /System/Library/Frameworks/QuartzCore.framework/Versions/A/QuartzCore
  /Users/runner/work/nanoraster/nanoraster/rust/target/aarch64-apple-darwin/release/deps/librender_napi.dylib
  /usr/lib/libSystem.B.dylib
  /usr/lib/libiconv.2.dylib
  /usr/lib/libobjc.A.dylib
]
`;

export const MACHO_VERSION_MIN_DARWIN_ARM64 = `
File: npm/darwin-arm64/nanoraster.darwin-arm64.node
Format: Mach-O arm64
Arch: aarch64
AddressSize: 64bit
MinVersion {
  Cmd: LC_BUILD_VERSION
  Size: 32
  Platform: macos
  Version: 11.0
  SDK: 26.5
}
`;

export const MACHO_DYLIB_ID_DARWIN_ARM64 = `npm/darwin-arm64/nanoraster.darwin-arm64.node:
/Users/runner/work/nanoraster/nanoraster/rust/target/aarch64-apple-darwin/release/deps/librender_napi.dylib
`;

export const PE_FILE_HEADERS_WIN32_IA32_MSVC = `
File: npm/win32-ia32-msvc/nanoraster.win32-ia32-msvc.node
Format: COFF-i386
Arch: i386
AddressSize: 32bit
ImageFileHeader {
  Machine: IMAGE_FILE_MACHINE_I386 (0x14C)
  SectionCount: 1
  TimeDateStamp: 2026-08-22 06:44:19 (0x6A894543)
  PointerToSymbolTable: 0x0
  SymbolCount: 0
  StringTableSize: 0
  OptionalHeaderSize: 224
  Characteristics [ (0x2102)
    IMAGE_FILE_32BIT_MACHINE (0x100)
    IMAGE_FILE_DLL (0x2000)
    IMAGE_FILE_EXECUTABLE_IMAGE (0x2)
  ]
}
ImageOptionalHeader {
  Magic: 0x10B
  MajorLinkerVersion: 14
  MinorLinkerVersion: 0
  SizeOfCode: 512
  SizeOfInitializedData: 0
  SizeOfUninitializedData: 0
  AddressOfEntryPoint: 0x0
  BaseOfCode: 0x1000
  BaseOfData: 0x0
  ImageBase: 0x10000000
  SectionAlignment: 4096
  FileAlignment: 512
  MajorOperatingSystemVersion: 6
  MinorOperatingSystemVersion: 0
  MajorImageVersion: 0
  MinorImageVersion: 0
  MajorSubsystemVersion: 6
  MinorSubsystemVersion: 0
  SizeOfImage: 8192
  SizeOfHeaders: 512
  CheckSum: 0x0
  Subsystem: IMAGE_SUBSYSTEM_WINDOWS_GUI (0x2)
  Characteristics [ (0x540)
    IMAGE_DLL_CHARACTERISTICS_DYNAMIC_BASE (0x40)
    IMAGE_DLL_CHARACTERISTICS_NO_SEH (0x400)
    IMAGE_DLL_CHARACTERISTICS_NX_COMPAT (0x100)
  ]
  SizeOfStackReserve: 1048576
  SizeOfStackCommit: 4096
  SizeOfHeapReserve: 1048576
  SizeOfHeapCommit: 4096
  NumberOfRvaAndSize: 16
  DataDirectory {
    ExportTableRVA: 0x0
    ExportTableSize: 0x0
    ImportTableRVA: 0x0
    ImportTableSize: 0x0
    ResourceTableRVA: 0x0
    ResourceTableSize: 0x0
    ExceptionTableRVA: 0x0
    ExceptionTableSize: 0x0
    CertificateTableRVA: 0x0
    CertificateTableSize: 0x0
    BaseRelocationTableRVA: 0x0
    BaseRelocationTableSize: 0x0
    DebugRVA: 0x0
    DebugSize: 0x0
    ArchitectureRVA: 0x0
    ArchitectureSize: 0x0
    GlobalPtrRVA: 0x0
    GlobalPtrSize: 0x0
    TLSTableRVA: 0x0
    TLSTableSize: 0x0
    LoadConfigTableRVA: 0x0
    LoadConfigTableSize: 0x0
    BoundImportRVA: 0x0
    BoundImportSize: 0x0
    IATRVA: 0x0
    IATSize: 0x0
    DelayImportDescriptorRVA: 0x0
    DelayImportDescriptorSize: 0x0
    CLRRuntimeHeaderRVA: 0x0
    CLRRuntimeHeaderSize: 0x0
    ReservedRVA: 0x0
    ReservedSize: 0x0
  }
}
DOSHeader {
  Magic: MZ
  UsedBytesInTheLastPage: 120
  FileSizeInPages: 1
  NumberOfRelocationItems: 0
  HeaderSizeInParagraphs: 4
  MinimumExtraParagraphs: 0
  MaximumExtraParagraphs: 0
  InitialRelativeSS: 0
  InitialSP: 0
  Checksum: 0
  InitialIP: 0
  InitialRelativeCS: 0
  AddressOfRelocationTable: 64
  OverlayNumber: 0
  OEMid: 0
  OEMinfo: 0
  AddressOfNewExeHeader: 120
}
`;
