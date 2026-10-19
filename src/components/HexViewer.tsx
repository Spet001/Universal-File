import React, { useState, useMemo } from 'react';
import { Search, ArrowRight, Copy, Check } from 'lucide-react';
import { toHex, readAscii } from '../services/archiveParser';

interface HexViewerProps {
  data: Uint8Array;
  baseOffset?: number;
  title?: string;
}

const BYTES_PER_ROW = 16;
const ROWS_PER_PAGE = 32; // 512 bytes per page for instant zero-lag rendering

export const HexViewer: React.FC<HexViewerProps> = ({ data, baseOffset = 0, title }) => {
  const [selectedOffset, setSelectedOffset] = useState<number>(0);
  const [page, setPage] = useState<number>(0);
  const [jumpInput, setJumpInput] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [copiedHex, setCopiedHex] = useState<boolean>(false);

  const totalPages = Math.max(1, Math.ceil(data.length / (BYTES_PER_ROW * ROWS_PER_PAGE)));
  const safePage = Math.min(page, totalPages - 1);
  const pageStartByte = safePage * BYTES_PER_ROW * ROWS_PER_PAGE;
  const pageEndByte = Math.min(data.length, pageStartByte + BYTES_PER_ROW * ROWS_PER_PAGE);

  // Decode multi-type values at selectedOffset
  const decodedValues = useMemo(() => {
    if (data.length === 0 || selectedOffset >= data.length) {
      return null;
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const rem = data.length - selectedOffset;

    const u8 = view.getUint8(selectedOffset);
    const i8 = view.getInt8(selectedOffset);
    const u16le = rem >= 2 ? view.getUint16(selectedOffset, true) : null;
    const u16be = rem >= 2 ? view.getUint16(selectedOffset, false) : null;
    const u32le = rem >= 4 ? view.getUint32(selectedOffset, true) : null;
    const i32le = rem >= 4 ? view.getInt32(selectedOffset, true) : null;
    const u32be = rem >= 4 ? view.getUint32(selectedOffset, false) : null;
    const f32le = rem >= 4 ? view.getFloat32(selectedOffset, true) : null;
    const asciiPreview = readAscii(data, selectedOffset, Math.min(16, rem));

    return {
      u8,
      i8,
      u16le,
      u16be,
      u32le,
      i32le,
      u32be,
      f32le,
      asciiPreview,
    };
  }, [data, selectedOffset]);

  const handleJump = (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = jumpInput.trim().toLowerCase();
    if (!cleaned) return;
    const parsed = cleaned.startsWith('0x') ? parseInt(cleaned.slice(2), 16) : parseInt(cleaned, 10);
    if (!isNaN(parsed) && parsed >= 0 && parsed < data.length) {
      setSelectedOffset(parsed);
      setPage(Math.floor(parsed / (BYTES_PER_ROW * ROWS_PER_PAGE)));
    }
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const q = searchQuery.trim();
    if (!q || data.length === 0) return;

    // Support hex search if prefixed with 0x or space-separated hex pairs, otherwise ASCII case-insensitive
    let needle: number[] = [];
    if (/^([0-9a-fA-F]{2}\s*)+$/.test(q) && q.includes(' ')) {
      needle = q
        .split(/\s+/)
        .filter(Boolean)
        .map((h) => parseInt(h, 16));
    } else {
      for (let i = 0; i < q.length; i++) {
        needle.push(q.charCodeAt(i));
      }
    }

    if (needle.length === 0) return;
    const startSearch = (selectedOffset + 1) % data.length;

    for (let step = 0; step < data.length; step++) {
      const idx = (startSearch + step) % data.length;
      if (idx + needle.length > data.length) continue;
      let match = true;
      for (let k = 0; k < needle.length; k++) {
        if (data[idx + k] !== needle[k] && String.fromCharCode(data[idx + k]).toLowerCase() !== String.fromCharCode(needle[k]).toLowerCase()) {
          match = false;
          break;
        }
      }
      if (match) {
        setSelectedOffset(idx);
        setPage(Math.floor(idx / (BYTES_PER_ROW * ROWS_PER_PAGE)));
        break;
      }
    }
  };

  const handleCopyHexSlice = () => {
    const slice = data.subarray(pageStartByte, Math.min(pageEndByte, pageStartByte + 256));
    const hexStr = Array.from(slice)
      .map((b) => b.toString(16).toUpperCase().padStart(2, '0'))
      .join(' ');
    navigator.clipboard.writeText(hexStr);
    setCopiedHex(true);
    setTimeout(() => setCopiedHex(false), 1600);
  };

  const rows: number[] = [];
  for (let offset = pageStartByte; offset < pageEndByte; offset += BYTES_PER_ROW) {
    rows.push(offset);
  }

  return (
    <div className="flex flex-col h-full bg-[#0B0F17] text-slate-200 select-none">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 border-b border-slate-800/80 bg-[#0F1623]">
        <div className="flex items-center gap-3 text-xs text-slate-400 font-mono tabular-nums">
          <span className="text-slate-200 font-medium">{title || 'Binary Stream'}</span>
          <span aria-hidden="true">·</span>
          <span>{data.length.toLocaleString()} bytes</span>
          <span aria-hidden="true">·</span>
          <span>Cursor: {toHex(selectedOffset, 8)}</span>
        </div>

        <div className="flex items-center gap-2">
          <form onSubmit={handleJump} className="flex items-center">
            <input
              type="text"
              value={jumpInput}
              onChange={(e) => setJumpInput(e.target.value)}
              placeholder="Jump offset (0x100)"
              className="w-36 px-2.5 py-1 text-xs font-mono bg-[#0B0F17] border border-slate-700/80 rounded-l text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-amber-500"
            />
            <button
              type="submit"
              className="px-2 py-1 text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 border border-l-0 border-slate-700/80 rounded-r transition-colors whitespace-nowrap shrink-0"
              title="Jump to Offset"
            >
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </form>

          <form onSubmit={handleSearch} className="flex items-center">
            <div className="relative flex items-center">
              <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Find ASCII or Hex..."
                className="w-40 pl-7 pr-2.5 py-1 text-xs font-mono bg-[#0B0F17] border border-slate-700/80 rounded text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-amber-500"
              />
            </div>
          </form>

          <button
            type="button"
            onClick={handleCopyHexSlice}
            className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium bg-slate-800/90 hover:bg-slate-700 text-slate-200 border border-slate-700/80 rounded transition-colors whitespace-nowrap shrink-0"
          >
            {copiedHex ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            <span>{copiedHex ? 'Copied Hex' : 'Copy Page Hex'}</span>
          </button>
        </div>
      </div>

      {/* Main Split: Hex Matrix + Data Inspector */}
      <div className="flex-1 grid grid-cols-1 xl:grid-cols-12 min-h-0 overflow-hidden">
        {/* Hex Matrix */}
        <div className="xl:col-span-8 overflow-auto p-4 font-mono text-xs leading-6 tabular-nums border-b xl:border-b-0 xl:border-r border-slate-800/80">
          {/* Column Header */}
          <div className="flex items-center text-slate-500 pb-2 mb-2 border-b border-slate-800/80 select-none">
            <span className="w-24 shrink-0">OFFSET</span>
            <div className="flex-1 grid grid-cols-16 gap-1 text-center">
              {Array.from({ length: 16 }).map((_, idx) => (
                <span key={idx} className={idx === 8 ? 'pl-1 text-amber-400/80' : ''}>
                  {idx.toString(16).toUpperCase().padStart(2, '0')}
                </span>
              ))}
            </div>
            <span className="w-40 shrink-0 pl-4">ASCII DECODED</span>
          </div>

          {rows.length === 0 ? (
            <div className="py-12 text-center text-slate-500">Empty binary payload (0 bytes).</div>
          ) : (
            rows.map((rowOffset) => {
              const rowSlice = data.subarray(rowOffset, Math.min(data.length, rowOffset + BYTES_PER_ROW));
              return (
                <div
                  key={rowOffset}
                  className="flex items-center hover:bg-slate-900/70 rounded px-1 -mx-1 transition-colors"
                >
                  {/* Offset Column */}
                  <span className="w-24 shrink-0 text-slate-500 select-all">
                    {(baseOffset + rowOffset).toString(16).toUpperCase().padStart(8, '0')}
                  </span>

                  {/* 16 Hex Bytes */}
                  <div className="flex-1 grid grid-cols-16 gap-1 text-center">
                    {Array.from({ length: 16 }).map((_, colIdx) => {
                      const absIdx = rowOffset + colIdx;
                      if (absIdx >= data.length) {
                        return <span key={colIdx} className="text-slate-800">··</span>;
                      }
                      const byteVal = data[absIdx];
                      const isSelected = absIdx === selectedOffset;
                      const isRangeHighlight = absIdx > selectedOffset && absIdx < selectedOffset + 4;
                      const isNull = byteVal === 0;

                      return (
                        <button
                          key={colIdx}
                          type="button"
                          onClick={() => setSelectedOffset(absIdx)}
                          className={`rounded px-0.5 transition-colors ${colIdx === 8 ? 'ml-1' : ''} ${
                            isSelected
                              ? 'bg-amber-500 text-slate-950 font-semibold'
                              : isRangeHighlight
                              ? 'bg-amber-500/20 text-amber-200'
                              : isNull
                              ? 'text-slate-600 hover:text-slate-300'
                              : 'text-slate-200 hover:bg-slate-800'
                          }`}
                        >
                          {byteVal.toString(16).toUpperCase().padStart(2, '0')}
                        </button>
                      );
                    })}
                  </div>

                  {/* ASCII Column */}
                  <div className="w-40 shrink-0 pl-4 tracking-wider text-slate-400 flex">
                    {Array.from(rowSlice).map((b, colIdx) => {
                      const absIdx = rowOffset + colIdx;
                      const isSelected = absIdx === selectedOffset;
                      const ch = b >= 32 && b <= 126 ? String.fromCharCode(b) : '·';
                      return (
                        <span
                          key={colIdx}
                          onClick={() => setSelectedOffset(absIdx)}
                          className={`cursor-pointer ${
                            isSelected
                              ? 'bg-amber-500 text-slate-950 font-bold'
                              : b >= 32 && b <= 126
                              ? 'text-emerald-300/90'
                              : 'text-slate-600'
                          }`}
                        >
                          {ch}
                        </span>
                      );
                    })}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Right Column: Live Binary Data Type Inspector */}
        <div className="xl:col-span-4 p-4 bg-[#0D131F] overflow-y-auto flex flex-col justify-between gap-4">
          <div className="space-y-4">
            <div>
              <h4 className="text-xs font-semibold text-slate-300 tracking-tight mb-1">
                Data Type Inspector (Cursor +4B Highlighted)
              </h4>
              <p className="text-xs text-slate-400">
                Click any byte in the matrix to inspect integer, float, and string representations at that offset.
              </p>
            </div>

            {decodedValues ? (
              <div className="border border-slate-800 rounded-lg divide-y divide-slate-800/80 font-mono text-xs tabular-nums bg-[#0B0F17]">
                <div className="flex items-center justify-between px-3 py-2">
                  <span className="text-slate-400">Relative Offset</span>
                  <span className="text-amber-300 font-medium">
                    {toHex(selectedOffset)} ({selectedOffset.toLocaleString()})
                  </span>
                </div>
                <div className="flex items-center justify-between px-3 py-2">
                  <span className="text-slate-400">Archive Offset</span>
                  <span className="text-slate-200">
                    {toHex(baseOffset + selectedOffset)} ({(baseOffset + selectedOffset).toLocaleString()})
                  </span>
                </div>
                <div className="flex items-center justify-between px-3 py-2">
                  <span className="text-slate-400">UInt8 / Int8</span>
                  <span className="text-slate-200">
                    {decodedValues.u8} / {decodedValues.i8} (0b{decodedValues.u8.toString(2).padStart(8, '0')})
                  </span>
                </div>
                <div className="flex items-center justify-between px-3 py-2">
                  <span className="text-slate-400">UInt16 (LE / BE)</span>
                  <span className="text-slate-200">
                    {decodedValues.u16le !== null ? `${decodedValues.u16le} / ${decodedValues.u16be}` : 'EOF'}
                  </span>
                </div>
                <div className="flex items-center justify-between px-3 py-2">
                  <span className="text-slate-400">Int32 (Little Endian)</span>
                  <span className="text-emerald-300">
                    {decodedValues.i32le !== null ? decodedValues.i32le.toLocaleString() : 'EOF'}
                  </span>
                </div>
                <div className="flex items-center justify-between px-3 py-2">
                  <span className="text-slate-400">UInt32 Hex (LE / BE)</span>
                  <span className="text-slate-200">
                    {decodedValues.u32le !== null
                      ? `${toHex(decodedValues.u32le)} / ${toHex(decodedValues.u32be!)}`
                      : 'EOF'}
                  </span>
                </div>
                <div className="flex items-center justify-between px-3 py-2">
                  <span className="text-slate-400">Float32 (IEEE 754 LE)</span>
                  <span className="text-slate-200">
                    {decodedValues.f32le !== null
                      ? Number.isFinite(decodedValues.f32le)
                        ? decodedValues.f32le.toPrecision(6)
                        : 'NaN / Inf'
                      : 'EOF'}
                  </span>
                </div>
                <div className="flex items-center justify-between px-3 py-2">
                  <span className="text-slate-400">ASCII String (16B)</span>
                  <span className="text-amber-200 truncate max-w-[180px]">"{decodedValues.asciiPreview}"</span>
                </div>
              </div>
            ) : null}
          </div>

          {/* Pagination Controls */}
          <div className="pt-3 border-t border-slate-800/80 flex items-center justify-between text-xs font-mono tabular-nums">
            <button
              type="button"
              disabled={safePage === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              className="px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 transition-colors whitespace-nowrap shrink-0"
            >
              Prev 512B
            </button>
            <span className="text-slate-400">
              Page {safePage + 1} / {totalPages}
            </span>
            <button
              type="button"
              disabled={safePage >= totalPages - 1}
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              className="px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 transition-colors whitespace-nowrap shrink-0"
            >
              Next 512B
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
