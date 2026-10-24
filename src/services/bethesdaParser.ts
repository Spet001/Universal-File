import { unzlibSync } from 'fflate';
import { ArchiveEntry, ArchiveHeaderField, ParsedArchive } from '../types/archive';
import { computeCRC32, classifyEntry, formatBytes, toHex } from './archiveParser';

export function isBethesdaArchive(bytes: Uint8Array): boolean {
  if (bytes.length < 16) return false;

  if (bytes[0] === 0x42 && bytes[1] === 0x53 && bytes[2] === 0x41 && bytes[3] === 0x00) return true;

  if (bytes[0] === 0x42 && bytes[1] === 0x54 && bytes[2] === 0x44 && bytes[3] === 0x58) return true;
  return false;
}

export function parseBethesdaArchive(fileName: string, bytes: Uint8Array, startTime: number): ParsedArchive {
  const isBa2 = bytes[0] === 0x42 && bytes[1] === 0x54 && bytes[2] === 0x44 && bytes[3] === 0x58;
  return isBa2
    ? parseBa2Archive(fileName, bytes, startTime)
    : parseBsaArchive(fileName, bytes, startTime);
}

function parseBsaArchive(fileName: string, bytes: Uint8Array, startTime: number): ParsedArchive {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(4, true);
  const folderRecordOffset = view.getUint32(8, true);
  const archiveFlags = view.getUint32(12, true);
  const folderCount = view.getUint32(16, true);
  const fileCount = view.getUint32(20, true);
  const totalFolderNameLength = view.getUint32(24, true);
  const totalFileNameLength = view.getUint32(28, true);

  const isCompressed = (archiveFlags & 0x0004) !== 0;
  const versionName =
    version === 0x67 ? 'TES IV: Oblivion (v103)' :
    version === 0x68 ? 'Skyrim / Fallout 3 / Fallout NV (v104)' :
    version === 0x69 ? 'Skyrim SE (v105)' : `Version 0x${version.toString(16)}`;

  const headerFields: ArchiveHeaderField[] = [
    { label: 'Signature', offset: '0x00', length: 4, value: 'BSA\\0 (0x00415342)', description: 'Bethesda Softworks Archive' },
    { label: 'Format Version', offset: '0x04', length: 4, value: versionName, description: 'Engine Archive Schema' },
    { label: 'Folder Count', offset: '0x10', length: 4, value: folderCount.toLocaleString(), description: 'Total virtual directories' },
    { label: 'File Count', offset: '0x14', length: 4, value: fileCount.toLocaleString(), description: 'Total assets stored' },
    { label: 'Compression Flag', offset: '0x0C', length: 4, value: isCompressed ? 'Default Zlib Compressed' : 'Uncompressed', description: 'Bit 2 of Archive Flags' },
  ];

  const entries: ArchiveEntry[] = [];
  const safeCount = Math.min(fileCount, 20000);

  let fileNamesOffset = folderRecordOffset + folderCount * 16 + fileCount * 16 + totalFolderNameLength;
  const fileNames: string[] = [];

  if (fileNamesOffset < bytes.length) {
    let curr = fileNamesOffset;
    for (let i = 0; i < safeCount && curr < bytes.length; i++) {
      let end = curr;
      while (end < bytes.length && bytes[end] !== 0) end++;
      const name = new TextDecoder('ascii').decode(bytes.subarray(curr, end));
      fileNames.push(name || `file_${i}.dat`);
      curr = end + 1;
    }
  }

  let fileRecordPos = folderRecordOffset + folderCount * 16;
  for (let i = 0; i < safeCount && fileRecordPos + 16 <= bytes.length; i++) {
    const rawSize = view.getUint32(fileRecordPos + 8, true);
    const offset = view.getUint32(fileRecordPos + 12, true);
    fileRecordPos += 16;

    const fileCompressed = (rawSize & (1 << 30)) !== 0 ? !isCompressed : isCompressed;
    const realSize = rawSize & ~(1 << 30);

    const name = fileNames[i] || `asset_${i}.dat`;
    const folder = name.includes('\\') ? name.split('\\').slice(0, -1).join('/') : 'root';
    const cleanName = name.includes('\\') ? name.split('\\').pop() || name : name;

    let payload: Uint8Array;
    let uncompressedSize = realSize;

    if (offset < bytes.length) {
      if (fileCompressed && offset + 4 <= bytes.length) {
        uncompressedSize = view.getUint32(offset, true);
        const compSlice = bytes.subarray(offset + 4, Math.min(bytes.length, offset + realSize));
        try {
          payload = unzlibSync(compSlice);
        } catch {
          payload = compSlice;
        }
      } else {
        payload = bytes.subarray(offset, Math.min(bytes.length, offset + realSize));
      }
    } else {
      payload = new Uint8Array(0);
    }

    entries.push({
      id: `bsa-${i}`,
      name: cleanName,
      path: name.replace(/\\/g, '/'),
      folder,
      offset,
      compressedSize: realSize,
      uncompressedSize,
      compressionMethod: fileCompressed ? 'Zlib Deflate' : 'Uncompressed',
      crc32: computeCRC32(payload),
      category: classifyEntry(cleanName, payload),
      data: payload,
    });
  }

  return {
    fileName,
    fileSize: bytes.length,
    formatId: 'BSA',
    formatName: `BSA (${versionName})`,
    engineFamily: 'Bethesda Creation / Gamebryo Engine',
    magicBytes: '42 53 41 00',
    endianness: 'Little Endian',
    headerFields,
    entries,
    rawBytes: bytes,
    parseTimeMs: Math.round(performance.now() - startTime),
    warnings: [],
  };
}

function parseBa2Archive(fileName: string, bytes: Uint8Array, startTime: number): ParsedArchive {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(4, true);
  const typeMagic = new TextDecoder('ascii').decode(bytes.subarray(8, 12));
  const fileCount = view.getUint32(12, true);
  const nameTableOffset = Number(view.getBigUint64(16, true));

  const game = version >= 2 ? 'Starfield (Creation Engine 2)' : 'Fallout 4 (Creation Engine)';
  const headerFields: ArchiveHeaderField[] = [
    { label: 'Signature', offset: '0x00', length: 4, value: 'BTDX (0x58445442)', description: 'Bethesda Archive 2' },
    { label: 'Archive Type', offset: '0x08', length: 4, value: typeMagic === 'DX10' ? 'DX10 Texture Container' : 'GNRL General Assets', description: 'FourCC Asset Class' },
    { label: 'Format Version', offset: '0x04', length: 4, value: `v${version} (${game})`, description: 'BA2 Schema Revision' },
    { label: 'Total Files', offset: '0x0C', length: 4, value: fileCount.toLocaleString(), description: 'Entry count in header table' },
    { label: 'Name Table Offset', offset: '0x10', length: 8, value: toHex(nameTableOffset), description: 'File names array location' },
  ];

  const fileNames: string[] = [];
  if (nameTableOffset > 0 && nameTableOffset < bytes.length) {
    let p = nameTableOffset;
    for (let i = 0; i < fileCount && p + 2 <= bytes.length; i++) {
      const len = view.getUint16(p, true);
      p += 2;
      if (p + len <= bytes.length) {
        const name = new TextDecoder('ascii').decode(bytes.subarray(p, p + len));
        fileNames.push(name);
        p += len;
      }
    }
  }

  const entries: ArchiveEntry[] = [];
  const safeCount = Math.min(fileCount, 15000);
  let recordPos = 24;

  for (let i = 0; i < safeCount && recordPos + 36 <= bytes.length; i++) {

    const ext = new TextDecoder('ascii').decode(bytes.subarray(recordPos + 4, recordPos + 8)).replace(/\0/g, '');
    const offset = Number(view.getBigUint64(recordPos + 16, true));
    const packedSize = view.getUint32(recordPos + 24, true);
    const unpackedSize = view.getUint32(recordPos + 28, true);
    recordPos += 36;

    const rawPath = fileNames[i] || `asset_${i}.${ext || 'bin'}`;
    const cleanPath = rawPath.replace(/\\/g, '/');
    const folder = cleanPath.includes('/') ? cleanPath.split('/').slice(0, -1).join('/') : 'root';
    const cleanName = cleanPath.includes('/') ? cleanPath.split('/').pop() || cleanPath : cleanPath;

    let payload: Uint8Array;
    const isCompressed = packedSize > 0 && packedSize !== unpackedSize;

    if (offset < bytes.length) {
      const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + (packedSize || unpackedSize)));
      if (isCompressed) {
        try {
          payload = unzlibSync(chunk);
        } catch {
          payload = chunk;
        }
      } else {
        payload = chunk;
      }
    } else {
      payload = new Uint8Array(0);
    }

    entries.push({
      id: `ba2-${i}`,
      name: cleanName,
      path: cleanPath,
      folder,
      offset,
      compressedSize: packedSize || unpackedSize,
      uncompressedSize: unpackedSize,
      compressionMethod: isCompressed ? 'Deflate / Zlib' : 'Uncompressed',
      crc32: computeCRC32(payload),
      category: classifyEntry(cleanName, payload),
      data: payload,
    });
  }

  return {
    fileName,
    fileSize: bytes.length,
    formatId: 'BA2',
    formatName: `BA2 (${typeMagic} · ${game})`,
    engineFamily: 'Bethesda Creation Engine',
    magicBytes: '42 54 44 58',
    endianness: 'Little Endian',
    headerFields,
    entries,
    rawBytes: bytes,
    parseTimeMs: Math.round(performance.now() - startTime),
    warnings: [],
  };
}
