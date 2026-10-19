import { inflateSync, unzlibSync } from 'fflate';
import { ArchiveEntry, ArchiveHeaderField, ParsedArchive } from '../types/archive';
import { computeCRC32, toHex, bytesToHexPreview, classifyEntry, readAscii, splitFolderAndName } from './archiveParser';

export const UNREAL_PAK_MAGIC = 0x5a6f12e1; // 0xE1, 0x12, 0x6F, 0x5A
export const UNREAL_PACKAGE_MAGIC = 0x9e2a83c1; // 0xC1, 0x83, 0x2A, 0x9E (.uasset / .umap)

export interface UnrealPakFooter {
  magic: number;
  version: number;
  indexOffset: number;
  indexSize: number;
  indexHash: Uint8Array;
  isEncrypted: boolean;
  compressionMethods: string[];
}

export function findUnrealPakFooter(bytes: Uint8Array): UnrealPakFooter | null {
  const n = bytes.length;
  if (n < 44) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Check known footer offsets: n - 44 (UE4.0-4.2), n - 204 (UE4.3-4.21), or scan backwards up to 512 bytes
  const offsetsToCheck: number[] = [n - 44, n - 204, n - 221, n - 128, n - 64];
  for (let i = n - 4; i >= Math.max(0, n - 512); i--) {
    if (view.getUint32(i, true) === UNREAL_PAK_MAGIC) {
      offsetsToCheck.unshift(i);
      break;
    }
  }

  for (const magicPos of offsetsToCheck) {
    if (magicPos >= 0 && magicPos + 4 <= n) {
      if (view.getUint32(magicPos, true) === UNREAL_PAK_MAGIC) {
        // In UE PAK, magic is at the END of the footer struct or followed by encryption flag
        // Standard footer:
        // offset: magicPos - 44 to magicPos + 4
        // Let's inspect around magicPos
        let version = 8;
        let indexOffset = 0;
        let indexSize = 0;

        // Pattern A: Magic at magicPos
        // Before magic: indexOffset (int64), indexSize (int64), version (int32)
        if (magicPos >= 20) {
          version = view.getInt32(magicPos - 20, true);
          indexOffset = Number(view.getBigInt64(magicPos - 16, true));
          indexSize = Number(view.getBigInt64(magicPos - 8, true));
        }

        // Pattern B: Magic at start of footer (magic + version + indexOffset + indexSize)
        if (indexOffset <= 0 || indexOffset >= n || indexSize <= 0) {
          if (magicPos + 24 <= n) {
            version = view.getInt32(magicPos + 4, true);
            indexOffset = Number(view.getBigInt64(magicPos + 8, true));
            indexSize = Number(view.getBigInt64(magicPos + 16, true));
          }
        }

        if (indexOffset >= 0 && indexOffset < n && indexSize > 0 && indexSize < n) {
          return {
            magic: UNREAL_PAK_MAGIC,
            version: Math.abs(version) < 20 ? version : 8,
            indexOffset,
            indexSize,
            indexHash: bytes.subarray(Math.max(0, magicPos - 20), magicPos),
            isEncrypted: false,
            compressionMethods: ['Zlib', 'Gzip', 'Oodle', 'LZ4'],
          };
        }
      }
    }
  }

  return null;
}

/**
 * Parse Unreal Engine 4/5 .pak Archive or .uasset/.umap Package
 */
export function parseUnrealArchive(fileName: string, bytes: Uint8Array, startTime: number): ParsedArchive {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const isUAsset = bytes.length >= 4 && view.getUint32(0, true) === UNREAL_PACKAGE_MAGIC;

  const warnings: string[] = [];
  const entries: ArchiveEntry[] = [];
  const headerFields: ArchiveHeaderField[] = [];

  if (isUAsset) {
    // Unreal Engine Asset Package (.uasset / .umap)
    const legacyVer = view.getInt32(4, true);
    const ue3Ver = view.getInt32(8, true);
    const fileVer = view.getInt32(12, true);
    const licenseeVer = view.getInt32(16, true);

    const totalHeaderSize = view.getInt32(24, true);
    const folderNameLen = view.getInt32(28, true);
    let pos = 32;
    let folderName = 'None';
    if (folderNameLen > 0 && folderNameLen < 128 && pos + folderNameLen <= bytes.length) {
      folderName = readAscii(bytes, pos, folderNameLen).replace(/\0/g, '');
      pos += folderNameLen;
    }

    const packageFlags = view.getUint32(pos, true);
    pos += 4;
    const nameCount = view.getInt32(pos, true);
    const nameOffset = view.getInt32(pos + 4, true);
    pos += 8;
    const exportCount = view.getInt32(pos, true);
    const exportOffset = view.getInt32(pos + 4, true);
    pos += 8;
    const importCount = view.getInt32(pos, true);
    const importOffset = view.getInt32(pos + 4, true);

    // Read Name Table strings
    const nameStrings: string[] = [];
    if (nameOffset > 0 && nameOffset < bytes.length && nameCount > 0 && nameCount < 10000) {
      let np = nameOffset;
      for (let i = 0; i < nameCount && np < bytes.length; i++) {
        const len = view.getInt32(np, true);
        np += 4;
        if (len > 0 && len < 256 && np + len <= bytes.length) {
          const str = readAscii(bytes, np, len).replace(/\0/g, '');
          nameStrings.push(str);
          np += len + 4; // length + string + non-case hash
        } else {
          break;
        }
      }
    }

    headerFields.push(
      {
        label: 'Unreal Package Header Signature',
        offset: '0x00000000',
        length: 4,
        value: '0x9E2A83C1 (UE Asset Package)',
        description: 'Standard Unreal Engine 4 / 5 package format',
      },
      {
        label: 'Engine Package File Version',
        offset: '0x0000000C',
        length: 4,
        value: `Version ${fileVer} (Licensee ${licenseeVer})`,
        description: 'Unreal Engine serialization build',
      },
      {
        label: 'Name Table Entries',
        offset: `0x${nameOffset.toString(16).toUpperCase()}`,
        length: 4,
        value: `${nameCount} names (${nameStrings.length} decoded)`,
        description: 'Internal engine symbols, properties, and material parameters',
      },
      {
        label: 'Export / Import Counts',
        offset: 'Summary',
        length: 8,
        value: `${exportCount} exports · ${importCount} imports`,
        description: 'Package object hierarchies and external module dependencies',
      }
    );

    // Format decoded Name Table as an inspector text file
    if (nameStrings.length > 0) {
      const nameTableContent = [
        `// Unreal Engine Asset Package: ${fileName}`,
        `// Engine File Version: ${fileVer} (Licensee: ${licenseeVer})`,
        `// Total Names: ${nameCount}`,
        `// Package Flags: 0x${packageFlags.toString(16).toUpperCase()}`,
        '',
        '=== NAME TABLE ENTRIES ===',
        ...nameStrings.map((s, idx) => `[${idx.toString().padStart(4, '0')}] ${s}`),
      ].join('\n');

      const enc = new TextEncoder();
      const nameData = enc.encode(nameTableContent);
      entries.push({
        id: 'ue-names-table',
        name: `${fileName.replace(/\.(uasset|umap)$/i, '')}_names.txt`,
        path: `package_meta/${fileName.replace(/\.(uasset|umap)$/i, '')}_names.txt`,
        folder: 'package_meta',
        offset: nameOffset,
        compressedSize: nameData.length,
        uncompressedSize: nameData.length,
        compressionMethod: 'Decoded Name Table',
        crc32: computeCRC32(nameData),
        category: 'config',
        data: nameData,
      });
    }

    // Include raw package payload
    entries.push({
      id: 'ue-asset-raw',
      name: fileName,
      path: fileName,
      folder: '(root)',
      offset: 0,
      compressedSize: bytes.length,
      uncompressedSize: bytes.length,
      compressionMethod: 'Unreal Package Blob',
      crc32: computeCRC32(bytes),
      category: fileName.endsWith('.umap') ? 'map' : 'binary',
      data: bytes,
    });

    return {
      fileName,
      fileSize: bytes.length,
      formatId: 'UNREAL',
      formatName: `Unreal Engine ${fileName.endsWith('.umap') ? 'Level (.umap)' : 'Asset (.uasset)'}`,
      engineFamily: `Unreal Engine 4 / 5 (Version ${fileVer})`,
      magicBytes: bytesToHexPreview(bytes.subarray(0, 8), 8),
      endianness: 'Little Endian',
      headerFields,
      entries,
      rawBytes: bytes,
      parseTimeMs: Math.max(1, Math.round(performance.now() - startTime)),
      warnings,
      extraInfo: { fileVer, nameCount, exportCount, importCount },
    };
  }

  // Unreal Engine .pak Archive
  const footer = findUnrealPakFooter(bytes);

  headerFields.push({
    label: 'Unreal PAK Magic Signature',
    offset: 'Footer',
    length: 4,
    value: '0x5A6F12E1 (Unreal Engine PAK)',
    description: 'UE4/UE5 footer container identifier',
  });

  if (footer) {
    headerFields.push(
      {
        label: 'PAK Format Version',
        offset: 'Footer + 4',
        length: 4,
        value: `Version ${footer.version}`,
        description: 'Unreal Engine PAK directory format version (3 to 11)',
      },
      {
        label: 'Index Table Offset',
        offset: 'Footer + 8',
        length: 8,
        value: `0x${footer.indexOffset.toString(16).toUpperCase()} (${footer.indexOffset.toLocaleString()} B)`,
        description: 'Byte position of the central virtual directory table',
      },
      {
        label: 'Index Table Size',
        offset: 'Footer + 16',
        length: 8,
        value: `${footer.indexSize.toLocaleString()} B`,
        description: 'Byte size of the index records',
      }
    );

    // Try reading index table
    try {
      const idxStart = footer.indexOffset;
      const idxEnd = Math.min(bytes.length, idxStart + footer.indexSize);
      let idxBytes = bytes.subarray(idxStart, idxEnd);

      // Check if index is Zlib compressed
      if (idxBytes[0] === 0x78 && (idxBytes[1] === 0x9c || idxBytes[1] === 0xda)) {
        try {
          idxBytes = unzlibSync(idxBytes);
        } catch {
          // Keep raw
        }
      }

      const idxView = new DataView(idxBytes.buffer, idxBytes.byteOffset, idxBytes.byteLength);
      let ip = 0;

      // Mount point string
      const mountLen = idxView.getInt32(ip, true);
      ip += 4;
      let mountPoint = '../../../';
      if (mountLen > 0 && mountLen < 256 && ip + mountLen <= idxBytes.length) {
        mountPoint = readAscii(idxBytes, ip, mountLen).replace(/\0/g, '');
        ip += mountLen;
      }

      const fileCount = idxView.getInt32(ip, true);
      ip += 4;

      if (fileCount > 0 && fileCount < 100000) {
        let entryCounter = 0;
        for (let i = 0; i < fileCount && ip < idxBytes.length - 32; i++) {
          const pathLen = idxView.getInt32(ip, true);
          ip += 4;
          if (pathLen <= 0 || pathLen > 512 || ip + pathLen > idxBytes.length) break;

          const rawPath = readAscii(idxBytes, ip, pathLen).replace(/\0/g, '');
          ip += pathLen;

          const fileOffset = Number(idxView.getBigInt64(ip, true));
          ip += 8;
          const fileSize = Number(idxView.getBigInt64(ip, true));
          ip += 8;
          const uncmpSize = Number(idxView.getBigInt64(ip, true));
          ip += 8;
          const compMethod = idxView.getUint32(ip, true);
          ip += 4;
          ip += 20; // SHA1 hash (20 bytes)

          // Extra flags / block list if version >= 3
          let isEncrypted = false;
          if (footer.version >= 3 && ip + 1 <= idxBytes.length) {
            isEncrypted = idxView.getUint8(ip) !== 0;
            ip += 1;
          }
          if (footer.version >= 7 && ip + 4 <= idxBytes.length) {
            const compBlockSize = idxView.getUint32(ip, true);
            ip += 4;
          }

          const { folder, name, cleanPath } = splitFolderAndName(rawPath);
          const safeStart = Math.max(0, Math.min(bytes.length, fileOffset));
          const safeEnd = Math.max(safeStart, Math.min(bytes.length, fileOffset + fileSize));
          let fileData = bytes.slice(safeStart, safeEnd);

          // If compressed with standard Zlib
          let methodStr = compMethod === 0 ? 'Stored' : compMethod === 1 ? 'Zlib' : 'Oodle / LZ4';
          if (compMethod === 1 && fileData.length > 0) {
            try {
              fileData = unzlibSync(fileData);
              methodStr = 'Zlib (Decompressed)';
            } catch {
              // Keep raw
            }
          }

          entries.push({
            id: `ue-pak-${entryCounter++}`,
            name,
            path: cleanPath,
            folder,
            offset: fileOffset,
            compressedSize: fileSize,
            uncompressedSize: uncmpSize || fileSize,
            compressionMethod: methodStr,
            crc32: computeCRC32(fileData),
            category: classifyEntry(cleanPath, fileData),
            data: fileData,
          });
        }
      }
    } catch (err) {
      warnings.push(`Unreal PAK index table parsing note: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Fallback: If no entries extracted from index table, carve embedded .uasset, .umap, .bik, textures
  if (entries.length === 0) {
    let carvedIdx = 0;
    for (let i = 0; i < bytes.length - 8; i++) {
      // Look for .uasset signature 0x9E2A83C1
      if (view.getUint32(i, true) === UNREAL_PACKAGE_MAGIC) {
        const slice = bytes.slice(i, Math.min(bytes.length, i + 131072));
        entries.push({
          id: `ue-carved-${carvedIdx++}`,
          name: `asset_${toHex(i, 6)}.uasset`,
          path: `carved_assets/asset_${toHex(i, 6)}.uasset`,
          folder: 'carved_assets',
          offset: i,
          compressedSize: slice.length,
          uncompressedSize: slice.length,
          compressionMethod: 'Carved Unreal Package',
          crc32: computeCRC32(slice),
          category: 'binary',
          data: slice,
        });
        i += 4096;
      }
    }

    if (entries.length === 0) {
      entries.push({
        id: 'ue-pak-raw',
        name: `${fileName}.payload`,
        path: `raw/${fileName}.payload`,
        folder: 'raw',
        offset: 0,
        compressedSize: bytes.length,
        uncompressedSize: bytes.length,
        compressionMethod: 'Unreal Engine Container Stream',
        crc32: computeCRC32(bytes),
        category: 'binary',
        data: bytes,
      });
    }
  }

  return {
    fileName,
    fileSize: bytes.length,
    formatId: 'UNREAL',
    formatName: `Unreal Engine PAK Archive (${footer ? `v${footer.version}` : 'UE4 / UE5'})`,
    engineFamily: `Epic Games Unreal Engine 4 / 5`,
    magicBytes: bytesToHexPreview(bytes.subarray(Math.max(0, bytes.length - 44)), 12),
    endianness: 'Little Endian',
    headerFields,
    entries,
    rawBytes: bytes,
    parseTimeMs: Math.max(1, Math.round(performance.now() - startTime)),
    warnings,
  };
}
