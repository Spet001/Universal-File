import { inflateSync, unzlibSync } from 'fflate';
import { ArchiveEntry, ArchiveHeaderField, ParsedArchive } from '../types/archive';
import {
  bytesToHexPreview,
  classifyEntry,
  computeCRC32,
  readAscii,
  splitFolderAndName,
  toHex,
} from './archiveParser';

/**
 * Xbox 360 Games on Demand (GOD), XContent (CON/LIVE/PIRS), and GDFX Disc Image Parser
 */

export interface Xbox360ContentMetadata {
  signatureType: 'CON ' | 'LIVE' | 'PIRS' | 'GDFX';
  contentType: number;
  contentTypeName: string;
  titleId: string;
  mediaId: string;
  titleName: string;
  description: string;
  publisher: string;
  discNumber: number;
  discTotal: number;
  hasThumbnail: boolean;
}

const CONTENT_TYPE_NAMES: Record<number, string> = {
  0x00000001: 'Saved Game',
  0x00000002: 'MarketPlace / DLC Content',
  0x00000003: 'Publisher / Title Asset',
  0x00010000: 'Xbox LIVE Arcade (XBLA)',
  0x00020000: 'Game Demo',
  0x00030000: 'Kinect / Video Title',
  0x00040000: 'Xbox 360 Theme',
  0x00050000: 'Gamer Picture Pack',
  0x00007000: 'Games on Demand (GOD)',
  0x00080000: 'Avatar Item',
  0x00090000: 'Avatar Title / Prop',
  0x000a0000: 'Xbox 360 Video Clip',
  0x000b0000: 'Game Trailer',
  0x000c0000: 'Xbox Live Title Asset',
  0x000d0000: 'Title Update (TU)',
};

/**
 * Decodes null-terminated UTF-16 Big Endian string (used widely in Xbox 360 metadata)
 */
export function decodeUtf16BE(bytes: Uint8Array, offset: number, maxBytes: number): string {
  const chars: string[] = [];
  const end = Math.min(bytes.length, offset + maxBytes);
  for (let i = offset; i + 1 < end; i += 2) {
    const code = (bytes[i] << 8) | bytes[i + 1];
    if (code === 0) break;
    chars.push(String.fromCharCode(code));
  }
  return chars.join('').trim();
}

/**
 * Checks if a byte buffer contains GDFX / XDVDFS (Xbox Disc Virtual File System)
 */
export function isGdfxFilesystem(bytes: Uint8Array): { found: boolean; offset: number } {
  // GDFX magic is "MICROSOFT*XBOX*MEDIA" (20 bytes)
  const magic = 'MICROSOFT*XBOX*MEDIA';
  // Common offsets: Sector 32 (0x10000 = 65536), Sector 0 (0x00), or Sector 16 (0x8000)
  const candidateOffsets = [0x10000, 0x00, 0x800, 0x8000, 0x2000, 0x10800];
  for (const ofs of candidateOffsets) {
    if (bytes.length >= ofs + 20) {
      if (readAscii(bytes, ofs, 20) === magic) {
        return { found: true, offset: ofs };
      }
    }
  }

  // Linear scan in first 256KB if not at standard offsets
  const scanLimit = Math.min(bytes.length - 20, 0x40000);
  for (let ofs = 0; ofs <= scanLimit; ofs += 0x800) {
    if (readAscii(bytes, ofs, 20) === magic) {
      return { found: true, offset: ofs };
    }
  }

  return { found: false, offset: -1 };
}

/**
 * Parses GDFX (Xbox 360 Game Disc Format) directory binary tree
 */
export function parseGdfxDirectoryTree(
  bytes: Uint8Array,
  gdfxOffset: number,
  baseSectorOffset: number = 0
): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Sector size in Xbox 360 DVD / GDF is 2048 bytes (0x800)
  const SECTOR_SIZE = 2048;

  // GDFX header at gdfxOffset:
  // 0x00..0x13 (20 bytes): "MICROSOFT*XBOX*MEDIA"
  // 0x14..0x17 (4 bytes): Root directory sector (uint32 LE)
  // 0x18..0x1B (4 bytes): Root directory size (uint32 LE)
  // 0x1C..0x23 (8 bytes): Image creation FILETIME
  if (bytes.length < gdfxOffset + 0x24) return entries;

  const rootSector = view.getUint32(gdfxOffset + 0x14, true);
  const rootSize = view.getUint32(gdfxOffset + 0x18, true);

  if (rootSector === 0 || rootSize === 0) return entries;

  // Root directory offset in bytes
  const rootByteOffset = baseSectorOffset + rootSector * SECTOR_SIZE;
  if (rootByteOffset >= bytes.length) return entries;

  // Directory entry traversal queue: [dirByteOffset, dirSize, currentPath]
  const dirQueue: Array<{ offset: number; size: number; path: string }> = [
    { offset: rootByteOffset, size: rootSize, path: '' },
  ];

  const visitedDirs = new Set<number>();
  let entryCounter = 0;

  while (dirQueue.length > 0 && entryCounter < 2000) {
    const { offset: dirOffset, size: dirSize, path: curPath } = dirQueue.shift()!;
    if (visitedDirs.has(dirOffset)) continue;
    visitedDirs.add(dirOffset);

    // Directory tree traversal queue for binary tree nodes within this directory table
    // Nodes in GDFX directory:
    // uint16 LE: Left Child (offset divided by 4)
    // uint16 LE: Right Child (offset divided by 4)
    // uint32 LE: Sector Start (multiply by 2048 to get data offset)
    // uint32 LE: File Size
    // uint8: File Attributes (0x10 = Directory)
    // uint8: Name Length
    // Name Length bytes: ASCII filename
    // Padding to 4-byte boundary
    const nodeOffsets: number[] = [0];
    const visitedNodes = new Set<number>();

    while (nodeOffsets.length > 0 && entryCounter < 2000) {
      const relOfs = nodeOffsets.shift()!;
      if (visitedNodes.has(relOfs)) continue;
      visitedNodes.add(relOfs);

      const nodeAbs = dirOffset + relOfs;
      if (nodeAbs + 14 > bytes.length || relOfs >= dirSize) continue;

      const leftChild = view.getUint16(nodeAbs, true) * 4;
      const rightChild = view.getUint16(nodeAbs + 2, true) * 4;
      const sectorStart = view.getUint32(nodeAbs + 4, true);
      const fileSize = view.getUint32(nodeAbs + 8, true);
      const attributes = bytes[nodeAbs + 12];
      const nameLen = bytes[nodeAbs + 13];

      if (leftChild > 0 && leftChild < dirSize) nodeOffsets.push(leftChild);
      if (rightChild > 0 && rightChild < dirSize) nodeOffsets.push(rightChild);

      if (nameLen === 0 || nodeAbs + 14 + nameLen > bytes.length) continue;

      const name = readAscii(bytes, nodeAbs + 14, nameLen);
      const isDir = (attributes & 0x10) !== 0;
      const fullPath = curPath ? `${curPath}/${name}` : name;
      const fileDataOffset = baseSectorOffset + sectorStart * SECTOR_SIZE;

      if (isDir) {
        if (fileDataOffset < bytes.length && fileSize > 0) {
          dirQueue.push({ offset: fileDataOffset, size: fileSize, path: fullPath });
        }
      } else {
        const dataEnd = Math.min(bytes.length, fileDataOffset + fileSize);
        const fileBytes = fileDataOffset < bytes.length ? bytes.slice(fileDataOffset, dataEnd) : new Uint8Array(0);

        const { folder, name: cleanName } = splitFolderAndName(fullPath);
        entries.push({
          id: `gdfx-${entryCounter++}-${cleanName}`,
          name: cleanName,
          path: fullPath,
          folder,
          offset: fileDataOffset,
          compressedSize: fileBytes.length,
          uncompressedSize: fileSize,
          compressionMethod: 'GDFX Uncompressed Sector (2048B)',
          crc32: computeCRC32(fileBytes),
          category: classifyEntry(cleanName, fileBytes),
          data: fileBytes,
          metadata: {
            sectorStart,
            attributes: `0x${toHex(attributes, 2)}`,
            isXex: cleanName.toLowerCase().endsWith('.xex'),
            isFastFile: cleanName.toLowerCase().endsWith('.ff'),
          },
        });
      }
    }
  }

  return entries;
}

/**
 * Parses Xbox 360 Games on Demand (GOD) / XContent package (CON, LIVE, PIRS)
 */
export function parseXbox360GodArchive(
  fileName: string,
  bytes: Uint8Array,
  startTime: number
): ParsedArchive {
  const warnings: string[] = [];
  const headerFields: ArchiveHeaderField[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const magic4 = readAscii(bytes, 0, 4);
  const signatureType = (
    magic4 === 'LIVE' ? 'LIVE' : magic4 === 'PIRS' ? 'PIRS' : magic4 === 'CON ' ? 'CON ' : 'LIVE'
  ) as 'CON ' | 'LIVE' | 'PIRS';

  headerFields.push({
    label: 'Container Magic Signature',
    offset: '0x0000',
    length: 4,
    value: `${magic4} (${signatureType === 'LIVE' ? 'Xbox LIVE Signed' : signatureType === 'PIRS' ? 'Retail / Pre-Installed Package' : 'Console / Dev Signed'})`,
    description: 'Xbox 360 XContent package container signature',
  });

  // Extract Content Metadata (starts at 0x328 or 0x340 in XContent)
  // Check for content type: 0x00007000 = GOD, 0x00010000 = XBLA, 0x00020000 = Demo, etc.
  let contentType = 0x00007000;
  let titleId = '415608C3';
  let mediaId = '00000000';
  let titleName = 'Xbox 360 Title';
  let description = '';
  let publisher = 'Microsoft Studios';
  let discNumber = 1;
  let discTotal = 1;

  // In XContent header:
  // Offset 0x328 (or 0x344): Content Type (uint32 BE)
  // Offset 0x360: Execution Info (Media ID 4B, Title ID 4B BE, Title Version, Base Version, Disc Number, Disc Total)
  if (bytes.length >= 0x400) {
    const ctCandidate1 = view.getUint32(0x328, false);
    const ctCandidate2 = view.getUint32(0x344, false);
    const ctCandidate3 = view.getUint32(0x340, false);

    if (CONTENT_TYPE_NAMES[ctCandidate1]) contentType = ctCandidate1;
    else if (CONTENT_TYPE_NAMES[ctCandidate2]) contentType = ctCandidate2;
    else if (CONTENT_TYPE_NAMES[ctCandidate3]) contentType = ctCandidate3;

    // Search for Title ID (usually at 0x360 or in execution info)
    for (const tidOfs of [0x360, 0x358, 0x364, 0x384]) {
      if (bytes.length >= tidOfs + 8) {
        const tidVal = view.getUint32(tidOfs + 4, false);
        if (tidVal > 0x10000000 && tidVal < 0xffffffff) {
          mediaId = toHex(view.getUint32(tidOfs, false), 8);
          titleId = toHex(tidVal, 8);
          discNumber = bytes[tidOfs + 12] || 1;
          discTotal = bytes[tidOfs + 13] || 1;
          break;
        }
      }
    }

    // Search for Title Name (UTF-16BE) starting at 0x410 / 0x411 or scanned
    for (const strOfs of [0x410, 0x411, 0x400, 0x420, 0x440, 0x3b0]) {
      if (bytes.length > strOfs + 32) {
        const decoded = decodeUtf16BE(bytes, strOfs, 128);
        if (decoded.length >= 2 && !/^[\x00-\x1f]+$/.test(decoded)) {
          titleName = decoded;
          break;
        }
      }
    }

    // Search for description / publisher
    for (const descOfs of [0x490, 0x510, 0x550, 0x600]) {
      if (bytes.length > descOfs + 32) {
        const decoded = decodeUtf16BE(bytes, descOfs, 256);
        if (decoded.length >= 4 && decoded !== titleName) {
          if (!description) description = decoded;
          else if (!publisher) {
            publisher = decoded;
            break;
          }
        }
      }
    }
  }

  const contentTypeName = CONTENT_TYPE_NAMES[contentType] || `Custom Type (0x${toHex(contentType, 8)})`;

  headerFields.push({
    label: 'Package Content Type',
    offset: '0x0344',
    length: 4,
    value: `0x${toHex(contentType, 8)} (${contentTypeName})`,
    description: 'Xbox 360 Live / Games on Demand classification',
  });

  headerFields.push({
    label: 'Title ID (Hex)',
    offset: '0x0364',
    length: 4,
    value: `0x${titleId.toUpperCase()}`,
    description: 'Xbox 360 Title Unique ID (e.g. 415608C3 for Black Ops II, 41560817 for Black Ops)',
  });

  headerFields.push({
    label: 'Media ID',
    offset: '0x0360',
    length: 4,
    value: `0x${mediaId.toUpperCase()}`,
    description: 'Disc / media build tracking identifier',
  });

  headerFields.push({
    label: 'Title Display Name',
    offset: '0x0410',
    length: 128,
    value: titleName,
    description: 'Xbox 360 Dashboard UTF-16BE title name',
  });

  if (description) {
    headerFields.push({
      label: 'Package Description',
      offset: '0x0490',
      length: 256,
      value: description.length > 80 ? `${description.slice(0, 80)}...` : description,
      description: 'Localized title description from content header',
    });
  }

  // Scan for embedded PNG thumbnail image (often at ~0x171A or between 0x1000..0x3000)
  let thumbnailEntry: ArchiveEntry | null = null;
  const pngHeader = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0x800; i < Math.min(bytes.length - 8, 0x4000); i++) {
    let match = true;
    for (let j = 0; j < 8; j++) {
      if (bytes[i + j] !== pngHeader[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      // Find IEND chunk (0x49 0x45 0x4E 0x44 + 4B CRC)
      let pngEnd = -1;
      for (let k = i + 8; k < Math.min(bytes.length - 4, i + 65536); k++) {
        if (
          bytes[k] === 0x49 &&
          bytes[k + 1] === 0x45 &&
          bytes[k + 2] === 0x4e &&
          bytes[k + 3] === 0x44
        ) {
          pngEnd = k + 8;
          break;
        }
      }
      if (pngEnd > i) {
        const thumbBytes = bytes.slice(i, pngEnd);
        thumbnailEntry = {
          id: 'x360-thumb',
          name: 'TitleThumbnail.png',
          path: 'metadata/TitleThumbnail.png',
          folder: 'metadata',
          offset: i,
          compressedSize: thumbBytes.length,
          uncompressedSize: thumbBytes.length,
          compressionMethod: 'PNG (Embedded Icon)',
          crc32: computeCRC32(thumbBytes),
          category: 'texture',
          data: thumbBytes,
          metadata: {
            titleId,
            isIcon: true,
          },
        };
        break;
      }
    }
  }

  const entries: ArchiveEntry[] = [];
  if (thumbnailEntry) entries.push(thumbnailEntry);

  // Check if GDFX (Xbox Disc Virtual File System) is present inside package or sector 32
  const gdfxCheck = isGdfxFilesystem(bytes);
  if (gdfxCheck.found) {
    const gdfxEntries = parseGdfxDirectoryTree(bytes, gdfxCheck.offset, 0);
    for (const e of gdfxEntries) {
      entries.push(e);
    }
    headerFields.push({
      label: 'Embedded GDFX Disc Filesystem',
      offset: `0x${toHex(gdfxCheck.offset, 4)}`,
      length: 20,
      value: `MICROSOFT*XBOX*MEDIA (${gdfxEntries.length} Game Files Extracted)`,
      description: 'Xbox Disc Virtual File System partition found inside GOD package',
    });
  }

  // If no GDFX files found or few files, check XContent File Table
  // In XContent packages (DLC, Title Updates, Arcade titles):
  // Metadata directory table typically starts at block allocation table or 0x37C / 0x4000
  if (entries.length <= 1 && bytes.length >= 0x4000) {
    // Scan for file records in XContent directory
    // Records are 64 bytes (0x40):
    // 0x00..0x27: ASCII / UTF-8 filename (up to 40 bytes)
    // 0x28: Flags (0x40 = directory, 0x00 = file)
    // 0x29..0x2B: Number of consecutive blocks (uint24 BE)
    // 0x2C..0x2F: Starting block (uint32 BE or uint24 BE)
    // 0x30..0x31: Path index / parent folder
    // 0x34..0x37: File Size (uint32 BE)
    // 0x38..0x3B: Timestamp
    let dirScanStart = 0x2000;
    while (dirScanStart < Math.min(bytes.length - 64, 0x8000)) {
      // Check if candidate directory block
      let validRecordCount = 0;
      for (let recOfs = dirScanStart; recOfs < dirScanStart + 0x1000 && recOfs + 64 <= bytes.length; recOfs += 64) {
        const firstByte = bytes[recOfs];
        if (firstByte >= 0x20 && firstByte <= 0x7e) {
          const name = readAscii(bytes, recOfs, 40);
          if (/^[a-zA-Z0-9_\-\.\/\\]+$/.test(name) && name.length >= 3) {
            validRecordCount++;
          }
        }
      }

      if (validRecordCount >= 1) {
        for (let recOfs = dirScanStart; recOfs < dirScanStart + 0x1000 && recOfs + 64 <= bytes.length; recOfs += 64) {
          const firstByte = bytes[recOfs];
          if (firstByte === 0) continue;
          const name = readAscii(bytes, recOfs, 40);
          if (!name || name.trim().length === 0) continue;

          const flags = bytes[recOfs + 0x28];
          const isDir = (flags & 0x40) !== 0;
          if (isDir) continue;

          const startBlock = (bytes[recOfs + 0x2d] << 16) | (bytes[recOfs + 0x2e] << 8) | bytes[recOfs + 0x2f];
          const fileSize = view.getUint32(recOfs + 0x34, false);

          // Data block size in XContent is 4096 (0x1000) bytes; data starts after header (~0x1000 or block table)
          const dataOffset = 0x1000 + startBlock * 0x1000;
          if (dataOffset < bytes.length && fileSize > 0) {
            const dataEnd = Math.min(bytes.length, dataOffset + fileSize);
            const fileData = bytes.slice(dataOffset, dataEnd);

            const { folder, name: cleanName } = splitFolderAndName(name);
            entries.push({
              id: `xcontent-${entries.length}-${cleanName}`,
              name: cleanName,
              path: name,
              folder,
              offset: dataOffset,
              compressedSize: fileData.length,
              uncompressedSize: fileSize,
              compressionMethod: 'XContent Stored (4KB Block)',
              crc32: computeCRC32(fileData),
              category: classifyEntry(cleanName, fileData),
              data: fileData,
              metadata: {
                startBlock,
                fileSize,
              },
            });
          }
        }
        break;
      }
      dirScanStart += 0x1000;
    }
  }

  // If still empty (e.g. standalone GOD descriptor header), generate virtual descriptor entry
  if (entries.length === 0) {
    const descriptorText = `Xbox 360 Games on Demand Package Header\nTitle: ${titleName}\nTitle ID: 0x${titleId}\nMedia ID: 0x${mediaId}\nType: ${contentTypeName}\nPublisher: ${publisher}\nDisc: ${discNumber}/${discTotal}\nSignature: ${signatureType}\nFile Size: ${bytes.length} bytes\n`;
    const enc = new TextEncoder();
    const descBytes = enc.encode(descriptorText);
    entries.push({
      id: 'god-descriptor',
      name: 'ContentManifest.txt',
      path: 'ContentManifest.txt',
      folder: '',
      offset: 0,
      compressedSize: descBytes.length,
      uncompressedSize: descBytes.length,
      compressionMethod: 'Stored',
      crc32: computeCRC32(descBytes),
      category: 'config',
      data: descBytes,
      metadata: {
        titleId,
        contentType: `0x${toHex(contentType, 8)}`,
      },
    });
  }

  return {
    fileName,
    fileSize: bytes.length,
    formatId: 'GOD',
    formatName: `Xbox 360 ${contentTypeName} Container (${signatureType})`,
    engineFamily: 'Microsoft Xbox 360 (XContent / GOD File System)',
    magicBytes: bytesToHexPreview(bytes, 16),
    endianness: 'Big Endian',
    headerFields,
    entries,
    rawBytes: bytes,
    parseTimeMs: Math.round(performance.now() - startTime),
    warnings,
    extraInfo: {
      titleId,
      mediaId,
      titleName,
      contentTypeName,
      signatureType,
      discNumber,
      discTotal,
    },
  };
}

/**
 * Xbox 360 Executable (XEX / XEX1 / XEX2) Parser
 */

export interface XexOptionalHeader {
  key: number;
  keyHex: string;
  name: string;
  value: number;
  data?: Uint8Array;
}

const XEX_HEADER_KEYS: Record<number, string> = {
  0x000002ff: 'Execution Info (Media/Title ID/Versions)',
  0x000003ff: 'Game Ratings Table',
  0x000004ff: 'TLS (Thread Local Storage) Data',
  0x000080ff: 'Image Base Address',
  0x00008105: 'Entry Point Address',
  0x00010001: 'System Flags',
  0x00010100: 'Original PE / Image File Name',
  0x00010201: 'Static Libraries Manifest',
  0x000103ff: 'Import Libraries / Modules Directory',
  0x00018002: 'Default Stack Size',
  0x00018102: 'Default Filesystem Heap Size',
  0x00020100: 'Resource Directory / Sections',
  0x00020200: 'Delta Compression Info',
  0x00030000: 'Compression / Encryption Descriptor',
};

export function parseXbox360Xex(
  fileName: string,
  bytes: Uint8Array,
  startTime: number
): ParsedArchive {
  const warnings: string[] = [];
  const headerFields: ArchiveHeaderField[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const magic4 = readAscii(bytes, 0, 4);
  const isXex2 = magic4 === 'XEX2';
  const isXex1 = magic4 === 'XEX1';

  headerFields.push({
    label: 'XEX Magic Signature',
    offset: '0x0000',
    length: 4,
    value: `${magic4} (${isXex2 ? 'Xbox 360 Retail Executable' : isXex1 ? 'Xbox 360 Beta/Dev Executable' : 'Xbox Executable'})`,
    description: 'Xbox 360 native PowerPC executable binary container',
  });

  // Module Flags (uint32 BE at 0x04)
  const moduleFlags = view.getUint32(4, false);
  const flagNames: string[] = [];
  if (moduleFlags & 0x01) flagNames.push('Title Module');
  if (moduleFlags & 0x02) flagNames.push('Exports');
  if (moduleFlags & 0x04) flagNames.push('System Debugger');
  if (moduleFlags & 0x08) flagNames.push('DLL / Shared Lib');
  if (moduleFlags & 0x10) flagNames.push('Module Patch');
  if (flagNames.length === 0) flagNames.push('Standard Executable');

  headerFields.push({
    label: 'Module Flags',
    offset: '0x0004',
    length: 4,
    value: `0x${toHex(moduleFlags, 8)} (${flagNames.join(', ')})`,
    description: 'PowerPC executable execution mode & runtime permissions',
  });

  // PE / Base Data Offset (uint32 BE at 0x08)
  const peDataOffset = view.getUint32(8, false);
  headerFields.push({
    label: 'PE / Base Data Offset',
    offset: '0x0008',
    length: 4,
    value: `0x${toHex(peDataOffset, 8)} (${peDataOffset} bytes)`,
    description: 'Offset to PE header and uncompressed/decrypted section payload',
  });

  // Certificate Offset (uint32 BE at 0x10)
  const certOffset = view.getUint32(0x10, false);
  headerFields.push({
    label: 'Certificate Offset',
    offset: '0x0010',
    length: 4,
    value: `0x${toHex(certOffset, 8)}`,
    description: 'Offset to Xbox Security Certificate and RSA Public Key',
  });

  // Optional Headers Count (uint32 BE at 0x14)
  const optHeaderCount = view.getUint32(0x14, false);
  headerFields.push({
    label: 'Optional Headers Count',
    offset: '0x0014',
    length: 4,
    value: `${optHeaderCount} Headers`,
    description: 'Number of configuration headers describing title ID, imports, and libraries',
  });

  // Parse Optional Headers
  const optionalHeaders: XexOptionalHeader[] = [];
  let titleId = '415608C3';
  let mediaId = '00000000';
  let originalPeName = 'default.exe';
  let baseAddress = '0x82000000';
  let entryPoint = '0x82000000';
  let staticLibraries: string[] = [];

  let curOptOffset = 0x18;
  for (let i = 0; i < optHeaderCount && curOptOffset + 8 <= bytes.length; i++) {
    const key = view.getUint32(curOptOffset, false);
    const valOrOfs = view.getUint32(curOptOffset + 4, false);
    curOptOffset += 8;

    const keyName = XEX_HEADER_KEYS[key] || `Header Key 0x${toHex(key, 8)}`;
    optionalHeaders.push({
      key,
      keyHex: `0x${toHex(key, 8)}`,
      name: keyName,
      value: valOrOfs,
    });

    // 0x000002FF: Execution Info
    if (key === 0x000002ff && valOrOfs < bytes.length) {
      if (valOrOfs + 16 <= bytes.length) {
        mediaId = toHex(view.getUint32(valOrOfs, false), 8);
        titleId = toHex(view.getUint32(valOrOfs + 8, false), 8);
      }
    }

    // 0x000080FF: Image Base Address
    if (key === 0x000080ff) {
      baseAddress = `0x${toHex(valOrOfs, 8)}`;
    }

    // 0x00008105: Entry Point Address
    if (key === 0x00008105) {
      entryPoint = `0x${toHex(valOrOfs, 8)}`;
    }

    // 0x00010100: Original PE Name
    if (key === 0x00010100 && valOrOfs < bytes.length) {
      const name = readAscii(bytes, valOrOfs, 64);
      if (name) originalPeName = name;
    }

    // 0x00010201: Static Libraries List
    if (key === 0x00010201 && valOrOfs < bytes.length) {
      const libDataOffset = valOrOfs;
      if (libDataOffset + 4 <= bytes.length) {
        const libCount = view.getUint32(libDataOffset, false);
        let libPtr = libDataOffset + 4;
        for (let l = 0; l < libCount && libPtr + 16 <= bytes.length; l++) {
          const libName = readAscii(bytes, libPtr, 8).trim();
          const major = view.getUint16(libPtr + 8, false);
          const minor = view.getUint16(libPtr + 10, false);
          const build = view.getUint16(libPtr + 12, false);
          staticLibraries.push(`${libName} (v${major}.${minor}.${build})`);
          libPtr += 16;
        }
      }
    }
  }

  headerFields.push({
    label: 'Title ID',
    offset: 'OptHeader (0x2FF)',
    length: 4,
    value: `0x${titleId.toUpperCase()}`,
    description: 'Xbox 360 Title Unique Identifier',
  });

  headerFields.push({
    label: 'Original Executable Name',
    offset: 'OptHeader (0x10100)',
    length: 64,
    value: originalPeName,
    description: 'Source PE executable filename prior to XEX packing',
  });

  headerFields.push({
    label: 'Entry Point & Base Address',
    offset: 'OptHeaders',
    length: 8,
    value: `${entryPoint} (Base: ${baseAddress})`,
    description: 'PowerPC 32-bit virtual memory entry point',
  });

  if (staticLibraries.length > 0) {
    headerFields.push({
      label: 'Linked Static Libraries',
      offset: 'OptHeader (0x10201)',
      length: staticLibraries.length * 16,
      value: staticLibraries.slice(0, 4).join(', ') + (staticLibraries.length > 4 ? ` (+${staticLibraries.length - 4} more)` : ''),
      description: 'Xbox 360 SDK libraries statically linked into this executable',
    });
  }

  const entries: ArchiveEntry[] = [];
  const enc = new TextEncoder();

  // 1. Entry: Optional Headers & Metadata Report
  const optSummary = optionalHeaders
    .map((h) => `[${h.keyHex}] ${h.name}: Value/Offset 0x${toHex(h.value, 8)}`)
    .join('\n');
  const manifestText = `Xbox 360 Executable (XEX2) Analysis\n==================================\nFile Name: ${fileName}\nOriginal PE Name: ${originalPeName}\nTitle ID: 0x${titleId}\nMedia ID: 0x${mediaId}\nEntry Point: ${entryPoint}\nBase Address: ${baseAddress}\nModule Flags: 0x${toHex(moduleFlags, 8)} (${flagNames.join(', ')})\nCertificate Offset: 0x${toHex(certOffset, 8)}\nPE Base Offset: 0x${toHex(peDataOffset, 8)}\n\nStatic Libraries (${staticLibraries.length}):\n${staticLibraries.map((s) => `  - ${s}`).join('\n')}\n\nOptional Headers (${optionalHeaders.length}):\n${optSummary}\n`;
  const manifestBytes = enc.encode(manifestText);

  entries.push({
    id: 'xex-manifest',
    name: 'XexManifest.txt',
    path: 'XexManifest.txt',
    folder: '',
    offset: 0,
    compressedSize: manifestBytes.length,
    uncompressedSize: manifestBytes.length,
    compressionMethod: 'Stored',
    crc32: computeCRC32(manifestBytes),
    category: 'config',
    data: manifestBytes,
    metadata: {
      titleId,
      originalPeName,
      entryPoint,
    },
  });

  // 2. Entry: Security Certificate (if within bounds)
  if (certOffset > 0 && certOffset < bytes.length) {
    const certLength = Math.min(bytes.length - certOffset, 0x180);
    const certBytes = bytes.slice(certOffset, certOffset + certLength);
    entries.push({
      id: 'xex-certificate',
      name: 'XboxSecurityCertificate.bin',
      path: 'security/XboxSecurityCertificate.bin',
      folder: 'security',
      offset: certOffset,
      compressedSize: certBytes.length,
      uncompressedSize: certBytes.length,
      compressionMethod: 'Stored (RSA-2048)',
      crc32: computeCRC32(certBytes),
      category: 'binary',
      data: certBytes,
      metadata: {
        certOffset,
        certLength,
      },
    });
  }

  // 3. Entry: PE Executable Payload / Sections
  if (peDataOffset > 0 && peDataOffset < bytes.length) {
    const peBytes = bytes.slice(peDataOffset);
    // Check if PE header (MZ) is directly at PE offset
    const isMz = peBytes.length >= 2 && peBytes[0] === 0x4d && peBytes[1] === 0x5a;
    entries.push({
      id: 'xex-pe-payload',
      name: originalPeName.endsWith('.exe') ? originalPeName : `${originalPeName}.exe`,
      path: `payload/${originalPeName.endsWith('.exe') ? originalPeName : `${originalPeName}.exe`}`,
      folder: 'payload',
      offset: peDataOffset,
      compressedSize: peBytes.length,
      uncompressedSize: peBytes.length,
      compressionMethod: isMz ? 'Uncompressed PE32 Image' : 'Compressed / Encrypted Section Data',
      crc32: computeCRC32(peBytes),
      category: 'executable',
      data: peBytes,
      metadata: {
        isMz,
        peDataOffset,
      },
    });

    // Check for PE sections inside payload if MZ present
    if (isMz && peBytes.length >= 0x100) {
      const peView = new DataView(peBytes.buffer, peBytes.byteOffset, peBytes.byteLength);
      const peHeaderOffset = peView.getUint32(0x3c, true);
      if (peHeaderOffset + 24 <= peBytes.length && readAscii(peBytes, peHeaderOffset, 4) === 'PE\0\0') {
        const numSections = peView.getUint16(peHeaderOffset + 6, true);
        const optHeaderSize = peView.getUint16(peHeaderOffset + 20, true);
        let sectionHeaderOfs = peHeaderOffset + 24 + optHeaderSize;

        for (let s = 0; s < numSections && sectionHeaderOfs + 40 <= peBytes.length; s++) {
          const sectName = readAscii(peBytes, sectionHeaderOfs, 8).trim();
          const virtSize = peView.getUint32(sectionHeaderOfs + 8, true);
          const rawSize = peView.getUint32(sectionHeaderOfs + 16, true);
          const rawOffset = peView.getUint32(sectionHeaderOfs + 20, true);
          sectionHeaderOfs += 40;

          if (rawOffset < peBytes.length && rawSize > 0) {
            const sectEnd = Math.min(peBytes.length, rawOffset + rawSize);
            const sectData = peBytes.slice(rawOffset, sectEnd);
            entries.push({
              id: `xex-sect-${s}-${sectName.replace(/[^a-zA-Z0-9]/g, '_')}`,
              name: `${sectName.replace(/^\./, '')}.section`,
              path: `sections/${sectName.replace(/^\./, '')}.section`,
              folder: 'sections',
              offset: peDataOffset + rawOffset,
              compressedSize: sectData.length,
              uncompressedSize: virtSize || sectData.length,
              compressionMethod: 'Stored PE Section',
              crc32: computeCRC32(sectData),
              category: sectName === '.rdata' || sectName === '.data' ? 'binary' : 'executable',
              data: sectData,
              metadata: {
                sectionName: sectName,
                virtualSize: virtSize,
              },
            });
          }
        }
      }
    }
  }

  return {
    fileName,
    fileSize: bytes.length,
    formatId: 'XEX',
    formatName: `Xbox 360 Executable (${magic4})`,
    engineFamily: 'Microsoft Xbox 360 Native PowerPC (XEX2 / XEX1)',
    magicBytes: bytesToHexPreview(bytes, 16),
    endianness: 'Big Endian',
    headerFields,
    entries,
    rawBytes: bytes,
    parseTimeMs: Math.round(performance.now() - startTime),
    warnings,
    extraInfo: {
      titleId,
      mediaId,
      originalPeName,
      entryPoint,
      baseAddress,
      staticLibraries,
      optHeaderCount,
    },
  };
}
