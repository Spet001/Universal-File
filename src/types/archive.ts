import type { FastFileZoneState } from '../services/t5t6FastFile';

export type ArchiveFormatId =
  | 'WAD'
  | 'PAK'
  | 'FF'
  | 'PK3'
  | 'ZIP'
  | 'RAR'
  | 'ISO'
  | 'PS1'
  | 'UNITY'
  | 'UNREAL'
  | 'FF13'
  | 'IDTECH'
  | 'BIK'
  | 'GOD'
  | 'XEX'
  | 'APPX'
  | 'NDS'
  | 'ROM'
  | 'PAR'
  | 'VPK'
  | 'BIG'
  | 'ZLIB'
  | 'RAW'
  | 'BSA'
  | 'BA2'
  | 'FORGE'
  | 'RPF'
  | 'JAR'
  | 'PKG'
  | 'CRIWARE'
  | 'FROMSOFT'
  | 'SQUARE'
  | 'RPA';

export type AssetCategory =
  | 'script'
  | 'texture'
  | 'palette'
  | 'map'
  | 'audio'
  | 'video'
  | 'model'
  | 'config'
  | 'binary'
  | 'executable'
  | 'package'
  | 'zlib_chunk';

export interface ArchiveEntry {
  id: string;
  name: string;
  path: string;
  folder: string;
  offset: number;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod: string;
  crc32: number;
  category: AssetCategory;
  data: Uint8Array;
  isModified?: boolean;
  metadata?: Record<string, string | number | boolean>;
}

export interface ArchiveHeaderField {
  label: string;
  offset: string;
  length: number;
  value: string;
  description: string;
}

export interface ParsedArchive {
  fileName: string;
  fileSize: number;
  unpackedZoneSize?: number;
  formatId: ArchiveFormatId;
  formatName: string;
  engineFamily: string;
  magicBytes: string;
  endianness: 'Little Endian' | 'Big Endian' | 'Mixed / Stream';
  headerFields: ArchiveHeaderField[];
  entries: ArchiveEntry[];
  rawBytes: Uint8Array;
  parseTimeMs: number;
  warnings: string[];
  zoneState?: FastFileZoneState | null;
  extraInfo?: Record<string, unknown>;
}

export interface FormatSpec {
  id: ArchiveFormatId;
  ext: string;
  name: string;
  engines: string;
  magicSignature: string;
  compression: string;
  canRepack: boolean;
  description: string;
}
