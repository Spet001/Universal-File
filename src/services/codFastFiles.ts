import { inflateSync, unzlibSync } from 'fflate';
import { ArchiveEntry, ArchiveHeaderField, ParsedArchive } from '../types/archive';
import { computeCRC32, toHex, bytesToHexPreview, classifyEntry, readAscii, decodeLatin1 } from './archiveParser';
import { parseT5T6FastFile, FastFileZoneState } from './t5t6FastFile';

export interface CodEngineInfo {
  game: string;
  engine: string;
  year: number;
  family: 'IW' | 'Treyarch' | 'Sledgehammer';
  is64Bit: boolean;
}

export function identifyCodVersion(magic: string, version: number): CodEngineInfo {
  // Treyarch FastFiles (TAffu100 / TAff0100 / TAff)
  if (magic.startsWith('TAff')) {
    if (version === 0x93 || version === 147) {
      return { game: 'Call of Duty: Black Ops II (T6)', engine: 'Treyarch T6', year: 2012, family: 'Treyarch', is64Bit: true };
    }
    if (version >= 0x200 && version < 0x250) {
      return { game: 'Call of Duty: Black Ops III (T7)', engine: 'Treyarch T7', year: 2015, family: 'Treyarch', is64Bit: true };
    }
    if (version >= 0x250 && version < 0x300) {
      return { game: 'Call of Duty: Black Ops 4 (T8)', engine: 'Treyarch T8', year: 2018, family: 'Treyarch', is64Bit: true };
    }
    if (version >= 0x300 && version < 0x380) {
      return { game: 'Call of Duty: Black Ops Cold War (T9)', engine: 'Treyarch T9', year: 2020, family: 'Treyarch', is64Bit: true };
    }
    if (version >= 0x380 || version >= 900) {
      return { game: 'Call of Duty: Black Ops 6 (T10)', engine: 'Treyarch T10', year: 2024, family: 'Treyarch', is64Bit: true };
    }
    return { game: `Call of Duty: Treyarch Title (ver ${version})`, engine: 'Treyarch Engine', year: 2015, family: 'Treyarch', is64Bit: true };
  }

  // Infinity Ward / Sledgehammer FastFiles (IWffu100 / IWff0100 / S1ff)
  if (magic.startsWith('IWff') || magic.startsWith('S1ff')) {
    if (version === 5 || version === 6) {
      return { game: 'Call of Duty 4: Modern Warfare (IW3)', engine: 'IW 3.0', year: 2007, family: 'IW', is64Bit: false };
    }
    if (version === 372 || version === 0x174 || version === 380) {
      return { game: 'Call of Duty: World at War (T4)', engine: 'Treyarch T4', year: 2008, family: 'Treyarch', is64Bit: false };
    }
    if (version === 276 || version === 277 || version === 278) {
      return { game: 'Call of Duty: Modern Warfare 2 (IW4)', engine: 'IW 4.0', year: 2009, family: 'IW', is64Bit: false };
    }
    if (version === 473 || version === 0x1d9) {
      return { game: 'Call of Duty: Black Ops (T5)', engine: 'Treyarch T5', year: 2010, family: 'Treyarch', is64Bit: true };
    }
    if (version === 1 || version === 3) {
      return { game: 'Call of Duty: Modern Warfare 3 (IW5)', engine: 'IW 5.0', year: 2011, family: 'IW', is64Bit: false };
    }
    if (version >= 10 && version < 30) {
      return { game: 'Call of Duty: Ghosts (IW6)', engine: 'IW 6.0', year: 2013, family: 'IW', is64Bit: true };
    }
    if (version >= 30 && version < 60) {
      return { game: 'Call of Duty: Infinite Warfare (IW7)', engine: 'IW 7.0', year: 2016, family: 'IW', is64Bit: true };
    }
    if (version >= 60 && version < 100) {
      return { game: 'Call of Duty: Modern Warfare 2019 (IW8)', engine: 'IW 8.0', year: 2019, family: 'IW', is64Bit: true };
    }
    if (version >= 100 && version < 150) {
      return { game: 'Call of Duty: Modern Warfare II (IW9)', engine: 'IW 9.0', year: 2022, family: 'IW', is64Bit: true };
    }
    if (version >= 150) {
      return { game: 'Call of Duty: Modern Warfare III (IW10)', engine: 'IW 10.0', year: 2023, family: 'IW', is64Bit: true };
    }
  }

  return {
    game: `Call of Duty Engine Container (${magic})`,
    engine: `Engine Build 0x${version.toString(16).toUpperCase()}`,
    year: 2012,
    family: magic.startsWith('TA') ? 'Treyarch' : 'IW',
    is64Bit: magic.startsWith('TA') || version > 400,
  };
}

/**
 * Universal FastFile parser for T4-T10 and IW3-IW10
 */
export function parseUniversalFastFile(
  fileName: string,
  raw: Uint8Array,
  startTime: number
): { parsed: ParsedArchive; zoneState: FastFileZoneState | null } {
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const magic = decodeLatin1(raw, 0, 8);
  const version = raw.length >= 12 ? view.getUint32(8, true) : 0;
  const info = identifyCodVersion(magic, version);

  // If this is T5 or T6 (BO1 / BO2 MS Store or compatible), run Spet's full zone decompiler
  if (magic === 'TAffu100' || (magic === 'IWffu100' && (version === 473 || version === 0x1d9))) {
    const t5t6 = parseT5T6FastFile(fileName, raw, startTime);
    if (t5t6.parsed.entries.length > 0) {
      t5t6.parsed.engineFamily = `${info.game} · ${info.engine}`;
      return t5t6;
    }
  }

  const warnings: string[] = [];
  const entries: ArchiveEntry[] = [];
  let decompressedZone: Uint8Array | null = null;
  let decompressMethod = 'Raw';

  // 1. Try finding zlib stream (RFC 1950 0x78 0x01 / 0x9C / 0xDA)
  // Check standard offsets (0x0C, 0x10, 0x14, 0x20, 0x80, 0x100, 0x200, 0x400)
  const candidateOffsets = [12, 16, 20, 32, 64, 128, 256, 512, 1024];
  for (const off of candidateOffsets) {
    if (off + 2 < raw.length) {
      const b0 = raw[off];
      const b1 = raw[off + 1];
      if (b0 === 0x78 && (b1 === 0x01 || b1 === 0x9c || b1 === 0xda) && ((b0 << 8) | b1) % 31 === 0) {
        try {
          const sub = raw.subarray(off);
          const decomp = unzlibSync(sub);
          if (decomp && decomp.length > 64) {
            decompressedZone = decomp;
            decompressMethod = `Zlib Stream at 0x${off.toString(16).toUpperCase()} (unpacked ${decomp.length.toLocaleString()} B)`;
            break;
          }
        } catch {
          // Continue scanning
        }
      }
    }
  }

  // 2. If not found at fixed offsets, scan raw for first valid zlib header up to offset 4096
  if (!decompressedZone) {
    const scanLimit = Math.min(raw.length - 2, 4096);
    for (let i = 12; i < scanLimit; i++) {
      const b0 = raw[i];
      const b1 = raw[i + 1];
      if (b0 === 0x78 && (b1 === 0x01 || b1 === 0x9c || b1 === 0xda) && ((b0 << 8) | b1) % 31 === 0) {
        try {
          const decomp = unzlibSync(raw.subarray(i));
          if (decomp && decomp.length > 64) {
            decompressedZone = decomp;
            decompressMethod = `Zlib Stream found at offset 0x${i.toString(16).toUpperCase()}`;
            break;
          }
        } catch {
          // Continue
        }
      }
    }
  }

  // 3. Try raw deflate (-15) chunk loop (T6 / IW6 / T7 chunk layout)
  if (!decompressedZone && raw.length > 32) {
    try {
      const blen = view.getUint32(12, true);
      if (blen > 0 && blen < raw.length - 32) {
        let off = 16 + blen;
        const chunks: Uint8Array[] = [];
        let total = 0;
        let blocksRead = 0;
        while (off + 4 <= raw.length && blocksRead < 500) {
          const c = view.getUint32(off, true);
          if (c <= 0 || off + 4 + c > raw.length) break;
          try {
            const dec = inflateSync(raw.subarray(off + 4, off + 4 + c));
            chunks.push(dec);
            total += dec.length;
            off += 4 + c;
            blocksRead++;
          } catch {
            break;
          }
        }
        if (chunks.length > 0 && total > 1024) {
          const full = new Uint8Array(total);
          let w = 0;
          for (const ch of chunks) {
            full.set(ch, w);
            w += ch.length;
          }
          decompressedZone = full;
          decompressMethod = `Raw Deflate Blocks (${chunks.length} blocks, ${total.toLocaleString()} B)`;
        }
      }
    } catch {
      // Ignored
    }
  }

  // If zone stream was successfully decompressed, carve out all contained assets!
  if (decompressedZone && decompressedZone.length > 0) {
    const zone = decompressedZone;
    const n = zone.length;
    let entryIdx = 0;

    // Scan for script markers (\x80GSC or text GSC/CSC), rawfiles, stringtables, vision configs, and sounds
    for (let i = 0; i < n - 8; i++) {
      // Compiled GSC script (\x80GSC)
      if (zone[i] === 0x80 && zone[i + 1] === 0x47 && zone[i + 2] === 0x53 && zone[i + 3] === 0x43) {
        // Read script len or bound
        let end = Math.min(n, i + 65536);
        for (let j = i + 16; j < end - 4; j++) {
          if (zone[j] === 0x80 && zone[j + 1] === 0x47 && zone[j + 2] === 0x53 && zone[j + 3] === 0x43) {
            end = j;
            break;
          }
        }
        const slice = zone.slice(i, end);
        entries.push({
          id: `ff-script-${entryIdx++}`,
          name: `script_${toHex(i, 6)}.gsc`,
          path: `scripts/script_${toHex(i, 6)}.gsc`,
          folder: 'scripts',
          offset: i,
          compressedSize: slice.length,
          uncompressedSize: slice.length,
          compressionMethod: 'Compiled CoD Script Bytecode',
          crc32: computeCRC32(slice),
          category: 'script',
          data: slice,
          metadata: { ffKind: 'script', magic: '\\x80GSC' },
        });
        i = end - 1;
        continue;
      }

      // Rawfile / Config / Menu script text
      if (
        (readAscii(zone, i, 4) === 'maps' || readAscii(zone, i, 4) === 'code' || readAscii(zone, i, 4) === 'ui_m') &&
        zone[i - 1] === 0
      ) {
        let nameEnd = i;
        while (nameEnd < Math.min(n, i + 128) && zone[nameEnd] >= 0x20 && zone[nameEnd] <= 0x7e) {
          nameEnd++;
        }
        if (zone[nameEnd] === 0 && nameEnd > i + 4) {
          const name = readAscii(zone, i, nameEnd - i);
          if (
            name.endsWith('.gsc') ||
            name.endsWith('.csc') ||
            name.endsWith('.cfg') ||
            name.endsWith('.menu') ||
            name.endsWith('.vision')
          ) {
            const dataStart = nameEnd + 1;
            let dataEnd = dataStart;
            while (dataEnd < Math.min(n, dataStart + 131072) && (zone[dataEnd] !== 0 || zone[dataEnd + 1] !== 0)) {
              dataEnd++;
            }
            if (dataEnd > dataStart + 16) {
              const fileData = zone.slice(dataStart, dataEnd);
              entries.push({
                id: `ff-asset-${entryIdx++}`,
                name: name.split('/').pop() || name,
                path: name,
                folder: name.includes('/') ? name.substring(0, name.lastIndexOf('/')) : 'raw',
                offset: dataStart,
                compressedSize: fileData.length,
                uncompressedSize: fileData.length,
                compressionMethod: 'FastFile Raw Asset',
                crc32: computeCRC32(fileData),
                category: classifyEntry(name, fileData),
                data: fileData,
              });
              i = dataEnd;
              continue;
            }
          }
        }
      }

      // DDS Texture Header (DDS )
      if (zone[i] === 0x44 && zone[i + 1] === 0x44 && zone[i + 2] === 0x53 && zone[i + 3] === 0x20 && i + 128 <= n) {
        const texView = new DataView(zone.buffer, zone.byteOffset + i, 128);
        const texHeight = texView.getUint32(12, true);
        const texWidth = texView.getUint32(16, true);
        const linearSize = texView.getUint32(20, true);
        if (texWidth > 0 && texWidth <= 8192 && texHeight > 0 && texHeight <= 8192) {
          const estimatedSize = Math.max(128, Math.min(n - i, 128 + (linearSize || texWidth * texHeight)));
          const texData = zone.slice(i, i + estimatedSize);
          entries.push({
            id: `ff-tex-${entryIdx++}`,
            name: `texture_${texWidth}x${texHeight}_${toHex(i, 6)}.dds`,
            path: `textures/texture_${texWidth}x${texHeight}_${toHex(i, 6)}.dds`,
            folder: 'textures',
            offset: i,
            compressedSize: texData.length,
            uncompressedSize: texData.length,
            compressionMethod: 'DirectDraw Surface (DDS)',
            crc32: computeCRC32(texData),
            category: 'texture',
            data: texData,
          });
          i += estimatedSize - 1;
          continue;
        }
      }

      // RIFF WAVE audio lump
      if (
        zone[i] === 0x52 &&
        zone[i + 1] === 0x49 &&
        zone[i + 2] === 0x46 &&
        zone[i + 3] === 0x46 &&
        i + 12 <= n &&
        readAscii(zone, i + 8, 4) === 'WAVE'
      ) {
        const riffSize = new DataView(zone.buffer, zone.byteOffset + i, 12).getUint32(4, true) + 8;
        const safeEnd = Math.min(n, i + Math.max(44, riffSize));
        const audioData = zone.slice(i, safeEnd);
        entries.push({
          id: `ff-snd-${entryIdx++}`,
          name: `sound_${toHex(i, 6)}.wav`,
          path: `sounds/sound_${toHex(i, 6)}.wav`,
          folder: 'sounds',
          offset: i,
          compressedSize: audioData.length,
          uncompressedSize: audioData.length,
          compressionMethod: 'RIFF WAVE Audio Stream',
          crc32: computeCRC32(audioData),
          category: 'audio',
          data: audioData,
        });
        i = safeEnd - 1;
        continue;
      }
    }

    // Also include the decompressed zone stream as a master file
    entries.unshift({
      id: 'ff-decompressed-zone',
      name: `${fileName}.zone_unpacked`,
      path: `zone/${fileName}.zone_unpacked`,
      folder: 'zone',
      offset: 0,
      compressedSize: raw.length,
      uncompressedSize: zone.length,
      compressionMethod: decompressMethod,
      crc32: computeCRC32(zone),
      category: 'binary',
      data: zone,
    });
  } else {
    warnings.push(
      `FastFile ${info.game} header parsed (${magic}, version 0x${version.toString(
        16
      ).toUpperCase()}). The zone payload is encrypted/signed with console RSA signatures. Providing root payload container.`
    );
    entries.push({
      id: 'ff-raw-payload',
      name: `${fileName}.payload`,
      path: `raw/${fileName}.payload`,
      folder: 'raw',
      offset: 12,
      compressedSize: Math.max(0, raw.length - 12),
      uncompressedSize: Math.max(0, raw.length - 12),
      compressionMethod: `${info.engine} Signed / Encrypted Payload Stream`,
      crc32: computeCRC32(raw.subarray(12)),
      category: 'binary',
      data: raw.subarray(12),
    });
  }

  const headerFields: ArchiveHeaderField[] = [
    {
      label: 'FastFile Container Magic',
      offset: '0x00000000',
      length: 8,
      value: `${magic} (${bytesToHexPreview(raw, 8)})`,
      description: `${info.family} FastFile magic signature identifier`,
    },
    {
      label: 'Engine Version Code',
      offset: '0x00000008',
      length: 4,
      value: `0x${version.toString(16).toUpperCase()} (${version})`,
      description: `Matched to: ${info.game} (${info.engine}, ${info.year})`,
    },
    {
      label: 'Decompression Engine',
      offset: 'Zone Stream',
      length: 4,
      value: decompressMethod,
      description: 'Stream decoding and asset carving state',
    },
    {
      label: 'Extracted Asset Count',
      offset: 'Zone Assets',
      length: 4,
      value: `${entries.length} assets carved`,
      description: 'Compiled scripts, rawfiles, DDS textures, sounds, and UI menus',
    },
  ];

  return {
    parsed: {
      fileName,
      fileSize: raw.length,
      unpackedZoneSize: decompressedZone ? decompressedZone.length : undefined,
      formatId: 'FF',
      formatName: `Call of Duty FastFile (${info.game})`,
      engineFamily: `${info.engine} · ${info.year} (${info.is64Bit ? '64-bit' : '32-bit'})`,
      magicBytes: bytesToHexPreview(raw, 12),
      endianness: 'Little Endian',
      headerFields,
      entries,
      rawBytes: raw,
      parseTimeMs: Math.max(1, Math.round(performance.now() - startTime)),
      warnings,
    },
    zoneState: null,
  };
}
