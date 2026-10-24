import { inflateSync, unzlibSync } from 'fflate';
import { ArchiveEntry, ArchiveHeaderField, ParsedArchive, AssetCategory } from '../types/archive';
import { computeCRC32, toHex, bytesToHexPreview, classifyEntry, readAscii } from './archiveParser';

export const UNITY_CLASS_NAMES: Record<number, { name: string; category: AssetCategory }> = {
  1: { name: 'GameObject', category: 'config' },
  4: { name: 'Transform', category: 'config' },
  21: { name: 'Material', category: 'config' },
  23: { name: 'MeshRenderer', category: 'config' },
  28: { name: 'Texture2D', category: 'texture' },
  33: { name: 'MeshFilter', category: 'model' },
  43: { name: 'Mesh', category: 'model' },
  48: { name: 'Shader', category: 'script' },
  49: { name: 'TextAsset', category: 'script' },
  82: { name: 'AudioSource', category: 'audio' },
  83: { name: 'AudioClip', category: 'audio' },
  114: { name: 'MonoBehaviour', category: 'script' },
  115: { name: 'MonoScript', category: 'script' },
  128: { name: 'Font', category: 'config' },
  142: { name: 'AssetBundle', category: 'binary' },
  152: { name: 'MovieTexture', category: 'video' },
  156: { name: 'TerrainData', category: 'map' },
  213: { name: 'Sprite', category: 'texture' },
};

export const UNITY_TARGET_PLATFORMS: Record<number, string> = {
  1: 'OSX',
  2: 'iOS',
  4: 'PS3',
  5: 'Windows Standalone (x86/x64)',
  9: 'Xbox 360',
  13: 'Android',
  16: 'Linux Standalone',
  19: 'WebGL',
  25: 'PS4',
  27: 'Xbox One',
  31: 'Nintendo Switch',
  38: 'PS5',
  42: 'Xbox Series X/S',
};

export function parseUnityArchive(fileName: string, bytes: Uint8Array, startTime: number): ParsedArchive {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic7 = readAscii(bytes, 0, 7);
  const isBundle = magic7 === 'UnityFS' || magic7 === 'UnityWe' || magic7 === 'UnityRa';

  const warnings: string[] = [];
  const entries: ArchiveEntry[] = [];
  const headerFields: ArchiveHeaderField[] = [];

  let unityVersion = 'Unknown';
  let targetPlatform = 'Unknown';
  let engineFamily = 'Unity Engine';

  if (isBundle) {

    const formatVersion = view.getUint32(8, false);
    let pos = 12;

    let endStr = pos;
    while (endStr < Math.min(bytes.length, pos + 32) && bytes[endStr] !== 0) endStr++;
    unityVersion = readAscii(bytes, pos, endStr - pos);
    pos = endStr + 1;

    let endRev = pos;
    while (endRev < Math.min(bytes.length, pos + 32) && bytes[endRev] !== 0) endRev++;
    const revision = readAscii(bytes, pos, endRev - pos);
    pos = endRev + 1;

    const totalFileSize = Number(view.getBigInt64(pos, false));
    pos += 8;
    const compressedMetadataSize = view.getUint32(pos, false);
    pos += 4;
    const uncompressedMetadataSize = view.getUint32(pos, false);
    pos += 4;
    const flags = view.getUint32(pos, false);
    pos += 4;

    const compressionType = flags & 0x3f;
    const compressionName =
      compressionType === 0 ? 'None (Uncompressed)' : compressionType === 1 ? 'LZMA' : 'LZ4 / LZ4HC';

    headerFields.push(
      {
        label: 'Unity Container Magic',
        offset: '0x00000000',
        length: 8,
        value: `${magic7} (Format Version ${formatVersion})`,
        description: 'Unity AssetBundle / UnityFS container format',
      },
      {
        label: 'Unity Engine Build',
        offset: '0x0000000C',
        length: unityVersion.length,
        value: `${unityVersion} (${revision || 'Release'})`,
        description: 'Target Unity runtime version',
      },
      {
        label: 'Bundle Compression',
        offset: 'Flags',
        length: 4,
        value: `${compressionName} (Flags: 0x${flags.toString(16).toUpperCase()})`,
        description: 'Directory and payload block compression',
      }
    );

    let entryIdx = 0;
    for (let i = pos; i < bytes.length - 8; i++) {

      if (
        (bytes[i] === 0x50 && bytes[i + 1] === 0x4e && bytes[i + 2] === 0x47) ||
        (bytes[i] === 0x44 && bytes[i + 1] === 0x44 && bytes[i + 2] === 0x53 && bytes[i + 3] === 0x20) ||
        (bytes[i] === 0x52 && bytes[i + 1] === 0x49 && bytes[i + 2] === 0x46 && bytes[i + 3] === 0x46) ||
        (bytes[i] === 0x4f && bytes[i + 1] === 0x67 && bytes[i + 2] === 0x67 && bytes[i + 3] === 0x53)
      ) {
        const slice = bytes.slice(i, Math.min(bytes.length, i + 65536));
        const cat = classifyEntry(`asset_${entryIdx}`, slice);
        const ext = cat === 'texture' ? (slice[0] === 0x44 ? '.dds' : '.png') : cat === 'audio' ? '.ogg' : '.bin';
        entries.push({
          id: `unity-bundle-${entryIdx++}`,
          name: `bundle_asset_${toHex(i, 6)}${ext}`,
          path: `assets/bundle_asset_${toHex(i, 6)}${ext}`,
          folder: 'assets',
          offset: i,
          compressedSize: slice.length,
          uncompressedSize: slice.length,
          compressionMethod: compressionName,
          crc32: computeCRC32(slice),
          category: cat,
          data: slice,
        });
        i += slice.length - 1;
      }
    }

    if (entries.length === 0) {
      entries.push({
        id: 'unity-bundle-data',
        name: `${fileName}.bundle_stream`,
        path: `raw/${fileName}.bundle_stream`,
        folder: 'raw',
        offset: pos,
        compressedSize: bytes.length - pos,
        uncompressedSize: bytes.length - pos,
        compressionMethod: compressionName,
        crc32: computeCRC32(bytes.subarray(pos)),
        category: 'binary',
        data: bytes.subarray(pos),
      });
    }

    engineFamily = `Unity Engine · ${unityVersion}`;
  } else {

    const metadataSize = view.getUint32(0, false);
    const fileSize = view.getUint32(4, false);
    const formatVersion = view.getUint32(8, false);
    const dataOffset = view.getUint32(12, false);
    const endiannessByte = bytes[16];
    const isBigEndian = endiannessByte !== 0;

    let p = 20;
    if (formatVersion >= 7 && p < bytes.length) {
      let strEnd = p;
      while (strEnd < Math.min(bytes.length, p + 32) && bytes[strEnd] >= 0x20 && bytes[strEnd] <= 0x7e) strEnd++;
      if (strEnd > p + 3 && bytes[strEnd] === 0) {
        unityVersion = readAscii(bytes, p, strEnd - p);
        p = strEnd + 1;
      }
    }

    let targetPlatformId = 0;
    if (formatVersion >= 8 && p + 4 <= bytes.length) {
      targetPlatformId = view.getInt32(p, isBigEndian);
      targetPlatform = UNITY_TARGET_PLATFORMS[targetPlatformId] || `Platform ID ${targetPlatformId}`;
      p += 4;
    }

    headerFields.push(
      {
        label: 'Unity Serialized File Version',
        offset: '0x00000008',
        length: 4,
        value: `Format Version ${formatVersion}`,
        description: 'SerializedFile layout version (versions 9 to 22 supported)',
      },
      {
        label: 'Unity Version String',
        offset: '0x00000014',
        length: unityVersion.length,
        value: unityVersion,
        description: 'Engine build that generated this asset archive',
      },
      {
        label: 'Target Platform',
        offset: `0x${p.toString(16).toUpperCase()}`,
        length: 4,
        value: targetPlatform,
        description: 'Compilation target architecture / console',
      },
      {
        label: 'Data Stream Offset',
        offset: '0x0000000C',
        length: 4,
        value: `0x${dataOffset.toString(16).toUpperCase()} (${dataOffset.toLocaleString()} B)`,
        description: 'Starting byte offset of binary object blobs',
      }
    );

    let objectCount = 0;
    const baseDataPos = Math.max(20, Math.min(bytes.length, dataOffset || 4096));

    let entryIdx = 0;
    for (let i = baseDataPos; i < bytes.length - 16; i++) {

      const potentialLen = view.getInt32(i, false);
      if (potentialLen > 10 && potentialLen < 262144 && i + 4 + potentialLen <= bytes.length) {
        let isText = true;
        for (let c = 0; c < Math.min(potentialLen, 64); c++) {
          const ch = bytes[i + 4 + c];
          if ((ch < 32 || ch > 126) && ch !== 9 && ch !== 10 && ch !== 13) {
            isText = false;
            break;
          }
        }
        if (isText) {
          const textData = bytes.slice(i + 4, i + 4 + potentialLen);
          const firstLine = readAscii(textData, 0, Math.min(40, textData.length)).trim();
          let ext = '.txt';
          if (firstLine.includes('Shader') || firstLine.includes('SubShader')) ext = '.shader';
          else if (firstLine.startsWith('{') || firstLine.startsWith('[')) ext = '.json';
          else if (firstLine.startsWith('<')) ext = '.xml';
          else if (firstLine.includes('using UnityEngine;')) ext = '.cs';

          entries.push({
            id: `unity-asset-${entryIdx++}`,
            name: `text_asset_${toHex(i, 6)}${ext}`,
            path: `text_assets/text_asset_${toHex(i, 6)}${ext}`,
            folder: 'text_assets',
            offset: i + 4,
            compressedSize: potentialLen,
            uncompressedSize: potentialLen,
            compressionMethod: 'Unity Serialized TextAsset',
            crc32: computeCRC32(textData),
            category: ext === '.shader' || ext === '.cs' ? 'script' : 'config',
            data: textData,
          });
          i += 4 + potentialLen;
          continue;
        }
      }

      if (bytes[i] === 0x44 && bytes[i + 1] === 0x44 && bytes[i + 2] === 0x53 && bytes[i + 3] === 0x20) {
        const texView = new DataView(bytes.buffer, bytes.byteOffset + i, 32);
        const h = texView.getUint32(12, true);
        const w = texView.getUint32(16, true);
        if (w > 0 && w <= 4096 && h > 0 && h <= 4096) {
          const len = Math.min(bytes.length - i, 128 + w * h);
          const texData = bytes.slice(i, i + len);
          entries.push({
            id: `unity-tex-${entryIdx++}`,
            name: `texture_${w}x${h}_${toHex(i, 6)}.dds`,
            path: `textures/texture_${w}x${h}_${toHex(i, 6)}.dds`,
            folder: 'textures',
            offset: i,
            compressedSize: len,
            uncompressedSize: len,
            compressionMethod: 'Unity Texture2D (DDS)',
            crc32: computeCRC32(texData),
            category: 'texture',
            data: texData,
          });
          i += len - 1;
          continue;
        }
      }
    }

    if (entries.length === 0) {
      entries.push({
        id: 'unity-raw-data',
        name: `${fileName}.serialized_data`,
        path: `raw/${fileName}.serialized_data`,
        folder: 'raw',
        offset: baseDataPos,
        compressedSize: bytes.length - baseDataPos,
        uncompressedSize: bytes.length - baseDataPos,
        compressionMethod: 'Serialized Object Table',
        crc32: computeCRC32(bytes.subarray(baseDataPos)),
        category: 'binary',
        data: bytes.subarray(baseDataPos),
      });
    }

    engineFamily = `Unity Engine · ${unityVersion} (${targetPlatform})`;
  }

  return {
    fileName,
    fileSize: bytes.length,
    formatId: 'UNITY',
    formatName: isBundle ? `Unity AssetBundle (${unityVersion})` : `Unity Serialized File (${unityVersion})`,
    engineFamily,
    magicBytes: bytesToHexPreview(bytes.subarray(0, 8), 8),
    endianness: isBundle ? 'Big Endian' : 'Little Endian',
    headerFields,
    entries,
    rawBytes: bytes,
    parseTimeMs: Math.max(1, Math.round(performance.now() - startTime)),
    warnings,
    extraInfo: { unityVersion, targetPlatform, isBundle },
  };
}
