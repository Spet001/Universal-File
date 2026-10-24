import { inflateSync, deflateSync, unzlibSync, zlibSync } from 'fflate';
import { ArchiveEntry, ArchiveHeaderField, ParsedArchive } from '../types/archive';
import { computeCRC32, toHex, bytesToHexPreview, formatBytes, classifyEntry } from './archiveParser';

export const MAGIC_BO2_MSSTORE = 'TAffu100';
export const MAGIC_BO1_MSSTORE = 'IWffu100';
export const BLOCK_SIZE = 0x7fc0;
export const VIRTUAL_BLOCK = 5;

export const T6_ASSET_TYPES = [
  'xmodelpieces',
  'physpreset',
  'physconstraints',
  'destructibledef',
  'xanim',
  'xmodel',
  'material',
  'techset',
  'image',
  'sound',
  'soundpatch',
  'clipmap',
  'clipmap_pvs',
  'comworld',
  'gameworld_sp',
  'gameworld_mp',
  'map_ents',
  'gfxworld',
  'lightdef',
  'ui_map',
  'font',
  'fonticon',
  'menulist',
  'menu',
  'localize',
  'weapon',
  'weapondef',
  'weaponvariant',
  'weaponfull',
  'attachment',
  'attachmentunique',
  'weaponcamo',
  'snddriverglobals',
  'fx',
  'impactfx',
  'aitype',
  'mptype',
  'mpbody',
  'mphead',
  'character',
  'xmodelalias',
  'rawfile',
  'stringtable',
  'leaderboard',
  'xglobals',
  'ddl',
  'glasses',
  'emblemset',
  'script',
  'keyvaluepairs',
  'vehicle',
  'memoryblock',
  'addon_map_ents',
  'tracer',
  'skinnedverts',
  'qdb',
  'slug',
  'footstep_table',
  'footstepfx_table',
  'zbarrier',
];

export const T5_ASSET_TYPES = [
  'xmodelpieces',
  'physpreset',
  'xanim',
  'xmodel',
  'material',
  'techset',
  'image',
  'sound',
  'sound_patch',
  'clipmap',
  'clipmap_pvs',
  'comworld',
  'gameworld_sp',
  'gameworld_mp',
  'map_ents',
  'gfxworld',
  'lightdef',
  'ui_map',
  'font',
  'menufile',
  'menu',
  'localize',
  'weapon',
  'snddriverglobals',
  'fx',
  'impactfx',
  'aitype',
  'mptype',
  'character',
  'xmodelalias',
  'rawfile',
  'stringtable',
  'leaderboard',
  'structureddatadef',
  'tracer',
  'vehicle',
  'addon_map_ents',
];

export function getAssetTypeName(typeId: number, isBo1: boolean): string {
  const table = isBo1 ? T5_ASSET_TYPES : T6_ASSET_TYPES;
  return typeId >= 0 && typeId < table.length ? table[typeId] : `type_${typeId}`;
}

export interface FastFileItem {
  id: string;
  kind: 'rawfile' | 'script' | 'menu' | 'stringtable' | 'localize';
  name: string;
  hdr: number;
  data: number;
  size: number;
  extra: {
    compressed?: boolean;
    cols?: number;
    rows?: number;
    cells?: string[];
    end?: number;
  };
}

export interface FastFileZoneState {
  magic: string;
  version: number;
  isBo1: boolean;
  xfile: number[];
  origXfile: number[];
  xfileTail: Uint8Array;
  zone: Uint8Array;
  origZoneLen: number;
  gaps: number;
  nblocks: number;
  scriptStrings: (string | null)[];
  depends: (string | null)[];
  assetTypes: number[];
  dataStart: number;
  items: FastFileItem[];
}

const RX_RAWNAME = /^[A-Za-z0-9_./\-\\]{3,250}$/;
const RX_LOC_NAME = /^[A-Z0-9_][A-Za-z0-9_]{1,127}$/;

export function decodeLatin1(bytes: Uint8Array, start = 0, end = bytes.length): string {
  let out = '';
  const limit = Math.min(bytes.length, end);
  for (let i = start; i < limit; i++) {
    out += String.fromCharCode(bytes[i]);
  }
  return out;
}

export function looksBinary(b: Uint8Array): boolean {
  if (!b || b.length === 0) return false;
  let end = Math.min(b.length, 4096);
  while (end > 0 && b[end - 1] === 0) end--;
  if (end === 0) return false;
  let bad = 0;
  for (let i = 0; i < end; i++) {
    const c = b[i];
    if (c < 9 || (c > 13 && c < 32)) {
      bad++;
    }
  }
  return bad > Math.max(4, Math.floor(end / 50));
}

function isInlinePtrAt(z: Uint8Array, offset: number): boolean {
  if (offset + 8 > z.length) return false;
  return (
    z[offset] === 0xff &&
    z[offset + 1] === 0xff &&
    z[offset + 2] === 0xff &&
    z[offset + 3] === 0xff &&
    z[offset + 4] === 0x00 &&
    z[offset + 5] === 0x00 &&
    z[offset + 6] === 0x00 &&
    z[offset + 7] === 0x00
  );
}

function isZeroPtrAt(z: Uint8Array, offset: number): boolean {
  if (offset + 8 > z.length) return false;
  for (let i = 0; i < 8; i++) {
    if (z[offset + i] !== 0) return false;
  }
  return true;
}

export function inflateRawfile(b: Uint8Array): Uint8Array | null {
  if (b.length < 6) return null;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const usz = view.getUint32(0, true);
  if (usz === 0 || usz > 0x10000000) return null;
  try {
    const inflated = inflateSync(b.subarray(4));
    if (inflated && inflated.length === usz) {
      return inflated;
    }
    return null;
  } catch {
    return null;
  }
}

export function disassembleT6GscInfo(buf: Uint8Array): string {
  if (
    buf.length < 0x40 ||
    buf[0] !== 0x80 ||
    buf[1] !== 0x47 ||
    buf[2] !== 0x53 ||
    buf[3] !== 0x43
  ) {
    return 'Not a compiled T6 script. (BO1/T5 scripts do not have a recognizable script header magic, they are pure bytecode).';
  }

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  const cstr = (o: number): string => {
    if (o < 0 || o >= buf.length) return `<bad 0x${o.toString(16).toUpperCase()}>`;
    let e = o;
    while (e < buf.length && buf[e] !== 0) e++;
    return decodeLatin1(buf, o, e);
  };

  try {
    const crc = view.getUint32(8, true);
    const incOff = view.getUint32(12, true);
    const animOff = view.getUint32(16, true);
    const csegOff = view.getUint32(20, true);
    const strfixOff = view.getUint32(24, true);
    const expOff = view.getUint32(28, true);
    const impOff = view.getUint32(32, true);
    const fixOff = view.getUint32(36, true);
    const profOff = view.getUint32(40, true);
    const csegSize = view.getUint32(44, true);

    const nameOff = view.getUint16(0x30, true);
    const strfixCnt = view.getUint16(0x32, true);
    const expCnt = view.getUint16(0x34, true);
    const impCnt = view.getUint16(0x36, true);
    const fixCnt = view.getUint16(0x38, true);
    const profCnt = view.getUint16(0x3a, true);

    const incCnt = buf[0x3c];
    const animCnt = buf[0x3d];
    const flags = buf[0x3e];

    void animOff;
    void fixOff;
    void profOff;
    void fixCnt;
    void profCnt;

    const magicHex = Array.from(buf.subarray(0, 8))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(' ');

    const L: string[] = [
      `Compiled script  (magic ${magicHex})`,
      `Name        : ${cstr(nameOff)}`,
      `Source CRC  : 0x${crc.toString(16).toUpperCase().padStart(8, '0')}`,
      `Size        : ${buf.length} bytes   code segment 0x${csegOff.toString(16).toUpperCase()} (${csegSize} bytes)`,
      `Flags       : 0x${flags.toString(16).toUpperCase().padStart(2, '0')}`,
      '',
    ];

    L.push(`#include (${incCnt})`);
    for (let i = 0; i < incCnt; i++) {
      if (incOff + 4 * i + 4 <= buf.length) {
        const ptr = view.getUint32(incOff + 4 * i, true);
        L.push(`    #include ${cstr(ptr)};`);
      }
    }

    L.push('');
    L.push(`Functions / exports (${expCnt})`);
    const exportsList: { addr: number; nm: string; params: number; fl: number; ck: number }[] = [];
    for (let i = 0; i < expCnt; i++) {
      const base = expOff + 12 * i;
      if (base + 12 > buf.length) break;
      const ck = view.getUint32(base, true);
      const addr = view.getUint32(base + 4, true);
      const nm = view.getUint16(base + 8, true);
      const params = buf[base + 10];
      const fl = buf[base + 11];
      exportsList.push({ addr, nm: cstr(nm), params, fl, ck });
    }
    exportsList.sort((a, b) => a.addr - b.addr);
    for (const ex of exportsList) {
      const args = Array.from({ length: ex.params }, (_, a) => `arg${a}`).join(', ');
      const flStr = ex.fl ? `  [flags 0x${ex.fl.toString(16).toUpperCase()}]` : '';
      L.push(
        `    ${ex.nm}(${args})    @0x${ex.addr.toString(16).toUpperCase()}  crc=0x${ex.ck
          .toString(16)
          .toUpperCase()
          .padStart(8, '0')}${flStr}`
      );
    }

    L.push('');
    L.push(`Calls / imports (${impCnt})`);
    let p = impOff;
    for (let i = 0; i < impCnt; i++) {
      if (p + 8 > buf.length) break;
      const nm = view.getUint16(p, true);
      const ns = view.getUint16(p + 2, true);
      const nrefs = view.getUint16(p + 4, true);
      const params = buf[p + 6];
      p += 8 + 4 * nrefs;
      const nss = cstr(ns);
      L.push(
        `    ${nss ? nss + '::' : ''}${cstr(nm)}  (${params} args, ${nrefs} call sites)`
      );
    }

    L.push('');
    L.push(`Strings (${strfixCnt})`);
    p = strfixOff;
    for (let i = 0; i < strfixCnt; i++) {
      if (p + 4 > buf.length) break;
      const s = view.getUint16(p, true);
      const nrefs = buf[p + 2];
      p += 4 + 4 * nrefs;
      L.push(`    "${cstr(s).replace(/\n/g, '\\n')}"`);
    }

    if (animCnt) {
      L.push('');
      L.push(`#using_animtree (%d)`.replace('%d', String(animCnt)));
    }

    L.push('');
    L.push(
      'Note: this is a structural dump of the bytecode. Full source decompilation needs a dedicated GSC decompiler; use Extract to save the .gsc binary or use Replace Binary to inject a modified .gsc.'
    );
    return L.join('\n');
  } catch (err) {
    return `Could not fully parse script header: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function resyncBo2Block(
  raw: Uint8Array,
  view: DataView,
  off: number
): { c: number; newOff: number; data: Uint8Array } {
  for (let skip = 1; skip < 64; skip++) {
    const o = off + skip;
    if (o + 4 > raw.length) break;
    const c = view.getUint32(o, true);
    if (c > 0 && c <= 0x10000 && o + 4 + c <= raw.length) {
      try {
        const data = inflateSync(raw.subarray(o + 4, o + 4 + c));
        if (data && data.length > 0) {
          return { c, newOff: o, data };
        }
      } catch {

      }
    }
  }
  throw new Error(`Corrupt compressed block at file offset ${toHex(off)}`);
}

function parseZoneHeader(state: FastFileZoneState): void {
  const z = state.zone;
  const view = new DataView(z.buffer, z.byteOffset, z.byteLength);

  const readStrings = (count: number, startP: number): { list: (string | null)[]; nextP: number } => {
    const res: (string | null)[] = [];
    let p = startP;
    if (p + 8 * count > z.length) return { list: res, nextP: p };

    const isInline: boolean[] = [];
    for (let i = 0; i < count; i++) {
      isInline.push(isInlinePtrAt(z, p + i * 8));
    }
    p += 8 * count;

    for (let i = 0; i < count; i++) {
      if (isInline[i]) {
        let e = p;
        while (e < z.length && z[e] !== 0) e++;
        if (e < z.length) {
          res.push(decodeLatin1(z, p, e));
          p = e + 1;
        } else {
          res.push(null);
        }
      } else {
        res.push(null);
      }
    }
    return { list: res, nextP: p };
  };

  state.scriptStrings = [];
  state.depends = [];
  state.assetTypes = [];

  if (state.isBo1) {
    let p = 0x24;
    const ptrOffsets: number[] = [];
    const scanLimit = Math.min(z.length - 8, 256);
    for (let i = 0; i <= scanLimit; i++) {
      if (isInlinePtrAt(z, i)) {
        ptrOffsets.push(i);
        i += 7;
      }
    }

    let sc = 0;
    let ac = 0;
    if (ptrOffsets.length >= 2) {
      const secondLast = ptrOffsets[ptrOffsets.length - 2];
      const last = ptrOffsets[ptrOffsets.length - 1];
      if (secondLast >= 4) sc = view.getUint32(secondLast - 4, true);
      if (last >= 4) ac = view.getUint32(last - 4, true);
      p = last + 8;
    } else if (ptrOffsets.length === 1) {
      if (ptrOffsets[0] >= 4) ac = view.getUint32(ptrOffsets[0] - 4, true);
      p = ptrOffsets[0] + 8;
    } else {

      p = Math.min(0x24, z.length);
    }

    if (sc > 0 && sc < 100000) {
      const r = readStrings(sc, p);
      state.scriptStrings = r.list;
      p = r.nextP;
    }
    if (ac > 0 && ac < 100000) {
      if (p + 16 * ac <= z.length) {
        for (let i = 0; i < ac; i++) {
          state.assetTypes.push(view.getUint32(p + 16 * i, true));
        }
      }
      p += 16 * ac;
    }
    state.dataStart = Math.min(p, z.length);
  } else {
    if (z.length < 0x30) {
      state.dataStart = 0;
      return;
    }
    const sc = view.getUint32(0x00, true);
    const spInline = isInlinePtrAt(z, 0x08);
    const dc = view.getUint32(0x10, true);
    const dpInline = isInlinePtrAt(z, 0x18);
    const ac = view.getUint32(0x20, true);
    const apInline = isInlinePtrAt(z, 0x28);
    let p = 0x30;

    if (spInline && sc > 0 && sc < 100000) {
      const r = readStrings(sc, p);
      state.scriptStrings = r.list;
      p = r.nextP;
    }
    if (dpInline && dc > 0 && dc < 100000) {
      const r = readStrings(dc, p);
      state.depends = r.list;
      p = r.nextP;
    }
    if (apInline && ac > 0 && ac < 100000) {
      if (p + 16 * ac <= z.length) {
        for (let i = 0; i < ac; i++) {
          state.assetTypes.push(view.getUint32(p + 16 * i, true));
        }
      }
      p += 16 * ac;
    }
    state.dataStart = Math.min(p, z.length);
  }
}

function scanZoneAssets(state: FastFileZoneState): void {
  const z = state.zone;
  const view = new DataView(z.buffer, z.byteOffset, z.byteLength);
  const n = z.length;
  const items: FastFileItem[] = [];
  let itemCounter = 0;

  let pos = state.dataStart;
  while (pos + 28 < n) {
    if (!isInlinePtrAt(z, pos)) {
      pos++;
      continue;
    }

    if (
      z[pos + 12] === 0 &&
      z[pos + 13] === 0 &&
      z[pos + 14] === 0 &&
      z[pos + 15] === 0 &&
      isInlinePtrAt(z, pos + 16)
    ) {
      const ln = view.getUint32(pos + 8, true);
      const nameStart = pos + 24;
      const firstChar = z[nameStart];
      if (firstChar >= 0x21 && firstChar <= 0x7e) {
        let nameEnd = nameStart + 1;
        const maxNameEnd = Math.min(n, nameStart + 254);
        while (nameEnd < maxNameEnd && z[nameEnd] >= 0x20 && z[nameEnd] <= 0x7e) {
          nameEnd++;
        }
        if (nameEnd < n && z[nameEnd] === 0) {
          const b0 = nameEnd + 1;
          const b1 = b0 + ln;
          if (ln < 0x8000000 && b1 < n) {
            const name = decodeLatin1(z, nameStart, nameEnd);
            const isGscMagic =
              b0 + 4 <= n &&
              z[b0] === 0x80 &&
              z[b0 + 1] === 0x47 &&
              z[b0 + 2] === 0x53 &&
              z[b0 + 3] === 0x43;
            const isAllFfHead =
              b0 + 4 <= n &&
              z[b0] === 0xff &&
              z[b0 + 1] === 0xff &&
              z[b0 + 2] === 0xff &&
              z[b0 + 3] === 0xff;

            let kind: FastFileItem['kind'] | null = null;
            const extra: FastFileItem['extra'] = {};

            if (z[b1] === 0 && isGscMagic) {
              kind = 'script';
            } else if (!isAllFfHead && RX_RAWNAME.test(name)) {
              if (state.isBo1 && z[b1] === 0 && (name.endsWith('.gsc') || name.endsWith('.csc'))) {
                kind = 'script';
              } else if (inflateRawfile(z.subarray(b0, b1)) !== null) {
                kind = 'rawfile';
                extra.compressed = true;
              } else if (z[b1] === 0) {
                if ((state.isBo1 && !name.includes('.')) || name.endsWith('.menu')) {
                  kind = 'menu';
                } else {
                  kind = 'rawfile';
                }
              }
            }

            if (kind) {
              items.push({
                id: `ff-item-${itemCounter++}`,
                kind,
                name,
                hdr: pos,
                data: b0,
                size: ln,
                extra,
              });
              pos = b1 + 1;
              continue;
            }
          }
        }
      }
    }
    pos++;
  }

  pos = state.dataStart;
  while (pos + 24 < n) {
    if (!isInlinePtrAt(z, pos)) {
      pos++;
      continue;
    }

    if (isInlinePtrAt(z, pos + 8)) {
      const s1Start = pos + 16;
      let s1End = s1Start;
      const s1Max = Math.min(n, s1Start + 8192);
      while (s1End < s1Max && z[s1End] !== 0 && z[s1End] !== 0xff) {
        s1End++;
      }
      if (s1End < n && z[s1End] === 0) {
        const s2Start = s1End + 1;
        let s2End = s2Start;
        const s2Max = Math.min(n, s2Start + 8192);
        while (s2End < s2Max && z[s2End] !== 0 && z[s2End] !== 0xff) {
          s2End++;
        }
        if (s2End < n && z[s2End] === 0) {
          const str1 = decodeLatin1(z, s1Start, s1End);
          const str2 = decodeLatin1(z, s2Start, s2End);

          if (str2.length >= 2 && str2.length <= 128 && RX_LOC_NAME.test(str2)) {
            items.push({
              id: `ff-loc-${itemCounter++}`,
              kind: 'localize',
              name: str2,
              hdr: pos,
              data: s1Start,
              size: s1End - s1Start,
              extra: {},
            });
            pos = s2End + 1;
            continue;
          }

          if (str1.length >= 2 && str1.length <= 128 && RX_LOC_NAME.test(str1)) {
            items.push({
              id: `ff-loc-${itemCounter++}`,
              kind: 'localize',
              name: str1,
              hdr: pos,
              data: s2Start,
              size: s2End - s2Start,
              extra: {},
            });
            pos = s2End + 1;
            continue;
          }
        }
      }
    }

    if (pos + 38 < n && isInlinePtrAt(z, pos + 16) && (isZeroPtrAt(z, pos + 24) || isInlinePtrAt(z, pos + 24))) {
      const cols = view.getInt32(pos + 8, true);
      const rows = view.getInt32(pos + 12, true);
      if (cols > 0 && cols < 4096 && rows > 0 && rows < 1000000 && cols * rows <= 4000000) {
        const nameStart = pos + 32;
        let nameEnd = nameStart;
        const maxName = Math.min(n, nameStart + 250);
        while (nameEnd < maxName && z[nameEnd] >= 0x21 && z[nameEnd] <= 0x7e) {
          nameEnd++;
        }
        if (nameEnd > nameStart + 4 && nameEnd < n && z[nameEnd] === 0) {
          const csvName = decodeLatin1(z, nameStart, nameEnd);
          if (csvName.toLowerCase().endsWith('.csv')) {
            const cnt = cols * rows;
            let p = nameEnd + 1;
            if (p + 16 * cnt <= n) {
              const cells: string[] = [];
              let validTable = true;
              const ptrKinds: ('inline' | 'zero' | 'ref')[] = [];
              const ptrRefs: number[] = [];

              for (let i = 0; i < cnt; i++) {
                const cellPtrOff = p + 16 * i;
                if (isInlinePtrAt(z, cellPtrOff)) {
                  ptrKinds.push('inline');
                  ptrRefs.push(0);
                } else if (isZeroPtrAt(z, cellPtrOff)) {
                  ptrKinds.push('zero');
                  ptrRefs.push(0);
                } else {
                  ptrKinds.push('ref');
                  ptrRefs.push(view.getUint32(cellPtrOff, true));
                }
              }
              p += 16 * cnt;

              const utf8Dec = new TextDecoder('utf-8', { fatal: false });
              for (let i = 0; i < cnt; i++) {
                if (ptrKinds[i] === 'inline') {
                  let e = p;
                  while (e < n && z[e] !== 0) e++;
                  if (e >= n) {
                    validTable = false;
                    break;
                  }
                  cells.push(utf8Dec.decode(z.subarray(p, e)));
                  p = e + 1;
                } else if (ptrKinds[i] === 'zero') {
                  cells.push('');
                } else {
                  cells.push(`<ref 0x${ptrRefs[i].toString(16).toUpperCase()}>`);
                }
              }

              if (validTable) {
                if (isInlinePtrAt(z, pos + 24)) {
                  p += 2 * cnt;
                }
                const dataStartOffset = nameEnd + 1;
                items.push({
                  id: `ff-st-${itemCounter++}`,
                  kind: 'stringtable',
                  name: csvName,
                  hdr: pos,
                  data: dataStartOffset,
                  size: Math.max(0, p - dataStartOffset),
                  extra: {
                    cols,
                    rows,
                    cells,
                    end: p,
                  },
                });
                pos = p;
                continue;
              }
            }
          }
        }
      }
    }

    pos++;
  }

  items.sort((a, b) => a.hdr - b.hdr);
  state.items = items;
}

export function formatStringTableCsv(cols: number, rows: number, cells: string[]): Uint8Array {
  const lines: string[] = [];
  for (let r = 0; r < rows; r++) {
    const rowCells = cells.slice(r * cols, (r + 1) * cols).map((cell) => {
      if (cell.includes(',') || cell.includes('"') || cell.includes('\n') || cell.includes('\r')) {
        return `"${cell.replace(/"/g, '""')}"`;
      }
      return cell;
    });
    lines.push(rowCells.join(','));
  }
  return new TextEncoder().encode(lines.join('\n') + '\n');
}

export function buildZoneSummaryJson(fileName: string, state: FastFileZoneState): Record<string, unknown> {
  const counts: Record<string, number> = {};
  for (const t of state.assetTypes) {
    const tName = getAssetTypeName(t, state.isBo1);
    counts[tName] = (counts[tName] || 0) + 1;
  }
  const sortedTypes = Object.fromEntries(
    Object.entries(counts).sort((a, b) => b[1] - a[1])
  );
  const blocks =
    state.xfile.length >= 10
      ? state.xfile.slice(2, 10)
      : state.xfile.slice(2);

  return {
    file: fileName,
    magic: state.magic,
    version: `0x${state.version.toString(16).toUpperCase()}`,
    zone_size: state.zone.length,
    xfile_size: state.xfile.length > 0 ? state.xfile[0] : null,
    external_size: state.xfile.length > 1 ? state.xfile[1] : null,
    block_sizes: blocks.map((b) => `0x${b.toString(16).toUpperCase()}`),
    compressed_blocks: state.nblocks,
    block_gaps_repaired: state.gaps,
    script_strings: state.scriptStrings.length,
    dependencies: state.depends.filter(Boolean),
    asset_count: state.assetTypes.length,
    asset_types: sortedTypes,
    found: {
      rawfile: state.items.filter((i) => i.kind === 'rawfile').length,
      script: state.items.filter((i) => i.kind === 'script').length,
      menu: state.items.filter((i) => i.kind === 'menu').length,
      stringtable: state.items.filter((i) => i.kind === 'stringtable').length,
      localize: state.items.filter((i) => i.kind === 'localize').length,
    },
  };
}

export function replaceItemInZoneState(
  state: FastFileZoneState,
  itemId: string,
  newContent: Uint8Array,
  keepSize = false
): void {
  const it = state.items.find((i) => i.id === itemId);
  if (!it) return;
  if (it.kind !== 'rawfile' && it.kind !== 'script' && it.kind !== 'localize' && it.kind !== 'menu') {
    throw new Error(`${it.kind} assets cannot be replaced in-place.`);
  }

  let payload = newContent;
  if (it.extra.compressed) {
    const deflated = deflateSync(newContent, { level: 9 });
    const wrapped = new Uint8Array(4 + deflated.length);
    new DataView(wrapped.buffer).setUint32(0, newContent.length, true);
    wrapped.set(deflated, 4);
    payload = wrapped;
  }

  if (keepSize && payload.length <= it.size) {
    const padded = new Uint8Array(it.size);
    padded.set(payload, 0);
    payload = padded;
  }

  const delta = payload.length - it.size;
  const start = it.data;
  const oldEnd = start + it.size;

  const updatedZone = new Uint8Array(state.zone.length + delta);
  updatedZone.set(state.zone.subarray(0, start), 0);
  updatedZone.set(payload, start);
  updatedZone.set(state.zone.subarray(oldEnd), start + payload.length);

  state.zone = updatedZone;
  it.size = payload.length;

  if (it.kind === 'rawfile' || it.kind === 'script' || it.kind === 'menu') {
    const zView = new DataView(state.zone.buffer, state.zone.byteOffset, state.zone.byteLength);
    zView.setUint32(it.hdr + 8, payload.length, true);
  }

  if (delta !== 0) {
    for (const other of state.items) {
      if (other !== it && other.hdr > start) {
        other.hdr += delta;
        other.data += delta;
        if (other.extra.end !== undefined) {
          other.extra.end += delta;
        }
      }
    }
  }
}

export function buildT5T6FastFileBinary(state: FastFileZoneState, level: 1 | 6 | 9 = 6): Uint8Array {
  const z = state.zone;
  const xf = [...state.xfile];
  const enc = new TextEncoder();

  if (state.isBo1) {

    if (xf.length >= 9) {
      xf[0] = Math.max(0, z.length - 36);
      const zView = new DataView(z.buffer, z.byteOffset, z.byteLength);
      for (let i = 0; i < 9; i++) {
        zView.setUint32(i * 4, xf[i], true);
      }
    }

    const compressedZone = zlibSync(z, { level });
    const out = new Uint8Array(8 + 4 + compressedZone.length + 10);
    out.set(enc.encode(state.magic.slice(0, 8)), 0);
    new DataView(out.buffer).setUint32(8, state.version, true);
    out.set(compressedZone, 12);
    return out;
  } else {

    if (xf.length > 0) {
      xf[0] = z.length;
    }
    const growth = z.length - state.origZoneLen;
    if (growth > 0 && xf.length >= 10 && state.origXfile.length >= 10) {
      const blocks = state.origXfile.slice(2, 10);
      let idx = VIRTUAL_BLOCK;
      if (!blocks[VIRTUAL_BLOCK]) {
        idx = 0;
        for (let i = 1; i < 8; i++) {
          if (blocks[i] > blocks[idx]) idx = i;
        }
      }
      xf[2 + idx] = blocks[idx] + ((growth + 0x100 + 0xff) & ~0xff);
    }

    const xfBuf = new Uint8Array(xf.length * 4 + state.xfileTail.length);
    const xfView = new DataView(xfBuf.buffer);
    for (let i = 0; i < xf.length; i++) {
      xfView.setUint32(i * 4, xf[i], true);
    }
    xfBuf.set(state.xfileTail, xf.length * 4);

    const blob = deflateSync(xfBuf, { level: 9 });

    const compressedBlocks: Uint8Array[] = [];
    let totalBlocksByteLen = 0;
    for (let o = 0; o < z.length; o += BLOCK_SIZE) {
      const slice = z.subarray(o, Math.min(z.length, o + BLOCK_SIZE));
      const c = deflateSync(slice, { level });
      compressedBlocks.push(c);
      totalBlocksByteLen += 4 + c.length;
    }

    const prePadLen = 8 + 8 + blob.length + totalBlocksByteLen + 4;
    const padLen = ((-prePadLen % 64) + 64) % 64 + 64;
    const out = new Uint8Array(prePadLen + padLen);
    const outView = new DataView(out.buffer);

    out.set(enc.encode(state.magic.slice(0, 8)), 0);
    outView.setUint32(8, state.version, true);
    outView.setUint32(12, blob.length, true);
    out.set(blob, 16);

    let writePos = 16 + blob.length;
    for (const c of compressedBlocks) {
      outView.setUint32(writePos, c.length, true);
      out.set(c, writePos + 4);
      writePos += 4 + c.length;
    }
    return out;
  }
}

export function parseT5T6FastFile(
  fileName: string,
  raw: Uint8Array,
  startTime: number
): { parsed: ParsedArchive; zoneState: FastFileZoneState | null } {
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const magic = decodeLatin1(raw, 0, 8);
  const version = raw.length >= 12 ? view.getUint32(8, true) : 0;
  const warnings: string[] = [];

  if (magic === MAGIC_BO2_MSSTORE || magic === MAGIC_BO1_MSSTORE) {
    const isBo1 = magic === MAGIC_BO1_MSSTORE;
    const state: FastFileZoneState = {
      magic,
      version,
      isBo1,
      xfile: [],
      origXfile: [],
      xfileTail: new Uint8Array(0),
      zone: new Uint8Array(0),
      origZoneLen: 0,
      gaps: 0,
      nblocks: 0,
      scriptStrings: [],
      depends: [],
      assetTypes: [],
      dataStart: 0,
      items: [],
    };

    try {
      if (isBo1) {

        const decomp = unzlibSync(raw.subarray(12));
        state.zone = decomp;
        state.origZoneLen = decomp.length;
        if (decomp.length >= 36) {
          const zView = new DataView(decomp.buffer, decomp.byteOffset, decomp.byteLength);
          for (let i = 0; i < 9; i++) {
            state.xfile.push(zView.getUint32(i * 4, true));
          }
          state.origXfile = [...state.xfile];
        }
      } else {

        const blen = view.getUint32(12, true);
        const xf = inflateSync(raw.subarray(16, 16 + blen));
        const n = Math.floor(xf.length / 4);
        const xfView = new DataView(xf.buffer, xf.byteOffset, xf.byteLength);
        for (let i = 0; i < n; i++) {
          state.xfile.push(xfView.getUint32(i * 4, true));
        }
        state.origXfile = [...state.xfile];
        state.xfileTail = xf.slice(n * 4);

        let off = 16 + blen;
        const chunks: Uint8Array[] = [];
        let totalUnpacked = 0;

        while (off + 4 <= raw.length) {
          let c = view.getUint32(off, true);
          if (c === 0) break;
          let chunkData: Uint8Array;
          try {
            if (off + 4 + c > raw.length) throw new Error('Block exceeds EOF');
            chunkData = inflateSync(raw.subarray(off + 4, off + 4 + c));
          } catch {
            const resynced = resyncBo2Block(raw, view, off);
            c = resynced.c;
            off = resynced.newOff;
            chunkData = resynced.data;
            state.gaps++;
          }
          chunks.push(chunkData);
          totalUnpacked += chunkData.length;
          off += 4 + c;
          state.nblocks++;
        }

        const fullZone = new Uint8Array(totalUnpacked);
        let writePos = 0;
        for (const ch of chunks) {
          fullZone.set(ch, writePos);
          writePos += ch.length;
        }
        state.zone = fullZone;
        state.origZoneLen = fullZone.length;
      }

      parseZoneHeader(state);
      scanZoneAssets(state);

      const entries: ArchiveEntry[] = [];
      const enc = new TextEncoder();

      if (state.items.length > 0 || !isBo1 || version >= 0x100) {
        const folderPrefixMap: Record<FastFileItem['kind'], string> = {
          rawfile: 'rawfiles',
          script: 'scripts',
          menu: 'menus',
          stringtable: 'stringtables',
          localize: 'localize',
        };

        for (const it of state.items) {
          const rawSlice = state.zone.subarray(it.data, it.data + it.size);
          let usableData = rawSlice;
          let methodLabel = `XAsset (${it.kind})`;

          if (it.kind === 'rawfile' && it.extra.compressed) {
            const inflated = inflateRawfile(rawSlice);
            if (inflated) {
              usableData = inflated;
              methodLabel = 'Compressed Rawfile (Deflate -15)';
            }
          } else if (it.kind === 'stringtable' && it.extra.cols && it.extra.rows && it.extra.cells) {
            usableData = formatStringTableCsv(it.extra.cols, it.extra.rows, it.extra.cells);
            methodLabel = `StringTable (${it.extra.cols}×${it.extra.rows} CSV)`;
          } else if (it.kind === 'script') {
            methodLabel = isBo1 ? 'T5 Compiled GSC Bytecode' : 'T6 Compiled GSC (\\x80GSC)';
          }

          const cleanName = it.name.replace(/\\/g, '/').replace(/^\/+/, '');
          const parts = cleanName.split('/').filter(Boolean);
          const baseName = parts[parts.length - 1] || cleanName;
          const subFolder =
            parts.length > 1
              ? `${folderPrefixMap[it.kind]}/${parts.slice(0, parts.length - 1).join('/')}`
              : folderPrefixMap[it.kind];

          entries.push({
            id: it.id,
            name: baseName,
            path: `${folderPrefixMap[it.kind]}/${cleanName}`,
            folder: subFolder,
            offset: it.data,
            compressedSize: it.size,
            uncompressedSize: usableData.length,
            compressionMethod: methodLabel,
            crc32: computeCRC32(usableData),
            category:
              it.kind === 'script'
                ? 'script'
                : it.kind === 'stringtable' || it.kind === 'localize' || it.kind === 'menu' || it.kind === 'rawfile'
                ? 'config'
                : 'binary',
            data: usableData,
            metadata: {
              ffKind: it.kind,
              hdrOffset: it.hdr,
              compressedRawfile: it.extra.compressed ? 1 : 0,
              cols: it.extra.cols || 0,
              rows: it.extra.rows || 0,
            },
          });
        }

        const summaryObj = buildZoneSummaryJson(fileName, state);
        const summaryBytes = enc.encode(JSON.stringify(summaryObj, null, 2));
        entries.push({
          id: 'ff-meta-zone-info',
          name: 'zone_info.json',
          path: 'zone_metadata/zone_info.json',
          folder: 'zone_metadata',
          offset: 0,
          compressedSize: summaryBytes.length,
          uncompressedSize: summaryBytes.length,
          compressionMethod: 'Zone Summary JSON',
          crc32: computeCRC32(summaryBytes),
          category: 'config',
          data: summaryBytes,
        });

        if (state.scriptStrings.length > 0) {
          const ssBytes = enc.encode(state.scriptStrings.map((s) => s || '').join('\n'));
          entries.push({
            id: 'ff-meta-script-strings',
            name: 'script_strings.txt',
            path: 'zone_metadata/script_strings.txt',
            folder: 'zone_metadata',
            offset: 0x30,
            compressedSize: ssBytes.length,
            uncompressedSize: ssBytes.length,
            compressionMethod: `Script Strings (${state.scriptStrings.length})`,
            crc32: computeCRC32(ssBytes),
            category: 'config',
            data: ssBytes,
          });
        }

        const locItems = state.items.filter((i) => i.kind === 'localize');
        if (locItems.length > 0) {
          const utf8Dec = new TextDecoder('utf-8', { fatal: false });
          const locLines = locItems.map((it) => {
            const valBytes = state.zone.subarray(it.data, it.data + it.size);
            const valStr = utf8Dec.decode(valBytes).replace(/\n/g, '\\n');
            return `${it.name}=${valStr}`;
          });
          const locBytes = enc.encode(locLines.join('\n') + '\n');
          entries.push({
            id: 'ff-meta-localize-all',
            name: 'localize.txt',
            path: 'localize/localize.txt',
            folder: 'localize',
            offset: locItems[0].hdr,
            compressedSize: locBytes.length,
            uncompressedSize: locBytes.length,
            compressionMethod: `Combined Localized Table (${locItems.length})`,
            crc32: computeCRC32(locBytes),
            category: 'config',
            data: locBytes,
          });
        }
      } else {

        const zoneText = new TextDecoder('utf-8', { fatal: false }).decode(state.zone);
        const assetRegex =
          /([a-zA-Z0-9_/\\.-]+\.(?:gsc|csc|vision|menu|cfg|str|hlsl|shader|csv|atr|rmb))\x00([\s\S]*?)\x00/g;
        let match: RegExpExecArray | null;
        let idx = 0;
        while ((match = assetRegex.exec(zoneText)) !== null && idx < 250) {
          const assetPath = match[1].replace(/\\/g, '/');
          const bodyText = match[2];
          if (bodyText.length >= 4) {
            const bodyBytes = enc.encode(bodyText);
            const parts = assetPath.split('/').filter(Boolean);
            const name = parts[parts.length - 1] || assetPath;
            const folder = parts.length > 1 ? parts.slice(0, -1).join('/') : '(root)';
            entries.push({
              id: `ff-legacy-${idx++}`,
              name,
              path: assetPath,
              folder,
              offset: match.index,
              compressedSize: bodyBytes.length,
              uncompressedSize: bodyBytes.length,
              compressionMethod: 'IW3/IW4 XAsset Stream',
              crc32: computeCRC32(bodyBytes),
              category: classifyEntry(assetPath, bodyBytes),
              data: bodyBytes,
            });
          }
        }
      }

      entries.push({
        id: 'ff-zone-master',
        name: `${fileName.replace(/\.ff$/i, '')}.zone`,
        path: `zone_stream/${fileName.replace(/\.ff$/i, '')}.zone`,
        folder: 'zone_stream',
        offset: state.dataStart,
        compressedSize: raw.length,
        uncompressedSize: state.zone.length,
        compressionMethod: isBo1
          ? 'BO1 / IW Unpacked Zone'
          : `BO2 Unpacked Zone (${state.nblocks} blocks)`,
        crc32: computeCRC32(state.zone),
        category: 'binary',
        data: state.zone,
      });

      const headerFields: ArchiveHeaderField[] = [
        {
          label: 'FastFile Magic & Version',
          offset: '0x00000000',
          length: 12,
          value: `${magic} · v0x${version.toString(16).toUpperCase()} (${
            !isBo1 ? 'T6 / Black Ops II' : version >= 0x100 ? 'T5 / Black Ops I' : 'IW3 / CoD4'
          })`,
          description: !isBo1
            ? `T6 MS Store / PC FastFile: Raw-Deflate XFile header + ${state.nblocks} × 0x7FC0 deflate blocks`
            : 'Single Zlib stream at 0x0C with inline 36-byte XFile header',
        },
        {
          label: 'Decompressed Zone Telemetry',
          offset: toHex(state.dataStart),
          length: state.zone.length,
          value: `${formatBytes(state.zone.length)} · ${state.assetTypes.length} XAssets · ${state.scriptStrings.length} Script Strings`,
          description: `Data starts at ${toHex(state.dataStart)} (${state.gaps} block padding gaps auto-repaired)`,
        },
        {
          label: 'Discovered Editable Assets',
          offset: toHex(state.dataStart),
          length: state.items.length,
          value: `${state.items.length} assets (${
            state.items.filter((i) => i.kind === 'rawfile').length
          } rawfiles, ${state.items.filter((i) => i.kind === 'script').length} scripts, ${
            state.items.filter((i) => i.kind === 'stringtable').length
          } CSVs, ${state.items.filter((i) => i.kind === 'localize').length} localized)`,
          description: 'Scanned via 64-bit INLINE pointer signatures (0xFFFFFFFF00000000)',
        },
      ];

      return {
        parsed: {
          fileName,
          fileSize: raw.length,
          unpackedZoneSize: state.zone.length,
          formatId: 'FF',
          formatName: !isBo1
            ? `Call of Duty: Black Ops II FastFile (${magic})`
            : version >= 0x100
            ? `Call of Duty: Black Ops I FastFile (${magic})`
            : `Call of Duty FastFile (${magic})`,
          engineFamily: !isBo1
            ? `Treyarch T6 Engine (BO2 v0x${version.toString(16).toUpperCase()})`
            : version >= 0x100
            ? `Treyarch T5 Engine (BO1 v0x${version.toString(16).toUpperCase()})`
            : `IW Engine (v0x${version.toString(16).toUpperCase()})`,
          magicBytes: bytesToHexPreview(raw, 12),
          endianness: 'Little Endian',
          headerFields,
          entries,
          rawBytes: raw,
          parseTimeMs: Math.max(1, Math.round(performance.now() - startTime)),
          warnings,
          zoneState: state,
        },
        zoneState: state,
      };
    } catch (err) {
      warnings.push(
        `FastFile Zone decompression error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return {
    parsed: {
      fileName,
      fileSize: raw.length,
      formatId: 'FF',
      formatName: `Call of Duty FastFile (${magic})`,
      engineFamily: `Version 0x${version.toString(16).toUpperCase()}`,
      magicBytes: bytesToHexPreview(raw, 12),
      endianness: 'Little Endian',
      headerFields: [],
      entries: [],
      rawBytes: raw,
      parseTimeMs: 1,
      warnings,
      zoneState: null,
    },
    zoneState: null,
  };
}
