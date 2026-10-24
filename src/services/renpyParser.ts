import { unzlibSync, zlibSync } from 'fflate';
import {
  ArchiveEntry,
  ArchiveHeaderField,
  ParsedArchive,
} from '../types/archive';
import {
  computeCRC32,
  classifyEntry,
  splitFolderAndName,
  bytesToHexPreview,
  formatBytes,
} from './archiveParser';

const PICKLE_MARK = Symbol('PICKLE_MARK');

function decodeLongLE(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0;
  let val = 0n;
  for (let i = 0; i < bytes.length; i++) {
    val |= BigInt(bytes[i]) << BigInt(i * 8);
  }
  if ((bytes[bytes.length - 1] & 0x80) !== 0) {
    val -= 1n << BigInt(bytes.length * 8);
  }
  return Number(val);
}

function unescapePythonString(raw: string): string {
  let s = raw.trim();
  if (
    (s.startsWith("'") && s.endsWith("'")) ||
    (s.startsWith('"') && s.endsWith('"'))
  ) {
    s = s.slice(1, -1);
  }
  return s.replace(
    /\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|[\\'"nrtbfv0])/g,
    (_, esc) => {
      if (esc.startsWith('x') || esc.startsWith('X')) {
        return String.fromCharCode(parseInt(esc.slice(1), 16));
      }
      if (esc.startsWith('u') || esc.startsWith('U')) {
        return String.fromCharCode(parseInt(esc.slice(1), 16));
      }
      switch (esc) {
        case 'n':
          return '\n';
        case 'r':
          return '\r';
        case 't':
          return '\t';
        case 'b':
          return '\b';
        case 'f':
          return '\f';
        case 'v':
          return '\v';
        case '0':
          return '\0';
        case '\\':
          return '\\';
        case "'":
          return "'";
        case '"':
          return '"';
        default:
          return esc;
      }
    }
  );
}

export function parsePickle(bytes: Uint8Array): any {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const stack: any[] = [];
  const memo = new Map<number, any>();
  let pos = 0;

  const utf8 = new TextDecoder('utf-8');
  const latin1 = new TextDecoder('latin1');

  function readLine(): string {
    let line = '';
    while (pos < bytes.length) {
      const b = bytes[pos++];
      if (b === 0x0a) break;
      if (b !== 0x0d) line += String.fromCharCode(b);
    }
    return line;
  }

  function popMark(): any[] {
    const idx = stack.lastIndexOf(PICKLE_MARK);
    if (idx === -1) {
      throw new Error('Pickle syntax error: MARK not found on stack');
    }
    const items = stack.splice(idx);
    items.shift();
    return items;
  }

  while (pos < bytes.length) {
    const opcode = bytes[pos++];

    switch (opcode) {
      case 0x80: {

        pos++;
        break;
      }
      case 0x2e: {

        return stack.pop();
      }
      case 0x28: {

        stack.push(PICKLE_MARK);
        break;
      }
      case 0x30: {

        stack.pop();
        break;
      }
      case 0x31: {

        popMark();
        break;
      }
      case 0x32: {

        stack.push(stack[stack.length - 1]);
        break;
      }
      case 0x7d: {

        stack.push({});
        break;
      }
      case 0x5d: {

        stack.push([]);
        break;
      }
      case 0x29: {

        stack.push([]);
        break;
      }
      case 0x4e: {

        stack.push(null);
        break;
      }
      case 0x88: {

        stack.push(true);
        break;
      }
      case 0x89: {

        stack.push(false);
        break;
      }
      case 0x71: {

        const idx = bytes[pos++];
        memo.set(idx, stack[stack.length - 1]);
        break;
      }
      case 0x72: {

        const idx = view.getUint32(pos, true);
        pos += 4;
        memo.set(idx, stack[stack.length - 1]);
        break;
      }
      case 0x70: {

        const idx = parseInt(readLine(), 10);
        memo.set(idx, stack[stack.length - 1]);
        break;
      }
      case 0x94: {

        memo.set(memo.size, stack[stack.length - 1]);
        break;
      }
      case 0x68: {

        const idx = bytes[pos++];
        stack.push(memo.get(idx));
        break;
      }
      case 0x6a: {

        const idx = view.getUint32(pos, true);
        pos += 4;
        stack.push(memo.get(idx));
        break;
      }
      case 0x67: {

        const idx = parseInt(readLine(), 10);
        stack.push(memo.get(idx));
        break;
      }
      case 0x4a: {

        stack.push(view.getInt32(pos, true));
        pos += 4;
        break;
      }
      case 0x4b: {

        stack.push(bytes[pos++]);
        break;
      }
      case 0x4d: {

        stack.push(view.getUint16(pos, true));
        pos += 2;
        break;
      }
      case 0x49: {

        const line = readLine().trim();
        if (line === '01') stack.push(true);
        else if (line === '00') stack.push(false);
        else stack.push(parseInt(line, 10));
        break;
      }
      case 0x4c: {

        const line = readLine().trim();
        stack.push(parseInt(line.replace(/L$/, ''), 10));
        break;
      }
      case 0x8a: {

        const len = bytes[pos++];
        stack.push(decodeLongLE(bytes.subarray(pos, pos + len)));
        pos += len;
        break;
      }
      case 0x8b: {

        const len = view.getUint32(pos, true);
        pos += 4;
        stack.push(decodeLongLE(bytes.subarray(pos, pos + len)));
        pos += len;
        break;
      }
      case 0x58: {

        const len = view.getUint32(pos, true);
        pos += 4;
        stack.push(utf8.decode(bytes.subarray(pos, pos + len)));
        pos += len;
        break;
      }
      case 0x8c: {

        const len = bytes[pos++];
        stack.push(utf8.decode(bytes.subarray(pos, pos + len)));
        pos += len;
        break;
      }
      case 0x8d: {

        const len = Number(view.getBigUint64(pos, true));
        pos += 8;
        stack.push(utf8.decode(bytes.subarray(pos, pos + len)));
        pos += len;
        break;
      }
      case 0x55: {

        const len = bytes[pos++];
        stack.push(latin1.decode(bytes.subarray(pos, pos + len)));
        pos += len;
        break;
      }
      case 0x54: {

        const len = view.getUint32(pos, true);
        pos += 4;
        stack.push(latin1.decode(bytes.subarray(pos, pos + len)));
        pos += len;
        break;
      }
      case 0x43: {

        const len = bytes[pos++];
        stack.push(bytes.slice(pos, pos + len));
        pos += len;
        break;
      }
      case 0x42: {

        const len = view.getUint32(pos, true);
        pos += 4;
        stack.push(bytes.slice(pos, pos + len));
        pos += len;
        break;
      }
      case 0x8e: {

        const len = Number(view.getBigUint64(pos, true));
        pos += 8;
        stack.push(bytes.slice(pos, pos + len));
        pos += len;
        break;
      }
      case 0x53: {

        stack.push(unescapePythonString(readLine()));
        break;
      }
      case 0x56: {

        stack.push(unescapePythonString(readLine()));
        break;
      }
      case 0x74: {

        stack.push(popMark());
        break;
      }
      case 0x85: {

        const a = stack.pop();
        stack.push([a]);
        break;
      }
      case 0x86: {

        const b = stack.pop();
        const a = stack.pop();
        stack.push([a, b]);
        break;
      }
      case 0x87: {

        const c = stack.pop();
        const b = stack.pop();
        const a = stack.pop();
        stack.push([a, b, c]);
        break;
      }
      case 0x6c: {

        stack.push(popMark());
        break;
      }
      case 0x61: {

        const val = stack.pop();
        const list = stack[stack.length - 1];
        list.push(val);
        break;
      }
      case 0x65: {

        const items = popMark();
        const list = stack[stack.length - 1];
        list.push(...items);
        break;
      }
      case 0x64: {

        const items = popMark();
        const dict: Record<string, any> = {};
        for (let i = 0; i < items.length; i += 2) {
          dict[String(items[i])] = items[i + 1];
        }
        stack.push(dict);
        break;
      }
      case 0x75: {

        const items = popMark();
        const dict = stack[stack.length - 1];
        for (let i = 0; i < items.length; i += 2) {
          dict[String(items[i])] = items[i + 1];
        }
        break;
      }
      case 0x73: {

        const val = stack.pop();
        const key = stack.pop();
        const dict = stack[stack.length - 1];
        dict[String(key)] = val;
        break;
      }
      case 0x63: {

        const mod = readLine().trim();
        const name = readLine().trim();
        stack.push({ __global: true, mod, name });
        break;
      }
      case 0x52: {

        const args = stack.pop();
        const fn = stack.pop();
        if (
          fn &&
          (fn.name === 'encode' || fn.name === '_codecs_encode') &&
          Array.isArray(args)
        ) {
          const str = String(args[0] || '');
          const buf = new Uint8Array(str.length);
          for (let i = 0; i < str.length; i++) {
            buf[i] = str.charCodeAt(i) & 0xff;
          }
          stack.push(buf);
        } else {
          stack.push(args);
        }
        break;
      }
      default: {

        throw new Error(
          `Unsupported Pickle opcode 0x${opcode.toString(16).padStart(2, '0')} at position ${pos - 1}`
        );
      }
    }
  }

  return stack.pop();
}

function normalizePrefix(prefix: unknown): Uint8Array {
  if (!prefix) return new Uint8Array(0);
  if (prefix instanceof Uint8Array) return prefix;
  if (typeof prefix === 'string') {
    const bytes = new Uint8Array(prefix.length);
    for (let i = 0; i < prefix.length; i++) {
      bytes[i] = prefix.charCodeAt(i) & 0xff;
    }
    return bytes;
  }
  if (Array.isArray(prefix)) {
    return new Uint8Array(prefix);
  }
  return new Uint8Array(0);
}

function concatUint8(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

interface RawSegment {
  rawOffset: number;
  rawLength: number;
  prefix?: unknown;
}

function extractSegments(val: unknown): RawSegment[] {
  if (!Array.isArray(val)) return [];
  if (val.length === 0) return [];

  if (Array.isArray(val[0])) {
    return val.map((item: any) => ({
      rawOffset: Number(item[0]) || 0,
      rawLength: Number(item[1]) || 0,
      prefix: item[2],
    }));
  }

  return [
    {
      rawOffset: Number(val[0]) || 0,
      rawLength: Number(val[1]) || 0,
      prefix: val[2],
    },
  ];
}

export function isRenpyArchive(bytes: Uint8Array, fileName?: string): boolean {
  if (bytes.length < 8) return false;
  const sig = String.fromCharCode(
    bytes[0],
    bytes[1],
    bytes[2],
    bytes[3],
    bytes[4],
    bytes[5],
    bytes[6],
    bytes[7]
  );
  if (sig.startsWith('RPA-3.0') || sig.startsWith('RPA-2.0')) {
    return true;
  }
  if (fileName && fileName.toLowerCase().endsWith('.rpa')) {

    if (
      bytes[0] === 0x52 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x41 &&
      bytes[3] === 0x2d
    ) {
      return true;
    }
  }
  return false;
}

export function parseRenpyArchive(
  fileName: string,
  bytes: Uint8Array,
  startTime: number
): ParsedArchive {
  const warnings: string[] = [];

  let lineEnd = 0;
  while (lineEnd < bytes.length && bytes[lineEnd] !== 0x0a) {
    lineEnd++;
  }
  const headerLine = new TextDecoder('latin1')
    .decode(bytes.subarray(0, lineEnd))
    .trim();
  const tokens = headerLine.split(/\s+/);

  if (tokens.length < 2) {
    throw new Error(
      `Invalid Ren'Py RPA header format: "${headerLine.slice(0, 40)}"`
    );
  }

  const version = tokens[0];
  if (version !== 'RPA-3.0' && version !== 'RPA-2.0') {
    throw new Error(`Unsupported Ren'Py archive version: ${version}`);
  }

  const rawOffsetStr = tokens[1].replace(/[^0-9a-fA-F]/g, '');
  const indexOffset = Number(BigInt('0x' + (rawOffsetStr || '0')));

  if (isNaN(indexOffset) || indexOffset <= 0 || indexOffset >= bytes.length) {
    throw new Error(
      `Invalid Ren'Py RPA index offset: 0x${rawOffsetStr} (${indexOffset})`
    );
  }

  let key = 0;
  if (version === 'RPA-3.0') {
    if (tokens.length >= 3) {
      const rawKeyStr = tokens[2].replace(/[^0-9a-fA-F]/g, '');
      key = rawKeyStr ? Number(BigInt('0x' + rawKeyStr)) : 0;
    }
  }

  const indexCompressed = bytes.subarray(indexOffset);
  let indexPickleBytes: Uint8Array;
  try {
    indexPickleBytes = unzlibSync(indexCompressed);
  } catch (err: any) {
    throw new Error(
      `Failed to decompress Ren'Py RPA index at offset 0x${indexOffset.toString(16)}: ${err?.message || String(err)}`
    );
  }

  let indexDict: Record<string, any>;
  try {
    indexDict = parsePickle(indexPickleBytes);
  } catch (err: any) {
    throw new Error(
      `Failed to unpickle Ren'Py RPA index: ${err?.message || String(err)}`
    );
  }

  if (!indexDict || typeof indexDict !== 'object') {
    throw new Error('Ren\'Py RPA index did not decode into a dictionary');
  }

  const entries: ArchiveEntry[] = [];
  const filePaths = Object.keys(indexDict);
  filePaths.sort((a, b) => a.localeCompare(b));

  let entryIdx = 0;

  for (const rawPath of filePaths) {
    const rawVal = indexDict[rawPath];
    const segments = extractSegments(rawVal);
    const { folder, name, cleanPath } = splitFolderAndName(rawPath);

    const segmentsData: Uint8Array[] = [];
    let totalCompressedSize = 0;
    let primaryOffset = 0;

    for (let s = 0; s < segments.length; s++) {
      const seg = segments[s];
      const entryOffset =
        version === 'RPA-3.0'
          ? Number(BigInt(seg.rawOffset) ^ BigInt(key))
          : Number(seg.rawOffset);
      const entryLength =
        version === 'RPA-3.0'
          ? Number(BigInt(seg.rawLength) ^ BigInt(key))
          : Number(seg.rawLength);
      const prefBytes = normalizePrefix(seg.prefix);

      if (s === 0) {
        primaryOffset = entryOffset;
      }
      totalCompressedSize += entryLength + prefBytes.length;

      let body = new Uint8Array(0);
      if (entryOffset >= 0 && entryOffset < bytes.length && entryLength > 0) {
        const sliceLen = Math.min(entryLength, bytes.length - entryOffset);
        body = bytes.slice(entryOffset, entryOffset + sliceLen);
      } else if (entryLength > 0) {
        warnings.push(
          `Entry "${cleanPath}" chunk #${s} offset 0x${entryOffset.toString(16)} is out of archive bounds`
        );
      }

      const chunk = concatUint8(prefBytes, body);
      segmentsData.push(chunk);
    }

    let fileData: Uint8Array;
    if (segmentsData.length === 1) {
      fileData = segmentsData[0];
    } else if (segmentsData.length === 0) {
      fileData = new Uint8Array(0);
    } else {
      const totalLen = segmentsData.reduce((acc, c) => acc + c.length, 0);
      fileData = new Uint8Array(totalLen);
      let pos = 0;
      for (const c of segmentsData) {
        fileData.set(c, pos);
        pos += c.length;
      }
    }

    let category = classifyEntry(cleanPath, fileData);
    const lower = cleanPath.toLowerCase();
    if (
      lower.endsWith('.rpy') ||
      lower.endsWith('.rpym') ||
      lower.endsWith('.py')
    ) {
      category = 'script';
    } else if (lower.endsWith('.webp')) {
      category = 'texture';
    }

    const compressionMethod =
      version === 'RPA-3.0'
        ? totalCompressedSize > 0 && segments.some((s) => s.prefix)
          ? 'XOR-32 + Prefix'
          : 'XOR-32 Obfuscated'
        : segments.some((s) => s.prefix)
          ? 'Prefix + Store'
          : 'Store';

    entries.push({
      id: `rpa-${entryIdx++}`,
      name,
      path: cleanPath,
      folder,
      offset: primaryOffset,
      compressedSize: totalCompressedSize,
      uncompressedSize: fileData.length,
      compressionMethod,
      crc32: computeCRC32(fileData),
      category,
      data: fileData,
    });
  }

  const headerFields: ArchiveHeaderField[] = [
    {
      label: 'Format Signature',
      offset: '0x00',
      length: tokens[0].length,
      value: version,
      description: 'Ren\'Py Archive Container Magic',
    },
    {
      label: 'Index Offset',
      offset: 'Header',
      length: tokens[1].length,
      value: `0x${indexOffset.toString(16).toUpperCase()} (${formatBytes(indexOffset)})`,
      description: 'Byte offset of Zlib-compressed Pickle file table',
    },
    {
      label: 'Obfuscation Key',
      offset: 'Header',
      length: version === 'RPA-3.0' ? tokens[2]?.length || 8 : 0,
      value:
        version === 'RPA-3.0'
          ? `0x${key.toString(16).padStart(8, '0').toUpperCase()} (${key})`
          : 'None (RPA-2.0 Plaintext)',
      description: '32-bit XOR key applied to entry offset & length',
    },
    {
      label: 'Total Files',
      offset: 'Index',
      length: 0,
      value: `${entries.length.toLocaleString()} assets`,
      description: 'Files indexed in unpickled catalog',
    },
    {
      label: 'Index Payload Size',
      offset: `0x${indexOffset.toString(16)}`,
      length: indexCompressed.length,
      value: `${formatBytes(indexCompressed.length)} (Decompressed: ${formatBytes(indexPickleBytes.length)})`,
      description: 'Zlib compressed Python Pickle index stream',
    },
  ];

  return {
    fileName,
    fileSize: bytes.length,
    formatId: 'RPA',
    formatName: `Ren'Py Archive (${version})`,
    engineFamily: "Ren'Py Visual Novel Engine",
    magicBytes: bytesToHexPreview(bytes, 8),
    endianness: 'Little Endian',
    headerFields,
    entries,
    rawBytes: bytes,
    parseTimeMs: Math.round(performance.now() - startTime),
    warnings,
  };
}

export interface RenpyBuildFile {
  path: string;
  data: Uint8Array;
  prefix?: Uint8Array;
}

export interface RenpyBuildOptions {
  version?: 'RPA-3.0' | 'RPA-2.0';
  key?: number;
}

function encodePickleInt(num: number): Uint8Array {
  if (num >= 0 && num <= 255) {
    return new Uint8Array([0x4b, num]);
  }
  if (num > 255 && num <= 65535) {
    const b = new Uint8Array(3);
    b[0] = 0x4d;
    new DataView(b.buffer).setUint16(1, num, true);
    return b;
  }
  if (num > 65535 && num <= 0x7fffffff) {
    const b = new Uint8Array(5);
    b[0] = 0x4a;
    new DataView(b.buffer).setInt32(1, num, true);
    return b;
  }

  let n = BigInt(num);
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.push(Number(n & 0xffn));
    n >>= 8n;
  }
  if ((bytes[bytes.length - 1] & 0x80) !== 0) {
    bytes.push(0);
  }
  const b = new Uint8Array(2 + bytes.length);
  b[0] = 0x8a;
  b[1] = bytes.length;
  b.set(bytes, 2);
  return b;
}

function encodePickleProtocol2(
  index: Record<string, Array<[number, number, Uint8Array]>>
): Uint8Array {
  const parts: Uint8Array[] = [];
  const textEnc = new TextEncoder();

  parts.push(new Uint8Array([0x80, 0x02, 0x7d, 0x71, 0x00, 0x28]));
  let memoIdx = 1;

  for (const [path, segments] of Object.entries(index)) {

    const pathBytes = textEnc.encode(path);
    const pathHeader = new Uint8Array(5);
    pathHeader[0] = 0x58;
    new DataView(pathHeader.buffer).setUint32(1, pathBytes.length, true);
    parts.push(pathHeader);
    parts.push(pathBytes);
    parts.push(new Uint8Array([0x71, memoIdx++ & 0xff]));

    parts.push(new Uint8Array([0x5d, 0x71, memoIdx++ & 0xff]));

    for (const seg of segments) {
      const [offset, length, prefix] = seg;

      parts.push(encodePickleInt(offset));

      parts.push(encodePickleInt(length));

      const prefBytes = normalizePrefix(prefix);
      if (prefBytes.length <= 255) {
        const h = new Uint8Array(2);
        h[0] = 0x43;
        h[1] = prefBytes.length;
        parts.push(h);
        parts.push(prefBytes);
      } else {
        const h = new Uint8Array(5);
        h[0] = 0x42;
        new DataView(h.buffer).setUint32(1, prefBytes.length, true);
        parts.push(h);
        parts.push(prefBytes);
      }
      parts.push(new Uint8Array([0x71, memoIdx++ & 0xff]));

      parts.push(new Uint8Array([0x87, 0x71, memoIdx++ & 0xff, 0x61]));
    }
  }

  parts.push(new Uint8Array([0x75, 0x2e]));

  const totalLen = parts.reduce((acc, p) => acc + p.length, 0);
  const out = new Uint8Array(totalLen);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

export function buildRenpyArchive(
  files: RenpyBuildFile[],
  options: RenpyBuildOptions = {}
): Uint8Array {
  const version = options.version || 'RPA-3.0';
  const key =
    version === 'RPA-3.0'
      ? options.key !== undefined
        ? options.key
        : 0x42f00d
      : 0;

  const headerLen = version === 'RPA-3.0' ? 34 : 25;
  const payloads: Uint8Array[] = [];
  let currentOffset = headerLen;

  const indexMap: Record<string, Array<[number, number, Uint8Array]>> = {};

  for (const f of files) {
    const pref = f.prefix || new Uint8Array(0);
    const body = f.data.slice(pref.length);
    const rawOffset = currentOffset;
    const rawLen = body.length;

    currentOffset += rawLen;
    payloads.push(body);

    const obfuscatedOffset =
      version === 'RPA-3.0'
        ? Number(BigInt(rawOffset) ^ BigInt(key))
        : rawOffset;
    const obfuscatedLen =
      version === 'RPA-3.0'
        ? Number(BigInt(rawLen) ^ BigInt(key))
        : rawLen;

    indexMap[f.path] = [[obfuscatedOffset, obfuscatedLen, pref]];
  }

  const indexOffset = currentOffset;
  const pickleBytes = encodePickleProtocol2(indexMap);
  const compressedIndex = zlibSync(pickleBytes);

  let headerStr: string;
  if (version === 'RPA-3.0') {
    const hexOffset = indexOffset.toString(16).padStart(16, '0');
    const hexKey = key.toString(16).padStart(8, '0');
    headerStr = `RPA-3.0 ${hexOffset} ${hexKey}\n`;
  } else {
    const hexOffset = indexOffset.toString(16).padStart(16, '0');
    headerStr = `RPA-2.0 ${hexOffset}\n`;
  }

  const textEnc = new TextEncoder();
  const headerBytes = textEnc.encode(headerStr);

  const totalSize =
    headerBytes.length +
    payloads.reduce((acc, p) => acc + p.length, 0) +
    compressedIndex.length;
  const archive = new Uint8Array(totalSize);

  archive.set(headerBytes, 0);
  let pos = headerBytes.length;
  for (const p of payloads) {
    archive.set(p, pos);
    pos += p.length;
  }
  archive.set(compressedIndex, pos);

  return archive;
}
