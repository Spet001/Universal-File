import { unzlibSync } from 'fflate';
import { ArchiveEntry, ArchiveHeaderField, ParsedArchive } from '../types/archive';
import { computeCRC32, classifyEntry, formatBytes, toHex } from './archiveParser';

export function isRockstarRage(bytes: Uint8Array, fileName: string): boolean {
  if (fileName.toLowerCase().endsWith('.rpf')) return true;
  if (bytes.length < 16) return false;
  // "RPF0", "RPF2", "RPF3", "RPF4", "RPF6", "RPF7"
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x46 &&
    (bytes[3] >= 0x30 && bytes[3] <= 0x37)
  ) {
    return true;
  }
  return false;
}

export function parseRockstarRage(fileName: string, bytes: Uint8Array, startTime: number): ParsedArchive {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = new TextDecoder('ascii').decode(bytes.subarray(0, 4));
  const entryCount = view.getUint32(4, true);
  const namesLength = view.getUint32(8, true);
  const encryption = view.getUint32(12, true);

  const encName =
    encryption === 0 ? 'None (Plaintext)' :
    encryption === 1 ? 'OpenIV Standard' :
    encryption === 0x4e45504f ? 'OPEN (Decrypted)' : 'AES / Platform Encrypted';

  const rpfVersion =
    magic === 'RPF0' || magic === 'RPF2' ? 'GTA IV / EFLC (RPF2)' :
    magic === 'RPF3' ? 'Red Dead Redemption (RPF3)' :
    magic === 'RPF4' ? 'Max Payne 3 (RPF4)' :
    magic === 'RPF7' ? 'Grand Theft Auto V (RPF7)' : `Rockstar RAGE (${magic})`;

  const headerFields: ArchiveHeaderField[] = [
    { label: 'Signature', offset: '0x00', length: 4, value: `${magic} (RAGE Package)`, description: 'Rockstar Advanced Game Engine Archive' },
    { label: 'Format Schema', offset: '0x00', length: 4, value: rpfVersion, description: 'RAGE Container Generation' },
    { label: 'TOC Entry Count', offset: '0x04', length: 4, value: entryCount.toLocaleString(), description: 'Directories and asset records' },
    { label: 'Names Heap Size', offset: '0x08', length: 4, value: formatBytes(namesLength), description: 'Null-terminated string pool' },
    { label: 'Encryption Mode', offset: '0x0C', length: 4, value: encName, description: 'Payload cryptographic status' },
  ];

  // String table sits immediately after the entry records
  const tocEntriesOffset = 16;
  const namesOffset = tocEntriesOffset + entryCount * 16;

  const readName = (nameOffset: number): string => {
    const abs = namesOffset + nameOffset;
    if (abs >= bytes.length) return '';
    let end = abs;
    while (end < bytes.length && bytes[end] !== 0) end++;
    return new TextDecoder('ascii').decode(bytes.subarray(abs, end));
  };

  const entries: ArchiveEntry[] = [];
  const safeCount = Math.min(entryCount, 15000);

  for (let i = 0; i < safeCount; i++) {
    const p = tocEntriesOffset + i * 16;
    if (p + 16 > bytes.length) break;

    const nameOffset = view.getUint16(p, true);
    const isDirectory = (view.getUint8(p + 3) & 0x80) !== 0;

    if (isDirectory) continue; // Skip virtual directory TOC entries

    const fileOffset = (view.getUint32(p + 4, true) & 0x7FFFFFFF) * 512;
    const fileSize = view.getUint32(p + 8, true);
    const uncompressedSize = view.getUint32(p + 12, true) || fileSize;

    const rawName = readName(nameOffset) || `rpf_entry_${i}.dat`;
    const folder = rawName.includes('/') ? rawName.split('/').slice(0, -1).join('/') : 'assets';
    const cleanName = rawName.includes('/') ? rawName.split('/').pop() || rawName : rawName;

    let payload: Uint8Array;
    const isDeflated = fileSize > 0 && fileSize !== uncompressedSize;

    if (fileOffset > 0 && fileOffset < bytes.length && fileSize > 0) {
      const slice = bytes.subarray(fileOffset, Math.min(bytes.length, fileOffset + fileSize));
      if (isDeflated) {
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
      id: `rpf-${i}`,
      name: cleanName,
      path: rawName,
      folder,
      offset: fileOffset,
      compressedSize: fileSize,
      uncompressedSize,
      compressionMethod: isDeflated ? 'Zlib Deflate' : 'Uncompressed',
      crc32: computeCRC32(payload),
      category: classifyEntry(cleanName, payload),
      data: payload,
    });
  }

  return {
    fileName,
    fileSize: bytes.length,
    formatId: 'RPF',
    formatName: rpfVersion,
    engineFamily: 'Rockstar RAGE Engine',
    magicBytes: `${magic.charCodeAt(0).toString(16)} ${magic.charCodeAt(1).toString(16)} ${magic.charCodeAt(2).toString(16)} ${magic.charCodeAt(3).toString(16)}`,
    endianness: 'Little Endian',
    headerFields,
    entries,
    rawBytes: bytes,
    parseTimeMs: Math.round(performance.now() - startTime),
    warnings: encryption > 1 ? ['Archive contains encrypted payloads; some assets may require AES key.'] : [],
  };
}
