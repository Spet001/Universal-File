import { unzlibSync, inflateSync } from 'fflate';
import { ArchiveEntry, ArchiveHeaderField, ParsedArchive } from '../types/archive';
import { computeCRC32, classifyEntry, formatBytes, toHex } from './archiveParser';

export function isFromSoftArchive(bytes: Uint8Array, fileName: string): boolean {
  const lower = fileName.toLowerCase();
  if (
    lower.endsWith('.dcx') ||
    lower.endsWith('.bnd') ||
    lower.endsWith('.bhd') ||
    lower.endsWith('.bdt') ||
    lower.endsWith('.tpf') ||
    lower.endsWith('.chrbnd') ||
    lower.endsWith('.objbnd') ||
    lower.endsWith('.partsbnd') ||
    lower.endsWith('.anibnd') ||
    lower.endsWith('.fev') ||
    lower.endsWith('.fsb')
  ) {
    return true;
  }
  if (bytes.length >= 4) {

    if (bytes[0] === 0x44 && bytes[1] === 0x43 && bytes[2] === 0x58 && bytes[3] === 0x00) return true;

    if (bytes[0] === 0x42 && bytes[1] === 0x4e && bytes[2] === 0x44 && bytes[3] === 0x33) return true;

    if (bytes[0] === 0x42 && bytes[1] === 0x4e && bytes[2] === 0x44 && bytes[3] === 0x34) return true;
  }
  return false;
}

export function parseFromSoftArchive(fileName: string, bytes: Uint8Array, startTime: number): ParsedArchive {
  const magic4 = bytes.length >= 4 ? new TextDecoder('ascii').decode(bytes.subarray(0, 4)) : '';

  if (magic4 === 'DCX\0' || fileName.toLowerCase().endsWith('.dcx')) {
    return parseDcxArchive(fileName, bytes, startTime);
  }
  if (magic4 === 'BND3') {
    return parseBnd3Archive(fileName, bytes, startTime);
  }
  if (magic4 === 'BND4') {
    return parseBnd4Archive(fileName, bytes, startTime);
  }

  for (let offset = 0; offset < Math.min(bytes.length - 4, 128); offset += 4) {
    const sub = new TextDecoder('ascii').decode(bytes.subarray(offset, offset + 4));
    if (sub === 'BND3') return parseBnd3Archive(fileName, bytes.subarray(offset), startTime);
    if (sub === 'BND4') return parseBnd4Archive(fileName, bytes.subarray(offset), startTime);
  }

  return parseBnd3Archive(fileName, bytes, startTime);
}

function parseDcxArchive(fileName: string, bytes: Uint8Array, startTime: number): ParsedArchive {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let uncompressedSize = 0;
  let compressedSize = 0;
  let compType = 'DFLT';
  let dataOffset = 0x48;

  for (let i = 0; i < Math.min(bytes.length - 8, 256); i++) {
    const chunk = new TextDecoder('ascii').decode(bytes.subarray(i, i + 3));
    if (chunk === 'DCS') {
      uncompressedSize = view.getUint32(i + 4, false);
      compressedSize = view.getUint32(i + 8, false);
    } else if (chunk === 'DCP') {
      compType = new TextDecoder('ascii').decode(bytes.subarray(i + 4, i + 8));
    } else if (chunk === 'DCA') {
      const dcaHeaderLen = view.getUint32(i + 4, false);
      dataOffset = dcaHeaderLen > 0 ? i + 4 + dcaHeaderLen : i + 8;
      if (dataOffset < bytes.length && bytes[dataOffset] !== 0x78) {
        for (let s = i + 8; s < Math.min(bytes.length - 2, i + 128); s++) {
          if (bytes[s] === 0x78 && (bytes[s + 1] === 0x01 || bytes[s + 1] === 0x5e || bytes[s + 1] === 0x9c || bytes[s + 1] === 0xda)) {
            dataOffset = s;
            break;
          }
        }
      }
      break;
    }
  }

  let decompressedPayload: Uint8Array | null = null;
  let decompressionError = '';

  if (dataOffset < bytes.length) {
    const compressedData = bytes.subarray(dataOffset);
    try {
      decompressedPayload = unzlibSync(compressedData);
    } catch {
      try {
        decompressedPayload = inflateSync(compressedData);
      } catch (err: any) {
        decompressionError = err?.message || 'Zlib decompression failed';
      }
    }
  }

  if (decompressedPayload && decompressedPayload.length >= 4) {
    const innerMagic = new TextDecoder('ascii').decode(decompressedPayload.subarray(0, 4));
    const innerName = fileName.replace(/\.dcx$/i, '');
    if (innerMagic === 'BND3') {
      const parsed = parseBnd3Archive(innerName, decompressedPayload, startTime);
      parsed.headerFields.unshift(
        { label: 'DCX Envelope', offset: '0x00', length: dataOffset, value: `DCX ${compType} (Compressed)`, description: 'FromSoftware compression wrapper' },
        { label: 'Decompressed Size', offset: 'DCS', length: 4, value: formatBytes(decompressedPayload.length), description: 'Uncompressed buffer size' }
      );
      parsed.formatName = `DCX -> ${parsed.formatName}`;
      return parsed;
    }
    if (innerMagic === 'BND4') {
      const parsed = parseBnd4Archive(innerName, decompressedPayload, startTime);
      parsed.headerFields.unshift(
        { label: 'DCX Envelope', offset: '0x00', length: dataOffset, value: `DCX ${compType} (Compressed)`, description: 'FromSoftware compression wrapper' },
        { label: 'Decompressed Size', offset: 'DCS', length: 4, value: formatBytes(decompressedPayload.length), description: 'Uncompressed buffer size' }
      );
      parsed.formatName = `DCX -> ${parsed.formatName}`;
      return parsed;
    }
  }

  const headerFields: ArchiveHeaderField[] = [
    { label: 'Signature', offset: '0x00', length: 4, value: 'DCX\\0 (FromSoftware Container)', description: 'FromSoftware Compressed Container' },
    { label: 'Compression Algorithm', offset: 'DCP', length: 4, value: compType === 'DFLT' ? 'Zlib Deflate (DFLT)' : compType, description: 'Payload compression method' },
    { label: 'Uncompressed Size', offset: 'DCS', length: 4, value: formatBytes(uncompressedSize || (decompressedPayload ? decompressedPayload.length : 0)), description: 'Target buffer allocation size' },
    { label: 'Compressed Data Offset', offset: 'DCA', length: 4, value: toHex(dataOffset), description: 'Start of compressed stream' },
  ];

  const payload = decompressedPayload || bytes.subarray(dataOffset);
  const unwrappedName = fileName.replace(/\.dcx$/i, '');

  const entries: ArchiveEntry[] = [
    {
      id: 'dcx-payload-0',
      name: unwrappedName,
      path: unwrappedName,
      folder: '(root)',
      offset: dataOffset,
      compressedSize: bytes.length - dataOffset,
      uncompressedSize: payload.length,
      compressionMethod: `DCX ${compType}`,
      crc32: computeCRC32(payload),
      category: classifyEntry(unwrappedName, payload),
      data: payload,
    },
  ];

  return {
    fileName,
    fileSize: bytes.length,
    formatId: 'FROMSOFT',
    formatName: `FromSoftware DCX (${compType})`,
    engineFamily: 'FromSoftware Soulsborne Engine',
    magicBytes: '44 43 58 00',
    endianness: 'Big Endian',
    headerFields,
    entries,
    rawBytes: bytes,
    parseTimeMs: Math.round(performance.now() - startTime),
    warnings: decompressionError ? [decompressionError] : [],
  };
}

function parseBnd3Archive(fileName: string, bytes: Uint8Array, startTime: number): ParsedArchive {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = bytes.length >= 12 ? new TextDecoder('ascii').decode(bytes.subarray(4, 12)).replace(/\0+$/, '') : '07D7R6';
  const formatFlags = bytes.length >= 13 ? bytes[12] : 0x74;
  const isBigEndian = bytes.length >= 14 ? bytes[13] === 1 : false;
  const fileCount = bytes.length >= 20 ? view.getUint32(16, !isBigEndian) : 0;
  const headerEnd = bytes.length >= 24 ? view.getUint32(20, !isBigEndian) : 0;

  const headerFields: ArchiveHeaderField[] = [
    { label: 'Signature', offset: '0x00', length: 4, value: 'BND3 (Binder 3)', description: 'FromSoftware Game Resource Package' },
    { label: 'Engine Schema Revision', offset: '0x04', length: 8, value: version, description: 'FromSoftware binder version stamp' },
    { label: 'Format Flags', offset: '0x0C', length: 1, value: `0x${formatFlags.toString(16).toUpperCase()}`, description: 'File header descriptor flags' },
    { label: 'Target Endianness', offset: '0x0D', length: 1, value: isBigEndian ? 'Big Endian (PS3 / X360)' : 'Little Endian (PC)', description: 'Architecture byte ordering' },
    { label: 'Asset Count', offset: '0x10', length: 4, value: fileCount.toLocaleString(), description: 'Total internal records' },
  ];

  const entries: ArchiveEntry[] = [];
  const safeCount = Math.min(Math.max(0, fileCount), 20000);

  const fileHeaderSize = 24;
  let currHeaderPos = 0x20;

  for (let i = 0; i < safeCount && currHeaderPos + fileHeaderSize <= bytes.length; i++) {
    const recordFlags = bytes[currHeaderPos];
    const compSize = view.getUint32(currHeaderPos + 4, !isBigEndian);
    const dataOffset = view.getUint32(currHeaderPos + 8, !isBigEndian);
    const fileId = view.getUint32(currHeaderPos + 12, !isBigEndian);
    const nameOffset = view.getUint32(currHeaderPos + 16, !isBigEndian);
    const uncompSize = view.getUint32(currHeaderPos + 20, !isBigEndian) || compSize;

    let rawPath = '';
    if (nameOffset > 0 && nameOffset < bytes.length) {
      let pEnd = nameOffset;
      while (pEnd < bytes.length && bytes[pEnd] !== 0) pEnd++;
      rawPath = new TextDecoder('ascii').decode(bytes.subarray(nameOffset, pEnd));
    }

    if (!rawPath) rawPath = `asset_${fileId}.dat`;

    const cleanPath = rawPath.replace(/\\/g, '/').replace(/^[a-zA-Z]:\//, '').replace(/^\/+/, '');
    const parts = cleanPath.split('/');
    const cleanName = parts.pop() || `asset_${fileId}.dat`;
    const folder = parts.length > 0 ? parts.join('/') : '(root)';

    const payload =
      dataOffset < bytes.length
        ? bytes.subarray(dataOffset, Math.min(bytes.length, dataOffset + compSize))
        : new Uint8Array(0);

    entries.push({
      id: `bnd3-${i}-${fileId}`,
      name: cleanName,
      path: cleanPath,
      folder,
      offset: dataOffset,
      compressedSize: compSize,
      uncompressedSize: uncompSize,
      compressionMethod: 'Uncompressed Stream',
      crc32: computeCRC32(payload),
      category: classifyEntry(cleanName, payload),
      data: payload,
    });

    currHeaderPos += fileHeaderSize;
  }

  return {
    fileName,
    fileSize: bytes.length,
    formatId: 'FROMSOFT',
    formatName: `FromSoftware BND3 (Dark Souls / Demon's Souls)`,
    engineFamily: 'FromSoftware Soulsborne Engine',
    magicBytes: '42 4E 44 33',
    endianness: isBigEndian ? 'Big Endian' : 'Little Endian',
    headerFields,
    entries,
    rawBytes: bytes,
    parseTimeMs: Math.round(performance.now() - startTime),
    warnings: [],
  };
}

function parseBnd4Archive(fileName: string, bytes: Uint8Array, startTime: number): ParsedArchive {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const isBigEndian = bytes.length >= 10 ? bytes[9] === 1 : false;
  const isUnicode = bytes.length >= 33 ? bytes[32] === 1 : true;
  const fileCount = bytes.length >= 20 ? Number(view.getBigUint64(12, !isBigEndian)) : 0;
  const version = bytes.length >= 36 ? new TextDecoder('ascii').decode(bytes.subarray(24, 32)).replace(/\0+$/, '') : 'GRACE';
  const fileHeadersOffset = bytes.length >= 52 ? Number(view.getBigUint64(44, !isBigEndian)) : 0x40;

  const headerFields: ArchiveHeaderField[] = [
    { label: 'Signature', offset: '0x00', length: 4, value: 'BND4 (Binder 4)', description: 'Modern FromSoftware Universal Container' },
    { label: 'Engine Generation', offset: '0x18', length: 8, value: `BND4 (${version})`, description: 'DS3 / Bloodborne / Elden Ring schema' },
    { label: 'Target Endianness', offset: '0x09', length: 1, value: isBigEndian ? 'Big Endian (Console)' : 'Little Endian (PC / x64)', description: 'Word alignment' },
    { label: 'Character Encoding', offset: '0x20', length: 1, value: isUnicode ? 'UTF-16LE' : 'UTF-8 / ASCII', description: 'String table encoding' },
    { label: 'Asset Count', offset: '0x0C', length: 8, value: fileCount.toLocaleString(), description: 'Bound asset records' },
  ];

  const entries: ArchiveEntry[] = [];
  const safeCount = Math.min(Math.max(0, fileCount), 25000);
  const fileHeaderSize = 36;

  let currHeaderPos = fileHeadersOffset > 0 && fileHeadersOffset < bytes.length ? fileHeadersOffset : 0x40;

  for (let i = 0; i < safeCount && currHeaderPos + fileHeaderSize <= bytes.length; i++) {
    const compSize = Number(view.getBigUint64(currHeaderPos + 8, !isBigEndian));
    const uncompSize = Number(view.getBigUint64(currHeaderPos + 16, !isBigEndian));
    const dataOffset = Number(view.getBigUint64(currHeaderPos + 24, !isBigEndian));
    const fileId = view.getUint32(currHeaderPos + 32, !isBigEndian);

    let rawPath = '';
    const nameOffset = currHeaderPos + fileHeaderSize;
    if (nameOffset < bytes.length) {
      if (isUnicode) {
        let pEnd = nameOffset;
        while (pEnd + 1 < bytes.length && !(bytes[pEnd] === 0 && bytes[pEnd + 1] === 0)) pEnd += 2;
        rawPath = new TextDecoder('utf-16le').decode(bytes.subarray(nameOffset, pEnd));
      } else {
        let pEnd = nameOffset;
        while (pEnd < bytes.length && bytes[pEnd] !== 0) pEnd++;
        rawPath = new TextDecoder('utf-8').decode(bytes.subarray(nameOffset, pEnd));
      }
    }

    if (!rawPath || rawPath.charCodeAt(0) === 0) {
      rawPath = `asset_${fileId}.dat`;
    }

    const cleanPath = rawPath.replace(/\\/g, '/').replace(/^[a-zA-Z]:\//, '').replace(/^\/+/, '');
    const parts = cleanPath.split('/');
    const cleanName = parts.pop() || `asset_${fileId}.dat`;
    const folder = parts.length > 0 ? parts.join('/') : '(root)';

    const payload =
      dataOffset < bytes.length
        ? bytes.subarray(dataOffset, Math.min(bytes.length, dataOffset + compSize))
        : new Uint8Array(0);

    entries.push({
      id: `bnd4-${i}-${fileId}`,
      name: cleanName,
      path: cleanPath,
      folder,
      offset: dataOffset,
      compressedSize: compSize,
      uncompressedSize: uncompSize || compSize,
      compressionMethod: 'Uncompressed Stream',
      crc32: computeCRC32(payload),
      category: classifyEntry(cleanName, payload),
      data: payload,
    });

    currHeaderPos += fileHeaderSize + 4;
  }

  return {
    fileName,
    fileSize: bytes.length,
    formatId: 'FROMSOFT',
    formatName: 'FromSoftware BND4 (Elden Ring / DS3 / Sekiro)',
    engineFamily: 'FromSoftware Soulsborne Engine',
    magicBytes: '42 4E 44 34',
    endianness: isBigEndian ? 'Big Endian' : 'Little Endian',
    headerFields,
    entries,
    rawBytes: bytes,
    parseTimeMs: Math.round(performance.now() - startTime),
    warnings: [],
  };
}
