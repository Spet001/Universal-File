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

/**
 * Symbol representing the Pickle stack MARK object
 */
const PICKLE_MARK = Symbol('PICKLE_MARK');

/**
 * Decodes signed little-endian bytes of variable length into a JS number
 */
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

/**
 * Unescapes a Python string literal (quotes and escaped sequences)
 */
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

/**
 * Safe, lightweight Python Pickle protocol 0/1/2/3/4 opcode decoder.
 * Supports all data structures used by Ren'Py (dictionaries, lists, tuples,
 * strings, unicode, integers, and byte prefixes).
 */
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
    items.shift(); // remove MARK
    return items;
  }

  while (pos < bytes.length) {
    const opcode = bytes[pos++];

    switch (opcode) {
      case 0x80: {
        // PROTO (1 byte protocol version)
        pos++;
        break;
      }
      case 0x2e: {
        // STOP .
        return stack.pop();
      }
      case 0x28: {
        // MARK (
        stack.push(PICKLE_MARK);
        break;
      }
      case 0x30: {
        // POP 0
        stack.pop();
        break;
      }
      case 0x31: {
        // POP_MARK 1
        popMark();
        break;
      }
      case 0x32: {
        // DUP 2
        stack.push(stack[stack.length - 1]);
        break;
      }
      case 0x7d: {
        // EMPTY_DICT }
        stack.push({});
        break;
      }
      case 0x5d: {
        // EMPTY_LIST ]
        stack.push([]);
        break;
      }
      case 0x29: {
        // EMPTY_TUPLE )
        stack.push([]);
        break;
      }
      case 0x4e: {
        // NONE N
        stack.push(null);
        break;
      }
      case 0x88: {
        // NEWTRUE
        stack.push(true);
        break;
      }
      case 0x89: {
        // NEWFALSE
        stack.push(false);
        break;
      }
      case 0x71: {
        // BINPUT q (1 byte unsigned index)
        const idx = bytes[pos++];
        memo.set(idx, stack[stack.length - 1]);
        break;
      }
      case 0x72: {
        // LONG_BINPUT r (4 bytes uint32 LE index)
        const idx = view.getUint32(pos, true);
        pos += 4;
        memo.set(idx, stack[stack.length - 1]);
        break;
      }
      case 0x70: {
        // PUT p (decimal newline int)
        const idx = parseInt(readLine(), 10);
        memo.set(idx, stack[stack.length - 1]);
        break;
      }
      case 0x94: {
        // MEMOIZE \x94 (proto 4)
        memo.set(memo.size, stack[stack.length - 1]);
        break;
      }
      case 0x68: {
        // BINGET h (1 byte unsigned index)
        const idx = bytes[pos++];
        stack.push(memo.get(idx));
        break;
      }
      case 0x6a: {
        // LONG_BINGET j (4 bytes uint32 LE index)
        const idx = view.getUint32(pos, true);
        pos += 4;
        stack.push(memo.get(idx));
        break;
      }
      case 0x67: {
        // GET g (decimal newline int)
        const idx = parseInt(readLine(), 10);
        stack.push(memo.get(idx));
        break;
      }
      case 0x4a: {
        // BININT J (4 bytes int32 LE signed)
        stack.push(view.getInt32(pos, true));
        pos += 4;
        break;
      }
      case 0x4b: {
        // BININT1 K (1 byte uint8)
        stack.push(bytes[pos++]);
        break;
      }
      case 0x4d: {
        // BININT2 M (2 bytes uint16 LE)
        stack.push(view.getUint16(pos, true));
        pos += 2;
        break;
      }
      case 0x49: {
        // INT I (newline ascii decimal)
        const line = readLine().trim();
        if (line === '01') stack.push(true);
        else if (line === '00') stack.push(false);
        else stack.push(parseInt(line, 10));
        break;
      }
      case 0x4c: {
        // LONG L (newline ascii decimal with optional L)
        const line = readLine().trim();
        stack.push(parseInt(line.replace(/L$/, ''), 10));
        break;
      }
      case 0x8a: {
        // LONG1 \x8a (1 byte len, signed LE integer)
        const len = bytes[pos++];
        stack.push(decodeLongLE(bytes.subarray(pos, pos + len)));
        pos += len;
        break;
      }
      case 0x8b: {
        // LONG4 \x8b (4 bytes len, signed LE integer)
        const len = view.getUint32(pos, true);
        pos += 4;
        stack.push(decodeLongLE(bytes.subarray(pos, pos + len)));
        pos += len;
        break;
      }
      case 0x58: {
        // BINUNICODE X (4 bytes uint32 LE length, UTF-8)
        const len = view.getUint32(pos, true);
        pos += 4;
        stack.push(utf8.decode(bytes.subarray(pos, pos + len)));
        pos += len;
        break;
      }
      case 0x8c: {
        // SHORT_BINUNICODE \x8c (1 byte uint8 length, UTF-8)
        const len = bytes[pos++];
        stack.push(utf8.decode(bytes.subarray(pos, pos + len)));
        pos += len;
        break;
      }
      case 0x8d: {
        // BINUNICODE8 \x8d (8 bytes uint64 LE length, UTF-8)
        const len = Number(view.getBigUint64(pos, true));
        pos += 8;
        stack.push(utf8.decode(bytes.subarray(pos, pos + len)));
        pos += len;
        break;
      }
      case 0x55: {
        // SHORT_BINSTRING U (1 byte uint8 length, latin1)
        const len = bytes[pos++];
        stack.push(latin1.decode(bytes.subarray(pos, pos + len)));
        pos += len;
        break;
      }
      case 0x54: {
        // BINSTRING T (4 bytes uint32 LE length, latin1)
        const len = view.getUint32(pos, true);
        pos += 4;
        stack.push(latin1.decode(bytes.subarray(pos, pos + len)));
        pos += len;
        break;
      }
      case 0x43: {
        // SHORT_BINBYTES C (1 byte uint8 length, bytes)
        const len = bytes[pos++];
        stack.push(bytes.slice(pos, pos + len));
        pos += len;
        break;
      }
      case 0x42: {
        // BINBYTES B (4 bytes uint32 LE length, bytes)
        const len = view.getUint32(pos, true);
        pos += 4;
        stack.push(bytes.slice(pos, pos + len));
        pos += len;
        break;
      }
      case 0x8e: {
        // BINBYTES8 \x8e (8 bytes uint64 LE length, bytes)
        const len = Number(view.getBigUint64(pos, true));
        pos += 8;
        stack.push(bytes.slice(pos, pos + len));
        pos += len;
        break;
      }
      case 0x53: {
        // STRING S (newline string literal)
        stack.push(unescapePythonString(readLine()));
        break;
      }
      case 0x56: {
        // UNICODE V (newline raw unicode literal)
        stack.push(unescapePythonString(readLine()));
        break;
      }
      case 0x74: {
        // TUPLE t (all items from mark)
        stack.push(popMark());
        break;
      }
      case 0x85: {
        // TUPLE1 \x85
        const a = stack.pop();
        stack.push([a]);
        break;
      }
      case 0x86: {
        // TUPLE2 \x86
        const b = stack.pop();
        const a = stack.pop();
        stack.push([a, b]);
        break;
      }
      case 0x87: {
        // TUPLE3 \x87
        const c = stack.pop();
        const b = stack.pop();
        const a = stack.pop();
        stack.push([a, b, c]);
        break;
      }
      case 0x6c: {
        // LIST l (all items from mark)
        stack.push(popMark());
        break;
      }
      case 0x61: {
        // APPEND a (val, list)
        const val = stack.pop();
        const list = stack[stack.length - 1];
        list.push(val);
        break;
      }
      case 0x65: {
        // APPENDS e (items from mark into list)
        const items = popMark();
        const list = stack[stack.length - 1];
        list.push(...items);
        break;
      }
      case 0x64: {
        // DICT d (items from mark into dict)
        const items = popMark();
        const dict: Record<string, any> = {};
        for (let i = 0; i < items.length; i += 2) {
          dict[String(items[i])] = items[i + 1];
        }
        stack.push(dict);
        break;
      }
      case 0x75: {
        // SETITEMS u (items from mark into dict below mark)
        const items = popMark();
        const dict = stack[stack.length - 1];
        for (let i = 0; i < items.length; i += 2) {
          dict[String(items[i])] = items[i + 1];
        }
        break;
      }
      case 0x73: {
        // SETITEM s (val, key, dict)
        const val = stack.pop();
        const key = stack.pop();
        const dict = stack[stack.length - 1];
        dict[String(key)] = val;
        break;
      }
      case 0x63: {
        // GLOBAL c (module\nname\n)
        const mod = readLine().trim();
        const name = readLine().trim();
        stack.push({ __global: true, mod, name });
        break;
      }
      case 0x52: {
        // REDUCE R (callable, args)
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
        // Unrecognized opcode: throw informative error
        throw new Error(
          `Unsupported Pickle opcode 0x${opcode.toString(16).padStart(2, '0')} at position ${pos - 1}`
        );
      }
    }
  }

  return stack.pop();
}

/**
 * Converts any prefix value into a Uint8Array
 */
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

/**
 * Concatenates two Uint8Arrays
 */
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

/**
 * Normalizes entry data from Pickle index into a standard list of segments
 */
function extractSegments(val: unknown): RawSegment[] {
  if (!Array.isArray(val)) return [];
  if (val.length === 0) return [];
  // Case 1: val is an array of segments: [ [offset, length, prefix], ... ]
  if (Array.isArray(val[0])) {
    return val.map((item: any) => ({
      rawOffset: Number(item[0]) || 0,
      rawLength: Number(item[1]) || 0,
      prefix: item[2],
    }));
  }
  // Case 2: val is directly [offset, length, prefix] or [offset, length]
  return [
    {
      rawOffset: Number(val[0]) || 0,
      rawLength: Number(val[1]) || 0,
      prefix: val[2],
    },
  ];
}

/**
 * Detects if a binary buffer is a Ren'Py Archive (RPA-3.0 or RPA-2.0)
 */
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
    // Check if starts with "RPA-"
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

/**
 * Parses a Ren'Py RPA archive container (RPA-3.0 and RPA-2.0).
 */
export function parseRenpyArchive(
  fileName: string,
  bytes: Uint8Array,
  startTime: number
): ParsedArchive {
  const warnings: string[] = [];

  // 1. Read first line of header
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

  // 2. Slice compressed index from indexOffset to EOF and decompress using unzlibSync
  const indexCompressed = bytes.subarray(indexOffset);
  let indexPickleBytes: Uint8Array;
  try {
    indexPickleBytes = unzlibSync(indexCompressed);
  } catch (err: any) {
    throw new Error(
      `Failed to decompress Ren'Py RPA index at offset 0x${indexOffset.toString(16)}: ${err?.message || String(err)}`
    );
  }

  // 3. Decode Python Pickle index dictionary
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

  // 4. Extract entries and apply key un-obfuscation
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

/**
 * Builds a synthetic RPA-3.0 or RPA-2.0 archive binary for testing and preset demos.
 */
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
    return new Uint8Array([0x4b, num]); // BININT1
  }
  if (num > 255 && num <= 65535) {
    const b = new Uint8Array(3);
    b[0] = 0x4d; // BININT2
    new DataView(b.buffer).setUint16(1, num, true);
    return b;
  }
  if (num > 65535 && num <= 0x7fffffff) {
    const b = new Uint8Array(5);
    b[0] = 0x4a; // BININT
    new DataView(b.buffer).setInt32(1, num, true);
    return b;
  }
  // LONG1
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
  b[0] = 0x8a; // LONG1
  b[1] = bytes.length;
  b.set(bytes, 2);
  return b;
}

/**
 * Encodes an RPA index dictionary into standard Python Pickle Protocol 2 bytes.
 */
function encodePickleProtocol2(
  index: Record<string, Array<[number, number, Uint8Array]>>
): Uint8Array {
  const parts: Uint8Array[] = [];
  const textEnc = new TextEncoder();

  // Header: \x80\x02}q\x00(
  parts.push(new Uint8Array([0x80, 0x02, 0x7d, 0x71, 0x00, 0x28]));
  let memoIdx = 1;

  for (const [path, segments] of Object.entries(index)) {
    // Key: BINUNICODE X <len4> <utf8> q <memoIdx>
    const pathBytes = textEnc.encode(path);
    const pathHeader = new Uint8Array(5);
    pathHeader[0] = 0x58; // BINUNICODE
    new DataView(pathHeader.buffer).setUint32(1, pathBytes.length, true);
    parts.push(pathHeader);
    parts.push(pathBytes);
    parts.push(new Uint8Array([0x71, memoIdx++ & 0xff]));

    // Value: EMPTY_LIST ] q <memoIdx>
    parts.push(new Uint8Array([0x5d, 0x71, memoIdx++ & 0xff]));

    for (const seg of segments) {
      const [offset, length, prefix] = seg;
      // Encode offset
      parts.push(encodePickleInt(offset));
      // Encode length
      parts.push(encodePickleInt(length));
      // Encode prefix as SHORT_BINBYTES (0x43) or BINBYTES (0x42) or SHORT_BINSTRING (0x55)
      const prefBytes = normalizePrefix(prefix);
      if (prefBytes.length <= 255) {
        const h = new Uint8Array(2);
        h[0] = 0x43; // SHORT_BINBYTES
        h[1] = prefBytes.length;
        parts.push(h);
        parts.push(prefBytes);
      } else {
        const h = new Uint8Array(5);
        h[0] = 0x42; // BINBYTES
        new DataView(h.buffer).setUint32(1, prefBytes.length, true);
        parts.push(h);
        parts.push(prefBytes);
      }
      parts.push(new Uint8Array([0x71, memoIdx++ & 0xff]));

      // TUPLE3 \x87 q <memoIdx> a (APPEND)
      parts.push(new Uint8Array([0x87, 0x71, memoIdx++ & 0xff, 0x61]));
    }
  }

  // SETITEMS u STOP .
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

  // RPA-3.0: 8 + 16 + 1 + 8 + 1 = 34 bytes
  // RPA-2.0: 8 + 16 + 1 = 25 bytes
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
