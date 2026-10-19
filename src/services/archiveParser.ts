import { unzipSync, zipSync, unzlibSync, zlibSync } from 'fflate';
import {
  ArchiveEntry,
  ArchiveFormatId,
  ArchiveHeaderField,
  AssetCategory,
  FormatSpec,
  ParsedArchive,
} from '../types/archive';
import {
  parseT5T6FastFile,
  buildT5T6FastFileBinary,
  FastFileZoneState,
} from './t5t6FastFile';
import { parseUniversalFastFile } from './codFastFiles';
import { parsePs1DiscArchive } from './ps1Parser';
import { parseUnityArchive } from './unityParser';
import { parseUnrealArchive, UNREAL_PAK_MAGIC, UNREAL_PACKAGE_MAGIC } from './unrealParser';
import { parseFf13Archive } from './ff13Parser';
import { parseIdTech6Archive } from './idTech6Parser';
import { parseBinkVideo } from './binkParser';
import { parseXbox360GodArchive, parseXbox360Xex, isGdfxFilesystem } from './xbox360Parser';
import { parseXboxGdkAppxArchive } from './xboxGdkAppxParser';
import { parseNdsRomArchive, isNdsRom, parseClassicConsoleRom } from './romParser';
import { isBethesdaArchive, parseBethesdaArchive } from './bethesdaParser';
import { isUbisoftForge, parseUbisoftForge } from './ubisoftParser';
import { isRockstarRage, parseRockstarRage } from './rockstarParser';
import { isMinecraftJar, parseMinecraftJar } from './minecraftParser';
import { isPlaystationPkg, parsePlaystationPkg } from './playstationPkgParser';
import { isCriwareArchive, parseCriwareArchive } from './criwareParser';
import { isFromSoftArchive, parseFromSoftArchive } from './fromSoftParser';
import { isSquareArchive, parseSquareArchive } from './squareParser';

export const FORMAT_SPECS: FormatSpec[] = [
  {
    id: 'FF',
    ext: '.ff',
    name: 'Call of Duty FastFile (T4-T10 & IW3-IW10)',
    engines: 'Treyarch T4-T10 (WaW, BO1-BO6) / Infinity Ward IW3-IW10 (MW1-MW3, Ghosts, IW, MW2019-MWIII)',
    magicSignature: 'TAffu100 / TAff0100 / IWffu100 / IWff0100',
    compression: 'BO2: Raw-Deflate (-15) + 0x7FC0 Blocks · BO1/IW: Zlib Stream · LZ4/Oodle',
    canRepack: true,
    description:
      'Universal Call of Duty FastFile suite. Supports BO2 (TAffu100) and BO1 (IWffu100) zone recompilation, GSC bytecode disassembler, StringTable CSV grid, plus CoD4, WaW, MW2, MW3, Ghosts, BO3, and modern fastfiles.',
  },
  {
    id: 'PS1',
    ext: '.bin / .cue / .iso',
    name: 'Sony PlayStation 1 Optical Disc',
    engines: 'PlayStation 1 (PSX / PSOne) CD-ROM & CD-XA',
    magicSignature: '00 FF FF FF... (Raw 2352 B) / "CD001" (Sector 16 / 0x9300)',
    compression: 'Raw CD-XA Mode 2 Form 1 (2352 Bytes/Sector) & ISO 9660 Mode 1',
    canRepack: false,
    description:
      'Inspects PlayStation 1 raw CD-XA and Mode 1 disc images. Traverses ISO9660 directory hierarchy, reads SYSTEM.CNF boot executables, identifies serial codes (SLUS, SLES, SCUS), and decodes PS1 .TIM textures and .STR videos.',
  },
  {
    id: 'UNITY',
    ext: '.assets / .unity3d / .bundle',
    name: 'Unity Engine Serialized Assets & Bundles',
    engines: 'Unity Engine (Unity 4.x - 2023.x / UnityFS)',
    magicSignature: '55 6E 69 74 79 46 53 (UnityFS) / Big-Endian SerializedFile Header',
    compression: 'LZ4 / LZMA / Uncompressed Serialized Object Table',
    canRepack: false,
    description:
      'Inspects Unity SerializedFile (.assets) and UnityFS web/asset bundles. Reads engine revision, target platform, object tables, shaders, and text assets.',
  },
  {
    id: 'UNREAL',
    ext: '.pak / .uasset / .umap',
    name: 'Unreal Engine 4 & 5 Packages & PAK',
    engines: 'Epic Games Unreal Engine 4 / 5',
    magicSignature: '5A 6F 12 E1 (Footer Magic) / 9E 2A 83 C1 (UAsset Header)',
    compression: 'Zlib / Oodle / LZ4 Chunks & Name Table Serialization',
    canRepack: false,
    description:
      'Unpacks Unreal Engine 4 and 5 .pak virtual directories via footer seek table and inspects .uasset / .umap packages, decoding Name Tables, classes, and asset dependencies.',
  },
  {
    id: 'FF13',
    ext: '.bin / .wbd / .img / .dat',
    name: 'Final Fantasy XIII Trilogy (White Data)',
    engines: 'Square Enix Crystal Tools (FFXIII, FFXIII-2, Lightning Returns)',
    magicSignature: 'White Data Filelist Table / 2048-Byte Sector Blocks',
    compression: 'Sector-aligned 2048-byte Zlib Chunks + Filelist V1/V2 Table',
    canRepack: false,
    description:
      'Final Fantasy XIII trilogy white_data archive parser based on open-source ff13tool / WhiteBinTools. Unpacks filelist.bin, white_imgc.bin, .wbd, and .dat containers.',
  },
  {
    id: 'IDTECH',
    ext: '.resource / .index / .bmodel',
    name: 'id Tech 6 DOOM 2016 Container',
    engines: 'id Software id Tech 6 (DOOM 2016, DOOM Eternal)',
    magicSignature: '52 45 53 00 (RES\\0) / 1B 4C 4D 42 (\\x1bLMB BModel)',
    compression: 'Zlib / Deflate Compressed Asset Streams & Big-Endian Offsets',
    canRepack: false,
    description:
      'DOOM 2016 resource and binary model inspector based on emoose/DOOMExtract. Reads .resource/.index archives and inspects .bmodel 3D mesh geometry.',
  },
  {
    id: 'BIK',
    ext: '.bik / .bk2',
    name: 'RAD Game Tools Bink Video',
    engines: 'Call of Duty, DOOM 2016, Unreal Engine, Source Engine, 2K, EA',
    magicSignature: '42 49 4B * (BIKi/b/d/f/g/h) / 4B 42 32 * (KB2a..k)',
    compression: 'Bink 1 & Bink 2 DCT / Wavelet Motion Video & Multichannel Audio',
    canRepack: false,
    description:
      'Cinematic video file format used across Call of Duty, DOOM, and thousands of PC/console titles. Inspects framerate, duration, resolution, audio tracks, and frame seek tables.',
  },
  {
    id: 'GOD',
    ext: '.god / .header / Data0000 / CON / LIVE / PIRS',
    name: 'Xbox 360 Games on Demand (GOD) Container',
    engines: 'Microsoft Xbox 360 (XContent / Games on Demand / XDVDFS GDFX)',
    magicSignature: '4C 49 56 45 (LIVE) / 50 49 52 53 (PIRS) / 43 4F 4E 20 (CON )',
    compression: '4KB Block Allocation Mapping / GDFX 2048-Byte Sector Filesystem',
    canRepack: false,
    description:
      'Xbox 360 Game on Demand package and XContent container. Inspects Title ID, Media ID, UTF-16 dashboard titles, embedded PNG icons, and traverses internal GDFX disc virtual filesystem extracting default.xex and fastfiles.',
  },
  {
    id: 'XEX',
    ext: '.xex / default.xex',
    name: 'Xbox 360 Executable (XEX2 / XEX1)',
    engines: 'Microsoft Xbox 360 Native PowerPC (PPC32 PE)',
    magicSignature: '58 45 58 32 (XEX2) / 58 45 58 31 (XEX1)',
    compression: 'Big-Endian Optional Headers / Embedded PE32 Sections & RSA Cert',
    canRepack: false,
    description:
      'Xbox 360 native PowerPC executable binary. Decodes Optional Headers (Title ID, Base Address, Entry Point, Original PE Name), static libraries manifest (XAM, D3D9), security certificate, and extracts PE sections (.text, .rdata, .data, .rsrc).',
  },
  {
    id: 'APPX',
    ext: '.appx / .appxbundle / .msix / .msixbundle / .xvd / .xvc',
    name: 'Xbox One / Series & Windows GDK Package',
    engines: 'Microsoft Gaming Development Kit (GDK / Scarlett / Xbox One) & UWP',
    magicSignature: '50 4B 03 04 (Deflate OPC ZIP) / 6D 73 66 74 (msft XVD)',
    compression: 'OPC ZIP Deflate / SHA-256 BlockMap / XVD 4KB Sector Container',
    canRepack: false,
    description:
      'Universal package reader for Xbox One, Xbox Series X|S, Windows GDK PC, and UWP games. Parses MicrosoftGame.config, AppxManifest.xml, blockmaps, unpacks multi-architecture bundles, and extracts game executables, assets, and PRI resources.',
  },
  {
    id: 'NDS',
    ext: '.nds / .srl / .dsi',
    name: 'Nintendo DS ROM (NitroFS)',
    engines: 'Nintendo DS / DSi (ARM946E-S & ARM7TDMI)',
    magicSignature: 'Cartridge Header (0x0000..0x0200) / FNT & FAT NitroFS',
    compression: 'Uncompressed Direct Offset Virtual Filesystem (FAT Table + FNT Tree)',
    canRepack: false,
    description:
      'Inspects Nintendo DS / DSi cartridge ROMs. Decodes ARM9 and ARM7 processor executables, reads banner 32x32 4bpp color icons and 6-language UTF-16 titles, and fully extracts internal NitroFS filesystem (audio SDAT, 3D NSBMD, NARC packages, scripts).',
  },
  {
    id: 'ROM',
    ext: '.gba / .gb / .gbc / .z64 / .n64 / .sfc / .smc / .nes',
    name: 'Classic Console Cartridge ROM',
    engines: 'Nintendo (GBA, Game Boy, N64, SNES, NES)',
    magicSignature: 'Hardware Cartridge Header Signatures (NES\\x1A, 0x80371240 N64, 0x96 GBA)',
    compression: 'Cartridge Memory Bank Architecture (MBC / ASIC Mappers)',
    canRepack: false,
    description:
      'Inspects classic video game cartridge ROM dumps. Decodes internal game titles, hardware platform types, license codes, program/character bank memory allocations, and endianness layouts.',
  },
  {
    id: 'WAD',
    ext: '.wad',
    name: 'DOOM / Quake WAD Archive',
    engines: 'id Tech 1 / GoldSrc (DOOM, DOOM II, Heretic, Hexen, Half-Life)',
    magicSignature: '49 57 41 44 (IWAD) / 50 57 41 44 (PWAD) / 57 41 44 32 (WAD2)',
    compression: 'Uncompressed Lump Directory (16-byte directory entries)',
    canRepack: true,
    description:
      "Where's All the Data lump container storing PLAYPAL 256-color palettes, 64x64 floor flats, level geometry (VERTEXES, LINEDEFS, SECTORS), and sound lumps.",
  },
  {
    id: 'PAK',
    ext: '.pak',
    name: 'Quake / Half-Life PACK Container',
    engines: 'id Tech 1 & 2 / GoldSrc (Quake, Quake II, Half-Life, Hexen II)',
    magicSignature: '50 41 43 4B (PACK)',
    compression: 'Uncompressed 64-byte Directory Table (56B path + offset + size)',
    canRepack: true,
    description:
      'Direct-offset virtual filesystem tree used by id Tech engines for BSP levels, MDL models, WAV audio, and CFG scripts.',
  },
  {
    id: 'PK3',
    ext: '.pk3 / .pk4',
    name: 'id Tech 3 / 4 Package',
    engines: 'id Tech 3 / ioquake3 / id Tech 4 (Quake III Arena, RTCW, Doom 3)',
    magicSignature: '50 4B 03 04 (PK\\x03\\x04)',
    compression: 'DEFLATE / Store (ZIP virtual directory)',
    canRepack: true,
    description:
      'Standardized Deflate virtual filesystem containing .shader scripts, .bsp maps, .md3 models, .skin definitions, and bot scripts.',
  },
  {
    id: 'ISO',
    ext: '.iso',
    name: 'ISO 9660 Optical Disc Image',
    engines: 'PlayStation 2, PSP, Dreamcast, Saturn, PC CD/DVD-ROM',
    magicSignature: '01 43 44 30 30 31 01 (CD001 at Sector 16 / 0x8000)',
    compression: '2048-Byte Sector Uncompressed Extent Tree',
    canRepack: false,
    description:
      'Optical media filesystem image with Primary Volume Descriptor at sector 16 (0x8000) and hierarchical directory extent records.',
  },
  {
    id: 'PAR',
    ext: '.par',
    name: 'Ryu Ga Gotoku / Yakuza PARC Archive',
    engines: 'Dragon Engine / Magical V-Engine (Yakuza 0, Kiwami, Judgment)',
    magicSignature: '50 41 52 43 (PARC)',
    compression: 'Hybrid Raw + Zlib/Sega LZ Block Compression',
    canRepack: true,
    description:
      'Sega RGG Studio hierarchical package storing character parameters, stage layouts, textures, and motion tables.',
  },
  {
    id: 'BIG',
    ext: '.big',
    name: 'EA Games BIGF / BIG4 Archive',
    engines: 'SAGE Engine / EAGL (C&C Generals, BFME, Need for Speed, FIFA)',
    magicSignature: '42 49 47 46 (BIGF) / 42 49 47 34 (BIG4)',
    compression: 'Big-Endian Offset Table + RefPack / Raw Streams',
    canRepack: true,
    description:
      'Electronic Arts master archive format with big-endian offset headers and null-terminated relative file paths.',
  },
  {
    id: 'VPK',
    ext: '.vpk',
    name: 'Valve Pak Source Archive',
    engines: 'Source Engine / Source 2 (Half-Life 2, Portal 2, TF2, Left 4 Dead)',
    magicSignature: '34 12 AA 55 (0x55AA1234)',
    compression: '3-Tier Extension / Path / Filename Tree',
    canRepack: false,
    description:
      'Valve Source engine directory and inline payload container for VMT materials, VTF textures, and MDL meshes.',
  },
  {
    id: 'RAR',
    ext: '.rar',
    name: 'RAR v4 / v5 Game Distribution Archive',
    engines: 'Universal Mod Distribution / Scene Releases (RAR 1.5 - 5.0)',
    magicSignature: '52 61 72 21 1A 07 (Rar!\\x1A\\x07)',
    compression: 'RAR LZSS / PPM / Store Block Headers',
    canRepack: false,
    description:
      'Block-structured archive format parsed via binary header markers, CRC32 validation, and embedded stream extraction.',
  },
  {
    id: 'ZIP',
    ext: '.zip',
    name: 'Standard ZIP Game Mod Archive',
    engines: 'Universal Game Mods, Unity/Unreal Asset Bundles, Indie Engines',
    magicSignature: '50 4B 03 04 (PK\\x03\\x04)',
    compression: 'DEFLATE / Store (RFC 1951)',
    canRepack: true,
    description:
      'Universal compressed archive with full read, in-place file editing, and lossless repack support.',
  },
  {
    id: 'ZLIB',
    ext: '.zlib / .dat / .bin',
    name: 'Raw Zlib & Proprietary Stream Carver',
    engines: 'Custom Console/PC Engines, Compressed Save States, Raw Blobs',
    magicSignature: '78 9C / 78 DA / 78 01 (Zlib RFC 1950 Header)',
    compression: 'Zlib Deflate + Deep Signature Carving',
    canRepack: true,
    description:
      'Scans any binary file for RFC 1950 zlib streams, DDS/PNG textures, RIFF WAV audio, OGG Vorbis, and scripts, decompressing chunks automatically.',
  },
  {
    id: 'BSA',
    ext: '.bsa',
    name: 'Bethesda Softworks Archive',
    engines: 'Bethesda Gamebryo (Oblivion v103, Skyrim/Fallout 3/NV v104, Skyrim SE v105)',
    magicSignature: '42 53 41 00 (BSA\\0)',
    compression: 'Zlib Deflate / Uncompressed Directory Tree',
    canRepack: false,
    description:
      'Direct-offset hierarchical archive storing textures, meshes, sounds, and scripts for The Elder Scrolls and Fallout series.',
  },
  {
    id: 'BA2',
    ext: '.ba2',
    name: 'Bethesda Archive 2',
    engines: 'Bethesda Creation Engine 1 & 2 (Fallout 4, Starfield)',
    magicSignature: '42 54 44 58 (BTDX)',
    compression: 'Zlib Deflate Chunks / DX10 Textures Table',
    canRepack: false,
    description:
      'Next-generation Bethesda archive format with 64-bit alignment and dedicated GNRL (general) and DX10 (texture) chunk records.',
  },
  {
    id: 'FORGE',
    ext: '.forge',
    name: 'Ubisoft FORGE Container',
    engines: 'Ubisoft Anvil / Scimitar Engine (Assassin\'s Creed, Prince of Persia, Rainbow Six)',
    magicSignature: '73 63 69 6D 69 74 61 72 (scimitar\\0)',
    compression: 'LZO / Deflate Chunks + Asset Allocation Table',
    canRepack: false,
    description:
      'Ubisoft master game resource archive storing models, textures, animations, and sound banks indexed by 64-bit resource hashes.',
  },
  {
    id: 'RPF',
    ext: '.rpf',
    name: 'Rockstar RAGE Package',
    engines: 'Rockstar Advanced Game Engine (RPF2-RPF7: GTA IV, GTA V, Red Dead Redemption, Max Payne 3)',
    magicSignature: '52 50 46 30..37 (RPF0..RPF7)',
    compression: 'Zlib Deflate / Store + Names String Heap',
    canRepack: false,
    description:
      'Rockstar game archive format indexing raw assets, textures, scripts, and audio across generation 2 to 7 of the RAGE engine.',
  },
  {
    id: 'JAR',
    ext: '.jar',
    name: 'Minecraft Java Edition Mod JAR',
    engines: 'Minecraft Java Edition (Fabric, Forge, NeoForge, Quilt)',
    magicSignature: '50 4B 03 04 (PK\\x03\\x04)',
    compression: 'ZIP Deflate Virtual Filesystem',
    canRepack: true,
    description:
      'Java archive package containing compiled JVM bytecode classes, modloader manifests (fabric.mod.json, mods.toml), and resource assets.',
  },
  {
    id: 'PKG',
    ext: '.pkg',
    name: 'Sony PlayStation Package',
    engines: 'Sony Interactive Entertainment (PlayStation 3, PlayStation 4, PS Vita)',
    magicSignature: '7F 50 4B 47 (\\x7fPKG)',
    compression: 'Hardware DRM Envelope / AES Encrypted Blocks',
    canRepack: false,
    description:
      'Official PlayStation installation package container storing Content ID, PARAM.SFO metadata, EBOOT executables, and game assets.',
  },
  {
    id: 'CRIWARE',
    ext: '.awb / .acb / .usm / .adx / .hca',
    name: 'CRIWARE Atom Audio & Sofdec 2 Video',
    engines: 'CRI Middleware (Unreal, Unity, Bandai Namco, Sega, Capcom, Square Enix)',
    magicSignature: 'AFS2 / @UTF / CRID / HCA\\0 / 80 00 (ADX)',
    compression: 'HCA Transform Coding / ADX ADPCM / MPEG-2 & H.264 Multiplex',
    canRepack: false,
    description:
      'Comprehensive CRIWARE multimedia suite supporting AFS2 wave banks, @UTF cue bank schemas, Sofdec 2 movies, ADX audio, and HCA streams.',
  },
  {
    id: 'FROMSOFT',
    ext: '.bnd / .bnd4 / .dcx / .chrbnd',
    name: 'FromSoftware Binder & DCX Envelope',
    engines: 'FromSoftware Soulsborne Engine (Dark Souls 1-3, Bloodborne, Sekiro, Elden Ring, AC6)',
    magicSignature: '44 43 58 00 (DCX\\0) / 42 4E 44 33 (BND3) / 42 4E 44 34 (BND4)',
    compression: 'DCX Deflate (DFLT) / Uncompressed Streams',
    canRepack: false,
    description:
      'FromSoftware proprietary resource binder format and DCX compression wrapper storing character models, textures, animations, and game parameters.',
  },
  {
    id: 'SQUARE',
    ext: '.sdat / .pfs / .pf8',
    name: 'Square Enix Sound & Crystal Tools Package',
    engines: 'Nintendo DS / Square Enix Crystal Tools & Luminous (FF, Kingdom Hearts, Dragon Quest)',
    magicSignature: '53 44 41 54 (SDAT) / 50 46 53 20 (PFS )',
    compression: 'Uncompressed FAT Sound Blocks / Zlib Deflate Chunks',
    canRepack: false,
    description:
      'Decodes Nintendo DS SDAT audio archives (SSEQ sequences, SBNK instruments, SWAR waveforms) and Square Enix PFS master resource packages.',
  },
];

// Standard IEEE 802.3 CRC32 lookup
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[i] = c >>> 0;
}

export function computeCRC32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(Math.max(1, bytes)) / Math.log(k)), sizes.length - 1);
  const val = bytes / Math.pow(k, i);
  return `${val.toFixed(i === 0 ? 0 : 2)} ${sizes[i]}`;
}

export function toHex(num: number, pad = 8): string {
  return '0x' + (num >>> 0).toString(16).toUpperCase().padStart(pad, '0');
}

export function bytesToHexPreview(bytes: Uint8Array, maxLen = 8): string {
  const slice = bytes.subarray(0, Math.min(bytes.length, maxLen));
  return Array.from(slice)
    .map((b) => b.toString(16).toUpperCase().padStart(2, '0'))
    .join(' ');
}

export function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  const end = Math.min(bytes.length, offset + length);
  for (let i = offset; i < end; i++) {
    const b = bytes[i];
    if (b === 0) break;
    if (b >= 32 && b <= 126) {
      out += String.fromCharCode(b);
    } else {
      out += '.';
    }
  }
  return out;
}

export function decodeLatin1(bytes: Uint8Array, start: number, end: number): string {
  let s = '';
  const limit = Math.min(bytes.length, end);
  for (let i = start; i < limit; i++) {
    s += String.fromCharCode(bytes[i]);
  }
  return s;
}

export function classifyEntry(path: string, data: Uint8Array): AssetCategory {
  const lower = path.toLowerCase();
  const baseName = lower.split('/').pop() || lower;

  if (baseName === 'playpal' || baseName === 'colormap' || lower.endsWith('.pal') || lower.endsWith('.lmp')) {
    return 'palette';
  }
  if (
    baseName === 'vertexes' ||
    baseName === 'linedefs' ||
    baseName === 'sidedefs' ||
    baseName === 'sectors' ||
    baseName === 'things' ||
    /^e\d+m\d+$/.test(baseName) ||
    /^map\d\d$/.test(baseName) ||
    lower.endsWith('.bsp') ||
    lower.endsWith('.ent')
  ) {
    return 'map';
  }
  if (
    lower.endsWith('.gsc') ||
    lower.endsWith('.csc') ||
    lower.endsWith('.shader') ||
    lower.endsWith('.menu') ||
    lower.endsWith('.vision') ||
    lower.endsWith('.lua') ||
    lower.endsWith('.c') ||
    lower.endsWith('.h') ||
    lower.endsWith('.hlsl') ||
    lower.endsWith('.glsl')
  ) {
    return 'script';
  }
  if (
    lower.endsWith('.cfg') ||
    lower.endsWith('.ini') ||
    lower.endsWith('.json') ||
    lower.endsWith('.xml') ||
    lower.endsWith('.txt') ||
    lower.endsWith('.str') ||
    lower.endsWith('.csv') ||
    lower.endsWith('.cnf') ||
    lower.endsWith('.skin') ||
    lower.endsWith('.vmt')
  ) {
    return 'config';
  }
  if (
    lower.endsWith('.bik') ||
    lower.endsWith('.bk2') ||
    lower.endsWith('.str') ||
    lower.endsWith('.mp4') ||
    lower.endsWith('.roq')
  ) {
    return 'video';
  }
  if (
    lower.endsWith('.png') ||
    lower.endsWith('.jpg') ||
    lower.endsWith('.jpeg') ||
    lower.endsWith('.dds') ||
    lower.endsWith('.tga') ||
    lower.endsWith('.bmp') ||
    lower.endsWith('.vtf') ||
    lower.endsWith('.flat') ||
    lower.endsWith('.tim') ||
    lower.endsWith('.imgb') ||
    lower.endsWith('.image') ||
    (data.length === 4096 && !lower.includes('.'))
  ) {
    return 'texture';
  }
  if (
    lower.endsWith('.wav') ||
    lower.endsWith('.ogg') ||
    lower.endsWith('.mp3') ||
    lower.endsWith('.xa') ||
    lower.endsWith('.scd') ||
    (data.length > 12 && readAscii(data, 0, 4) === 'RIFF') ||
    (data.length > 4 && readAscii(data, 0, 4) === 'OggS')
  ) {
    return 'audio';
  }
  if (
    lower.endsWith('.mdl') ||
    lower.endsWith('.md3') ||
    lower.endsWith('.obj') ||
    lower.endsWith('.xmodel') ||
    lower.endsWith('.bmodel') ||
    lower.endsWith('.mesh')
  ) {
    return 'model';
  }
  if (
    lower.endsWith('.exe') ||
    lower.endsWith('.xex') ||
    lower.endsWith('.dll') ||
    lower.endsWith('.elf') ||
    lower.endsWith('.so')
  ) {
    return 'executable';
  }
  if (
    lower.endsWith('.appx') ||
    lower.endsWith('.msix') ||
    lower.endsWith('.appxbundle') ||
    lower.endsWith('.msixbundle') ||
    lower.endsWith('.xvd') ||
    lower.endsWith('.xvc')
  ) {
    return 'package';
  }

  if (data.length > 0 && data.length < 512 * 1024) {
    const checkLen = Math.min(data.length, 256);
    let printable = 0;
    for (let i = 0; i < checkLen; i++) {
      const c = data[i];
      if ((c >= 32 && c <= 126) || c === 9 || c === 10 || c === 13) {
        printable++;
      }
    }
    if (printable / checkLen > 0.9) {
      return 'config';
    }
  }

  return 'binary';
}

export function splitFolderAndName(fullPath: string): { folder: string; name: string; cleanPath: string } {
  const normalized = fullPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length <= 1) {
    return { folder: '(root)', name: parts[0] || 'unnamed.bin', cleanPath: parts[0] || 'unnamed.bin' };
  }
  const name = parts[parts.length - 1];
  const folder = parts.slice(0, parts.length - 1).join('/');
  return { folder, name, cleanPath: normalized };
}

/**
 * 1. Parse DOOM / Quake WAD (IWAD, PWAD, WAD2, WAD3)
 */
function parseWadArchive(fileName: string, bytes: Uint8Array, startTime: number): ParsedArchive {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = readAscii(bytes, 0, 4);
  const numLumps = view.getInt32(4, true);
  const infoTableOfs = view.getInt32(8, true);
  const isQuakeWad = magic === 'WAD2' || magic === 'WAD3';
  const entrySize = isQuakeWad ? 32 : 16;

  const warnings: string[] = [];
  const entries: ArchiveEntry[] = [];
  let currentMapGroup = '(root)';

  const maxSafeLumps = Math.min(Math.max(0, numLumps), 16384);
  for (let i = 0; i < maxSafeLumps; i++) {
    const dirPos = infoTableOfs + i * entrySize;
    if (dirPos + entrySize > bytes.length) {
      warnings.push(`Directory entry #${i} exceeds file bounds at ${toHex(dirPos)}.`);
      break;
    }

    const filePos = view.getInt32(dirPos, true);
    const size = view.getInt32(dirPos + 4, true);

    let lumpName = '';
    let lumpType = 'Raw Lump';

    if (isQuakeWad) {
      const diskSize = size;
      const uSize = view.getInt32(dirPos + 8, true);
      const typeByte = view.getUint8(dirPos + 12);
      lumpName = readAscii(bytes, dirPos + 16, 16);
      lumpType = `WAD2 Type 0x${typeByte.toString(16).toUpperCase()}`;
      const safeStart = Math.max(0, Math.min(bytes.length, filePos));
      const safeEnd = Math.max(safeStart, Math.min(bytes.length, filePos + diskSize));
      const lumpData = bytes.slice(safeStart, safeEnd);

      entries.push({
        id: `wad-${i}`,
        name: lumpName || `LUMP_${i}`,
        path: lumpName || `LUMP_${i}`,
        folder: 'textures',
        offset: filePos,
        compressedSize: diskSize,
        uncompressedSize: uSize || diskSize,
        compressionMethod: lumpType,
        crc32: computeCRC32(lumpData),
        category: classifyEntry(lumpName, lumpData),
        data: lumpData,
      });
    } else {
      lumpName = readAscii(bytes, dirPos + 8, 8).trim() || `LUMP_${i}`;
      const upper = lumpName.toUpperCase();

      if (/^E\dM\d$/.test(upper) || /^MAP\d\d$/.test(upper)) {
        currentMapGroup = `maps/${upper}`;
      } else if (
        !['THINGS', 'LINEDEFS', 'SIDEDEFS', 'VERTEXES', 'SEGS', 'SSECTORS', 'NODES', 'SECTORS', 'REJECT', 'BLOCKMAP'].includes(
          upper
        )
      ) {
        if (upper === 'PLAYPAL' || upper === 'COLORMAP' || upper === 'ENDOOM') {
          currentMapGroup = 'palettes_system';
        } else if (size === 4096) {
          currentMapGroup = 'flats';
        } else {
          currentMapGroup = 'lumps';
        }
      }

      const safeStart = Math.max(0, Math.min(bytes.length, filePos));
      const safeEnd = Math.max(safeStart, Math.min(bytes.length, filePos + Math.max(0, size)));
      const lumpData = bytes.slice(safeStart, safeEnd);

      entries.push({
        id: `wad-${i}`,
        name: lumpName,
        path: currentMapGroup === '(root)' ? lumpName : `${currentMapGroup}/${lumpName}`,
        folder: currentMapGroup,
        offset: filePos,
        compressedSize: size,
        uncompressedSize: size,
        compressionMethod: size === 0 ? 'Marker Lump (0 B)' : 'Uncompressed Lump',
        crc32: computeCRC32(lumpData),
        category: classifyEntry(lumpName, lumpData),
        data: lumpData,
      });
    }
  }

  const headerFields: ArchiveHeaderField[] = [
    {
      label: 'Identification Magic',
      offset: '0x00000000',
      length: 4,
      value: `${magic} (${bytesToHexPreview(bytes, 4)})`,
      description:
        magic === 'IWAD'
          ? 'Internal WAD (Standalone Commercial Game Archive)'
          : magic === 'PWAD'
          ? 'Patch WAD (Mod / Add-on Override Archive)'
          : 'Quake / GoldSrc Texture WAD',
    },
    {
      label: 'Lump Count (numlumps)',
      offset: '0x00000004',
      length: 4,
      value: `${numLumps.toLocaleString()} lumps`,
      description: 'Total number of directory entries in lump table',
    },
    {
      label: 'Directory Offset (infotableofs)',
      offset: '0x00000008',
      length: 4,
      value: `${toHex(infoTableOfs)} (${infoTableOfs.toLocaleString()} bytes)`,
      description: 'Byte offset to start of 16-byte lump directory array',
    },
  ];

  return {
    fileName,
    fileSize: bytes.length,
    formatId: 'WAD',
    formatName: `${magic} (${isQuakeWad ? 'Quake/GoldSrc Texture WAD' : 'DOOM Engine Lump Archive'})`,
    engineFamily: isQuakeWad ? 'id Tech 2 / GoldSrc' : 'id Tech 1 (DOOM / Heretic / Hexen)',
    magicBytes: bytesToHexPreview(bytes, 12),
    endianness: 'Little Endian',
    headerFields,
    entries,
    rawBytes: bytes,
    parseTimeMs: Math.max(1, Math.round(performance.now() - startTime)),
    warnings,
  };
}

/**
 * 2. Parse Quake / Half-Life PAK (PACK)
 */
function parsePakArchive(fileName: string, bytes: Uint8Array, startTime: number): ParsedArchive {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = readAscii(bytes, 0, 4);
  const dirOffset = view.getInt32(4, true);
  const dirLength = view.getInt32(8, true);
  const numEntries = Math.floor(dirLength / 64);

  const warnings: string[] = [];
  const entries: ArchiveEntry[] = [];

  const maxSafe = Math.min(Math.max(0, numEntries), 32768);
  for (let i = 0; i < maxSafe; i++) {
    const entryOfs = dirOffset + i * 64;
    if (entryOfs + 64 > bytes.length) {
      warnings.push(`PAK directory entry #${i} truncated at ${toHex(entryOfs)}.`);
      break;
    }
    const rawPath = readAscii(bytes, entryOfs, 56);
    const filePos = view.getInt32(entryOfs + 56, true);
    const fileLen = view.getInt32(entryOfs + 60, true);

    const safeStart = Math.max(0, Math.min(bytes.length, filePos));
    const safeEnd = Math.max(safeStart, Math.min(bytes.length, filePos + Math.max(0, fileLen)));
    const data = bytes.slice(safeStart, safeEnd);
    const { folder, name, cleanPath } = splitFolderAndName(rawPath || `entry_${i}.lmp`);

    entries.push({
      id: `pak-${i}`,
      name,
      path: cleanPath,
      folder,
      offset: filePos,
      compressedSize: fileLen,
      uncompressedSize: fileLen,
      compressionMethod: 'Stored (PACK Direct)',
      crc32: computeCRC32(data),
      category: classifyEntry(cleanPath, data),
      data,
    });
  }

  return {
    fileName,
    fileSize: bytes.length,
    formatId: 'PAK',
    formatName: 'Quake / Half-Life PACK Archive',
    engineFamily: 'id Tech 1 & 2 / GoldSrc Engine',
    magicBytes: bytesToHexPreview(bytes, 12),
    endianness: 'Little Endian',
    headerFields: [
      {
        label: 'Header Signature',
        offset: '0x00000000',
        length: 4,
        value: `${magic} (50 41 43 4B)`,
        description: 'Standard id Software PACK container identifier',
      },
      {
        label: 'Directory Offset',
        offset: '0x00000004',
        length: 4,
        value: `${toHex(dirOffset)} (${dirOffset.toLocaleString()} B)`,
        description: 'Absolute byte offset to the 64-byte file table',
      },
      {
        label: 'Directory Size',
        offset: '0x00000008',
        length: 4,
        value: `${dirLength.toLocaleString()} B (${numEntries} files)`,
        description: 'Byte length of file table (64 bytes per entry)',
      },
    ],
    entries,
    rawBytes: bytes,
    parseTimeMs: Math.max(1, Math.round(performance.now() - startTime)),
    warnings,
  };
}

/**
 * 3. Parse Call of Duty FastFile (.ff) - Universal T4-T10 & IW3-IW10 engine
 */
function parseFastFileArchive(fileName: string, bytes: Uint8Array, startTime: number): ParsedArchive {
  const { parsed, zoneState } = parseUniversalFastFile(fileName, bytes, startTime);
  if (zoneState) {
    parsed.zoneState = zoneState;
  }
  return parsed;
}

/**
 * 4. Parse ZIP / Quake III PK3 / Doom 3 PK4
 */
function parseZipOrPk3Archive(
  fileName: string,
  bytes: Uint8Array,
  startTime: number,
  forceFormatId?: 'ZIP' | 'PK3'
): ParsedArchive {
  const lower = fileName.toLowerCase();
  const isPk3 = forceFormatId === 'PK3' || lower.endsWith('.pk3') || lower.endsWith('.pk4') || lower.endsWith('.iwd');
  const formatId: ArchiveFormatId = isPk3 ? 'PK3' : 'ZIP';
  const warnings: string[] = [];
  const entries: ArchiveEntry[] = [];

  try {
    const unzipped = unzipSync(bytes);
    let idx = 0;
    for (const [entryPath, data] of Object.entries(unzipped)) {
      if (entryPath.endsWith('/') && data.length === 0) continue;
      const { folder, name, cleanPath } = splitFolderAndName(entryPath);
      entries.push({
        id: `${formatId.toLowerCase()}-${idx++}`,
        name,
        path: cleanPath,
        folder,
        offset: 0,
        compressedSize: Math.max(1, Math.round(data.length * 0.62)),
        uncompressedSize: data.length,
        compressionMethod: 'DEFLATE (RFC 1951)',
        crc32: computeCRC32(data),
        category: classifyEntry(cleanPath, data),
        data,
      });
    }
  } catch (err) {
    warnings.push(`ZIP/PK3 Central Directory warning: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    fileName,
    fileSize: bytes.length,
    formatId,
    formatName: isPk3 ? 'id Tech 3 / 4 Package (.PK3 / .IWD)' : 'ZIP Game Archive',
    engineFamily: isPk3 ? 'id Tech 3 / ioquake3 / IW 2.0' : 'Universal Deflate Archive',
    magicBytes: bytesToHexPreview(bytes, 12),
    endianness: 'Little Endian',
    headerFields: [
      {
        label: 'Local File Header Signature',
        offset: '0x00000000',
        length: 4,
        value: 'PK\\x03\\x04 (0x04034B50)',
        description: 'PKWARE / id Tech 3 Virtual File System signature',
      },
      {
        label: 'Extracted File Count',
        offset: 'Central Dir',
        length: 4,
        value: `${entries.length.toLocaleString()} files`,
        description: 'Total unpacked files in virtual hierarchy',
      },
    ],
    entries,
    rawBytes: bytes,
    parseTimeMs: Math.max(1, Math.round(performance.now() - startTime)),
    warnings,
  };
}

/**
 * 5. Parse ISO 9660 Optical Disc Image (.iso)
 */
function parseIsoArchive(fileName: string, bytes: Uint8Array, startTime: number): ParsedArchive {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pvdOffset = 0x8000;
  const sysId = readAscii(bytes, pvdOffset + 8, 32).trim();
  const volId = readAscii(bytes, pvdOffset + 40, 32).trim();
  const volSpaceSize = view.getUint32(pvdOffset + 80, true);
  const blockSize = view.getUint16(pvdOffset + 128, true) || 2048;

  const rootRecordOffset = pvdOffset + 156;
  const rootExtentLba = view.getUint32(rootRecordOffset + 2, true);
  const rootDataLen = view.getUint32(rootRecordOffset + 10, true);

  const entries: ArchiveEntry[] = [];
  const warnings: string[] = [];
  let entryCounter = 0;

  function walkIsoDirectory(extentLba: number, dataLength: number, folderPrefix: string, depth: number) {
    if (depth > 8) return;
    const dirStart = extentLba * blockSize;
    const dirEnd = Math.min(bytes.length, dirStart + dataLength);
    let pos = dirStart;

    while (pos < dirEnd && entryCounter < 4000) {
      const recordLen = bytes[pos];
      if (recordLen === 0) {
        const nextSector = Math.floor(pos / blockSize + 1) * blockSize;
        if (nextSector <= pos) break;
        pos = nextSector;
        continue;
      }
      if (pos + recordLen > bytes.length) break;

      const fileLba = view.getUint32(pos + 2, true);
      const fileSize = view.getUint32(pos + 10, true);
      const flags = bytes[pos + 25];
      const nameLen = bytes[pos + 32];
      const rawName = readAscii(bytes, pos + 33, nameLen);

      if (nameLen === 1 && (bytes[pos + 33] === 0 || bytes[pos + 33] === 1)) {
        pos += recordLen;
        continue;
      }

      const cleanName = rawName.replace(/;\d+$/, '');
      const isDir = (flags & 0x02) !== 0;

      if (isDir) {
        const subFolder = folderPrefix ? `${folderPrefix}/${cleanName}` : cleanName;
        if (fileLba !== extentLba && fileLba * blockSize < bytes.length) {
          walkIsoDirectory(fileLba, fileSize, subFolder, depth + 1);
        }
      } else {
        const byteStart = Math.min(bytes.length, fileLba * blockSize);
        const byteEnd = Math.min(bytes.length, byteStart + fileSize);
        const fileData = bytes.slice(byteStart, byteEnd);
        const fullPath = folderPrefix ? `${folderPrefix}/${cleanName}` : cleanName;
        entries.push({
          id: `iso-${entryCounter++}`,
          name: cleanName,
          path: fullPath,
          folder: folderPrefix || '(root)',
          offset: byteStart,
          compressedSize: fileSize,
          uncompressedSize: fileSize,
          compressionMethod: `ISO 9660 LBA ${fileLba}`,
          crc32: computeCRC32(fileData),
          category: classifyEntry(fullPath, fileData),
          data: fileData,
        });
      }

      pos += recordLen;
    }
  }

  walkIsoDirectory(rootExtentLba, rootDataLen, '', 0);

  return {
    fileName,
    fileSize: bytes.length,
    formatId: 'ISO',
    formatName: `ISO 9660 Optical Disc (${volId || 'GAME_DISC'})`,
    engineFamily: sysId ? `Optical Disc (${sysId})` : 'PlayStation / Console / PC CD-ROM',
    magicBytes: bytesToHexPreview(bytes.subarray(pvdOffset, pvdOffset + 8), 8),
    endianness: 'Little Endian',
    headerFields: [
      {
        label: 'Primary Volume Descriptor',
        offset: '0x00008000',
        length: 7,
        value: '01 "CD001" 01 (Sector 16)',
        description: 'ECMA-119 / ISO 9660 Primary Volume Descriptor header',
      },
      {
        label: 'System & Volume ID',
        offset: '0x00008008',
        length: 64,
        value: `${sysId || 'PLAYSTATION'} / ${volId || 'GAME_IMAGE'}`,
        description: 'Target hardware identifier and disc label',
      },
      {
        label: 'Logical Block Geometry',
        offset: '0x00008050',
        length: 8,
        value: `${volSpaceSize.toLocaleString()} sectors × ${blockSize} B`,
        description: 'Total optical volume space and sector byte size',
      },
    ],
    entries,
    rawBytes: bytes,
    parseTimeMs: Math.max(1, Math.round(performance.now() - startTime)),
    warnings,
  };
}

/**
 * 6. Parse Ryu Ga Gotoku / Yakuza PARC (.par) Archive
 */
function parseParArchive(fileName: string, bytes: Uint8Array, startTime: number): ParsedArchive {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = readAscii(bytes, 0, 4);
  const version = view.getUint32(4, true);
  const fileCount = view.getUint32(8, true);
  const dirOffset = view.getUint32(12, true);

  const entries: ArchiveEntry[] = [];
  const warnings: string[] = [];

  const safeCount = Math.min(fileCount, 4096);
  for (let i = 0; i < safeCount; i++) {
    const recOffset = dirOffset + i * 64;
    if (recOffset + 64 > bytes.length) {
      warnings.push(`PARC entry #${i} exceeds archive bounds.`);
      break;
    }
    const rawPath = readAscii(bytes, recOffset, 48);
    const dataOffset = view.getUint32(recOffset + 48, true);
    const compSize = view.getUint32(recOffset + 52, true);
    const uncompSize = view.getUint32(recOffset + 56, true);
    const isCompressed = view.getUint32(recOffset + 60, true) === 1;

    const safeStart = Math.min(bytes.length, dataOffset);
    const safeEnd = Math.min(bytes.length, safeStart + compSize);
    const rawSlice = bytes.slice(safeStart, safeEnd);

    let payload = rawSlice;
    let method = 'PARC Stored';
    if (isCompressed && rawSlice.length > 2) {
      try {
        payload = unzlibSync(rawSlice);
        method = 'PARC Zlib Deflate';
      } catch {
        method = 'PARC Compressed Stream';
      }
    }

    const { folder, name, cleanPath } = splitFolderAndName(rawPath || `entry_${i}.bin`);
    entries.push({
      id: `par-${i}`,
      name,
      path: cleanPath,
      folder,
      offset: dataOffset,
      compressedSize: compSize,
      uncompressedSize: uncompSize || payload.length,
      compressionMethod: method,
      crc32: computeCRC32(payload),
      category: classifyEntry(cleanPath, payload),
      data: payload,
    });
  }

  return {
    fileName,
    fileSize: bytes.length,
    formatId: 'PAR',
    formatName: 'Ryu Ga Gotoku PARC Archive (.par)',
    engineFamily: 'Sega Dragon Engine / RGG Studio',
    magicBytes: bytesToHexPreview(bytes, 12),
    endianness: 'Little Endian',
    headerFields: [
      {
        label: 'Magic Signature',
        offset: '0x00000000',
        length: 4,
        value: `${magic} (50 41 52 43)`,
        description: 'PARC archive container signature',
      },
      {
        label: 'Container Version',
        offset: '0x00000004',
        length: 4,
        value: toHex(version),
        description: 'PARC format revision',
      },
      {
        label: 'Entry Table',
        offset: toHex(dirOffset),
        length: safeCount * 64,
        value: `${fileCount} entries at ${toHex(dirOffset)}`,
        description: 'File descriptor table offset and count',
      },
    ],
    entries,
    rawBytes: bytes,
    parseTimeMs: Math.max(1, Math.round(performance.now() - startTime)),
    warnings,
  };
}

/**
 * 7. Parse EA BIGF / BIG4 (.big) Archive
 */
function parseBigArchive(fileName: string, bytes: Uint8Array, startTime: number): ParsedArchive {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = readAscii(bytes, 0, 4);
  const archiveLength = view.getUint32(4, true);
  const numFiles = view.getUint32(8, false);
  const firstDataOffset = view.getUint32(12, false);

  const entries: ArchiveEntry[] = [];
  const warnings: string[] = [];
  let pos = 16;

  const safeCount = Math.min(numFiles, 8192);
  for (let i = 0; i < safeCount; i++) {
    if (pos + 9 > bytes.length) break;
    const entryOffset = view.getUint32(pos, false);
    const entrySize = view.getUint32(pos + 4, false);
    pos += 8;

    let nameEnd = pos;
    while (nameEnd < bytes.length && bytes[nameEnd] !== 0) nameEnd++;
    const rawPath = readAscii(bytes, pos, nameEnd - pos);
    pos = nameEnd + 1;

    const safeStart = Math.min(bytes.length, entryOffset);
    const safeEnd = Math.min(bytes.length, safeStart + entrySize);
    const data = bytes.slice(safeStart, safeEnd);
    const { folder, name, cleanPath } = splitFolderAndName(rawPath || `asset_${i}.bin`);

    entries.push({
      id: `big-${i}`,
      name,
      path: cleanPath,
      folder,
      offset: entryOffset,
      compressedSize: entrySize,
      uncompressedSize: entrySize,
      compressionMethod: `${magic} Big-Endian Stream`,
      crc32: computeCRC32(data),
      category: classifyEntry(cleanPath, data),
      data,
    });
  }

  return {
    fileName,
    fileSize: bytes.length,
    formatId: 'BIG',
    formatName: `Electronic Arts ${magic} Archive`,
    engineFamily: 'SAGE Engine / EAGL (C&C Generals, BFME, NFS)',
    magicBytes: bytesToHexPreview(bytes, 12),
    endianness: 'Big Endian',
    headerFields: [
      {
        label: 'Signature',
        offset: '0x00000000',
        length: 4,
        value: `${magic} (${bytesToHexPreview(bytes, 4)})`,
        description: 'EA BIGF / BIG4 Master Archive Identifier',
      },
      {
        label: 'Archive Size (LE)',
        offset: '0x00000004',
        length: 4,
        value: `${archiveLength.toLocaleString()} B`,
        description: 'Total archive length recorded in header',
      },
      {
        label: 'File Count & Data Start (BE)',
        offset: '0x00000008',
        length: 8,
        value: `${numFiles} files · Data starts at ${toHex(firstDataOffset)}`,
        description: 'Big-endian directory count and first payload offset',
      },
    ],
    entries,
    rawBytes: bytes,
    parseTimeMs: Math.max(1, Math.round(performance.now() - startTime)),
    warnings,
  };
}

/**
 * 8. Parse RAR v4 / v5 Archive (Rar!\x1a\x07)
 */
function parseRarArchive(fileName: string, bytes: Uint8Array, startTime: number): ParsedArchive {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const isRar5 = bytes.length >= 8 && bytes[6] === 0x01 && bytes[7] === 0x00;
  const entries: ArchiveEntry[] = [];
  const warnings: string[] = [];

  if (!isRar5) {
    let pos = 7;
    let idx = 0;
    while (pos + 7 <= bytes.length && idx < 4096) {
      const headCrc = view.getUint16(pos, true);
      const headType = bytes[pos + 2];
      const headFlags = view.getUint16(pos + 3, true);
      const headSize = view.getUint16(pos + 5, true);

      if (headSize < 7 || pos + headSize > bytes.length) break;

      let addSize = 0;
      if ((headFlags & 0x8000) !== 0 && pos + 11 <= bytes.length) {
        addSize = view.getUint32(pos + 7, true);
      }

      if (headType === 0x74 && pos + 32 <= bytes.length) {
        const packSize = view.getUint32(pos + 7, true);
        const unpSize = view.getUint32(pos + 11, true);
        const fileCrc = view.getUint32(pos + 16, true);
        const method = bytes[pos + 25];
        const nameSize = view.getUint16(pos + 26, true);
        const rawName = readAscii(bytes, pos + 32, Math.min(nameSize, headSize - 32));
        const dataOffset = pos + headSize;
        const safeEnd = Math.min(bytes.length, dataOffset + packSize);
        const payload = bytes.slice(dataOffset, safeEnd);

        const { folder, name, cleanPath } = splitFolderAndName(rawName || `rar_entry_${idx}.bin`);
        entries.push({
          id: `rar-${idx++}`,
          name,
          path: cleanPath,
          folder,
          offset: dataOffset,
          compressedSize: packSize,
          uncompressedSize: unpSize,
          compressionMethod:
            method === 0x30 ? 'RAR v4 Store (0x30)' : `RAR v4 Method 0x${method.toString(16).toUpperCase()}`,
          crc32: fileCrc || computeCRC32(payload),
          category: classifyEntry(cleanPath, payload),
          data: payload,
          metadata: { headerCrc: toHex(headCrc, 4) },
        });

        pos = dataOffset + packSize;
        continue;
      }

      pos += headSize + addSize;
    }
  }

  if (entries.length === 0) {
    const carved = parseZlibAndCarveStreams(fileName, bytes, startTime);
    entries.push(...carved.entries);
  }

  return {
    fileName,
    fileSize: bytes.length,
    formatId: 'RAR',
    formatName: isRar5 ? 'RAR v5.0 Archive Container' : 'RAR v4.x Archive Container',
    engineFamily: 'Roshal Archive (Game Mod / Distribution Package)',
    magicBytes: bytesToHexPreview(bytes, 8),
    endianness: 'Little Endian',
    headerFields: [
      {
        label: 'RAR Signature Marker',
        offset: '0x00000000',
        length: isRar5 ? 8 : 7,
        value: isRar5 ? 'Rar!\\x1A\\x07\\x01\\x00 (v5.0)' : 'Rar!\\x1A\\x07\\x00 (v4.x)',
        description: 'RAR magic marker block',
      },
      {
        label: 'Parsed Block Entries',
        offset: '0x00000007',
        length: bytes.length - 7,
        value: `${entries.length} file blocks`,
        description: 'File headers and payload blocks discovered in stream',
      },
    ],
    entries,
    rawBytes: bytes,
    parseTimeMs: Math.max(1, Math.round(performance.now() - startTime)),
    warnings,
  };
}

/**
 * 9. Parse Valve VPK (0x55AA1234)
 */
function parseVpkArchive(fileName: string, bytes: Uint8Array, startTime: number): ParsedArchive {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(4, true);
  const treeSize = view.getUint32(8, true);
  const headerSize = version === 2 ? 28 : 12;

  const entries: ArchiveEntry[] = [];
  const warnings: string[] = [];
  let pos = headerSize;
  const treeEnd = Math.min(bytes.length, headerSize + treeSize);
  const dataBaseOffset = treeEnd;

  function readNullString(): string {
    const start = pos;
    while (pos < bytes.length && bytes[pos] !== 0) pos++;
    const str = readAscii(bytes, start, pos - start);
    pos++;
    return str;
  }

  let idx = 0;
  while (pos < treeEnd && idx < 4096) {
    const ext = readNullString();
    if (!ext) break;
    while (pos < treeEnd) {
      const pathStr = readNullString();
      if (!pathStr) break;
      while (pos < treeEnd) {
        const baseName = readNullString();
        if (!baseName) break;
        if (pos + 18 > bytes.length) break;

        const crc = view.getUint32(pos, true);
        const preloadBytes = view.getUint16(pos + 4, true);
        const archiveIndex = view.getUint16(pos + 6, true);
        const entryOffset = view.getUint32(pos + 8, true);
        const entryLength = view.getUint32(pos + 12, true);
        pos += 18;

        const preloadSlice = bytes.slice(pos, Math.min(bytes.length, pos + preloadBytes));
        pos += preloadBytes;

        let fullData = preloadSlice;
        let absOffset = pos - preloadBytes;
        if (archiveIndex === 0x7fff && entryLength > 0) {
          absOffset = dataBaseOffset + entryOffset;
          const inlineSlice = bytes.slice(
            Math.min(bytes.length, absOffset),
            Math.min(bytes.length, absOffset + entryLength)
          );
          const merged = new Uint8Array(preloadSlice.length + inlineSlice.length);
          merged.set(preloadSlice, 0);
          merged.set(inlineSlice, preloadSlice.length);
          fullData = merged;
        }

        const cleanDir = pathStr === ' ' ? '(root)' : pathStr.trim();
        const fileWithExt = ext === ' ' ? baseName : `${baseName}.${ext}`;
        const fullPath = cleanDir === '(root)' ? fileWithExt : `${cleanDir}/${fileWithExt}`;

        entries.push({
          id: `vpk-${idx++}`,
          name: fileWithExt,
          path: fullPath,
          folder: cleanDir,
          offset: absOffset,
          compressedSize: fullData.length,
          uncompressedSize: preloadBytes + entryLength,
          compressionMethod:
            archiveIndex === 0x7fff
              ? 'VPK Inline Payload'
              : `VPK Dir (pak01_${String(archiveIndex).padStart(3, '0')}.vpk)`,
          crc32: crc,
          category: classifyEntry(fullPath, fullData),
          data: fullData,
        });
      }
    }
  }

  return {
    fileName,
    fileSize: bytes.length,
    formatId: 'VPK',
    formatName: `Valve Pak v${version} Archive (.vpk)`,
    engineFamily: 'Valve Source Engine (Half-Life 2, TF2, Portal 2, Left 4 Dead)',
    magicBytes: bytesToHexPreview(bytes, 12),
    endianness: 'Little Endian',
    headerFields: [
      {
        label: 'VPK Signature',
        offset: '0x00000000',
        length: 4,
        value: '0x55AA1234 (34 12 AA 55)',
        description: 'Source Engine VPK magic identifier',
      },
      {
        label: 'VPK Version & Tree Size',
        offset: '0x00000004',
        length: 8,
        value: `v${version} · Directory Tree ${formatBytes(treeSize)}`,
        description: '3-tier Extension -> Path -> Filename tree length',
      },
    ],
    entries,
    rawBytes: bytes,
    parseTimeMs: Math.max(1, Math.round(performance.now() - startTime)),
    warnings,
  };
}

/**
 * 10. Universal Zlib Decompressor & Binary Signature Carver
 */
function parseZlibAndCarveStreams(fileName: string, bytes: Uint8Array, startTime: number): ParsedArchive {
  const entries: ArchiveEntry[] = [];
  const warnings: string[] = [];

  if (
    bytes.length >= 2 &&
    bytes[0] === 0x78 &&
    (bytes[1] === 0x01 || bytes[1] === 0x5e || bytes[1] === 0x9c || bytes[1] === 0xda)
  ) {
    try {
      const decompressed = unzlibSync(bytes);
      const outName = fileName.replace(/\.(zlib|z|dat|bin)$/i, '') + '.decompressed';
      entries.push({
        id: 'zlib-full-0',
        name: outName,
        path: `decompressed/${outName}`,
        folder: 'decompressed',
        offset: 0,
        compressedSize: bytes.length,
        uncompressedSize: decompressed.length,
        compressionMethod: `RFC 1950 Zlib (0x78 0x${bytes[1].toString(16).toUpperCase()})`,
        crc32: computeCRC32(decompressed),
        category: classifyEntry(outName, decompressed),
        data: decompressed,
      });
    } catch {
      // Proceed to multi-stream scan
    }
  }

  let chunkIdx = 0;
  for (let i = 0; i < bytes.length - 8 && chunkIdx < 200; i++) {
    if (
      bytes[i] === 0x89 &&
      bytes[i + 1] === 0x50 &&
      bytes[i + 2] === 0x4e &&
      bytes[i + 3] === 0x47
    ) {
      let endPos = i + 8;
      while (endPos < bytes.length - 8) {
        if (
          bytes[endPos] === 0x49 &&
          bytes[endPos + 1] === 0x45 &&
          bytes[endPos + 2] === 0x4e &&
          bytes[endPos + 3] === 0x44
        ) {
          endPos += 8;
          break;
        }
        endPos++;
      }
      const slice = bytes.slice(i, Math.min(bytes.length, endPos));
      entries.push({
        id: `carved-png-${chunkIdx}`,
        name: `texture_${String(chunkIdx).padStart(3, '0')}.png`,
        path: `carved_textures/texture_${String(chunkIdx).padStart(3, '0')}.png`,
        folder: 'carved_textures',
        offset: i,
        compressedSize: slice.length,
        uncompressedSize: slice.length,
        compressionMethod: 'Carved PNG Stream',
        crc32: computeCRC32(slice),
        category: 'texture',
        data: slice,
      });
      chunkIdx++;
      i = endPos - 1;
      continue;
    }

    if (
      bytes[i] === 0x52 &&
      bytes[i + 1] === 0x49 &&
      bytes[i + 2] === 0x46 &&
      bytes[i + 3] === 0x46 &&
      i + 12 <= bytes.length &&
      readAscii(bytes, i + 8, 4) === 'WAVE'
    ) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const riffSize = view.getUint32(i + 4, true) + 8;
      const safeEnd = Math.min(bytes.length, i + Math.max(44, riffSize));
      const slice = bytes.slice(i, safeEnd);
      entries.push({
        id: `carved-wav-${chunkIdx}`,
        name: `sfx_${String(chunkIdx).padStart(3, '0')}.wav`,
        path: `carved_audio/sfx_${String(chunkIdx).padStart(3, '0')}.wav`,
        folder: 'carved_audio',
        offset: i,
        compressedSize: slice.length,
        uncompressedSize: slice.length,
        compressionMethod: 'Carved RIFF WAVE',
        crc32: computeCRC32(slice),
        category: 'audio',
        data: slice,
      });
      chunkIdx++;
      i = safeEnd - 1;
      continue;
    }

    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    if (b0 === 0x78 && (b1 === 0x9c || b1 === 0xda) && ((b0 << 8) | b1) % 31 === 0 && i > 0) {
      try {
        const sub = bytes.subarray(i, Math.min(bytes.length, i + 262144));
        const decomp = unzlibSync(sub);
        if (decomp && decomp.length >= 16) {
          const cat = classifyEntry(`chunk_${chunkIdx}`, decomp);
          const ext = cat === 'config' || cat === 'script' ? '.txt' : '.bin';
          entries.push({
            id: `carved-zlib-${chunkIdx}`,
            name: `zlib_stream_${toHex(i, 6)}${ext}`,
            path: `zlib_streams/zlib_stream_${toHex(i, 6)}${ext}`,
            folder: 'zlib_streams',
            offset: i,
            compressedSize: Math.min(sub.length, decomp.length),
            uncompressedSize: decomp.length,
            compressionMethod: `Zlib Deflate (0x78 0x${b1.toString(16).toUpperCase()})`,
            crc32: computeCRC32(decomp),
            category: cat,
            data: decomp,
          });
          chunkIdx++;
          i += 32;
        }
      } catch {
        // Not a standalone zlib stream
      }
    }
  }

  if (entries.length === 0) {
    entries.push({
      id: 'raw-stream-0',
      name: fileName,
      path: fileName,
      folder: '(root)',
      offset: 0,
      compressedSize: bytes.length,
      uncompressedSize: bytes.length,
      compressionMethod: 'Uncompressed / Proprietary Binary Stream',
      crc32: computeCRC32(bytes),
      category: classifyEntry(fileName, bytes),
      data: bytes,
    });
  }

  return {
    fileName,
    fileSize: bytes.length,
    formatId: entries[0]?.id.startsWith('zlib') ? 'ZLIB' : 'RAW',
    formatName:
      entries[0]?.id.startsWith('zlib')
        ? 'Zlib Compressed Game Stream'
        : 'Proprietary Binary / Carved Archive',
    engineFamily: 'Universal Zlib & Signature Carver',
    magicBytes: bytesToHexPreview(bytes, 12),
    endianness: 'Mixed / Stream',
    headerFields: [
      {
        label: 'Leading Magic Bytes',
        offset: '0x00000000',
        length: Math.min(8, bytes.length),
        value: `${bytesToHexPreview(bytes, 8)} ("${readAscii(bytes, 0, 8)}")`,
        description: 'First 8 bytes of container header',
      },
      {
        label: 'Discovered Streams',
        offset: '0x00000000',
        length: bytes.length,
        value: `${entries.length} stream(s) extracted`,
        description: 'Decompressed zlib blocks and carved media signatures',
      },
    ],
    entries,
    rawBytes: bytes,
    parseTimeMs: Math.max(1, Math.round(performance.now() - startTime)),
    warnings,
  };
}

/**
 * Main Universal Dispatcher
 */
export function parseGameArchive(fileName: string, bytes: Uint8Array): ParsedArchive {
  const startTime = performance.now();
  const magic4 = readAscii(bytes, 0, 4);
  const magic8 = readAscii(bytes, 0, 8);
  const lower = fileName.toLowerCase();

  // 0a. Check Bethesda Softworks BSA / BA2
  if (isBethesdaArchive(bytes) || lower.endsWith('.bsa') || lower.endsWith('.ba2')) {
    return parseBethesdaArchive(fileName, bytes, startTime);
  }

  // 0b. Check Ubisoft FORGE (Assassin's Creed / Anvil)
  if (isUbisoftForge(bytes, fileName)) {
    return parseUbisoftForge(fileName, bytes, startTime);
  }

  // 0c. Check Rockstar RAGE RPF (GTA IV, GTA V, RDR, Max Payne 3)
  if (isRockstarRage(bytes, fileName)) {
    return parseRockstarRage(fileName, bytes, startTime);
  }

  // 0d. Check Minecraft Mod JAR (.jar)
  if (isMinecraftJar(bytes, fileName)) {
    return parseMinecraftJar(fileName, bytes, startTime);
  }

  // 0e. Check PlayStation Package (.pkg)
  if (isPlaystationPkg(bytes, fileName)) {
    return parsePlaystationPkg(fileName, bytes, startTime);
  }

  // 0f. Check CRIWARE Audio & Video (.awb, .acb, .usm, .adx, .hca)
  if (isCriwareArchive(bytes, fileName)) {
    return parseCriwareArchive(fileName, bytes, startTime);
  }

  // 0g. Check FromSoftware BND3, BND4 & DCX (.bnd, .bnd4, .dcx)
  if (isFromSoftArchive(bytes, fileName)) {
    return parseFromSoftArchive(fileName, bytes, startTime);
  }

  // 0h. Check Square Enix Sound Archive & PFS (.sdat, .pfs, .pf8)
  if (isSquareArchive(bytes, fileName)) {
    return parseSquareArchive(fileName, bytes, startTime);
  }

  // 1. Check RAD Game Tools Bink Video (.bik / .bk2)
  if (
    magic4.startsWith('BIK') ||
    magic4.startsWith('KB2') ||
    lower.endsWith('.bik') ||
    lower.endsWith('.bk2')
  ) {
    if (bytes.length >= 44 && (magic4.startsWith('BIK') || magic4.startsWith('KB2'))) {
      return parseBinkVideo(fileName, bytes, startTime);
    }
  }

  // 2. Check id Tech 6 DOOM 2016 (.resource, .index, .patch, .bmodel)
  if (
    (bytes.length >= 4 && bytes[0] === 0x1b && bytes[1] === 0x4c && bytes[2] === 0x4d && bytes[3] === 0x42) || // \x1bLMB
    (bytes.length >= 12 &&
      ((bytes[1] === 0x53 && bytes[2] === 0x45 && bytes[3] === 0x52) || // SER
        (bytes[0] === 0x52 && bytes[1] === 0x45 && bytes[2] === 0x53))) || // RES
    lower.endsWith('.resource') ||
    lower.endsWith('.bmodel')
  ) {
    if (
      (bytes[0] === 0x1b && bytes[1] === 0x4c && bytes[2] === 0x4d && bytes[3] === 0x42) ||
      (bytes[1] === 0x53 && bytes[2] === 0x45 && bytes[3] === 0x52) ||
      (bytes[0] === 0x52 && bytes[1] === 0x45 && bytes[2] === 0x53)
    ) {
      return parseIdTech6Archive(fileName, bytes, startTime);
    }
  }

  // 3. Check Unreal Engine 4 / 5 (.pak, .uasset, .umap)
  const isUAssetMagic =
    bytes.length >= 4 &&
    bytes[0] === 0xc1 &&
    bytes[1] === 0x83 &&
    bytes[2] === 0x2a &&
    bytes[3] === 0x9e; // 0x9E2A83C1
  const hasPakFooter =
    bytes.length >= 44 &&
    (new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
      Math.max(0, bytes.length - 44),
      true
    ) === UNREAL_PAK_MAGIC ||
      bytes.slice(Math.max(0, bytes.length - 512)).some((_, idx, arr) => {
        if (idx + 4 <= arr.length) {
          return (
            arr[idx] === 0xe1 &&
            arr[idx + 1] === 0x12 &&
            arr[idx + 2] === 0x6f &&
            arr[idx + 3] === 0x5a
          );
        }
        return false;
      }));

  if (isUAssetMagic || hasPakFooter || lower.endsWith('.uasset') || lower.endsWith('.umap')) {
    return parseUnrealArchive(fileName, bytes, startTime);
  }

  // 4. Check Unity Engine (.assets SerializedFile, .unity3d, .bundle, UnityFS)
  const isUnityFs = magic8.startsWith('UnityFS') || magic8.startsWith('UnityWe') || magic8.startsWith('UnityRa');
  if (isUnityFs || lower.endsWith('.assets') || lower.endsWith('.sharedassets') || lower.endsWith('.unity3d')) {
    return parseUnityArchive(fileName, bytes, startTime);
  }

  // 5. Check Final Fantasy XIII Trilogy (white_data, filelist*.bin, white_img*.bin, .wbd, .wdb)
  const isFf13Name =
    lower.includes('white_') ||
    lower.includes('filelist') ||
    lower.endsWith('.wbd') ||
    lower.endsWith('.wdb');
  if (isFf13Name && bytes.length >= 16) {
    return parseFf13Archive(fileName, bytes, startTime);
  }

  // 6. Check Xbox 360 Executable (XEX2, XEX1, XEX0, default.xex)
  if (
    (magic4 === 'XEX2' || magic4 === 'XEX1' || magic4 === 'XEX0' || magic4 === 'XEXP' || lower.endsWith('.xex')) &&
    bytes.length >= 24
  ) {
    return parseXbox360Xex(fileName, bytes, startTime);
  }

  // 7. Check Xbox 360 Games on Demand (GOD) & XContent (LIVE, PIRS, CON , GDFX Disc)
  const isGodSignature = magic4 === 'LIVE' || magic4 === 'PIRS' || magic4 === 'CON ';
  const gdfxCheck = isGdfxFilesystem(bytes);
  if (
    isGodSignature ||
    gdfxCheck.found ||
    lower.endsWith('.god') ||
    lower.endsWith('.header') ||
    lower.includes('00007000') ||
    (lower.startsWith('data00') && bytes.length >= 0x400)
  ) {
    if (isGodSignature || gdfxCheck.found || bytes.length >= 0x400) {
      return parseXbox360GodArchive(fileName, bytes, startTime);
    }
  }

  // 8. Check Xbox One / Series, Windows GDK PC, and UWP Packages (.appx, .appxbundle, .msix, .msixbundle, .xvd, .xvc)
  const isAppxExt =
    lower.endsWith('.appx') ||
    lower.endsWith('.appxbundle') ||
    lower.endsWith('.msix') ||
    lower.endsWith('.msixbundle') ||
    lower.endsWith('.xvd') ||
    lower.endsWith('.xvc') ||
    lower.endsWith('.eappx') ||
    lower.endsWith('.emsix') ||
    lower.endsWith('.eappxbundle') ||
    lower.endsWith('.emsixbundle') ||
    lower.endsWith('.appxupload') ||
    lower.endsWith('.msixupload');
  const isMsftMagic = bytes.length >= 4 && readAscii(bytes, 0, 4) === 'msft';

  if (isAppxExt || isMsftMagic) {
    return parseXboxGdkAppxArchive(fileName, bytes, startTime);
  }

  // 9. Check Nintendo DS / DSi ROM (.nds, .srl, .dsi) with NitroFS
  if (isNdsRom(bytes) || lower.endsWith('.nds') || lower.endsWith('.srl') || lower.endsWith('.dsi')) {
    if (bytes.length >= 0x200) {
      return parseNdsRomArchive(fileName, bytes, startTime);
    }
  }

  // 10. Check Classic Console ROMs (.gba, .gb, .gbc, .n64, .z64, .v64, .sfc, .smc, .nes)
  const isRomExt =
    lower.endsWith('.gba') ||
    lower.endsWith('.gb') ||
    lower.endsWith('.gbc') ||
    lower.endsWith('.z64') ||
    lower.endsWith('.n64') ||
    lower.endsWith('.v64') ||
    lower.endsWith('.sfc') ||
    lower.endsWith('.smc') ||
    lower.endsWith('.nes');
  const isNesMagic = bytes.length >= 16 && bytes[0] === 0x4e && bytes[1] === 0x45 && bytes[2] === 0x53 && bytes[3] === 0x1a;
  const isN64Magic = bytes.length >= 4 && ((bytes[0] === 0x80 && bytes[1] === 0x37) || (bytes[0] === 0x37 && bytes[1] === 0x80));
  if (isRomExt || isNesMagic || isN64Magic) {
    if (bytes.length >= 0x40) {
      return parseClassicConsoleRom(fileName, bytes, startTime);
    }
  }

  // 11. Check Sony PlayStation 1 Disc Image (2352 raw CD-XA sync bytes, SYSTEM.CNF, or PS1 ISO)
  const isPs1Sync =
    bytes.length >= 16 * 2352 + 12 &&
    bytes[0] === 0x00 &&
    bytes[1] === 0xff &&
    bytes[2] === 0xff &&
    bytes[11] === 0x00;
  if (isPs1Sync || (lower.endsWith('.bin') && bytes.length > 300000 && bytes.length % 2352 === 0)) {
    return parsePs1DiscArchive(fileName, bytes, startTime);
  }

  // 7. Check Call of Duty FastFile (.ff) - TAffu100, IWffu100, TAff0100, IWff0100 (T4-T10, IW3-IW10)
  if (magic8.startsWith('IWff') || magic8.startsWith('TAff') || magic8.startsWith('S1ff') || lower.endsWith('.ff')) {
    if (bytes.length >= 12 && (magic8.startsWith('IWff') || magic8.startsWith('TAff') || magic8.startsWith('S1ff'))) {
      return parseFastFileArchive(fileName, bytes, startTime);
    }
  }

  // 8. Check DOOM / Quake WAD (IWAD, PWAD, WAD2, WAD3)
  if (magic4 === 'IWAD' || magic4 === 'PWAD' || magic4 === 'WAD2' || magic4 === 'WAD3') {
    return parseWadArchive(fileName, bytes, startTime);
  }

  // 9. Check Quake / Half-Life PAK (PACK)
  if (magic4 === 'PACK' && bytes.length >= 12) {
    return parsePakArchive(fileName, bytes, startTime);
  }

  // 10. Check PK3 / PK4 / ZIP (PK\x03\x04)
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    return parseZipOrPk3Archive(fileName, bytes, startTime);
  }

  // 11. Check ISO 9660 (Sector 16 / 0x8000 has \x01CD001)
  if (bytes.length > 0x8006 && readAscii(bytes, 0x8001, 5) === 'CD001') {
    // Check if PlayStation disc
    if (readAscii(bytes, 0x8008, 32).includes('PLAYSTATION')) {
      return parsePs1DiscArchive(fileName, bytes, startTime);
    }
    return parseIsoArchive(fileName, bytes, startTime);
  }

  // 12. Check Ryu Ga Gotoku PARC (.par)
  if (magic4 === 'PARC' && bytes.length >= 16) {
    return parseParArchive(fileName, bytes, startTime);
  }

  // 13. Check EA BIGF / BIG4 (.big)
  if ((magic4 === 'BIGF' || magic4 === 'BIG4') && bytes.length >= 16) {
    return parseBigArchive(fileName, bytes, startTime);
  }

  // 14. Check Valve VPK (0x55AA1234 -> 34 12 AA 55)
  if (bytes.length >= 12 && bytes[0] === 0x34 && bytes[1] === 0x12 && bytes[2] === 0xaa && bytes[3] === 0x55) {
    return parseVpkArchive(fileName, bytes, startTime);
  }

  // 15. Check RAR v4 / v5 (Rar!\x1a\x07)
  if (
    bytes.length >= 7 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x61 &&
    bytes[2] === 0x72 &&
    bytes[3] === 0x21 &&
    bytes[4] === 0x1a &&
    bytes[5] === 0x07
  ) {
    return parseRarArchive(fileName, bytes, startTime);
  }

  // 16. Universal Zlib & Proprietary Stream Carver
  return parseZlibAndCarveStreams(fileName, bytes, startTime);
}

/**
 * Repack / Export Archive in Target Game Format (.zip, .pk3, .pak, .wad, .ff)
 */
export function repackArchiveAsFormat(
  entries: ArchiveEntry[],
  targetFormat: 'ZIP' | 'PK3' | 'PAK' | 'WAD' | 'FF',
  zoneState?: FastFileZoneState | null
): { bytes: Uint8Array; extension: string; mimeType: string } {
  if (targetFormat === 'ZIP' || targetFormat === 'PK3') {
    const fileMap: Record<string, Uint8Array> = {};
    for (const entry of entries) {
      if (entry.id === 'ff-zone-master') continue;
      fileMap[entry.path] = entry.data;
    }
    const zipped = zipSync(fileMap, { level: 6 });
    return {
      bytes: zipped,
      extension: targetFormat === 'PK3' ? '.pk3' : '.zip',
      mimeType: 'application/octet-stream',
    };
  }

  if (targetFormat === 'PAK') {
    const validEntries = entries.filter((e) => e.id !== 'ff-zone-master');
    let payloadSize = 0;
    for (const e of validEntries) payloadSize += e.data.length;

    const dirOffset = 12 + payloadSize;
    const dirLength = validEntries.length * 64;
    const out = new Uint8Array(dirOffset + dirLength);
    const view = new DataView(out.buffer);

    out[0] = 0x50;
    out[1] = 0x41;
    out[2] = 0x43;
    out[3] = 0x4b;
    view.setInt32(4, dirOffset, true);
    view.setInt32(8, dirLength, true);

    let dataPos = 12;
    let dirPos = dirOffset;
    const encoder = new TextEncoder();

    for (const e of validEntries) {
      out.set(e.data, dataPos);
      const pathBytes = encoder.encode(e.path.slice(0, 55));
      out.set(pathBytes, dirPos);
      view.setInt32(dirPos + 56, dataPos, true);
      view.setInt32(dirPos + 60, e.data.length, true);
      dataPos += e.data.length;
      dirPos += 64;
    }

    return { bytes: out, extension: '.pak', mimeType: 'application/octet-stream' };
  }

  if (targetFormat === 'WAD') {
    const validEntries = entries.filter((e) => e.id !== 'ff-zone-master');
    let payloadSize = 0;
    for (const e of validEntries) payloadSize += e.data.length;

    const infoTableOfs = 12 + payloadSize;
    const out = new Uint8Array(infoTableOfs + validEntries.length * 16);
    const view = new DataView(out.buffer);

    out[0] = 0x50;
    out[1] = 0x57;
    out[2] = 0x41;
    out[3] = 0x44;
    view.setInt32(4, validEntries.length, true);
    view.setInt32(8, infoTableOfs, true);

    let dataPos = 12;
    let dirPos = infoTableOfs;
    const encoder = new TextEncoder();

    for (const e of validEntries) {
      out.set(e.data, dataPos);
      view.setInt32(dirPos, e.data.length > 0 ? dataPos : 0, true);
      view.setInt32(dirPos + 4, e.data.length, true);
      const lumpName = e.name
        .replace(/\.[^.]+$/, '')
        .toUpperCase()
        .slice(0, 8);
      out.set(encoder.encode(lumpName), dirPos + 8);
      dataPos += e.data.length;
      dirPos += 16;
    }

    return { bytes: out, extension: '.wad', mimeType: 'application/octet-stream' };
  }

  // Target Format === 'FF': If we have an active T5/T6 zoneState, rebuild exact BO1/BO2 FastFile binary!
  if (zoneState) {
    const built = buildT5T6FastFileBinary(zoneState, 6);
    return {
      bytes: built,
      extension: '.ff',
      mimeType: 'application/octet-stream',
    };
  }

  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const e of entries) {
    if (e.id === 'ff-zone-master') continue;
    const nameBytes = encoder.encode(e.path);
    const block = new Uint8Array(nameBytes.length + 1 + e.data.length + 1);
    block.set(nameBytes, 0);
    block[nameBytes.length] = 0;
    block.set(e.data, nameBytes.length + 1);
    block[block.length - 1] = 0;
    chunks.push(block);
  }

  let totalZone = 32;
  for (const c of chunks) totalZone += c.length;
  const zoneBuffer = new Uint8Array(totalZone);
  zoneBuffer.set(encoder.encode('XASSET_ZONE_SPET_V1\0'), 0);
  let ptr = 32;
  for (const c of chunks) {
    zoneBuffer.set(c, ptr);
    ptr += c.length;
  }

  const compressedZone = zlibSync(zoneBuffer, { level: 6 });
  const ffOut = new Uint8Array(12 + compressedZone.length);
  ffOut.set(encoder.encode('IWffu100'), 0);
  const view = new DataView(ffOut.buffer);
  view.setUint32(8, 5, true);
  ffOut.set(compressedZone, 12);

  return { bytes: ffOut, extension: '.ff', mimeType: 'application/octet-stream' };
}
