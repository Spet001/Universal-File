import { unzlibSync } from 'fflate';
import { ArchiveEntry, ArchiveHeaderField, ParsedArchive } from '../types/archive';
import { computeCRC32, toHex, bytesToHexPreview, classifyEntry, readAscii, splitFolderAndName } from './archiveParser';

export interface Ff13FileInfo {
  fileCode: number;
  sectorOffset: number;
  byteOffset: number;
  uncompressedSize: number;
  compressedSize: number;
  virtualPath: string;
  isCompressed: boolean;
}

export function parseFf13Archive(fileName: string, bytes: Uint8Array, startTime: number): ParsedArchive {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const lower = fileName.toLowerCase();

  const warnings: string[] = [];
  const entries: ArchiveEntry[] = [];
  const headerFields: ArchiveHeaderField[] = [];

  let baseOffset = 0;

  if (bytes.length > 44 && readAscii(bytes, 0, 4) === 'CRYP') {
    baseOffset = 32;
  }

  const chunkInfoTableOffset = view.getUint32(baseOffset, true);
  const chunkDataStartOffset = view.getUint32(baseOffset + 4, true);
  const fileCount = view.getUint32(baseOffset + 8, true);

  const isValidFilelist =
    fileCount > 0 &&
    fileCount < 200000 &&
    chunkInfoTableOffset > 12 &&
    chunkInfoTableOffset < bytes.length &&
    chunkDataStartOffset > chunkInfoTableOffset &&
    chunkDataStartOffset < bytes.length;

  if (isValidFilelist) {
    headerFields.push(
      {
        label: 'FFXIII Filelist Header',
        offset: `0x${baseOffset.toString(16).toUpperCase()}`,
        length: 12,
        value: `White Data Filelist (${fileCount.toLocaleString()} files)`,
        description: 'Final Fantasy XIII white_data master filelist archive',
      },
      {
        label: 'Chunk Info Table Offset',
        offset: `0x${(baseOffset).toString(16).toUpperCase()}`,
        length: 4,
        value: `0x${chunkInfoTableOffset.toString(16).toUpperCase()}`,
        description: 'Byte offset of chunk descriptor table',
      },
      {
        label: 'Chunk Data Stream Offset',
        offset: `0x${(baseOffset + 4).toString(16).toUpperCase()}`,
        length: 4,
        value: `0x${chunkDataStartOffset.toString(16).toUpperCase()}`,
        description: 'Starting byte offset of compressed path chunks',
      }
    );

    let entryPos = baseOffset + 12;
    const entriesList: { fileCode: number; chunkId: number; fileInfoPos: number }[] = [];
    let maxChunkId = 0;

    for (let i = 0; i < fileCount && entryPos + 8 <= chunkInfoTableOffset; i++) {
      const fileCode = view.getUint32(entryPos, true);
      const chunkId = view.getUint16(entryPos + 4, true);
      const fileInfoPos = view.getUint16(entryPos + 6, true);
      entriesList.push({ fileCode, chunkId, fileInfoPos });
      if (chunkId > maxChunkId) maxChunkId = chunkId;
      entryPos += 8;
    }

    const chunkCount = maxChunkId + 1;

    const decompressedChunks: string[] = [];
    let chunkInfoPos = baseOffset + chunkInfoTableOffset;

    for (let c = 0; c < chunkCount && chunkInfoPos + 12 <= bytes.length; c++) {
      const uncmpSize = view.getUint32(chunkInfoPos, true);
      const cmpSize = view.getUint32(chunkInfoPos + 4, true);
      const chunkRelativePos = view.getUint32(chunkInfoPos + 8, true);
      chunkInfoPos += 12;

      const chunkAbsPos = baseOffset + chunkDataStartOffset + chunkRelativePos;
      if (chunkAbsPos + cmpSize <= bytes.length) {
        try {
          const cmpData = bytes.subarray(chunkAbsPos, chunkAbsPos + cmpSize);
          const uncmpData = uncmpSize === cmpSize ? cmpData : unzlibSync(cmpData);
          decompressedChunks.push(new TextDecoder('ascii', { fatal: false }).decode(uncmpData));
        } catch {
          decompressedChunks.push('');
        }
      } else {
        decompressedChunks.push('');
      }
    }

    let entryIdx = 0;
    for (const item of entriesList) {
      if (item.chunkId < decompressedChunks.length) {
        const chunkStr = decompressedChunks[item.chunkId];
        if (item.fileInfoPos < chunkStr.length) {
          const nullTerm = chunkStr.indexOf('\0', item.fileInfoPos);
          const line = nullTerm !== -1 ? chunkStr.substring(item.fileInfoPos, nullTerm) : chunkStr.substring(item.fileInfoPos);
          const parts = line.split(':');
          if (parts.length >= 4) {
            const secHex = parts[0];
            const uncmpHex = parts[1];
            const cmpHex = parts[2];
            const vPath = parts.slice(3).join(':').replace(/\\/g, '/');

            const sectorOffset = parseInt(secHex, 16) || 0;
            const byteOffset = sectorOffset * 2048;
            const uSize = parseInt(uncmpHex, 16) || 0;
            const cSize = parseInt(cmpHex, 16) || 0;

            const { folder, name, cleanPath } = splitFolderAndName(vPath || `file_${item.fileCode}`);
            const placeholderData = new Uint8Array(0);

            entries.push({
              id: `ff13-${entryIdx++}`,
              name,
              path: cleanPath,
              folder,
              offset: byteOffset,
              compressedSize: cSize,
              uncompressedSize: uSize,
              compressionMethod: cSize === uSize ? 'WhiteBin Sector Store (2048 B)' : 'WhiteBin Zlib Stream',
              crc32: item.fileCode,
              category: classifyEntry(cleanPath, placeholderData),
              data: placeholderData,
              metadata: {
                fileCode: toHex(item.fileCode),
                sectorOffset: `0x${secHex.toUpperCase()}`,
                sectorMultiplier: '2048 bytes',
              },
            });
          }
        }
      }
    }
  }

  if (entries.length === 0) {
    headerFields.push({
      label: 'White Data Image / Binary Stream',
      offset: '0x00000000',
      length: Math.min(16, bytes.length),
      value: `White Data Container (${bytesToHexPreview(bytes, 8)})`,
      description: 'FFXIII raw white_data binary / texture / database container',
    });

    let blockIdx = 0;
    const sectorCount = Math.floor(bytes.length / 2048);

    for (let s = 0; s < Math.min(sectorCount, 2000); s++) {
      const off = s * 2048;
      if (off + 4 < bytes.length) {
        const b0 = bytes[off];
        const b1 = bytes[off + 1];
        if (b0 === 0x78 && (b1 === 0x9c || b1 === 0xda) && ((b0 << 8) | b1) % 31 === 0) {
          try {
            const dec = unzlibSync(bytes.subarray(off, Math.min(bytes.length, off + 262144)));
            if (dec && dec.length >= 32) {
              const cat = classifyEntry(`block_${s}`, dec);
              const ext = cat === 'texture' ? '.dds' : cat === 'audio' ? '.scd' : '.dat';
              entries.push({
                id: `ff13-sec-${blockIdx++}`,
                name: `white_sector_${s}${ext}`,
                path: `sectors/white_sector_${s}${ext}`,
                folder: 'sectors',
                offset: off,
                compressedSize: 2048,
                uncompressedSize: dec.length,
                compressionMethod: 'Zlib Compressed Sector (2048 B aligned)',
                crc32: computeCRC32(dec),
                category: cat,
                data: dec,
                metadata: { sector: s, sectorOffset: `0x${off.toString(16).toUpperCase()}` },
              });
            }
          } catch {

          }
        }
      }
    }

    if (entries.length === 0) {
      entries.push({
        id: 'ff13-raw-stream',
        name: fileName,
        path: fileName,
        folder: '(root)',
        offset: 0,
        compressedSize: bytes.length,
        uncompressedSize: bytes.length,
        compressionMethod: 'White Data Binary Blob',
        crc32: computeCRC32(bytes),
        category: 'binary',
        data: bytes,
      });
    }
  }

  return {
    fileName,
    fileSize: bytes.length,
    formatId: 'FF13',
    formatName: `Final Fantasy XIII White Data (${isValidFilelist ? 'Filelist' : 'Archive'})`,
    engineFamily: 'Square Enix Crystal Tools (FFXIII / FFXIII-2 / LR)',
    magicBytes: bytesToHexPreview(bytes.subarray(0, 8), 8),
    endianness: 'Little Endian',
    headerFields,
    entries,
    rawBytes: bytes,
    parseTimeMs: Math.max(1, Math.round(performance.now() - startTime)),
    warnings,
  };
}
