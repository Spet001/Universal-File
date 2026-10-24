import { unzlibSync } from 'fflate';
import { ArchiveEntry, ArchiveHeaderField, ParsedArchive } from '../types/archive';
import { computeCRC32, classifyEntry, formatBytes, toHex } from './archiveParser';

export function isUbisoftForge(bytes: Uint8Array, fileName: string): boolean {
  if (fileName.toLowerCase().endsWith('.forge')) return true;
  if (bytes.length < 12) return false;

  if (
    bytes[0] === 0x73 &&
    bytes[1] === 0x63 &&
    bytes[2] === 0x69 &&
    bytes[3] === 0x6d &&
    bytes[4] === 0x69 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x61 &&
    bytes[7] === 0x72
  ) {
    return true;
  }
  return false;
}

export function parseUbisoftForge(fileName: string, bytes: Uint8Array, startTime: number): ParsedArchive {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const isScimitar =
    bytes.length >= 8 &&
    bytes[0] === 0x73 &&
    bytes[1] === 0x63 &&
    bytes[2] === 0x69 &&
    bytes[3] === 0x6d;

  let fileCount = 0;
  let indexOffset = 0;

  if (isScimitar && bytes.length >= 0x24) {

    fileCount = view.getUint32(16, true);
    indexOffset = Number(view.getBigUint64(20, true));
  } else if (bytes.length >= 0x20) {

    fileCount = view.getUint32(8, true);
    indexOffset = view.getUint32(12, true);
  }

  if (indexOffset === 0 || indexOffset >= bytes.length) {
    indexOffset = 0x20;
  }
  if (fileCount === 0 || fileCount > 50000) {
    fileCount = Math.min(Math.floor((bytes.length - indexOffset) / 32), 2000);
  }

  const headerFields: ArchiveHeaderField[] = [
    { label: 'Signature', offset: '0x00', length: 8, value: isScimitar ? 'scimitar\\0' : 'Ubisoft FORGE', description: 'Ubisoft Anvil / Scimitar Engine' },
    { label: 'Total Resources', offset: '0x10', length: 4, value: fileCount.toLocaleString(), description: 'Asset lumps in index table' },
    { label: 'Index Table Offset', offset: '0x14', length: 8, value: toHex(indexOffset), description: 'File allocation table offset' },
  ];

  const entries: ArchiveEntry[] = [];
  const safeCount = Math.min(fileCount, 5000);
  let p = indexOffset;

  for (let i = 0; i < safeCount && p + 24 <= bytes.length; i++) {

    const resourceId = view.getBigUint64(p, true);
    const dataOffset = Number(view.getBigUint64(p + 8, true));
    const compSize = view.getUint32(p + 16, true);
    const uncompSize = view.getUint32(p + 20, true) || compSize;
    p += 24;

    const hexId = resourceId.toString(16).padStart(16, '0');
    const name = `resource_${hexId}.forge_res`;
    const folder = `lumps_${hexId.slice(0, 4)}`;

    let payload: Uint8Array;
    const isComp = compSize > 0 && compSize !== uncompSize;

    if (dataOffset > 0 && dataOffset < bytes.length && compSize > 0) {
      const slice = bytes.subarray(dataOffset, Math.min(bytes.length, dataOffset + compSize));
      if (isComp) {
        try {
          payload = unzlibSync(slice);
        } catch {
          payload = slice;
        }
      } else {
        payload = slice;
      }
    } else {
      payload = new Uint8Array(0);
    }

    entries.push({
      id: `forge-${i}`,
      name,
      path: `${folder}/${name}`,
      folder,
      offset: dataOffset,
      compressedSize: compSize,
      uncompressedSize: uncompSize,
      compressionMethod: isComp ? 'Deflate / LZO' : 'Raw Stream',
      crc32: computeCRC32(payload),
      category: classifyEntry(name, payload),
      data: payload,
    });
  }

  return {
    fileName,
    fileSize: bytes.length,
    formatId: 'FORGE',
    formatName: 'Ubisoft FORGE (Assassin\'s Creed / Anvil)',
    engineFamily: 'Ubisoft Anvil / Scimitar Engine',
    magicBytes: '73 63 69 6D 69 74 61 72',
    endianness: 'Little Endian',
    headerFields,
    entries,
    rawBytes: bytes,
    parseTimeMs: Math.round(performance.now() - startTime),
    warnings: [],
  };
}
