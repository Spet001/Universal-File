import { unzlibSync } from 'fflate';
import { ArchiveEntry, ArchiveHeaderField, ParsedArchive } from '../types/archive';
import { computeCRC32, classifyEntry, formatBytes, toHex } from './archiveParser';

export function isSquareArchive(bytes: Uint8Array, fileName: string): boolean {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.sdat') || lower.endsWith('.pfs') || lower.endsWith('.pf8') || lower.endsWith('.dat')) {
    if (bytes.length >= 4) {

      if (bytes[0] === 0x53 && bytes[1] === 0x44 && bytes[2] === 0x41 && bytes[3] === 0x54) return true;

      if (bytes[0] === 0x50 && bytes[1] === 0x46 && bytes[2] === 0x53 && (bytes[3] === 0x20 || bytes[3] === 0x00)) return true;

      if (bytes[0] === 0x70 && bytes[1] === 0x66 && bytes[2] === 0x38 && bytes[3] === 0x20) return true;
    }
  }
  if (bytes.length >= 4) {
    if (bytes[0] === 0x53 && bytes[1] === 0x44 && bytes[2] === 0x41 && bytes[3] === 0x54) return true;
    if (bytes[0] === 0x50 && bytes[1] === 0x46 && bytes[2] === 0x53 && (bytes[3] === 0x20 || bytes[3] === 0x00)) return true;
  }
  return false;
}

export function parseSquareArchive(fileName: string, bytes: Uint8Array, startTime: number): ParsedArchive {
  const magic4 = bytes.length >= 4 ? new TextDecoder('ascii').decode(bytes.subarray(0, 4)) : '';

  if (magic4 === 'SDAT' || fileName.toLowerCase().endsWith('.sdat')) {
    return parseSdatArchive(fileName, bytes, startTime);
  }

  return parsePfsArchive(fileName, bytes, startTime);
}

function parseSdatArchive(fileName: string, bytes: Uint8Array, startTime: number): ParsedArchive {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = bytes.length >= 8 ? view.getUint16(6, true) : 0x0100;
  const fileSize = bytes.length >= 12 ? view.getUint32(8, true) : bytes.length;
  const headerSize = bytes.length >= 14 ? view.getUint16(12, true) : 0x40;
  const numBlocks = bytes.length >= 16 ? view.getUint16(14, true) : 4;

  const symbOffset = bytes.length >= 20 ? view.getUint32(16, true) : 0;
  const symbSize = bytes.length >= 24 ? view.getUint32(20, true) : 0;
  const infoOffset = bytes.length >= 28 ? view.getUint32(24, true) : 0;
  const infoSize = bytes.length >= 32 ? view.getUint32(28, true) : 0;
  const fatOffset = bytes.length >= 36 ? view.getUint32(32, true) : 0;
  const fatSize = bytes.length >= 40 ? view.getUint32(36, true) : 0;
  const fileOffset = bytes.length >= 44 ? view.getUint32(40, true) : 0;
  const fileSizeBlock = bytes.length >= 48 ? view.getUint32(44, true) : 0;

  const symbolMap = new Map<number, string>();
  if (symbOffset > 0 && symbOffset + 8 < bytes.length) {
    const symbMagic = new TextDecoder('ascii').decode(bytes.subarray(symbOffset, symbOffset + 4));
    if (symbMagic === 'SYMB') {

      const sView = new DataView(bytes.buffer, bytes.byteOffset + symbOffset, Math.min(bytes.byteLength - symbOffset, symbSize || 65536));
      let strSearch = symbOffset + 0x20;
      let symbolIdx = 0;
      while (strSearch < symbOffset + (symbSize || 0x2000) && strSearch < bytes.length && symbolIdx < 500) {
        if (bytes[strSearch] >= 32 && bytes[strSearch] <= 126) {
          let sEnd = strSearch;
          while (sEnd < bytes.length && bytes[sEnd] !== 0) sEnd++;
          const str = new TextDecoder('ascii').decode(bytes.subarray(strSearch, sEnd));
          if (str.length >= 3 && /^[A-Za-z0-9_]+$/.test(str)) {
            symbolMap.set(symbolIdx++, str);
          }
          strSearch = sEnd + 1;
        } else {
          strSearch++;
        }
      }
    }
  }

  let fileCount = 0;
  const fatRecords: { offset: number; size: number }[] = [];

  if (fatOffset > 0 && fatOffset + 12 <= bytes.length) {
    const fatView = new DataView(bytes.buffer, bytes.byteOffset + fatOffset, bytes.byteLength - fatOffset);
    fileCount = fatView.getUint32(8, true);
    const safeCount = Math.min(fileCount, 5000);

    for (let i = 0; i < safeCount; i++) {
      const recPos = 12 + i * 16;
      if (fatOffset + recPos + 8 <= bytes.length) {
        const offset = fatView.getUint32(recPos, true);
        const size = fatView.getUint32(recPos + 4, true);
        fatRecords.push({ offset, size });
      }
    }
  }

  const headerFields: ArchiveHeaderField[] = [
    { label: 'Signature', offset: '0x00', length: 4, value: 'SDAT (Sound Data Archive)', description: 'Nintendo DS / Square Enix Audio Package' },
    { label: 'Version', offset: '0x06', length: 2, value: `0x${version.toString(16).padStart(4, '0')}`, description: 'SDAT Specification Version' },
    { label: 'Container Size', offset: '0x08', length: 4, value: formatBytes(fileSize), description: 'Total internal byte footprint' },
    { label: 'Allocated Sounds', offset: 'FAT', length: 4, value: fileCount.toLocaleString(), description: 'Music sequences, sound banks, wavebanks' },
    { label: 'FILE Block Offset', offset: '0x28', length: 4, value: toHex(fileOffset), description: 'Base address for raw waveform payloads' },
  ];

  const entries: ArchiveEntry[] = [];

  for (let i = 0; i < fatRecords.length; i++) {
    const rec = fatRecords[i];
    const absOffset = rec.offset;
    const size = rec.size;
    const safeEnd = Math.min(bytes.length, absOffset + size);
    const payload = absOffset < bytes.length ? bytes.subarray(absOffset, safeEnd) : new Uint8Array(0);

    let ext = 'bin';
    let folder = 'sound';
    let typeDesc = 'Raw Audio Lump';
    if (payload.length >= 4) {
      const lumpMagic = new TextDecoder('ascii').decode(payload.subarray(0, 4));
      if (lumpMagic === 'SSEQ') {
        ext = 'sseq';
        folder = 'sequences';
        typeDesc = 'MIDI / Music Sequence (SSEQ)';
      } else if (lumpMagic === 'SBNK') {
        ext = 'sbnk';
        folder = 'banks';
        typeDesc = 'Sound Bank / Instrument Patch (SBNK)';
      } else if (lumpMagic === 'SWAR') {
        ext = 'swar';
        folder = 'wave_archives';
        typeDesc = 'Wave Archive / Sample Bank (SWAR)';
      } else if (lumpMagic === 'SWAV') {
        ext = 'swav';
        folder = 'waves';
        typeDesc = 'Direct PCM / ADPCM Sample (SWAV)';
      }
    }

    const customName = symbolMap.get(i);
    const lumpName = customName ? `${customName}.${ext}` : `sound_${String(i).padStart(4, '0')}.${ext}`;

    entries.push({
      id: `sdat-${i}`,
      name: lumpName,
      path: `${folder}/${lumpName}`,
      folder,
      offset: absOffset,
      compressedSize: size,
      uncompressedSize: size,
      compressionMethod: typeDesc,
      crc32: computeCRC32(payload),
      category: 'audio',
      data: payload,
    });
  }

  return {
    fileName,
    fileSize: bytes.length,
    formatId: 'SQUARE',
    formatName: 'Square Enix / NDS SDAT Sound Archive',
    engineFamily: 'Nintendo DS / Square Enix Sound Engine',
    magicBytes: '53 44 41 54',
    endianness: 'Little Endian',
    headerFields,
    entries,
    rawBytes: bytes,
    parseTimeMs: Math.round(performance.now() - startTime),
    warnings: [],
  };
}

function parsePfsArchive(fileName: string, bytes: Uint8Array, startTime: number): ParsedArchive {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = new TextDecoder('ascii').decode(bytes.subarray(0, 4));
  const version = bytes.length >= 8 ? view.getUint32(4, true) : 1;
  const fileCount = bytes.length >= 12 ? view.getUint32(8, true) : 0;
  const dirOffset = bytes.length >= 16 ? view.getUint32(12, true) : 0x20;

  const headerFields: ArchiveHeaderField[] = [
    { label: 'Signature', offset: '0x00', length: 4, value: `${magic} (Square Enix Container)`, description: 'Square Enix Master Asset Container' },
    { label: 'Version', offset: '0x04', length: 4, value: `Revision ${version}`, description: 'PFS archive format version' },
    { label: 'Asset Count', offset: '0x08', length: 4, value: fileCount.toLocaleString(), description: 'Packaged resource count' },
    { label: 'Directory Offset', offset: '0x0C', length: 4, value: toHex(dirOffset), description: 'Asset descriptor table offset' },
  ];

  const entries: ArchiveEntry[] = [];
  const safeCount = Math.min(Math.max(0, fileCount), 10000);
  const entrySize = 32;

  let pos = dirOffset > 0 && dirOffset < bytes.length ? dirOffset : 0x20;

  for (let i = 0; i < safeCount && pos + entrySize <= bytes.length; i++) {
    const dataOffset = view.getUint32(pos, true);
    const compSize = view.getUint32(pos + 4, true);
    const uncompSize = view.getUint32(pos + 8, true);
    const flags = view.getUint32(pos + 12, true);

    let rawName = '';
    let end = pos + 16;
    while (end < pos + 32 && bytes[end] !== 0) end++;
    rawName = new TextDecoder('ascii').decode(bytes.subarray(pos + 16, end)).trim();
    if (!rawName) rawName = `asset_${String(i).padStart(4, '0')}.dat`;

    const cleanPath = rawName.replace(/\\/g, '/').replace(/^\/+/, '');
    const parts = cleanPath.split('/');
    const name = parts.pop() || rawName;
    const folder = parts.length > 0 ? parts.join('/') : '(root)';

    const isCompressed = compSize < uncompSize && (flags & 1) !== 0;
    let payload =
      dataOffset < bytes.length
        ? bytes.subarray(dataOffset, Math.min(bytes.length, dataOffset + compSize))
        : new Uint8Array(0);

    if (isCompressed && payload.length > 0) {
      try {
        payload = unzlibSync(payload);
      } catch {

      }
    }

    entries.push({
      id: `pfs-${i}`,
      name,
      path: cleanPath,
      folder,
      offset: dataOffset,
      compressedSize: compSize,
      uncompressedSize: uncompSize || compSize,
      compressionMethod: isCompressed ? 'Zlib Deflate' : 'Raw Stream',
      crc32: computeCRC32(payload),
      category: classifyEntry(name, payload),
      data: payload,
    });

    pos += entrySize;
  }

  return {
    fileName,
    fileSize: bytes.length,
    formatId: 'SQUARE',
    formatName: `Square Enix PFS Container (${magic})`,
    engineFamily: 'Square Enix Crystal Tools / Luminous',
    magicBytes: bytes.subarray(0, 4).reduce((acc, b) => `${acc}${b.toString(16).toUpperCase().padStart(2, '0')} `, '').trim(),
    endianness: 'Little Endian',
    headerFields,
    entries,
    rawBytes: bytes,
    parseTimeMs: Math.round(performance.now() - startTime),
    warnings: [],
  };
}
