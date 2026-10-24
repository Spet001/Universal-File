import { unzlibSync, inflateSync } from 'fflate';
import { ArchiveEntry, ArchiveHeaderField, ParsedArchive } from '../types/archive';
import { computeCRC32, toHex, bytesToHexPreview, classifyEntry, readAscii, splitFolderAndName } from './archiveParser';

export const IDTECH6_RES_MAGIC = 0x52455300;
export const IDTECH6_BMODEL_MAGIC = 0x424d4c1b;

export interface BmodelMeshInfo {
  materialName: string;
  vertexCount: number;
  faceCount: number;
}

export function parseBmodelInfo(bytes: Uint8Array): { meshes: BmodelMeshInfo[]; summary: string } | null {
  if (bytes.length < 16) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (bytes[0] !== 0x1b || bytes[1] !== 0x4c || bytes[2] !== 0x4d || bytes[3] !== 0x42) {
    return null;
  }

  const meshes: BmodelMeshInfo[] = [];
  const meshCount = view.getInt32(4, true);

  let p = 8;
  for (let i = 0; i < Math.min(meshCount, 128) && p < bytes.length - 16; i++) {
    const matLen = view.getInt32(p, true);
    p += 4;
    let matName = `material_${i}`;
    if (matLen > 0 && matLen < 256 && p + matLen <= bytes.length) {
      matName = readAscii(bytes, p, matLen).replace(/\0/g, '');
      p += matLen;
    }
    const vertCount = p + 4 <= bytes.length ? view.getInt32(p, false) : 0;
    p += 4;
    const faceCount = p + 4 <= bytes.length ? view.getInt32(p, false) : 0;
    p += 4;

    meshes.push({
      materialName: matName || `material_${i}`,
      vertexCount: Math.abs(vertCount),
      faceCount: Math.abs(faceCount),
    });
  }

  return {
    meshes,
    summary: `id Tech 6 BMODEL Geometry: ${meshCount} sub-mesh(es) · ${meshes.map((m) => m.materialName).join(', ')}`,
  };
}

export function parseIdTech6Archive(fileName: string, bytes: Uint8Array, startTime: number): ParsedArchive {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const warnings: string[] = [];
  const entries: ArchiveEntry[] = [];
  const headerFields: ArchiveHeaderField[] = [];

  if (bytes.length >= 4 && bytes[0] === 0x1b && bytes[1] === 0x4c && bytes[2] === 0x4d && bytes[3] === 0x42) {
    const bmodel = parseBmodelInfo(bytes);

    headerFields.push(
      {
        label: 'id Tech 6 Model Signature',
        offset: '0x00000000',
        length: 4,
        value: '1B 4C 4D 42 ("\\x1bLMB")',
        description: 'DOOM (2016) / DOOM Eternal pre-processed binary mesh model',
      },
      {
        label: 'Sub-mesh Count',
        offset: '0x00000004',
        length: 4,
        value: `${bmodel?.meshes.length || 0} sub-meshes`,
        description: 'Indexed materials and vertex buffers',
      }
    );

    const modelReport = [
      `// id Tech 6 Binary Model (.bmodel): ${fileName}`,
      `// Engine: DOOM (2016) / id Tech 6`,
      `// Total Sub-Meshes: ${bmodel?.meshes.length || 0}`,
      '',
      '=== SUB-MESH & MATERIAL MAPPINGS ===',
      ...(bmodel?.meshes.map(
        (m, idx) =>
          `[Mesh #${idx}] Material: ${m.materialName} | Vertices: ${m.vertexCount.toLocaleString()} | Faces: ${m.faceCount.toLocaleString()}`
      ) || []),
    ].join('\n');

    const enc = new TextEncoder();
    const repBytes = enc.encode(modelReport);

    entries.push({
      id: 'bmodel-decl',
      name: `${fileName.replace(/\.bmodel$/i, '')}_decl.txt`,
      path: `geometry/${fileName.replace(/\.bmodel$/i, '')}_decl.txt`,
      folder: 'geometry',
      offset: 0,
      compressedSize: repBytes.length,
      uncompressedSize: repBytes.length,
      compressionMethod: 'Decoded BModel Structure',
      crc32: computeCRC32(repBytes),
      category: 'config',
      data: repBytes,
    });

    entries.push({
      id: 'bmodel-raw',
      name: fileName,
      path: fileName,
      folder: '(root)',
      offset: 0,
      compressedSize: bytes.length,
      uncompressedSize: bytes.length,
      compressionMethod: 'id Tech 6 BModel Blob',
      crc32: computeCRC32(bytes),
      category: 'model',
      data: bytes,
    });

    return {
      fileName,
      fileSize: bytes.length,
      formatId: 'IDTECH',
      formatName: 'id Tech 6 Binary Model (.bmodel)',
      engineFamily: 'id Software id Tech 6 (DOOM 2016)',
      magicBytes: bytesToHexPreview(bytes.subarray(0, 8), 8),
      endianness: 'Big Endian',
      headerFields,
      entries,
      rawBytes: bytes,
      parseTimeMs: Math.max(1, Math.round(performance.now() - startTime)),
      warnings,
    };
  }

  const isResHeader =
    (bytes[1] === 0x53 && bytes[2] === 0x45 && bytes[3] === 0x52) ||
    (bytes[0] === 0x52 && bytes[1] === 0x45 && bytes[2] === 0x53);

  let headerVersion = bytes[0];
  if (bytes[0] === 0x52 && bytes[1] === 0x45 && bytes[2] === 0x53) {
    headerVersion = 4;
  }

  let indexSize = 0;
  let numEntries = 0;
  let pos = 4;

  if (isResHeader && bytes.length >= 12) {
    indexSize = view.getInt32(4, true);
    numEntries = view.getInt32(8, true);
    pos = 12;
  }

  headerFields.push(
    {
      label: 'id Tech 6 Container Magic',
      offset: '0x00000000',
      length: 4,
      value: `${bytesToHexPreview(bytes, 4)} ("${readAscii(bytes, 0, 4)}")`,
      description: 'DOOM 2016 .resource / .index header',
    },
    {
      label: 'Format Version',
      offset: '0x00000000',
      length: 1,
      value: `Version ${headerVersion}`,
      description: 'DOOM 2016 resource index revision',
    },
    {
      label: 'Index Table Entries',
      offset: '0x00000008',
      length: 4,
      value: `${numEntries.toLocaleString()} entries`,
      description: 'Virtual assets in DOOM 2016 package',
    }
  );

  if (numEntries > 0 && numEntries < 100000 && pos < bytes.length) {
    let entryIdx = 0;
    for (let i = 0; i < numEntries && pos < bytes.length - 24; i++) {
      try {
        const id = view.getInt32(pos, false);
        pos += 4;

        const typeLen = view.getInt32(pos, true);
        pos += 4;
        let fileType = '';
        if (typeLen > 0 && typeLen < 128 && pos + typeLen <= bytes.length) {
          fileType = readAscii(bytes, pos, typeLen);
          pos += typeLen;
        }

        const name2Len = view.getInt32(pos, true);
        pos += 4;
        let fileName2 = '';
        if (name2Len > 0 && name2Len < 256 && pos + name2Len <= bytes.length) {
          fileName2 = readAscii(bytes, pos, name2Len);
          pos += name2Len;
        }

        const name3Len = view.getInt32(pos, true);
        pos += 4;
        let fileName3 = '';
        if (name3Len > 0 && name3Len < 512 && pos + name3Len <= bytes.length) {
          fileName3 = readAscii(bytes, pos, name3Len);
          pos += name3Len;
        }

        if (pos + 16 > bytes.length) break;

        const offset = Number(view.getBigInt64(pos, false));
        pos += 8;
        const size = view.getInt32(pos, false);
        pos += 4;
        const compressedSize = view.getInt32(pos, false);
        pos += 4;

        const zeroLen = headerVersion <= 4 ? 8 : 4;
        pos += zeroLen;

        const patchFileNumber = pos < bytes.length ? bytes[pos] : 0;
        pos += 1;

        const rawPath = (fileName3 || fileName2 || fileType || `res_file_${id}`).replace(/\\/g, '/');
        const { folder, name, cleanPath } = splitFolderAndName(rawPath);

        let fileData = new Uint8Array(0);
        let methodStr = size === compressedSize ? 'Stored' : 'Zlib Compressed';

        if (offset >= 0 && offset + compressedSize <= bytes.length && compressedSize > 0) {
          const slice = bytes.slice(offset, offset + compressedSize);
          if (size !== compressedSize) {
            try {
              fileData = unzlibSync(slice);
              methodStr = 'Zlib (Decompressed)';
            } catch {
              try {
                fileData = inflateSync(slice);
                methodStr = 'Raw Deflate (Decompressed)';
              } catch {
                fileData = slice;
              }
            }
          } else {
            fileData = slice;
          }
        }

        entries.push({
          id: `id6-${entryIdx++}`,
          name,
          path: cleanPath,
          folder,
          offset,
          compressedSize,
          uncompressedSize: size,
          compressionMethod: methodStr,
          crc32: computeCRC32(fileData),
          category: classifyEntry(cleanPath, fileData),
          data: fileData,
          metadata: {
            id,
            fileType,
            patchNumber: patchFileNumber,
            isCompressed: size !== compressedSize,
          },
        });
      } catch (err) {
        warnings.push(`DOOM resource entry #${i} reading error: ${err instanceof Error ? err.message : String(err)}`);
        break;
      }
    }
  }

  if (entries.length === 0) {
    let carvedIdx = 0;
    for (let i = 0; i < bytes.length - 8; i++) {
      if (bytes[i] === 0x1b && bytes[i + 1] === 0x4c && bytes[i + 2] === 0x4d && bytes[i + 3] === 0x42) {
        const slice = bytes.slice(i, Math.min(bytes.length, i + 65536));
        entries.push({
          id: `id6-carved-bmodel-${carvedIdx++}`,
          name: `mesh_${toHex(i, 6)}.bmodel`,
          path: `models/mesh_${toHex(i, 6)}.bmodel`,
          folder: 'models',
          offset: i,
          compressedSize: slice.length,
          uncompressedSize: slice.length,
          compressionMethod: 'id Tech 6 BModel',
          crc32: computeCRC32(slice),
          category: 'model',
          data: slice,
        });
        i += 4096;
      }
    }

    if (entries.length === 0) {
      entries.push({
        id: 'id6-raw',
        name: fileName,
        path: fileName,
        folder: '(root)',
        offset: 0,
        compressedSize: bytes.length,
        uncompressedSize: bytes.length,
        compressionMethod: 'id Tech 6 Container Stream',
        crc32: computeCRC32(bytes),
        category: 'binary',
        data: bytes,
      });
    }
  }

  return {
    fileName,
    fileSize: bytes.length,
    formatId: 'IDTECH',
    formatName: `id Tech 6 Resource Container (${numEntries > 0 ? `${numEntries} files` : 'DOOM 2016'})`,
    engineFamily: 'id Software id Tech 6 (DOOM 2016 / DOOM Eternal)',
    magicBytes: bytesToHexPreview(bytes.subarray(0, 8), 8),
    endianness: 'Big Endian',
    headerFields,
    entries,
    rawBytes: bytes,
    parseTimeMs: Math.max(1, Math.round(performance.now() - startTime)),
    warnings,
  };
}
