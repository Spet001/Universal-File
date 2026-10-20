# Universal Game File Opener

> **Live Web Application:** Available directly in the browser at [spet01.dev/tools/universal-file](https://spet01.dev/tools/universal-file/) (part of the [spet01.dev/tools](https://spet01.dev/tools/) suite). 100% client-side execution, zero server dependencies.

Virtual filesystem inspector, archive container parser, stream carver, and asset previewer executed client-side in the browser. Decodes proprietary container formats, compressed lump directories, sector-aligned disc images, and compressed data streams across 25+ PC and console game engines.

## System Architecture

The tool is designed as a client-side virtual filesystem (VFS) engine with modular format decoders, low-level binary carvers, and high-density inspection panels.

```
+-------------------------------------------------------------------------------+
|                                Main UI Thread                                 |
|  - React 19 Workspace Shell (5-Zone Docking Layout)                          |
|  - Virtual Directory Hierarchy & File Lump Table                              |
|  - Multi-Tab Inspector: Preview, Hex View, Headers, Zlib Transcoder, Formats  |
+---------------------------------------+---------------------------------------+
                                        |
                   +--------------------+--------------------+
                   |                                         |
                   v                                         v
+--------------------------------------+  +-------------------------------------+
|        Virtual Filesystem Engine     |  |       Asset Preview & Decoding      |
|  - Sliced Uint8Array Buffers         |  |  - Text / INI / GSC Disassembly     |
|  - DataView Binary Readers (LE / BE) |  |  - Canvas Image Decoder (DDS/PNG)   |
|  - Direct Stream Carvers             |  |  - Audio Player (WAV/OGG/ADX/HCA)   |
|  - In-Place Hex / Ascii Editor       |  |  - Video Demuxer (Bink 1/2, USM)    |
+--------------------------------------+  +-------------------------------------+
                   |                                         |
                   v                                         v
+--------------------------------------+  +-------------------------------------+
|       Decompression Pipelines        |  |        Container Rebuilders         |
|  - RFC 1950 Zlib Streams (fflate)    |  |  - BO1 / BO2 FastFile Compiler      |
|  - RFC 1951 Raw Deflate (-15 window) |  |  - DOOM WAD Lump Rebuilder          |
|  - 0x7FC0 Treyarch Chunk Slices      |  |  - Quake PACK & ZIP Mod Repackers   |
|  - RefPack, LZ4, LZO, DCX Deflate    |  |  - Single / Bulk Lump Exporters     |
+--------------------------------------+  +-------------------------------------+
```

### Virtual Filesystem and Memory Model

1. **Zero-Copy Slicing**:
   - Files are loaded via HTML5 `File.arrayBuffer()`.
   - Sub-file entries (`ArchiveEntry`) reference views of the master container using byte offsets (`offset`) and byte lengths (`compressedSize`, `uncompressedSize`).
   - Slicing uses `buffer.subarray(offset, offset + size)` to prevent unnecessary memory duplication during directory traversal.

2. **Endianness Handling**:
   - Headers are read using JavaScript `DataView` primitives with explicit boolean flags for Little-Endian (`true`) and Big-Endian (`false`).
   - Console formats (Xbox 360 XEX, PS3 PKG, Nintendo DS/64, EA BIGF) strictly use Big-Endian byte ordering.
   - PC formats (DOOM WAD, Quake PAK, Bethesda BSA/BA2, Unreal PAK) use Little-Endian byte ordering.

3. **Stream Carving & Transcoding Engine**:
   - Scanning routines search memory buffers for known magic markers when headers are missing, encrypted, or corrupted.
   - The integrated Zlib Transcoder parses raw RFC 1950 zlib stream headers (`0x7801`, `0x789C`, `0x78DA`), validating the two-byte header and Adler-32 checksums.
   - For raw deflate streams lacking zlib wrappers (such as Treyarch Call of Duty fastfiles), the carver uses raw deflate decoding with a 15-bit window.

4. **Security and Isolation**:
   - All parsing, decompression, and extraction logic runs within the browser sandbox.
   - No data is transmitted to remote endpoints; all network operations are restricted to loading static UI icons and local test fixtures.
   - Buffer bounds are verified prior to slicing to prevent out-of-range indexing.

## Supported Engine and Container Specifications

| Format Identifier | File Extensions | Target Engine / Platform | Magic Signature (Hex / ASCII) | Compression & Memory Layout | Repack Support |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **FF** | `.ff` | Call of Duty (Treyarch T4-T10, Infinity Ward IW3-IW10) | `TAffu100`, `TAff0100`, `IWffu100`, `IWff0100` | BO2: Raw Deflate (`-15`) + `0x7FC0` Blocks; BO1/IW: Zlib Stream; Modern: LZ4/Oodle | Yes |
| **PS1** | `.bin`, `.cue`, `.iso` | Sony PlayStation 1 CD-ROM | `00 FF FF FF...` (Sync) / `CD001` (Sector 16 / `0x9300`) | Raw CD-XA Mode 2 Form 1 (2352 B/sector) & ISO 9660 Mode 1 | No |
| **UNITY** | `.assets`, `.unity3d`, `.bundle` | Unity Engine (Unity 4.x - 2023.x / UnityFS) | `55 6E 69 74 79 46 53` (`UnityFS`) | LZ4, LZMA, or uncompressed SerializedFile Object Table | No |
| **UNREAL** | `.pak`, `.uasset`, `.umap` | Epic Games Unreal Engine 4 & 5 | Footer: `5A 6F 12 E1`; Header: `9E 2A 83 C1` | Zlib, Oodle, LZ4 Chunks, Name Table serialization | No |
| **FF13** | `.bin`, `.wbd`, `.img`, `.dat` | Square Enix Crystal Tools (FFXIII, FFXIII-2, LR) | Filelist header table (`filelist.bin`) | Sector-aligned 2048-byte Zlib chunks | No |
| **IDTECH** | `.resource`, `.index`, `.bmodel` | id Software id Tech 6 (DOOM 2016, DOOM Eternal) | `52 45 53 00` (`RES\0`), `1B 4C 4D 42` (`\x1bLMB`) | Zlib/Deflate compressed streams, Big-Endian offsets | No |
| **BIK** | `.bik`, `.bk2` | RAD Game Tools Bink Video 1 & 2 | `42 49 4B *` (`BIK`), `4B 42 32 *` (`KB2`) | DCT / Wavelet motion video, multichannel audio streams | No |
| **GOD** | `.god`, `.header`, `Data0000`, `CON`, `LIVE`, `PIRS` | Microsoft Xbox 360 Games on Demand & XContent | `4C 49 56 45` (`LIVE`), `50 49 52 53` (`PIRS`), `43 4F 4E 20` (`CON `) | 4KB block allocation table, GDFX 2048-byte sector filesystem | No |
| **XEX** | `.xex`, `default.xex` | Microsoft Xbox 360 Executable (XEX1 / XEX2) | `58 45 58 32` (`XEX2`), `58 45 58 31` (`XEX1`) | Big-Endian optional headers, PE32 section headers, RSA signature | No |
| **APPX** | `.appx`, `.msix`, `.msixbundle`, `.xvd` | Microsoft Windows GDK & Xbox One / Series X|S | `50 4B 03 04` (ZIP OPC), `6D 73 66 74` (`msft` XVD) | OPC Deflate, SHA-256 BlockMap, XVD 4KB sector images | No |
| **NDS** | `.nds`, `.srl`, `.dsi` | Nintendo DS / DSi Cartridge ROM | Header offset `0x0000..0x0200` | NitroFS directory hierarchy (FAT table + FNT tree) | No |
| **ROM** | `.gba`, `.gb`, `.gbc`, `.z64`, `.n64`, `.sfc`, `.nes` | Classic Cartridge Systems (NES, SNES, N64, Game Boy, GBA) | `NES\x1A`, `0x80371240` (N64), `0x96` (GBA logo) | Memory bank controllers (MBC), memory-mapped ROM offsets | No |
| **WAD** | `.wad` | id Tech 1 / GoldSrc (DOOM, DOOM II, Half-Life) | `49 57 41 44` (`IWAD`), `50 57 41 44` (`PWAD`), `57 41 44 32` | 16-byte lump directory: offset (4B), size (4B), name (8B) | Yes |
| **PAK** | `.pak` | id Tech 2 / GoldSrc (Quake, Quake II, Half-Life) | `50 41 43 4B` (`PACK`) | 64-byte directory entries: path (56B), offset (4B), size (4B) | Yes |
| **PK3** | `.pk3`, `.pk4` | id Tech 3 / 4 (Quake III Arena, Doom 3) | `50 4B 03 04` (`PK\x03\x04`) | Standard RFC 1951 Deflate virtual directory | Yes |
| **ISO** | `.iso` | ISO 9660 Optical Disc Images (PS2, PSP, Dreamcast, PC) | `01 43 44 30 30 31 01` (`CD001` at sector 16 / `0x8000`) | 2048-byte sector uncompressed extent hierarchy | No |
| **PAR** | `.par` | Ryu Ga Gotoku Studio (Yakuza series) | `50 41 52 43` (`PARC`) | Hybrid uncompressed + Zlib/Sega LZ block compression | Yes |
| **BIG** | `.big` | Electronic Arts SAGE Engine & EAGL (C&C, BFME, NFS) | `42 49 47 46` (`BIGF`), `42 49 47 34` (`BIG4`) | Big-Endian offset table, null-terminated relative paths | Yes |
| **VPK** | `.vpk` | Valve Source Engine & Source 2 | `34 12 AA 55` (`0x55AA1234`) | 3-tier extension/path/filename directory tree | No |
| **RAR** | `.rar` | Scene / Mod Distribution (RAR 1.5 - 5.0) | `52 61 72 21 1A 07` (`Rar!\x1A\x07`) | Block-structured headers, CRC32 validation | No |
| **ZIP** | `.zip` | Universal Archive Container | `50 4B 03 04` (`PK\x03\x04`) | RFC 1951 Deflate and Store | Yes |
| **ZLIB** | `.zlib`, `.dat`, `.bin` | Raw Stream Carver | `78 01`, `78 9C`, `78 DA` | RFC 1950 stream parsing + header validation | Yes |
| **BSA** | `.bsa` | Bethesda Gamebryo Engine (Oblivion, Skyrim, Fallout 3/NV) | `42 53 41 00` (`BSA\0`) | Direct-offset hierarchical directory tree with Zlib compression | No |
| **BA2** | `.ba2` | Bethesda Creation Engine (Fallout 4, Starfield) | `42 54 44 58` (`BTDX`) | 64-bit alignment, GNRL and DX10 chunk records | No |
| **FORGE** | `.forge` | Ubisoft Anvil / Scimitar Engine (Assassin's Creed) | `73 63 69 6D 69 74 61 72` (`scimitar\0`) | LZO / Deflate chunks with 64-bit resource hashes | No |
| **RPF** | `.rpf` | Rockstar Advanced Game Engine (GTA IV/V, RDR, Max Payne 3) | `52 50 46 30..37` (`RPF0..RPF7`) | Zlib Deflate / Store with name string heap | No |
| **JAR** | `.jar` | Minecraft Java Edition Mods | `50 4B 03 04` (`PK\x03\x04`) | ZIP Deflate containing JVM class files and mod manifests | Yes |
| **PKG** | `.pkg` | Sony PlayStation Package (PS3, PS4, PS Vita) | `7F 50 4B 47` (`\x7fPKG`) | DRM envelope, PARAM.SFO metadata, AES encrypted blocks | No |
| **CRIWARE** | `.awb`, `.acb`, `.usm`, `.adx`, `.hca` | CRI Middleware Audio and Video | `AFS2`, `@UTF`, `CRID`, `HCA\0`, `80 00` | AFS2 wave banks, @UTF schema tables, Sofdec2 streams, HCA audio | No |
| **FROMSOFT** | `.bnd`, `.bnd4`, `.dcx`, `.chrbnd` | FromSoftware Soulsborne (Dark Souls, Bloodborne, Elden Ring) | `44 43 58 00` (`DCX\0`), `42 4E 44 33`, `42 4E 44 34` | DCX Deflate (`DFLT`) container with embedded file records | No |
| **SQUARE** | `.sdat`, `.pfs`, `.pf8` | Square Enix Sound & Package Archives | `53 44 41 54` (`SDAT`), `50 46 53 20` (`PFS `) | SDAT audio bank hierarchy and PFS block containers | No |

## Data Structures

### Archive Entry Record

```typescript
export interface ArchiveEntry {
  id: string;
  name: string;
  path: string;
  offset: number;
  compressedSize: number;
  uncompressedSize: number;
  isCompressed: boolean;
  compressionMethod?: string;
  crc32?: number;
  category: AssetCategory;
  extension: string;
  data?: Uint8Array;
  metadata?: Record<string, string | number | boolean>;
}
```

### Parsed Archive Representation

```typescript
export interface ParsedArchive {
  formatId: ArchiveFormatId;
  formatName: string;
  filename: string;
  totalSize: number;
  entriesCount: number;
  entries: ArchiveEntry[];
  headers: ArchiveHeaderField[];
  canRepack: boolean;
  warning?: string;
  rawBuffer?: Uint8Array;
}
```

## Local Development and Verification

### Prerequisites

- Node.js 20.x or 22.x LTS
- npm 10.x or higher

### Installation

```bash
npm ci
```

### Test Suite Execution

Run the Vitest format and engine parser test suite:

```bash
npm test
```

The test runner validates:
1. DOOM WAD lump table parsing and repacking round-trips.
2. Quake PACK header offsets and lump extraction.
3. Call of Duty FastFile header identification and decompressed zone integrity.
4. Bethesda BSA / BA2 chunk record extraction.
5. FromSoftware BND / DCX envelope unpacking.
6. Nintendo DS NitroFS FAT/FNT directory traversal.
7. RFC 1950 Zlib and raw Deflate stream carvers.

### Production Build

Compile TypeScript and bundle assets with Vite:

```bash
npm run build
```

Production artifacts are written to the `dist/` directory.

### Local Preview

To serve the production build locally:

```bash
npm run preview
```

## Online Access

This tool runs entirely client-side inside the browser using WebAssembly and Web Workers.

- **Direct Web App:** [https://spet01.dev/tools/universal-file/](https://spet01.dev/tools/universal-file/)
- **Tools Suite:** [https://spet01.dev/tools/](https://spet01.dev/tools/)
