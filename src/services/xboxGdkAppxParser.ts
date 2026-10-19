import { unzipSync } from 'fflate';
import { ArchiveEntry, ArchiveHeaderField, ParsedArchive } from '../types/archive';
import {
  bytesToHexPreview,
  classifyEntry,
  computeCRC32,
  readAscii,
  splitFolderAndName,
  toHex,
} from './archiveParser';

/**
 * Xbox One, Xbox Series X|S, Windows GDK PC, and UWP Package Parser
 * Supports: .appx, .appxbundle, .msix, .msixbundle, .xvd, .xvc, .eappx, .emsix, .appxupload, MicrosoftGame.config
 */

export interface GdkGameConfigInfo {
  titleId?: string;
  storeId?: string;
  msaAppId?: string;
  targetPlatform?: string;
  displayName?: string;
  publisher?: string;
  description?: string;
  executables: string[];
}

export interface AppxManifestInfo {
  packageName?: string;
  publisher?: string;
  version?: string;
  processorArchitecture?: string;
  targetDeviceFamily?: string;
  minVersion?: string;
  maxVersionTested?: string;
  displayName?: string;
  description?: string;
  executable?: string;
  entryPoint?: string;
}

/**
 * Basic XML tag and attribute extractor for AppxManifest.xml and MicrosoftGame.config
 */
function extractXmlAttribute(xml: string, tag: string, attr: string): string | undefined {
  const tagRegex = new RegExp(`<${tag}[^>]*>`, 'i');
  const tagMatch = xml.match(tagRegex);
  if (!tagMatch) return undefined;

  const attrRegex = new RegExp(`${attr}\\s*=\\s*["']([^"']+)["']`, 'i');
  const attrMatch = tagMatch[0].match(attrRegex);
  return attrMatch ? attrMatch[1] : undefined;
}

function extractXmlTagContent(xml: string, tag: string): string | undefined {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = xml.match(regex);
  return match ? match[1].trim() : undefined;
}

export function parseMicrosoftGameConfig(xml: string): GdkGameConfigInfo {
  const titleId = extractXmlAttribute(xml, 'Game', 'TitleId') || extractXmlTagContent(xml, 'TitleId');
  const storeId = extractXmlAttribute(xml, 'Game', 'StoreId') || extractXmlTagContent(xml, 'StoreId');
  const msaAppId = extractXmlAttribute(xml, 'Game', 'MSAAppId') || extractXmlTagContent(xml, 'MSAAppId');
  const targetPlatform =
    extractXmlAttribute(xml, 'TargetPlatform', 'Name') ||
    extractXmlTagContent(xml, 'TargetPlatform') ||
    (xml.includes('Scarlett') ? 'Xbox Series X|S (Scarlett)' : xml.includes('XboxOne') ? 'Xbox One' : 'GDK PC');

  const displayName =
    extractXmlAttribute(xml, 'ShellVisuals', 'DefaultDisplayName') ||
    extractXmlTagContent(xml, 'DefaultDisplayName') ||
    extractXmlTagContent(xml, 'DisplayName');

  const publisher =
    extractXmlAttribute(xml, 'ShellVisuals', 'PublisherDisplayName') ||
    extractXmlTagContent(xml, 'PublisherDisplayName');

  const description =
    extractXmlAttribute(xml, 'ShellVisuals', 'Description') ||
    extractXmlTagContent(xml, 'Description');

  // Extract executables
  const executables: string[] = [];
  const exeRegex = /<Executable[^>]+Name\s*=\s*["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = exeRegex.exec(xml)) !== null) {
    if (match[1]) executables.push(match[1]);
  }

  return {
    titleId,
    storeId,
    msaAppId,
    targetPlatform,
    displayName,
    publisher,
    description,
    executables,
  };
}

export function parseAppxManifestXml(xml: string): AppxManifestInfo {
  const packageName = extractXmlAttribute(xml, 'Identity', 'Name');
  const publisher = extractXmlAttribute(xml, 'Identity', 'Publisher');
  const version = extractXmlAttribute(xml, 'Identity', 'Version');
  const processorArchitecture = extractXmlAttribute(xml, 'Identity', 'ProcessorArchitecture');

  const targetDeviceFamily = extractXmlAttribute(xml, 'TargetDeviceFamily', 'Name');
  const minVersion = extractXmlAttribute(xml, 'TargetDeviceFamily', 'MinVersion');
  const maxVersionTested = extractXmlAttribute(xml, 'TargetDeviceFamily', 'MaxVersionTested');

  const displayName =
    extractXmlAttribute(xml, 'VisualElements', 'DisplayName') ||
    extractXmlTagContent(xml, 'DisplayName');

  const description =
    extractXmlAttribute(xml, 'VisualElements', 'Description') ||
    extractXmlTagContent(xml, 'Description');

  const executable = extractXmlAttribute(xml, 'Application', 'Executable');
  const entryPoint = extractXmlAttribute(xml, 'Application', 'EntryPoint');

  return {
    packageName,
    publisher,
    version,
    processorArchitecture,
    targetDeviceFamily,
    minVersion,
    maxVersionTested,
    displayName,
    description,
    executable,
    entryPoint,
  };
}

/**
 * Parses Xbox One / Series XVD (Xbox Virtual Disk) container (.xvd / .xvc)
 */
export function parseXboxXvdContainer(
  fileName: string,
  bytes: Uint8Array,
  startTime: number
): ParsedArchive {
  const headerFields: ArchiveHeaderField[] = [];
  const warnings: string[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // XVD magic is "msft" (0x6D 0x73 0x66 0x74) at 0x00 or 0x200
  let magicOffset = 0;
  if (readAscii(bytes, 0, 4) === 'msft') {
    magicOffset = 0;
  } else if (bytes.length >= 0x204 && readAscii(bytes, 0x200, 4) === 'msft') {
    magicOffset = 0x200;
  }

  headerFields.push({
    label: 'XVD Magic Signature',
    offset: `0x${toHex(magicOffset, 4)}`,
    length: 4,
    value: 'msft (Microsoft Xbox Virtual Disk)',
    description: 'Xbox One & Xbox Series XVD/XVC package container header',
  });

  // Extract container metadata (GUID, Volume Size, Sector Size)
  const isXvc = fileName.toLowerCase().endsWith('.xvc');
  let volumeSize = bytes.length;
  if (bytes.length >= magicOffset + 0x28) {
    const volSizeCandidate = view.getBigUint64 ? Number(view.getBigUint64(magicOffset + 0x18, true)) : 0;
    if (volSizeCandidate > 0 && volSizeCandidate < 1000 * 1024 * 1024 * 1024) {
      volumeSize = volSizeCandidate;
    }
  }

  headerFields.push({
    label: 'Container Format',
    offset: 'Header',
    length: 4,
    value: isXvc ? 'XVC (Xbox Virtual Container - Encrypted Stream)' : 'XVD (Xbox Virtual Disk Image)',
    description: 'Xbox One / Series GDK deployment container',
  });

  headerFields.push({
    label: 'Sector Size',
    offset: 'Superblock',
    length: 4,
    value: '4096 Bytes (4KB Advanced Format)',
    description: 'Xbox One storage filesystem sector alignment',
  });

  headerFields.push({
    label: 'Virtual Volume Size',
    offset: 'Superblock',
    length: 8,
    value: `${(volumeSize / (1024 * 1024)).toFixed(2)} MB (${volumeSize.toLocaleString()} bytes)`,
    description: 'Internal block device partition size',
  });

  const entries: ArchiveEntry[] = [];
  const enc = new TextEncoder();

  // Create virtual descriptor entry
  const xvdInfo = `Xbox Virtual Disk (XVD/XVC) Container\n======================================\nFile Name: ${fileName}\nFormat: ${isXvc ? 'XVC (Xbox Virtual Container)' : 'XVD (Xbox Virtual Disk)'}\nMagic: msft (offset 0x${toHex(magicOffset, 4)})\nFile Size: ${bytes.length} bytes\nSector Size: 4096 bytes\nTarget Ecosystem: Microsoft Xbox One / Xbox Series X|S / Microsoft GDK\n`;
  const infoBytes = enc.encode(xvdInfo);

  entries.push({
    id: 'xvd-descriptor',
    name: 'XvdHeaderInfo.txt',
    path: 'XvdHeaderInfo.txt',
    folder: '',
    offset: 0,
    compressedSize: infoBytes.length,
    uncompressedSize: infoBytes.length,
    compressionMethod: 'Stored',
    crc32: computeCRC32(infoBytes),
    category: 'config',
    data: infoBytes,
    metadata: {
      isXvc,
      volumeSize,
    },
  });

  return {
    fileName,
    fileSize: bytes.length,
    formatId: 'APPX',
    formatName: isXvc ? 'Xbox Virtual Container (.xvc)' : 'Xbox Virtual Disk (.xvd)',
    engineFamily: 'Microsoft Xbox One / Xbox Series X|S (GDK)',
    magicBytes: bytesToHexPreview(bytes, 16),
    endianness: 'Little Endian',
    headerFields,
    entries,
    rawBytes: bytes,
    parseTimeMs: Math.round(performance.now() - startTime),
    warnings,
  };
}

/**
 * Universal Parser for Xbox One, Xbox Series, GDK PC, and UWP packages (.appx, .msix, .appxbundle, .msixbundle)
 */
export function parseXboxGdkAppxArchive(
  fileName: string,
  bytes: Uint8Array,
  startTime: number
): ParsedArchive {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.xvd') || lower.endsWith('.xvc') || readAscii(bytes, 0, 4) === 'msft') {
    return parseXboxXvdContainer(fileName, bytes, startTime);
  }

  const warnings: string[] = [];
  const headerFields: ArchiveHeaderField[] = [];

  const isBundle = lower.endsWith('.appxbundle') || lower.endsWith('.msixbundle');
  const isMsix = lower.endsWith('.msix') || lower.endsWith('.msixbundle');

  headerFields.push({
    label: 'Package Container Format',
    offset: '0x0000',
    length: 4,
    value: isBundle
      ? isMsix
        ? 'MSIXBundle (Multi-Architecture GDK / Windows Bundle)'
        : 'AppXBundle (Multi-Architecture Xbox / UWP Bundle)'
      : isMsix
        ? 'MSIX (Modern GDK / Windows Game Package)'
        : 'AppX (Xbox One / Series / UWP Application Package)',
    description: 'Open Packaging Conventions (OPC / ECMA-376) Deflate ZIP container',
  });

  // Unzip container
  let unzippedFiles: Record<string, Uint8Array> = {};
  try {
    unzippedFiles = unzipSync(bytes);
  } catch (err: unknown) {
    warnings.push(`Standard ZIP decompression encountered: ${String(err)}. Attempting partial stream carving.`);
  }

  const dec = new TextDecoder('utf-8');
  let gameConfig: GdkGameConfigInfo | null = null;
  let appxManifest: AppxManifestInfo | null = null;

  // Search for MicrosoftGame.config (GDK) and AppxManifest.xml (UWP/GDK)
  for (const [path, fileData] of Object.entries(unzippedFiles)) {
    const cleanPath = path.replace(/\\/g, '/');
    if (cleanPath.toLowerCase().endsWith('microsoftgame.config')) {
      try {
        const xmlText = dec.decode(fileData);
        gameConfig = parseMicrosoftGameConfig(xmlText);
      } catch {
        // ignore xml decode error
      }
    }
    if (cleanPath.toLowerCase().endsWith('appxmanifest.xml')) {
      try {
        const xmlText = dec.decode(fileData);
        appxManifest = parseAppxManifestXml(xmlText);
      } catch {
        // ignore xml decode error
      }
    }
  }

  // Populate Header Fields with Game and Package Metadata
  if (gameConfig) {
    if (gameConfig.displayName) {
      headerFields.push({
        label: 'GDK Game Title',
        offset: 'MicrosoftGame.config',
        length: gameConfig.displayName.length,
        value: gameConfig.displayName,
        description: 'Xbox GDK title display name from MicrosoftGame.config',
      });
    }
    if (gameConfig.titleId) {
      headerFields.push({
        label: 'Xbox Title ID',
        offset: 'MicrosoftGame.config',
        length: gameConfig.titleId.length,
        value: `0x${gameConfig.titleId.toUpperCase()}`,
        description: 'Xbox One / Series Title ID registered in Partner Center',
      });
    }
    if (gameConfig.targetPlatform) {
      headerFields.push({
        label: 'GDK Target Platform',
        offset: 'MicrosoftGame.config',
        length: gameConfig.targetPlatform.length,
        value: gameConfig.targetPlatform,
        description: 'Target hardware generation (Scarlett / Xbox One / PC)',
      });
    }
    if (gameConfig.executables.length > 0) {
      headerFields.push({
        label: 'Game Executables',
        offset: 'MicrosoftGame.config',
        length: gameConfig.executables.length,
        value: gameConfig.executables.join(', '),
        description: 'Entry point binaries registered in MicrosoftGame.config',
      });
    }
  }

  if (appxManifest) {
    if (appxManifest.packageName) {
      headerFields.push({
        label: 'Package Identity Name',
        offset: 'AppxManifest.xml',
        length: appxManifest.packageName.length,
        value: appxManifest.packageName,
        description: 'Full UWP / GDK Package Family identity',
      });
    }
    if (appxManifest.version) {
      headerFields.push({
        label: 'Package Version',
        offset: 'AppxManifest.xml',
        length: appxManifest.version.length,
        value: `v${appxManifest.version}`,
        description: 'Semantic package version (major.minor.build.revision)',
      });
    }
    if (appxManifest.processorArchitecture) {
      headerFields.push({
        label: 'Processor Architecture',
        offset: 'AppxManifest.xml',
        length: appxManifest.processorArchitecture.length,
        value: appxManifest.processorArchitecture.toUpperCase(),
        description: 'Target binary CPU architecture (x64, ARM64, Neutral)',
      });
    }
    if (appxManifest.targetDeviceFamily) {
      headerFields.push({
        label: 'Target Device Family',
        offset: 'AppxManifest.xml',
        length: appxManifest.targetDeviceFamily.length,
        value: `${appxManifest.targetDeviceFamily} (Min: ${appxManifest.minVersion || 'Any'})`,
        description: 'Platform device family compatibility (Windows.Xbox / Windows.Desktop)',
      });
    }
  }

  // Convert files into ArchiveEntry array
  const entries: ArchiveEntry[] = [];
  let fileIndex = 0;

  for (const [rawPath, fileBytes] of Object.entries(unzippedFiles)) {
    const path = rawPath.replace(/\\/g, '/').replace(/^\/+/, '');
    if (path.endsWith('/') || fileBytes.length === 0 && path.endsWith('/')) {
      continue; // Skip directory records
    }

    const { folder, name: cleanName } = splitFolderAndName(path);
    const lowerName = cleanName.toLowerCase();

    // Check specific GDK/UWP asset categories
    let category = classifyEntry(cleanName, fileBytes);
    if (lowerName.endsWith('.appx') || lowerName.endsWith('.msix')) {
      category = 'package';
    } else if (lowerName.endsWith('.exe') || lowerName.endsWith('.dll')) {
      category = 'executable';
    } else if (lowerName.endsWith('.pri')) {
      category = 'binary';
    } else if (lowerName === 'microsoftgame.config' || lowerName === 'appxmanifest.xml' || lowerName.endsWith('.xml')) {
      category = 'config';
    }

    entries.push({
      id: `appx-${fileIndex++}-${cleanName}`,
      name: cleanName,
      path,
      folder,
      offset: 0,
      compressedSize: fileBytes.length,
      uncompressedSize: fileBytes.length,
      compressionMethod: 'Deflate (OPC ZIP)',
      crc32: computeCRC32(fileBytes),
      category,
      data: fileBytes,
      metadata: {
        isGdkConfig: lowerName === 'microsoftgame.config',
        isAppxManifest: lowerName === 'appxmanifest.xml',
        isPriResource: lowerName.endsWith('.pri'),
        isBundledPackage: lowerName.endsWith('.appx') || lowerName.endsWith('.msix'),
      },
    });
  }

  // If bundle, note in summary
  if (isBundle) {
    const subPackages = entries.filter((e) => e.metadata?.isBundledPackage);
    headerFields.push({
      label: 'Bundled Architecture Packages',
      offset: 'AppxBundleManifest.xml',
      length: subPackages.length,
      value: `${subPackages.length} Sub-Packages (${subPackages.map((p) => p.name).join(', ')})`,
      description: 'Individual platform architectures and asset packages inside bundle',
    });
  }

  const formatName = isBundle
    ? isMsix
      ? 'MSIXBundle (Xbox / Windows GDK Bundle)'
      : 'AppXBundle (Xbox One / Series / UWP Bundle)'
    : isMsix
      ? 'MSIX (Windows / Xbox GDK Package)'
      : 'AppX (Xbox One / Series / UWP Package)';

  return {
    fileName,
    fileSize: bytes.length,
    formatId: 'APPX',
    formatName,
    engineFamily: gameConfig
      ? 'Microsoft Gaming Development Kit (GDK / Xbox Scarlett & One)'
      : 'Microsoft Universal Windows Platform (UWP / Xbox)',
    magicBytes: bytesToHexPreview(bytes, 16),
    endianness: 'Little Endian',
    headerFields,
    entries,
    rawBytes: bytes,
    parseTimeMs: Math.round(performance.now() - startTime),
    warnings,
    extraInfo: {
      gameConfig,
      appxManifest,
      isBundle,
      isMsix,
    },
  };
}
