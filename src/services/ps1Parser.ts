import { ArchiveEntry, ArchiveHeaderField, ParsedArchive } from '../types/archive';
import { computeCRC32, toHex, bytesToHexPreview, classifyEntry, readAscii, splitFolderAndName } from './archiveParser';

export interface Ps1DiscInfo {
  isRaw2352: boolean;
  sectorSize: number;
  dataOffsetPerSector: number;
  dataLengthPerSector: number;
  systemId: string;
  volumeId: string;
  gameSerial?: string;
  gameRegion?: string;
  bootExecutable?: string;
}

/**
 * PS1 TIM Texture Header & Image Data
 */
export interface Ps1TimImage {
  magic: number; // 0x10
  bpp: 4 | 8 | 16 | 24;
  hasClut: boolean;
  clutX: number;
  clutY: number;
  clutColors: number;
  clutNumPalettes: number;
  paletteColorsRgba: number[][]; // Array of [R, G, B, A]
  imgX: number;
  imgY: number;
  imgWidth: number;
  imgHeight: number;
  pixelWidth: number;
  rgbaPixels: Uint8Array; // RGBA Uint8ClampedArray for HTML Canvas
}

/**
 * Decode a PS1 .TIM Texture Image
 */
export function decodePs1Tim(data: Uint8Array): Ps1TimImage | null {
  if (data.length < 16) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const magic = view.getUint32(0, true);
  if ((magic & 0xff) !== 0x10) return null;

  const flag = view.getUint32(4, true);
  const bppMode = flag & 0x07;
  const hasClut = (flag & 0x08) !== 0;

  let bpp: 4 | 8 | 16 | 24 = 16;
  if (bppMode === 0) bpp = 4;
  else if (bppMode === 1) bpp = 8;
  else if (bppMode === 2) bpp = 16;
  else if (bppMode === 3) bpp = 24;

  let pos = 8;
  const paletteColorsRgba: number[][] = [];
  let clutX = 0;
  let clutY = 0;
  let clutColors = 0;
  let clutNumPalettes = 0;

  if (hasClut) {
    if (pos + 12 > data.length) return null;
    const clutLength = view.getUint32(pos, true);
    clutX = view.getUint16(pos + 4, true);
    clutY = view.getUint16(pos + 6, true);
    clutColors = view.getUint16(pos + 8, true);
    clutNumPalettes = view.getUint16(pos + 10, true);
    pos += 12;

    const totalClutEntries = clutColors * clutNumPalettes;
    for (let c = 0; c < totalClutEntries && pos + 2 <= data.length; c++) {
      const color16 = view.getUint16(pos, true);
      pos += 2;
      const r = (color16 & 0x1f) << 3;
      const g = ((color16 >> 5) & 0x1f) << 3;
      const b = ((color16 >> 10) & 0x1f) << 3;
      const stp = (color16 >> 15) & 1;
      const a = color16 === 0 ? 0 : stp ? 255 : 240;
      paletteColorsRgba.push([r, g, b, a]);
    }
  }

  if (pos + 12 > data.length) return null;
  const imgLength = view.getUint32(pos, true);
  const imgX = view.getUint16(pos + 4, true);
  const imgY = view.getUint16(pos + 6, true);
  const imgWidth = view.getUint16(pos + 8, true); // in 16-bit words
  const imgHeight = view.getUint16(pos + 10, true);
  pos += 12;

  let pixelWidth = imgWidth;
  if (bpp === 4) pixelWidth = imgWidth * 4;
  else if (bpp === 8) pixelWidth = imgWidth * 2;
  else if (bpp === 16) pixelWidth = imgWidth;
  else if (bpp === 24) pixelWidth = Math.floor((imgWidth * 2) / 3);

  const rgbaPixels = new Uint8Array(pixelWidth * imgHeight * 4);
  const pixelDataEnd = Math.min(data.length, pos + imgWidth * 2 * imgHeight);

  if (bpp === 4) {
    let px = 0;
    for (let i = pos; i < pixelDataEnd && px < pixelWidth * imgHeight; i++) {
      const byte = data[i];
      const idx1 = byte & 0x0f;
      const idx2 = (byte >> 4) & 0x0f;

      const col1 = paletteColorsRgba[idx1] || [0, 0, 0, 0];
      rgbaPixels[px * 4] = col1[0];
      rgbaPixels[px * 4 + 1] = col1[1];
      rgbaPixels[px * 4 + 2] = col1[2];
      rgbaPixels[px * 4 + 3] = col1[3];
      px++;

      if (px < pixelWidth * imgHeight) {
        const col2 = paletteColorsRgba[idx2] || [0, 0, 0, 0];
        rgbaPixels[px * 4] = col2[0];
        rgbaPixels[px * 4 + 1] = col2[1];
        rgbaPixels[px * 4 + 2] = col2[2];
        rgbaPixels[px * 4 + 3] = col2[3];
        px++;
      }
    }
  } else if (bpp === 8) {
    let px = 0;
    for (let i = pos; i < pixelDataEnd && px < pixelWidth * imgHeight; i++) {
      const idx = data[i];
      const col = paletteColorsRgba[idx] || [idx, idx, idx, 255];
      rgbaPixels[px * 4] = col[0];
      rgbaPixels[px * 4 + 1] = col[1];
      rgbaPixels[px * 4 + 2] = col[2];
      rgbaPixels[px * 4 + 3] = col[3];
      px++;
    }
  } else if (bpp === 16) {
    let px = 0;
    for (let i = pos; i + 2 <= pixelDataEnd && px < pixelWidth * imgHeight; i += 2) {
      const color16 = view.getUint16(i, true);
      const r = (color16 & 0x1f) << 3;
      const g = ((color16 >> 5) & 0x1f) << 3;
      const b = ((color16 >> 10) & 0x1f) << 3;
      const a = color16 === 0 ? 0 : 255;
      rgbaPixels[px * 4] = r;
      rgbaPixels[px * 4 + 1] = g;
      rgbaPixels[px * 4 + 2] = b;
      rgbaPixels[px * 4 + 3] = a;
      px++;
    }
  }

  return {
    magic,
    bpp,
    hasClut,
    clutX,
    clutY,
    clutColors,
    clutNumPalettes,
    paletteColorsRgba,
    imgX,
    imgY,
    imgWidth,
    imgHeight,
    pixelWidth,
    rgbaPixels,
  };
}

/**
 * PS1 BIN / CD-XA disc parser
 */
export function parsePs1DiscArchive(fileName: string, bytes: Uint8Array, startTime: number): ParsedArchive {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Check if raw 2352 sector image or 2048 sector
  let isRaw2352 = false;
  let sectorSize = 2048;
  let pvdOffset = 0x8000;
  let dataPayloadOffsetInSector = 0;
  let payloadSizePerSector = 2048;

  // Check sync header at sector 0 or sector 16
  const hasSync0 =
    bytes.length >= 12 &&
    bytes[0] === 0x00 &&
    bytes[1] === 0xff &&
    bytes[2] === 0xff &&
    bytes[11] === 0x00;
  const hasSync16 =
    bytes.length >= 16 * 2352 + 12 &&
    bytes[16 * 2352] === 0x00 &&
    bytes[16 * 2352 + 1] === 0xff &&
    bytes[16 * 2352 + 2] === 0xff &&
    bytes[16 * 2352 + 11] === 0x00;

  if (hasSync0 || hasSync16) {
    isRaw2352 = true;
    sectorSize = 2352;
    // Check CD001 at sector 16
    const sec16 = 16 * 2352;
    if (sec16 + 24 + 5 <= bytes.length && readAscii(bytes, sec16 + 24 + 1, 5) === 'CD001') {
      // Mode 2 Form 1 (Sync 12 + Header 4 + Subheader 8 = 24 bytes)
      dataPayloadOffsetInSector = 24;
      pvdOffset = sec16 + 24;
    } else if (sec16 + 16 + 5 <= bytes.length && readAscii(bytes, sec16 + 16 + 1, 5) === 'CD001') {
      // Mode 1 (Sync 12 + Header 4 = 16 bytes)
      dataPayloadOffsetInSector = 16;
      pvdOffset = sec16 + 16;
    } else {
      dataPayloadOffsetInSector = 24;
      pvdOffset = sec16 + 24;
    }
  } else {
    sectorSize = 2048;
    pvdOffset = 0x8000;
    dataPayloadOffsetInSector = 0;
  }

  const sysId = readAscii(bytes, pvdOffset + 8, 32).trim();
  const volId = readAscii(bytes, pvdOffset + 40, 32).trim();

  const rootRecordOffset = pvdOffset + 156;
  const rootExtentLba = view.getUint32(rootRecordOffset + 2, true);
  const rootDataLen = view.getUint32(rootRecordOffset + 10, true);

  const entries: ArchiveEntry[] = [];
  const warnings: string[] = [];
  let entryCounter = 0;
  let bootExe = '';
  let gameSerial = '';
  let gameRegion = '';

  function readSectorBytes(lba: number, byteCount: number): Uint8Array {
    if (isRaw2352) {
      const sectorsNeeded = Math.ceil(byteCount / payloadSizePerSector);
      const out = new Uint8Array(byteCount);
      let written = 0;
      for (let s = 0; s < sectorsNeeded; s++) {
        const secStart = (lba + s) * sectorSize + dataPayloadOffsetInSector;
        const take = Math.min(payloadSizePerSector, byteCount - written);
        if (secStart + take <= bytes.length) {
          out.set(bytes.subarray(secStart, secStart + take), written);
        }
        written += take;
      }
      return out;
    } else {
      const start = lba * 2048;
      return bytes.slice(start, Math.min(bytes.length, start + byteCount));
    }
  }

  function walkDirectory(extentLba: number, dataLength: number, folderPrefix: string, depth: number) {
    if (depth > 8) return;
    const dirBytes = readSectorBytes(extentLba, Math.min(dataLength, 65536));
    const dirView = new DataView(dirBytes.buffer, dirBytes.byteOffset, dirBytes.byteLength);
    let pos = 0;

    while (pos < dirBytes.length && entryCounter < 4000) {
      const recordLen = dirBytes[pos];
      if (recordLen === 0) {
        const nextSec = Math.floor(pos / 2048 + 1) * 2048;
        if (nextSec <= pos) break;
        pos = nextSec;
        continue;
      }
      if (pos + recordLen > dirBytes.length) break;

      const fileLba = dirView.getUint32(pos + 2, true);
      const fileSize = dirView.getUint32(pos + 10, true);
      const flags = dirBytes[pos + 25];
      const nameLen = dirBytes[pos + 32];
      const rawName = readAscii(dirBytes, pos + 33, nameLen);

      if (nameLen === 1 && (dirBytes[pos + 33] === 0 || dirBytes[pos + 33] === 1)) {
        pos += recordLen;
        continue;
      }

      const cleanName = rawName.replace(/;\d+$/, '');
      const isDir = (flags & 0x02) !== 0;

      if (isDir) {
        const subFolder = folderPrefix ? `${folderPrefix}/${cleanName}` : cleanName;
        if (fileLba !== extentLba) {
          walkDirectory(fileLba, fileSize, subFolder, depth + 1);
        }
      } else {
        const fullPath = folderPrefix ? `${folderPrefix}/${cleanName}` : cleanName;
        const fileData = readSectorBytes(fileLba, fileSize);

        // Check for SYSTEM.CNF to identify PS1 title
        if (cleanName.toUpperCase() === 'SYSTEM.CNF') {
          const cnfText = new TextDecoder().decode(fileData);
          const match = cnfText.match(/BOOT\s*=\s*cdrom:[\\/]?([^;]+)/i);
          if (match && match[1]) {
            bootExe = match[1].trim();
            const serialMatch = bootExe.match(/(SLUS|SCUS|SLES|SCES|SLPS|SLPM|SCPS)[_\-]?(\d{3,5})[._]?(\d{2})/i);
            if (serialMatch) {
              gameSerial = `${serialMatch[1].toUpperCase()}-${serialMatch[2]}${serialMatch[3]}`;
              const prefix = serialMatch[1].toUpperCase();
              if (prefix === 'SLUS' || prefix === 'SCUS') gameRegion = 'North America (NTSC-U)';
              else if (prefix === 'SLES' || prefix === 'SCES') gameRegion = 'Europe (PAL)';
              else if (prefix === 'SLPS' || prefix === 'SLPM' || prefix === 'SCPS') gameRegion = 'Japan (NTSC-J)';
            }
          }
        }

        // Check for PS1 TIM texture
        let cat = classifyEntry(cleanName, fileData);
        const metadata: Record<string, string | number | boolean> = {
          lba: fileLba,
          sectorType: isRaw2352 ? 'Mode 2 Form 1 (2352 bytes/sector)' : 'Mode 1 (2048 bytes/sector)',
        };

        if (cleanName.toUpperCase().endsWith('.TIM') || (fileData.length >= 16 && (fileData[0] === 0x10 && fileData[1] === 0x00))) {
          cat = 'texture';
          metadata.isPs1Tim = true;
          const tim = decodePs1Tim(fileData);
          if (tim) {
            metadata.timBpp = `${tim.bpp}-bit`;
            metadata.timWidth = tim.pixelWidth;
            metadata.timHeight = tim.imgHeight;
            metadata.hasClut = tim.hasClut;
          }
        } else if (cleanName.toUpperCase().endsWith('.STR')) {
          cat = 'video';
          metadata.isVideoStream = true;
        } else if (cleanName.toUpperCase().endsWith('.XA')) {
          cat = 'audio';
          metadata.isAudioStream = true;
        }

        entries.push({
          id: `ps1-${entryCounter++}`,
          name: cleanName,
          path: fullPath,
          folder: folderPrefix || '(root)',
          offset: fileLba * sectorSize + dataPayloadOffsetInSector,
          compressedSize: fileSize,
          uncompressedSize: fileSize,
          compressionMethod: isRaw2352 ? `PS1 CD-XA Raw (LBA ${fileLba})` : `ISO 9660 Mode 1 (LBA ${fileLba})`,
          crc32: computeCRC32(fileData),
          category: cat,
          data: fileData,
          metadata,
        });
      }

      pos += recordLen;
    }
  }

  walkDirectory(rootExtentLba, rootDataLen, '', 0);

  const headerFields: ArchiveHeaderField[] = [
    {
      label: 'PS1 Disc Sector Format',
      offset: '0x00000000',
      length: isRaw2352 ? 2352 : 2048,
      value: isRaw2352 ? 'Raw CD-XA Mode 2 Form 1 (2352 Bytes/Sector)' : 'Standard ISO 9660 Mode 1 (2048 Bytes)',
      description: isRaw2352 ? 'PlayStation 1 optical media with sync bytes & CD-XA subheaders' : 'ISO 9660 filesystem',
    },
    {
      label: 'System Identifier',
      offset: `0x${(pvdOffset + 8).toString(16).toUpperCase()}`,
      length: 32,
      value: sysId || 'PLAYSTATION',
      description: 'Standard PlayStation ISO9660 system identifier',
    },
    {
      label: 'Volume Identifier',
      offset: `0x${(pvdOffset + 40).toString(16).toUpperCase()}`,
      length: 32,
      value: volId || fileName,
      description: 'Disc volume label',
    },
    {
      label: 'Boot Executable (SYSTEM.CNF)',
      offset: 'SYSTEM.CNF',
      length: bootExe.length || 4,
      value: bootExe ? `${bootExe} (${gameSerial || 'Custom'})` : 'No SYSTEM.CNF found',
      description: gameRegion ? `Detected Region: ${gameRegion}` : 'Boot configuration',
    },
    {
      label: 'Files Extracted',
      offset: 'Directory Tree',
      length: 4,
      value: `${entries.length} game files`,
      description: 'TIM textures, STR cutscenes, XA audio, and executables',
    },
  ];

  return {
    fileName,
    fileSize: bytes.length,
    formatId: 'PS1',
    formatName: `PlayStation 1 Disc Image (${gameSerial || volId || 'PS1_GAME'})`,
    engineFamily: gameRegion ? `Sony PlayStation 1 · ${gameRegion}` : 'Sony PlayStation 1 (CD-XA / ISO 9660)',
    magicBytes: bytesToHexPreview(bytes.subarray(0, 16), 16),
    endianness: 'Little Endian',
    headerFields,
    entries,
    rawBytes: bytes,
    parseTimeMs: Math.max(1, Math.round(performance.now() - startTime)),
    warnings,
    extraInfo: {
      gameSerial,
      gameRegion,
      bootExecutable: bootExe,
      isRaw2352,
    },
  };
}
