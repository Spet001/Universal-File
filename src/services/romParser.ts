import { ArchiveEntry, ArchiveHeaderField, ParsedArchive, AssetCategory } from '../types/archive';
import {
  bytesToHexPreview,
  classifyEntry,
  computeCRC32,
  formatBytes,
  readAscii,
  splitFolderAndName,
  toHex,
} from './archiveParser';

export interface NdsBannerInfo {
  version: number;
  iconWidth: number;
  iconHeight: number;
  paletteColorsRgba: number[][];
  rgbaPixels: Uint8Array;
  titles: {
    japanese?: string;
    english?: string;
    french?: string;
    german?: string;
    italian?: string;
    spanish?: string;
  };
}

function decodeUtf16LE(bytes: Uint8Array, offset: number, maxChars: number): string {
  const chars: string[] = [];
  const end = Math.min(bytes.length, offset + maxChars * 2);
  for (let i = offset; i + 1 < end; i += 2) {
    const code = bytes[i] | (bytes[i + 1] << 8);
    if (code === 0) break;
    chars.push(String.fromCharCode(code));
  }
  return chars.join('').trim();
}

function bgr555ToRgba(bgr: number, isTransparent = false): [number, number, number, number] {
  if (isTransparent) return [0, 0, 0, 0];
  const r = (bgr & 0x1f) << 3;
  const g = ((bgr >> 5) & 0x1f) << 3;
  const b = ((bgr >> 10) & 0x1f) << 3;
  return [r, g, b, 255];
}

export function decodeNdsBanner(bytes: Uint8Array, bannerOffset: number): NdsBannerInfo | null {
  if (bytes.length < bannerOffset + 0x840) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const version = view.getUint16(bannerOffset, true);
  if (version !== 0x0001 && version !== 0x0002 && version !== 0x0003 && version !== 0x0103) {
    return null;
  }

  const paletteColorsRgba: number[][] = [];
  const palOffset = bannerOffset + 0x220;
  for (let c = 0; c < 16; c++) {
    const colorVal = view.getUint16(palOffset + c * 2, true);

    paletteColorsRgba.push(bgr555ToRgba(colorVal, c === 0));
  }

  const iconPixelData = new Uint8Array(32 * 32 * 4);
  const iconTilesOffset = bannerOffset + 0x20;

  for (let tileIdx = 0; tileIdx < 16; tileIdx++) {
    const tileX = (tileIdx % 4) * 8;
    const tileY = Math.floor(tileIdx / 4) * 8;
    const tileDataStart = iconTilesOffset + tileIdx * 32;

    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col += 2) {
        const byteVal = bytes[tileDataStart + row * 4 + col / 2];
        const col0 = byteVal & 0x0f;
        const col1 = (byteVal >> 4) & 0x0f;

        const p0 = paletteColorsRgba[col0] || [0, 0, 0, 0];
        const p1 = paletteColorsRgba[col1] || [0, 0, 0, 0];

        const pixelIndex0 = ((tileY + row) * 32 + (tileX + col)) * 4;
        iconPixelData[pixelIndex0] = p0[0];
        iconPixelData[pixelIndex0 + 1] = p0[1];
        iconPixelData[pixelIndex0 + 2] = p0[2];
        iconPixelData[pixelIndex0 + 3] = p0[3];

        const pixelIndex1 = ((tileY + row) * 32 + (tileX + col + 1)) * 4;
        iconPixelData[pixelIndex1] = p1[0];
        iconPixelData[pixelIndex1 + 1] = p1[1];
        iconPixelData[pixelIndex1 + 2] = p1[2];
        iconPixelData[pixelIndex1 + 3] = p1[3];
      }
    }
  }

  const titleBase = bannerOffset + 0x240;
  const titles = {
    japanese: decodeUtf16LE(bytes, titleBase, 128),
    english: decodeUtf16LE(bytes, titleBase + 0x100, 128),
    french: decodeUtf16LE(bytes, titleBase + 0x200, 128),
    german: decodeUtf16LE(bytes, titleBase + 0x300, 128),
    italian: decodeUtf16LE(bytes, titleBase + 0x400, 128),
    spanish: decodeUtf16LE(bytes, titleBase + 0x500, 128),
  };

  return {
    version,
    iconWidth: 32,
    iconHeight: 32,
    paletteColorsRgba,
    rgbaPixels: iconPixelData,
    titles,
  };
}

export function isNdsRom(bytes: Uint8Array): boolean {
  if (bytes.length < 512) return false;

  const devCap = bytes[0x14];
  const unitCode = bytes[0x12];
  if (unitCode !== 0x00 && unitCode !== 0x02 && unitCode !== 0x03) return false;
  if (devCap > 0x15) return false;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const arm9Offset = view.getUint32(0x20, true);
  const arm7Offset = view.getUint32(0x30, true);
  const fntOffset = view.getUint32(0x40, true);
  const fatOffset = view.getUint32(0x48, true);

  if (arm9Offset >= 0x200 && arm9Offset < bytes.length &&
      arm7Offset >= 0x200 && arm7Offset < bytes.length &&
      fntOffset > 0 && fntOffset < bytes.length &&
      fatOffset > 0 && fatOffset < bytes.length) {
    return true;
  }

  const gameCode = readAscii(bytes, 0x0c, 4);
  if (/^[A-Z0-9]{4}$/.test(gameCode) && arm9Offset >= 0x200) {
    return true;
  }

  return false;
}

export function parseNdsRomArchive(
  fileName: string,
  bytes: Uint8Array,
  startTime: number
): ParsedArchive {
  const headerFields: ArchiveHeaderField[] = [];
  const warnings: string[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const rawTitle = readAscii(bytes, 0, 12).trim();
  const gameCode = readAscii(bytes, 0x0c, 4).trim();
  const makerCode = readAscii(bytes, 0x10, 2).trim();
  const unitCode = bytes[0x12];
  const unitCodeName = unitCode === 0x00 ? 'Nintendo DS' : unitCode === 0x02 ? 'Nintendo DS + DSi' : 'Nintendo DSi Exclusive';
  const romVersion = bytes[0x1c];

  const arm9Offset = view.getUint32(0x20, true);
  const arm9Entry = view.getUint32(0x24, true);
  const arm9Ram = view.getUint32(0x28, true);
  const arm9Size = view.getUint32(0x2c, true);

  const arm7Offset = view.getUint32(0x30, true);
  const arm7Entry = view.getUint32(0x34, true);
  const arm7Ram = view.getUint32(0x38, true);
  const arm7Size = view.getUint32(0x3c, true);

  const fntOffset = view.getUint32(0x40, true);
  const fntSize = view.getUint32(0x44, true);
  const fatOffset = view.getUint32(0x48, true);
  const fatSize = view.getUint32(0x4c, true);

  const bannerOffset = view.getUint32(0x68, true);
  const totalRomSize = view.getUint32(0x80, true) || bytes.length;

  headerFields.push({
    label: 'Cartridge Game Title',
    offset: '0x0000',
    length: 12,
    value: rawTitle || 'Untitled NDS Game',
    description: 'Internal 12-byte uppercase ASCII cartridge registration title',
  });

  headerFields.push({
    label: 'Game Product Code',
    offset: '0x000C',
    length: 4,
    value: `NTR-${gameCode} (Maker: ${makerCode})`,
    description: 'Nintendo unique 4-character serial identifier and licensee code',
  });

  headerFields.push({
    label: 'Hardware Platform Target',
    offset: '0x0012',
    length: 1,
    value: unitCodeName,
    description: 'Nintendo DS / DSi compatibility mode flag',
  });

  headerFields.push({
    label: 'ARM9 Main Binary',
    offset: '0x0020',
    length: 16,
    value: `ROM: 0x${toHex(arm9Offset, 6)} · Entry: 0x${toHex(arm9Entry, 8)} (${formatBytes(arm9Size)})`,
    description: 'ARM946E-S 67MHz primary CPU game engine binary',
  });

  headerFields.push({
    label: 'ARM7 Sub-Processor Binary',
    offset: '0x0030',
    length: 16,
    value: `ROM: 0x${toHex(arm7Offset, 6)} · Entry: 0x${toHex(arm7Entry, 8)} (${formatBytes(arm7Size)})`,
    description: 'ARM7TDMI 33MHz sound, touchscreen, and cartridge hardware binary',
  });

  headerFields.push({
    label: 'NitroFS File Table (FNT / FAT)',
    offset: '0x0040',
    length: 16,
    value: `FNT: 0x${toHex(fntOffset, 6)} (${formatBytes(fntSize)}) · FAT: 0x${toHex(fatOffset, 6)} (${formatBytes(fatSize)})`,
    description: 'Internal virtual filesystem directory tables',
  });

  let bannerInfo: NdsBannerInfo | null = null;
  if (bannerOffset > 0 && bannerOffset < bytes.length) {
    bannerInfo = decodeNdsBanner(bytes, bannerOffset);
    if (bannerInfo) {
      const displayTitle = bannerInfo.titles.english || bannerInfo.titles.japanese || rawTitle;
      headerFields.push({
        label: 'Banner Localized Title',
        offset: `0x${toHex(bannerOffset + 0x240, 6)}`,
        length: 256,
        value: displayTitle,
        description: 'Nintendo DS system menu 6-language UTF-16 title string',
      });
    }
  }

  const entries: ArchiveEntry[] = [];
  const enc = new TextEncoder();

  if (arm9Offset > 0 && arm9Offset + arm9Size <= bytes.length && arm9Size > 0) {
    const arm9Bytes = bytes.slice(arm9Offset, arm9Offset + arm9Size);
    entries.push({
      id: 'nds-arm9',
      name: 'arm9.bin',
      path: 'system/arm9.bin',
      folder: 'system',
      offset: arm9Offset,
      compressedSize: arm9Bytes.length,
      uncompressedSize: arm9Bytes.length,
      compressionMethod: 'Stored ARM9 Binary',
      crc32: computeCRC32(arm9Bytes),
      category: 'executable',
      data: arm9Bytes,
      metadata: {
        entryPoint: `0x${toHex(arm9Entry, 8)}`,
        ramAddress: `0x${toHex(arm9Ram, 8)}`,
      },
    });
  }

  if (arm7Offset > 0 && arm7Offset + arm7Size <= bytes.length && arm7Size > 0) {
    const arm7Bytes = bytes.slice(arm7Offset, arm7Offset + arm7Size);
    entries.push({
      id: 'nds-arm7',
      name: 'arm7.bin',
      path: 'system/arm7.bin',
      folder: 'system',
      offset: arm7Offset,
      compressedSize: arm7Bytes.length,
      uncompressedSize: arm7Bytes.length,
      compressionMethod: 'Stored ARM7 Binary',
      crc32: computeCRC32(arm7Bytes),
      category: 'executable',
      data: arm7Bytes,
      metadata: {
        entryPoint: `0x${toHex(arm7Entry, 8)}`,
        ramAddress: `0x${toHex(arm7Ram, 8)}`,
      },
    });
  }

  const headerBytes = bytes.slice(0, Math.min(bytes.length, 0x200));
  entries.push({
    id: 'nds-header',
    name: 'cartridge_header.bin',
    path: 'system/cartridge_header.bin',
    folder: 'system',
    offset: 0,
    compressedSize: headerBytes.length,
    uncompressedSize: headerBytes.length,
    compressionMethod: 'Stored',
    crc32: computeCRC32(headerBytes),
    category: 'config',
    data: headerBytes,
    metadata: {
      gameTitle: rawTitle,
      gameCode,
      makerCode,
    },
  });

  if (bannerInfo) {

    const iconEntry: ArchiveEntry = {
      id: 'nds-banner-icon',
      name: 'banner_icon.rgba',
      path: 'system/banner_icon.rgba',
      folder: 'system',
      offset: bannerOffset + 0x20,
      compressedSize: bannerInfo.rgbaPixels.length,
      uncompressedSize: bannerInfo.rgbaPixels.length,
      compressionMethod: 'NDS 4bpp Tiled (32x32)',
      crc32: computeCRC32(bannerInfo.rgbaPixels),
      category: 'texture',
      data: bannerInfo.rgbaPixels,
      metadata: {
        isNdsIcon: true,
        width: 32,
        height: 32,
        paletteCount: 16,
      },
    };
    entries.push(iconEntry);

    const titlesText = `Nintendo DS Banner Metadata\n===========================\nEnglish: ${bannerInfo.titles.english || '(none)'}\nJapanese: ${bannerInfo.titles.japanese || '(none)'}\nFrench: ${bannerInfo.titles.french || '(none)'}\nGerman: ${bannerInfo.titles.german || '(none)'}\nItalian: ${bannerInfo.titles.italian || '(none)'}\nSpanish: ${bannerInfo.titles.spanish || '(none)'}\n`;
    const titlesBytes = enc.encode(titlesText);
    entries.push({
      id: 'nds-banner-titles',
      name: 'banner_titles.txt',
      path: 'system/banner_titles.txt',
      folder: 'system',
      offset: bannerOffset + 0x240,
      compressedSize: titlesBytes.length,
      uncompressedSize: titlesBytes.length,
      compressionMethod: 'Stored UTF-16',
      crc32: computeCRC32(titlesBytes),
      category: 'config',
      data: titlesBytes,
    });
  }

  if (fatOffset > 0 && fatOffset + fatSize <= bytes.length && fntOffset > 0 && fntOffset + fntSize <= bytes.length) {

    const numFiles = Math.floor(fatSize / 8);
    const fatTable: Array<{ start: number; end: number; size: number }> = [];

    for (let f = 0; f < numFiles; f++) {
      const fStart = view.getUint32(fatOffset + f * 8, true);
      const fEnd = view.getUint32(fatOffset + f * 8 + 4, true);
      const fSize = fEnd > fStart ? fEnd - fStart : 0;
      fatTable.push({ start: fStart, end: fEnd, size: fSize });
    }

    if (fntSize >= 8) {
      const rootSubTableOfs = view.getUint32(fntOffset, true);
      const rootFirstFileId = view.getUint16(fntOffset + 4, true);
      const totalDirs = view.getUint16(fntOffset + 6, true);

      const dirQueue: Array<{ dirId: number; subTableOfs: number; firstFileId: number; path: string }> = [
        { dirId: 0xf000, subTableOfs: rootSubTableOfs, firstFileId: rootFirstFileId, path: 'data' },
      ];

      const visitedDirs = new Set<number>();
      let fileCount = 0;

      while (dirQueue.length > 0 && fileCount < 2000) {
        const { dirId, subTableOfs, firstFileId, path: curPath } = dirQueue.shift()!;
        if (visitedDirs.has(dirId)) continue;
        visitedDirs.add(dirId);

        let curFileId = firstFileId;
        let ptr = fntOffset + subTableOfs;

        while (ptr < fntOffset + fntSize && fileCount < 2000) {
          const typeAndLen = bytes[ptr++];
          if (typeAndLen === 0x00) {

            break;
          }

          const isSubDir = (typeAndLen & 0x80) !== 0;
          const nameLen = typeAndLen & 0x7f;

          if (ptr + nameLen > bytes.length) break;
          const entryName = readAscii(bytes, ptr, nameLen);
          ptr += nameLen;

          if (isSubDir) {
            if (ptr + 2 > bytes.length) break;
            const subDirId = view.getUint16(ptr, true);
            ptr += 2;

            const dirIndex = subDirId & 0x0fff;
            const dirEntryOfs = fntOffset + dirIndex * 8;
            if (dirEntryOfs + 8 <= fntOffset + fntSize) {
              const subOfs = view.getUint32(dirEntryOfs, true);
              const subFirstId = view.getUint16(dirEntryOfs + 4, true);
              dirQueue.push({
                dirId: subDirId,
                subTableOfs: subOfs,
                firstFileId: subFirstId,
                path: `${curPath}/${entryName}`,
              });
            }
          } else {

            const fId = curFileId++;
            if (fId < fatTable.length) {
              const { start: fStart, size: fSize } = fatTable[fId];
              const fEnd = Math.min(bytes.length, fStart + fSize);
              const fileData = fStart < bytes.length && fSize > 0 ? bytes.slice(fStart, fEnd) : new Uint8Array(0);

              const fullPath = `${curPath}/${entryName}`;
              const { folder, name: cleanName } = splitFolderAndName(fullPath);

              const lowerName = cleanName.toLowerCase();
              let category = classifyEntry(cleanName, fileData);

              if (lowerName.endsWith('.sdat') || (fileData.length >= 4 && readAscii(fileData, 0, 4) === 'SDAT')) {
                category = 'audio';
              } else if (lowerName.endsWith('.nsbmd') || lowerName.endsWith('.bmd')) {
                category = 'model';
              } else if (lowerName.endsWith('.ncgr') || lowerName.endsWith('.nclr') || lowerName.endsWith('.nsbtx')) {
                category = 'texture';
              } else if (lowerName.endsWith('.narc') || (fileData.length >= 4 && readAscii(fileData, 0, 4) === 'NARC')) {
                category = 'package';
              }

              entries.push({
                id: `nds-file-${fId}-${cleanName}`,
                name: cleanName,
                path: fullPath,
                folder,
                offset: fStart,
                compressedSize: fileData.length,
                uncompressedSize: fSize,
                compressionMethod: 'NitroFS Stored',
                crc32: computeCRC32(fileData),
                category,
                data: fileData,
                metadata: {
                  fileId: fId,
                  fStart,
                  fSize,
                  isSdat: category === 'audio',
                  isNarc: category === 'package',
                },
              });
              fileCount++;
            }
          }
        }
      }
    }
  }

  headerFields.push({
    label: 'Extracted NitroFS Game Assets',
    offset: 'Virtual FAT/FNT',
    length: entries.length,
    value: `${entries.length} Assets (ARM9, ARM7, Audio SDAT, NARC Packages, Textures)`,
    description: 'Fully indexed internal filesystem hierarchy extracted from Nintendo DS ROM',
  });

  return {
    fileName,
    fileSize: bytes.length,
    formatId: 'NDS',
    formatName: `Nintendo DS ROM (${rawTitle || gameCode})`,
    engineFamily: `Nintendo DS / NitroFS (${unitCodeName})`,
    magicBytes: bytesToHexPreview(bytes, 16),
    endianness: 'Little Endian',
    headerFields,
    entries,
    rawBytes: bytes,
    parseTimeMs: Math.round(performance.now() - startTime),
    warnings,
    extraInfo: {
      gameTitle: rawTitle,
      gameCode,
      makerCode,
      unitCodeName,
      romVersion,
      bannerInfo,
      totalRomSize,
    },
  };
}

export function parseClassicConsoleRom(
  fileName: string,
  bytes: Uint8Array,
  startTime: number
): ParsedArchive {
  const headerFields: ArchiveHeaderField[] = [];
  const warnings: string[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const lower = fileName.toLowerCase();
  const enc = new TextEncoder();

  let formatName = 'Console ROM Cartridge';
  let engineFamily = 'Nintendo Video Game Console';
  let detectedPlatform = 'ROM';

  if (lower.endsWith('.gba') || (bytes.length >= 0xC0 && bytes[0xb2] === 0x96)) {
    detectedPlatform = 'GBA';
    const title = readAscii(bytes, 0xa0, 12).trim();
    const gameCode = readAscii(bytes, 0xac, 4).trim();
    const makerCode = readAscii(bytes, 0xb0, 2).trim();

    formatName = `Game Boy Advance ROM (${title || gameCode})`;
    engineFamily = 'Nintendo Game Boy Advance (ARM7TDMI 16.78 MHz)';

    headerFields.push({
      label: 'GBA Game Title',
      offset: '0x00A0',
      length: 12,
      value: title || 'GBA Title',
      description: 'Cartridge 12-character uppercase registration string',
    });
    headerFields.push({
      label: 'Product Serial Code',
      offset: '0x00AC',
      length: 4,
      value: `AGB-${gameCode} (Maker: ${makerCode})`,
      description: 'GBA unique product catalog identifier',
    });
    headerFields.push({
      label: 'Fixed Value Flag',
      offset: '0x00B2',
      length: 1,
      value: `0x${toHex(bytes[0xb2], 2)} (Valid GBA Cartridge Header)`,
      description: 'Header validation byte required by GBA BIOS boot sequence',
    });
  }

  else if (lower.endsWith('.gb') || lower.endsWith('.gbc')) {
    detectedPlatform = 'GB';
    const title = readAscii(bytes, 0x134, 16).trim();
    const cgbFlag = bytes[0x143];
    const isCgb = cgbFlag === 0x80 || cgbFlag === 0xc0;
    const cartType = bytes[0x147];

    formatName = isCgb ? `Game Boy Color ROM (${title})` : `Game Boy DMG ROM (${title})`;
    engineFamily = isCgb ? 'Nintendo Game Boy Color (LR35902)' : 'Nintendo Game Boy DMG (Sharp LR35902 4.19 MHz)';

    headerFields.push({
      label: 'Game Boy Title',
      offset: '0x0134',
      length: 16,
      value: title || 'Game Boy Title',
      description: 'Internal cartridge title in header',
    });
    headerFields.push({
      label: 'CGB Color Flag',
      offset: '0x0143',
      length: 1,
      value: isCgb ? 'Game Boy Color Enhanced (0x80/0xC0)' : 'Monochrome Game Boy DMG (0x00)',
      description: 'Game Boy Color hardware compatibility mode',
    });
    headerFields.push({
      label: 'Cartridge Hardware Type',
      offset: '0x0147',
      length: 1,
      value: `MBC Controller Type 0x${toHex(cartType, 2)}`,
      description: 'Memory Bank Controller (MBC1, MBC2, MBC3, MBC5) or ROM Only',
    });
  }

  else if (
    lower.endsWith('.z64') ||
    lower.endsWith('.n64') ||
    lower.endsWith('.v64') ||
    (bytes.length >= 0x40 &&
      ((bytes[0] === 0x80 && bytes[1] === 0x37 && bytes[2] === 0x12 && bytes[3] === 0x40) ||
        (bytes[0] === 0x37 && bytes[1] === 0x80 && bytes[2] === 0x40 && bytes[3] === 0x12) ||
        (bytes[0] === 0x40 && bytes[1] === 0x12 && bytes[2] === 0x37 && bytes[3] === 0x80)))
  ) {
    detectedPlatform = 'N64';
    const isBigEndian = bytes[0] === 0x80 && bytes[1] === 0x37;
    const isByteSwapped = bytes[0] === 0x37 && bytes[1] === 0x80;
    const title = readAscii(bytes, 0x20, 20).trim();
    const gameCode = readAscii(bytes, 0x3b, 4).trim();

    formatName = `Nintendo 64 ROM (${title || gameCode})`;
    engineFamily = 'Nintendo 64 (MIPS VR4300 93.75 MHz & Reality Coprocessor)';

    headerFields.push({
      label: 'N64 Cartridge Title',
      offset: '0x0020',
      length: 20,
      value: title || 'N64 Game Title',
      description: 'Internal 20-byte ASCII registration string',
    });
    headerFields.push({
      label: 'N64 Media Code',
      offset: '0x003B',
      length: 4,
      value: `NUS-${gameCode}`,
      description: 'Nintendo Ultra 64 serial code',
    });
    headerFields.push({
      label: 'ROM Byte Endianness',
      offset: '0x0000',
      length: 4,
      value: isBigEndian ? 'Native Big-Endian (.z64)' : isByteSwapped ? 'Byte-Swapped (.v64)' : 'Little-Endian (.n64)',
      description: 'Format encoding layout of N64 cartridge dump',
    });
  }

  else if (bytes.length >= 16 && bytes[0] === 0x4e && bytes[1] === 0x45 && bytes[2] === 0x53 && bytes[3] === 0x1a) {
    detectedPlatform = 'NES';
    const prgSize = bytes[4] * 16384;
    const chrSize = bytes[5] * 8192;
    const mapper = (bytes[6] >> 4) | (bytes[7] & 0xf0);

    formatName = `Nintendo Entertainment System (iNES ROM)`;
    engineFamily = 'Nintendo Entertainment System / Famicom (Ricoh 2A03 1.79 MHz)';

    headerFields.push({
      label: 'NES Magic Signature',
      offset: '0x0000',
      length: 4,
      value: 'NES\\x1A (iNES / NES 2.0 Header)',
      description: 'Standard NES cartridge emulation container format',
    });
    headerFields.push({
      label: 'PRG ROM Program Size',
      offset: '0x0004',
      length: 1,
      value: `${formatBytes(prgSize)} (${bytes[4]} × 16KB Pages)`,
      description: '6502 machine code executable memory space',
    });
    headerFields.push({
      label: 'CHR ROM Character/Tiles Size',
      offset: '0x0005',
      length: 1,
      value: chrSize > 0 ? `${formatBytes(chrSize)} (${bytes[5]} × 8KB Pages)` : '0 B (Uses CHR-RAM)',
      description: 'PPU background and sprite tile pattern table storage',
    });
    headerFields.push({
      label: 'ASIC Memory Mapper ID',
      offset: '0x0006',
      length: 2,
      value: `Mapper #${mapper}`,
      description: 'Cartridge hardware bank switching ASIC (MMC1, MMC3, VRC, etc.)',
    });
  }

  const entries: ArchiveEntry[] = [];

  const manifest = `Classic Console ROM Cartridge Information\n=========================================\nFile Name: ${fileName}\nPlatform: ${detectedPlatform}\nFormat: ${formatName}\nEngine Family: ${engineFamily}\nROM Size: ${formatBytes(bytes.length)} (${bytes.length.toLocaleString()} bytes)\nCRC32: 0x${toHex(computeCRC32(bytes), 8)}\n`;
  const manifestBytes = enc.encode(manifest);

  entries.push({
    id: 'rom-manifest',
    name: 'RomHeaderInfo.txt',
    path: 'RomHeaderInfo.txt',
    folder: '',
    offset: 0,
    compressedSize: manifestBytes.length,
    uncompressedSize: manifestBytes.length,
    compressionMethod: 'Stored',
    crc32: computeCRC32(manifestBytes),
    category: 'config',
    data: manifestBytes,
  });

  entries.push({
    id: 'rom-payload',
    name: `${fileName.replace(/\.[^.]+$/, '')}.payload`,
    path: `cartridge/${fileName.replace(/\.[^.]+$/, '')}.payload`,
    folder: 'cartridge',
    offset: 0,
    compressedSize: bytes.length,
    uncompressedSize: bytes.length,
    compressionMethod: 'Raw Memory Map',
    crc32: computeCRC32(bytes),
    category: 'binary',
    data: bytes,
    metadata: {
      platform: detectedPlatform,
    },
  });

  return {
    fileName,
    fileSize: bytes.length,
    formatId: 'ROM',
    formatName,
    engineFamily,
    magicBytes: bytesToHexPreview(bytes, 16),
    endianness: 'Little Endian',
    headerFields,
    entries,
    rawBytes: bytes,
    parseTimeMs: Math.round(performance.now() - startTime),
    warnings,
  };
}
