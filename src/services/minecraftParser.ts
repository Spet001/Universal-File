import { unzipSync } from 'fflate';
import { ArchiveEntry, ArchiveHeaderField, ParsedArchive } from '../types/archive';
import { computeCRC32, classifyEntry, formatBytes } from './archiveParser';

export function isMinecraftJar(bytes: Uint8Array, fileName: string): boolean {
  if (fileName.toLowerCase().endsWith('.jar')) return true;
  // ZIP PK\x03\x04
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    if (fileName.toLowerCase().includes('mod') || fileName.toLowerCase().includes('minecraft')) {
      return true;
    }
  }
  return false;
}

export function parseMinecraftJar(fileName: string, bytes: Uint8Array, startTime: number): ParsedArchive {
  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = unzipSync(bytes);
  } catch (err: any) {
    throw new Error(`Failed to uncompress JAR: ${err?.message || String(err)}`);
  }

  const filePaths = Object.keys(unzipped);

  // Detect modloader ecosystem
  let modloader = 'Vanilla / Plain Java Library';
  let modId = 'unknown';
  let modName = fileName;
  let modVersion = '1.0';

  if ('fabric.mod.json' in unzipped) {
    modloader = 'Fabric Mod';
    try {
      const meta = JSON.parse(new TextDecoder().decode(unzipped['fabric.mod.json']));
      modId = meta.id || modId;
      modName = meta.name || modName;
      modVersion = meta.version || modVersion;
    } catch {
      // ignore JSON parse errors
    }
  } else if ('quilt.mod.json' in unzipped) {
    modloader = 'Quilt Mod';
  } else if ('META-INF/mods.toml' in unzipped || 'mods.toml' in unzipped) {
    modloader = 'Forge / NeoForge Mod';
  } else if ('mcmod.info' in unzipped) {
    modloader = 'Legacy Minecraft Forge (1.7 - 1.12)';
  }

  const classCount = filePaths.filter((p) => p.endsWith('.class')).length;
  const assetCount = filePaths.filter((p) => p.startsWith('assets/')).length;
  const dataCount = filePaths.filter((p) => p.startsWith('data/')).length;

  const headerFields: ArchiveHeaderField[] = [
    { label: 'Container', offset: '0x00', length: 4, value: 'Java JAR / ZIP (PK\\x03\\x04)', description: 'Java Archive Container' },
    { label: 'Modloader Target', offset: 'META-INF', length: 0, value: modloader, description: 'Mod ecosystem runtime environment' },
    { label: 'Mod ID & Name', offset: 'Metadata', length: 0, value: `${modName} (${modId}) v${modVersion}`, description: 'Identified manifest descriptor' },
    { label: 'Class / Bytecode Files', offset: 'JVM', length: 0, value: `${classCount} classes`, description: 'Compiled JVM Java bytecode' },
    { label: 'Assets & Datapacks', offset: 'Assets', length: 0, value: `${assetCount} assets · ${dataCount} data definitions`, description: 'Textures, models, sounds, recipes' },
  ];

  const entries: ArchiveEntry[] = [];
  let idx = 0;

  for (const p of filePaths) {
    const data = unzipped[p];
    const parts = p.split('/');
    const folder = parts.length > 1 ? parts.slice(0, -1).join('/') : 'root';
    const name = parts[parts.length - 1] || p;

    let category = classifyEntry(name, data);
    if (name.endsWith('.class')) {
      category = 'executable';
    } else if (name.endsWith('.json') && p.startsWith('assets/') && p.includes('/models/')) {
      category = 'model';
    } else if (name.endsWith('.ogg')) {
      category = 'audio';
    } else if (name.endsWith('.png')) {
      category = 'texture';
    }

    entries.push({
      id: `jar-${idx++}`,
      name,
      path: p,
      folder,
      offset: 0,
      compressedSize: data.length,
      uncompressedSize: data.length,
      compressionMethod: 'Deflate',
      crc32: computeCRC32(data),
      category,
      data,
    });
  }

  return {
    fileName,
    fileSize: bytes.length,
    formatId: 'JAR',
    formatName: `Minecraft Mod JAR (${modloader})`,
    engineFamily: 'Minecraft Java Edition (Mojang / Forge / Fabric)',
    magicBytes: '50 4B 03 04',
    endianness: 'Little Endian',
    headerFields,
    entries,
    rawBytes: bytes,
    parseTimeMs: Math.round(performance.now() - startTime),
    warnings: [],
  };
}
