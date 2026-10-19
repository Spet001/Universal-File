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
    <div className="flex flex-col h-full bg-[#06090f] text-[#cbd5e1] select-none font-mono text-xs">
      {/* Toolbar */}
      <div className="h-[26px] shrink-0 flex items-center justify-between gap-2 px-2.5 border-b border-[#182232] bg-[#0c121d]">
        <div className="flex items-center gap-2 text-[11px] text-[#64748b] truncate">
          <span className="text-slate-200 font-medium truncate">{title || 'Binary Stream'}</span>
          <span>·</span>
          <span>{data.length.toLocaleString()} B</span>
          <span>·</span>
          <span>Cursor: {toHex(selectedOffset, 8)}</span>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <form onSubmit={handleJump} className="flex items-center">
            <input
              type="text"
              value={jumpInput}
              onChange={(e) => setJumpInput(e.target.value)}
              placeholder="Jump 0x offset"
              className="w-32 h-[20px] px-1.5 text-[10px] bg-[#06090f] border border-[#182232] text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-[#38bdf8]"
            />
            <button
              type="submit"
              className="h-[20px] px-1.5 bg-[#111a29] hover:bg-[#182232] text-slate-300 border border-l-0 border-[#182232] text-[10px]"
              title="Jump"
            >
              <ArrowRight className="w-2.5 h-2.5" />
            </button>
          </form>

          <form onSubmit={handleSearch} className="flex items-center">
            <div className="relative flex items-center">
              <Search className="w-2.5 h-2.5 text-slate-600 absolute left-1.5 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Find ASCII or Hex..."
                className="w-36 h-[20px] pl-5 pr-1 text-[10px] bg-[#06090f] border border-[#182232] text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-[#38bdf8]"
              />
            </div>
          </form>

          <button
            type="button"
            onClick={handleCopyHexSlice}
            className="h-[20px] flex items-center gap-1 px-2 text-[10px] bg-[#111a29] hover:border-[#38bdf8] text-slate-200 border border-[#182232]"
          >
            {copiedHex ? <Check className="w-2.5 h-2.5 text-[#34d399]" /> : <Copy className="w-2.5 h-2.5" />}
            <span>{copiedHex ? 'Copied' : 'Copy Page'}</span>
          </button>
        </div>
      </div>

      {/* Main Split: Hex Matrix + Data Inspector */}
      <div className="flex-1 grid grid-cols-1 xl:grid-cols-12 min-h-0 overflow-hidden">
        {/* Hex Matrix */}
        <div className="xl:col-span-8 overflow-auto p-2 text-xs leading-5 tabular-nums border-b xl:border-b-0 xl:border-r border-[#182232] bg-[#06090f]">
          {/* Column Header */}
          <div className="flex items-center text-[#64748b] pb-1 mb-1 border-b border-[#182232] select-none text-[10px]">
            <span className="w-20 shrink-0">OFFSET</span>
            <div className="flex-1 grid grid-cols-16 gap-0.5 text-center">
              {Array.from({ length: 16 }).map((_, idx) => (
                <span key={idx} className={idx === 8 ? 'pl-0.5 text-[#38bdf8]' : ''}>
                  {idx.toString(16).toUpperCase().padStart(2, '0')}
                </span>
              ))}
            </div>
            <span className="w-36 shrink-0 pl-3">ASCII</span>
          </div>

          {rows.length === 0 ? (
            <div className="py-8 text-center text-[#64748b]">Empty binary payload.</div>
          ) : (
            rows.map((rowOffset) => {
              const rowSlice = data.subarray(rowOffset, Math.min(data.length, rowOffset + BYTES_PER_ROW));
              return (
                <div
                  key={rowOffset}
                  className="flex items-center hover:bg-[#38bdf8]/[0.06] px-0.5"
                >
                  {/* Offset Column */}
                  <span className="w-20 shrink-0 text-[#64748b] select-all text-[11px]">
                    {(baseOffset + rowOffset).toString(16).toUpperCase().padStart(8, '0')}
                  </span>

                  {/* 16 Hex Bytes */}
                  <div className="flex-1 grid grid-cols-16 gap-0.5 text-center text-[11px]">
                    {Array.from({ length: 16 }).map((_, colIdx) => {
                      const absIdx = rowOffset + colIdx;
                      if (absIdx >= data.length) {
                        return <span key={colIdx} className="text-[#182232]">··</span>;
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
                          className={`px-0.5 ${colIdx === 8 ? 'ml-0.5' : ''} ${
                            isSelected
                              ? 'bg-[#38bdf8] text-slate-950 font-bold'
                              : isRangeHighlight
                              ? 'bg-[#38bdf8]/20 text-[#38bdf8]'
                              : isNull
                              ? 'text-[#475569]'
                              : 'text-slate-200 hover:text-white'
                          }`}
                        >
                          {byteVal.toString(16).toUpperCase().padStart(2, '0')}
                        </button>
                      );
                    })}
                  </div>

                  {/* ASCII Column */}
                  <div className="w-36 shrink-0 pl-3 tracking-wider text-slate-400 flex text-[11px]">
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
                              ? 'bg-[#38bdf8] text-slate-950 font-bold'
                              : b >= 32 && b <= 126
                              ? 'text-[#34d399]'
                              : 'text-[#475569]'
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
        <div className="xl:col-span-4 p-3 bg-[#090d14] overflow-y-auto flex flex-col justify-between gap-3">
          <div className="space-y-2">
            <div>
              <h4 className="text-[11px] font-semibold text-[#38bdf8] uppercase tracking-wider mb-0.5">
                Data Type Inspector
              </h4>
              <p className="text-[10px] text-[#64748b]">
                Click any byte to decode integer, float, and string representations.
              </p>
            </div>

            {decodedValues ? (
              <div className="border border-[#182232] divide-y divide-[#182232] text-[11px] tabular-nums bg-[#06090f]">
                <div className="flex items-center justify-between px-2.5 py-1">
                  <span className="text-[#64748b]">Relative Offset</span>
                  <span className="text-[#38bdf8] font-medium">
                    {toHex(selectedOffset)} ({selectedOffset.toLocaleString()})
                  </span>
                </div>
                <div className="flex items-center justify-between px-2.5 py-1">
                  <span className="text-[#64748b]">Archive Offset</span>
                  <span className="text-slate-200">
                    {toHex(baseOffset + selectedOffset)} ({(baseOffset + selectedOffset).toLocaleString()})
                  </span>
                </div>
                <div className="flex items-center justify-between px-2.5 py-1">
                  <span className="text-[#64748b]">UInt8 / Int8</span>
                  <span className="text-slate-200">
                    {decodedValues.u8} / {decodedValues.i8}
                  </span>
                </div>
                <div className="flex items-center justify-between px-2.5 py-1">
                  <span className="text-[#64748b]">UInt16 (LE / BE)</span>
                  <span className="text-slate-200">
                    {decodedValues.u16le !== null ? `${decodedValues.u16le} / ${decodedValues.u16be}` : 'EOF'}
                  </span>
                </div>
                <div className="flex items-center justify-between px-2.5 py-1">
                  <span className="text-[#64748b]">Int32 (LE)</span>
                  <span className="text-[#34d399]">
                    {decodedValues.i32le !== null ? decodedValues.i32le.toLocaleString() : 'EOF'}
                  </span>
                </div>
                <div className="flex items-center justify-between px-2.5 py-1">
                  <span className="text-[#64748b]">UInt32 Hex (LE)</span>
                  <span className="text-slate-200">
                    {decodedValues.u32le !== null ? toHex(decodedValues.u32le) : 'EOF'}
                  </span>
                </div>
                <div className="flex items-center justify-between px-2.5 py-1">
                  <span className="text-[#64748b]">Float32 (IEEE 754)</span>
                  <span className="text-slate-200">
                    {decodedValues.f32le !== null
                      ? Number.isFinite(decodedValues.f32le)
                        ? decodedValues.f32le.toPrecision(6)
                        : 'NaN / Inf'
                      : 'EOF'}
                  </span>
                </div>
                <div className="flex items-center justify-between px-2.5 py-1">
                  <span className="text-[#64748b]">ASCII (16B)</span>
                  <span className="text-amber-300 truncate max-w-[150px]">"{decodedValues.asciiPreview}"</span>
                </div>
              </div>
            ) : null}
          </div>

          {/* Pagination Controls */}
          <div className="pt-2 border-t border-[#182232] flex items-center justify-between text-[10px] font-mono tabular-nums">
            <button
              type="button"
              disabled={safePage === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              className="h-[20px] px-2 bg-[#111a29] border border-[#182232] hover:border-[#38bdf8] disabled:opacity-30 text-slate-200"
            >
              Prev 512B
            </button>
            <span className="text-[#64748b]">
              Page {safePage + 1} / {totalPages}
            </span>
            <button
              type="button"
              disabled={safePage >= totalPages - 1}
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              className="h-[20px] px-2 bg-[#111a29] border border-[#182232] hover:border-[#38bdf8] disabled:opacity-30 text-slate-200"
            >
              Next 512B
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
