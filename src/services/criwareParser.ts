import { ArchiveEntry, ArchiveHeaderField, ParsedArchive } from '../types/archive';
import { computeCRC32, classifyEntry, formatBytes, toHex } from './archiveParser';

export function isCriwareArchive(bytes: Uint8Array, fileName: string): boolean {
  const lower = fileName.toLowerCase();
  if (
    lower.endsWith('.awb') ||
    lower.endsWith('.acb') ||
    lower.endsWith('.usm') ||
    lower.endsWith('.adx') ||
    lower.endsWith('.hca')
  ) {
    return true;
  }
  if (bytes.length >= 4) {
    // AFS2
    if (bytes[0] === 0x41 && bytes[1] === 0x46 && bytes[2] === 0x53 && bytes[3] === 0x32) return true;
    // @UTF
    if (bytes[0] === 0x40 && bytes[1] === 0x55 && bytes[2] === 0x54 && bytes[3] === 0x46) return true;
    // CRID
    if (bytes[0] === 0x43 && bytes[1] === 0x52 && bytes[2] === 0x49 && bytes[3] === 0x44) return true;
    // HCA\0
    if (bytes[0] === 0x48 && bytes[1] === 0x43 && bytes[2] === 0x41 && bytes[3] === 0x00) return true;
    // ADX (0x80 0x00)
    if (bytes[0] === 0x80 && bytes[1] === 0x00) return true;
  }
  return false;
}

export function parseCriwareArchive(fileName: string, bytes: Uint8Array, startTime: number): ParsedArchive {
  const lower = fileName.toLowerCase();
  const magic4 = bytes.length >= 4 ? new TextDecoder('ascii').decode(bytes.subarray(0, 4)) : '';

  if (magic4 === 'AFS2' || lower.endsWith('.awb')) {
    return parseAfs2Archive(fileName, bytes, startTime);
  }
  if (magic4 === '@UTF' || lower.endsWith('.acb')) {
    return parseAcbArchive(fileName, bytes, startTime);
  }
  if (magic4 === 'CRID' || lower.endsWith('.usm')) {
    return parseUsmArchive(fileName, bytes, startTime);
  }
  if (magic4 === 'HCA\0' || lower.endsWith('.hca')) {
    return parseHcaAudio(fileName, bytes, startTime);
  }
  if ((bytes.length >= 2 && bytes[0] === 0x80 && bytes[1] === 0x00) || lower.endsWith('.adx')) {
    return parseAdxAudio(fileName, bytes, startTime);
  }

  return parseAfs2Archive(fileName, bytes, startTime);
}

/**
 * 1. CRI Atom AFS2 Audio Wave Bank (.awb)
 */
function parseAfs2Archive(fileName: string, bytes: Uint8Array, startTime: number): ParsedArchive {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = bytes.length >= 5 ? bytes[4] : 1;
  const offsetSize = bytes.length >= 6 ? bytes[5] : 4;
  const subkey = bytes.length >= 8 ? view.getUint16(6, true) : 0;
  const waveCount = bytes.length >= 12 ? view.getUint32(8, true) : 0;
  const alignment = bytes.length >= 16 ? view.getUint32(12, true) : 0x20;

  const headerFields: ArchiveHeaderField[] = [
    { label: 'Signature', offset: '0x00', length: 4, value: 'AFS2 (Atom Wave Bank)', description: 'CRIWARE Atom Audio Container' },
    { label: 'Container Version', offset: '0x04', length: 1, value: `AFS2 v${version}`, description: 'CRI Atom Wave Format Revision' },
    { label: 'Offset Field Width', offset: '0x05', length: 1, value: `${offsetSize} bytes (${offsetSize * 8}-bit)`, description: 'Offset pointer integer width' },
    { label: 'Waveform Count', offset: '0x08', length: 4, value: waveCount.toLocaleString(), description: 'Audio tracks in wavebank' },
    { label: 'Byte Alignment', offset: '0x0C', length: 4, value: `${alignment} bytes`, description: 'Sample boundary alignment' },
  ];

  const entries: ArchiveEntry[] = [];
  const safeCount = Math.min(Math.max(0, waveCount), 10000);

  // Offset table follows wave IDs table (waveCount * 2 bytes)
  const idsOffset = 0x10;
  const offsetsTableOffset = idsOffset + safeCount * 2;

  const offsets: number[] = [];
  for (let i = 0; i <= safeCount; i++) {
    const pos = offsetsTableOffset + i * offsetSize;
    if (pos + offsetSize <= bytes.length) {
      if (offsetSize === 2) {
        offsets.push(view.getUint16(pos, true));
      } else {
        offsets.push(view.getUint32(pos, true));
      }
    } else {
      offsets.push(bytes.length);
    }
  }

  for (let i = 0; i < safeCount; i++) {
    const startOfs = offsets[i] ?? 0;
    const endOfs = offsets[i + 1] ?? bytes.length;
    const size = Math.max(0, endOfs - startOfs);

    let ext = 'hca';
    let compression = 'CRI High Compression Audio (HCA)';
    if (startOfs + 4 <= bytes.length) {
      if (bytes[startOfs] === 0x80 && bytes[startOfs + 1] === 0x00) {
        ext = 'adx';
        compression = 'CRI ADX ADPCM Audio';
      } else if (
        bytes[startOfs] === 0x48 &&
        bytes[startOfs + 1] === 0x43 &&
        bytes[startOfs + 2] === 0x41
      ) {
        ext = 'hca';
        compression = 'CRI HCA Audio';
      }
    }

    const payload = bytes.subarray(startOfs, Math.min(bytes.length, startOfs + size));
    const trackName = `track_${String(i).padStart(4, '0')}.${ext}`;

    entries.push({
      id: `awb-${i}`,
      name: trackName,
      path: `audio/${trackName}`,
      folder: 'audio',
      offset: startOfs,
      compressedSize: size,
      uncompressedSize: size,
      compressionMethod: compression,
      crc32: computeCRC32(payload),
      category: 'audio',
      data: payload,
    });
  }

  return {
    fileName,
    fileSize: bytes.length,
    formatId: 'CRIWARE',
    formatName: 'CRIWARE AFS2 Wave Bank (.awb)',
    engineFamily: 'CRI Middleware CRIWARE Atom',
    magicBytes: '41 46 53 32',
    endianness: 'Little Endian',
    headerFields,
    entries,
    rawBytes: bytes,
    parseTimeMs: Math.round(performance.now() - startTime),
    warnings: [],
  };
}

/**
 * 2. CRI Audio Cue Bank (@UTF / .acb)
 */
function parseAcbArchive(fileName: string, bytes: Uint8Array, startTime: number): ParsedArchive {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tableSize = bytes.length >= 8 ? view.getUint32(4, false) : 0;
  const rowsOffset = bytes.length >= 12 ? view.getUint32(8, false) + 8 : 0x20;
  const stringsOffset = bytes.length >= 16 ? view.getUint32(12, false) + 8 : 0;
  const dataOffset = bytes.length >= 20 ? view.getUint32(16, false) + 8 : 0;
  const numColumns = bytes.length >= 26 ? view.getUint16(24, false) : 0;
  const rowLength = bytes.length >= 28 ? view.getUint16(26, false) : 0;
  const numRows = bytes.length >= 32 ? view.getUint32(28, false) : 0;

  const headerFields: ArchiveHeaderField[] = [
    { label: 'Signature', offset: '0x00', length: 4, value: '@UTF (0x40555446)', description: 'CRIWARE Universal Table Format' },
    { label: 'Table Size', offset: '0x04', length: 4, value: formatBytes(tableSize), description: 'Schema and metadata payload size' },
    { label: 'Schema Columns', offset: '0x18', length: 2, value: numColumns.toString(), description: 'Database attribute descriptors' },
    { label: 'Cue Record Rows', offset: '0x1C', length: 4, value: numRows.toLocaleString(), description: 'Audio cues and waveform descriptors' },
    { label: 'Strings Heap', offset: '0x0C', length: 4, value: toHex(stringsOffset), description: 'Cue sheet names and tags offset' },
  ];

  const entries: ArchiveEntry[] = [];

  // Add the UTF metadata table entry
  entries.push({
    id: 'acb-utf-table',
    name: 'CueSheetTable.utf',
    path: 'metadata/CueSheetTable.utf',
    folder: 'metadata',
    offset: 0,
    compressedSize: Math.min(bytes.length, tableSize + 8),
    uncompressedSize: Math.min(bytes.length, tableSize + 8),
    compressionMethod: '@UTF Relational Schema',
    crc32: computeCRC32(bytes.subarray(0, Math.min(bytes.length, tableSize + 8))),
    category: 'config',
    data: bytes.subarray(0, Math.min(bytes.length, tableSize + 8)),
  });

  // Search for embedded AFS2 or HCA / ADX payloads inside ACB
  let searchIdx = 0x20;
  let waveIdx = 0;
  while (searchIdx + 8 < bytes.length) {
    // Embedded AFS2
    if (
      bytes[searchIdx] === 0x41 &&
      bytes[searchIdx + 1] === 0x46 &&
      bytes[searchIdx + 2] === 0x53 &&
      bytes[searchIdx + 3] === 0x32
    ) {
      const embeddedAwb = parseAfs2Archive(`${fileName}_embedded.awb`, bytes.subarray(searchIdx), startTime);
      for (const e of embeddedAwb.entries) {
        entries.push({
          ...e,
          id: `acb-embedded-${e.id}`,
          path: `internal_awb/${e.name}`,
          folder: 'internal_awb',
          offset: searchIdx + e.offset,
        });
      }
      break;
    }
    // Standalone HCA stream embedded
    if (
      bytes[searchIdx] === 0x48 &&
      bytes[searchIdx + 1] === 0x43 &&
      bytes[searchIdx + 2] === 0x41 &&
      bytes[searchIdx + 3] === 0x00
    ) {
      const hcaSize = Math.min(bytes.length - searchIdx, 256 * 1024);
      const payload = bytes.subarray(searchIdx, searchIdx + hcaSize);
      entries.push({
        id: `acb-hca-${waveIdx}`,
        name: `cue_wave_${waveIdx}.hca`,
        path: `cues/cue_wave_${waveIdx}.hca`,
        folder: 'cues',
        offset: searchIdx,
        compressedSize: hcaSize,
        uncompressedSize: hcaSize,
        compressionMethod: 'CRI HCA Audio',
        crc32: computeCRC32(payload),
        category: 'audio',
        data: payload,
      });
      waveIdx++;
      searchIdx += hcaSize;
      continue;
    }
    searchIdx += 4;
  }

  return {
    fileName,
    fileSize: bytes.length,
    formatId: 'CRIWARE',
    formatName: 'CRIWARE Audio Cue Bank (.acb)',
    engineFamily: 'CRI Middleware CRIWARE Atom',
    magicBytes: '40 55 54 46',
    endianness: 'Big Endian',
    headerFields,
    entries,
    rawBytes: bytes,
    parseTimeMs: Math.round(performance.now() - startTime),
    warnings: [],
  };
}

/**
 * 3. CRI Sofdec 2 Movie Container (CRID / .usm)
 */
function parseUsmArchive(fileName: string, bytes: Uint8Array, startTime: number): ParsedArchive {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let videoPayloadSize = 0;
  let audioPayloadSize = 0;
  let packetCount = 0;

  // Scan USM packets
  let pos = 0;
  while (pos + 8 <= bytes.length && packetCount < 5000) {
    const magic = new TextDecoder('ascii').decode(bytes.subarray(pos, pos + 4));
    const size = view.getUint32(pos + 4, false);
    if (size <= 0 || pos + 8 + size > bytes.length) break;

    if (magic === '@SFV') videoPayloadSize += size;
    else if (magic === '@SFA') audioPayloadSize += size;

    packetCount++;
    pos += 8 + size;
  }

  const headerFields: ArchiveHeaderField[] = [
    { label: 'Signature', offset: '0x00', length: 4, value: 'CRID (Sofdec 2 Video)', description: 'CRI Middleware Video Container' },
    { label: 'Packets Inspected', offset: '0x00', length: 4, value: packetCount.toLocaleString(), description: 'Multiplexed stream chunks' },
    { label: 'Video Stream Size', offset: '@SFV', length: 0, value: formatBytes(videoPayloadSize), description: 'H.264 / MPEG-2 elementary video' },
    { label: 'Audio Stream Size', offset: '@SFA', length: 0, value: formatBytes(audioPayloadSize), description: 'HCA / ADX 5.1/Stereo audio' },
  ];

  const entries: ArchiveEntry[] = [];

  // Demuxed streams representation
  entries.push({
    id: 'usm-video',
    name: 'video_track.m2v',
    path: 'video/video_track.m2v',
    folder: 'video',
    offset: 0,
    compressedSize: videoPayloadSize || Math.floor(bytes.length * 0.75),
    uncompressedSize: videoPayloadSize || Math.floor(bytes.length * 0.75),
    compressionMethod: 'Sofdec 2 Video (MPEG-2/H.264)',
    crc32: computeCRC32(bytes.subarray(0, Math.min(bytes.length, 65536))),
    category: 'video',
    data: bytes.subarray(0, Math.min(bytes.length, 512 * 1024)),
  });

  entries.push({
    id: 'usm-audio',
    name: 'audio_track.hca',
    path: 'audio/audio_track.hca',
    folder: 'audio',
    offset: 0,
    compressedSize: audioPayloadSize || Math.floor(bytes.length * 0.2),
    uncompressedSize: audioPayloadSize || Math.floor(bytes.length * 0.2),
    compressionMethod: 'CRI HCA / ADX Audio Track',
    crc32: computeCRC32(bytes.subarray(0, Math.min(bytes.length, 32768))),
    category: 'audio',
    data: bytes.subarray(0, Math.min(bytes.length, 256 * 1024)),
  });

  return {
    fileName,
    fileSize: bytes.length,
    formatId: 'CRIWARE',
    formatName: 'CRI Sofdec 2 Movie Container (.usm)',
    engineFamily: 'CRI Middleware Sofdec 2',
    magicBytes: '43 52 49 44',
    endianness: 'Big Endian',
    headerFields,
    entries,
    rawBytes: bytes,
    parseTimeMs: Math.round(performance.now() - startTime),
    warnings: [],
  };
}

/**
 * 4. CRI ADX Audio (.adx)
 */
function parseAdxAudio(fileName: string, bytes: Uint8Array, startTime: number): ParsedArchive {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const copyrightOffset = bytes.length >= 4 ? view.getUint16(2, false) : 0;
  const channelCount = bytes.length >= 8 ? bytes[7] : 2;
  const sampleRate = bytes.length >= 12 ? view.getUint32(8, false) : 44100;
  const sampleCount = bytes.length >= 16 ? view.getUint32(12, false) : 0;
  const durationSec = sampleRate > 0 ? (sampleCount / sampleRate).toFixed(2) : '0';

  const headerFields: ArchiveHeaderField[] = [
    { label: 'Signature', offset: '0x00', length: 2, value: '0x8000 (CRI ADX Header)', description: 'CRI ADX ADPCM Audio Stream' },
    { label: 'Channel Configuration', offset: '0x07', length: 1, value: channelCount === 1 ? 'Mono' : channelCount === 2 ? 'Stereo' : `${channelCount} Channels`, description: 'Audio channels' },
    { label: 'Sampling Rate', offset: '0x08', length: 4, value: `${sampleRate.toLocaleString()} Hz`, description: 'Sample playback frequency' },
    { label: 'Sample Count', offset: '0x0C', length: 4, value: `${sampleCount.toLocaleString()} samples (${durationSec}s)`, description: 'Total audio duration' },
  ];

  const entries: ArchiveEntry[] = [
    {
      id: 'adx-stream-0',
      name: fileName,
      path: `audio/${fileName}`,
      folder: 'audio',
      offset: 0,
      compressedSize: bytes.length,
      uncompressedSize: sampleCount * channelCount * 2 || bytes.length * 4,
      compressionMethod: 'CRI ADX ADPCM',
      crc32: computeCRC32(bytes),
      category: 'audio',
      data: bytes,
    },
  ];

  return {
    fileName,
    fileSize: bytes.length,
    formatId: 'CRIWARE',
    formatName: 'CRI ADX Audio (.adx)',
    engineFamily: 'CRI Middleware CRIWARE',
    magicBytes: '80 00',
    endianness: 'Big Endian',
    headerFields,
    entries,
    rawBytes: bytes,
    parseTimeMs: Math.round(performance.now() - startTime),
    warnings: [],
  };
}

/**
 * 5. CRI High Compression Audio (.hca)
 */
function parseHcaAudio(fileName: string, bytes: Uint8Array, startTime: number): ParsedArchive {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = bytes.length >= 6 ? view.getUint16(4, false) : 0x0200;
  const headerSize = bytes.length >= 8 ? view.getUint16(6, false) : 0x60;

  // Read 'fmt\0' chunk if present
  let channels = 2;
  let sampleRate = 48000;
  let blockCount = 0;

  if (bytes.length >= headerSize && headerSize >= 0x18) {
    channels = bytes[0x0b] || 2;
    sampleRate = (bytes[0x0c] << 16) | (bytes[0x0d] << 8) | bytes[0x0e] || 48000;
    blockCount = view.getUint32(0x10, false) || 0;
  }

  const headerFields: ArchiveHeaderField[] = [
    { label: 'Signature', offset: '0x00', length: 4, value: 'HCA\\0 (0x48434100)', description: 'CRI High Compression Audio' },
    { label: 'Codec Version', offset: '0x04', length: 2, value: `0x${version.toString(16).padStart(4, '0')}`, description: 'HCA compression codec revision' },
    { label: 'Audio Channels', offset: 'fmt', length: 1, value: channels === 1 ? 'Mono' : channels === 2 ? 'Stereo' : `${channels} Channels`, description: 'Playback channel configuration' },
    { label: 'Sample Rate', offset: 'fmt', length: 3, value: `${sampleRate.toLocaleString()} Hz`, description: 'Sampling frequency' },
    { label: 'Total Audio Blocks', offset: 'fmt', length: 4, value: blockCount.toLocaleString(), description: 'Coded frame blocks' },
  ];

  const entries: ArchiveEntry[] = [
    {
      id: 'hca-stream-0',
      name: fileName,
      path: `audio/${fileName}`,
      folder: 'audio',
      offset: 0,
      compressedSize: bytes.length,
      uncompressedSize: blockCount * 1024 * channels * 2 || bytes.length * 6,
      compressionMethod: 'CRI HCA Transform Coding',
      crc32: computeCRC32(bytes),
      category: 'audio',
      data: bytes,
    },
  ];

  return {
    fileName,
    fileSize: bytes.length,
    formatId: 'CRIWARE',
    formatName: 'CRI High Compression Audio (.hca)',
    engineFamily: 'CRI Middleware CRIWARE Atom',
    magicBytes: '48 43 41 00',
    endianness: 'Big Endian',
    headerFields,
    entries,
    rawBytes: bytes,
    parseTimeMs: Math.round(performance.now() - startTime),
    warnings: [],
  };
}
