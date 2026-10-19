import React, { useEffect, useRef, useState, useMemo } from 'react';
import {
  Play,
  Square,
  Download,
  Save,
  Check,
  RotateCcw,
  ZoomIn,
  ZoomOut,
  FileCode,
  Volume2,
  Palette,
  Map as MapIcon,
  Image as ImageIcon,
  Upload,
  Table,
  Cpu,
  Film,
  Box,
  Sparkles,
  Gamepad2,
  Layers,
  ShieldCheck,
  Package,
  Terminal,
} from 'lucide-react';
import { ArchiveEntry, ParsedArchive } from '../types/archive';
import { formatBytes, toHex, computeCRC32 } from '../services/archiveParser';
import { disassembleT6GscInfo, looksBinary } from '../services/t5t6FastFile';
import { decodePs1Tim, Ps1TimImage } from '../services/ps1Parser';
import { parseBmodelInfo, BmodelMeshInfo } from '../services/idTech6Parser';
import { parseBinkVideo, BinkVideoInfo } from '../services/binkParser';
import { parseXbox360Xex } from '../services/xbox360Parser';
import { parseMicrosoftGameConfig, parseAppxManifestXml } from '../services/xboxGdkAppxParser';

interface AssetPreviewerProps {
  entry: ArchiveEntry;
  archive: ParsedArchive;
  onUpdateEntryData: (entryId: string, newData: Uint8Array) => void;
  onDownloadSingle: (entry: ArchiveEntry) => void;
}

export const AssetPreviewer: React.FC<AssetPreviewerProps> = ({
  entry,
  archive,
  onUpdateEntryData,
  onDownloadSingle,
}) => {
  const [editedText, setEditedText] = useState<string>('');
  const [isDirty, setIsDirty] = useState<boolean>(false);
  const [savedNotice, setSavedNotice] = useState<boolean>(false);
  const [selectedColorIdx, setSelectedColorIdx] = useState<number>(0);
  const [flatZoom, setFlatZoom] = useState<number>(4);
  const [timZoom, setTimZoom] = useState<number>(4);
  const [ndsZoom, setNdsZoom] = useState<number>(6);
  const [selectedFrameIdx, setSelectedFrameIdx] = useState<number>(0);
  const [isPlayingAudio, setIsPlayingAudio] = useState<boolean>(false);
  const [csvViewMode, setCsvViewMode] = useState<'grid' | 'raw'>('grid');

  const replaceFileInputRef = useRef<HTMLInputElement | null>(null);
  const flatCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const timCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const ndsCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const mapCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const waveCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<AudioBufferSourceNode | null>(null);

  const playpalData = useMemo(() => {
    const found = archive.entries.find((e) => e.name.toUpperCase() === 'PLAYPAL' && e.data.length >= 768);
    return found ? found.data : null;
  }, [archive.entries]);

  const isCompiledT6Gsc = useMemo(() => {
    return (
      entry.data.length >= 4 &&
      entry.data[0] === 0x80 &&
      entry.data[1] === 0x47 &&
      entry.data[2] === 0x53 &&
      entry.data[3] === 0x43
    );
  }, [entry.data]);

  const isBinaryPayload = useMemo(() => {
    if (isCompiledT6Gsc) return true;
    if (entry.id === 'ff-zone-master') return true;
    return looksBinary(entry.data);
  }, [entry.data, entry.id, isCompiledT6Gsc]);

  const decodedString = useMemo(() => {
    if (isCompiledT6Gsc || (entry.metadata?.ffKind === 'script' && isBinaryPayload)) {
      return disassembleT6GscInfo(entry.data);
    }
    if (isBinaryPayload) {
      // Render clean structured hex + ASCII dump (like Spet's hexdump()) instead of raw mojibake
      const limit = Math.min(entry.data.length, 16384);
      const lines: string[] = [];
      for (let i = 0; i < limit; i += 16) {
        const chunk = entry.data.subarray(i, Math.min(limit, i + 16));
        const hx = Array.from(chunk)
          .map((c) => c.toString(16).toUpperCase().padStart(2, '0'))
          .join(' ')
          .padEnd(47, ' ');
        let asc = '';
        for (let k = 0; k < chunk.length; k++) {
          const c = chunk[k];
          asc += c >= 32 && c < 127 ? String.fromCharCode(c) : '.';
        }
        lines.push(`${(entry.offset + i).toString(16).toUpperCase().padStart(8, '0')}  ${hx}  ${asc}`);
      }
      if (entry.data.length > limit) {
        lines.push(`... (${(entry.data.length - limit).toLocaleString()} more bytes — switch to Entry Hex View for full stream)`);
      }
      return lines.join('\n');
    }
    const dec = new TextDecoder('utf-8', { fatal: false });
    return dec.decode(entry.data.subarray(0, Math.min(entry.data.length, 256 * 1024)));
  }, [entry, isCompiledT6Gsc, isBinaryPayload]);

  useEffect(() => {
    setEditedText(decodedString);
    setIsDirty(false);
    setSavedNotice(false);
    stopAudio();
  }, [entry.id, decodedString]);

  // 1. Render DOOM 64x64 Floor Flat on Canvas using PLAYPAL
  useEffect(() => {
    if (entry.data.length !== 4096 || !flatCanvasRef.current) return;
    const ctx = flatCanvasRef.current.getContext('2d');
    if (!ctx) return;

    const imgData = ctx.createImageData(64, 64);
    for (let i = 0; i < 4096; i++) {
      const colorIndex = entry.data[i];
      if (playpalData && colorIndex * 3 + 2 < playpalData.length) {
        imgData.data[i * 4] = playpalData[colorIndex * 3];
        imgData.data[i * 4 + 1] = playpalData[colorIndex * 3 + 1];
        imgData.data[i * 4 + 2] = playpalData[colorIndex * 3 + 2];
        imgData.data[i * 4 + 3] = 255;
      } else {
        imgData.data[i * 4] = colorIndex;
        imgData.data[i * 4 + 1] = colorIndex;
        imgData.data[i * 4 + 2] = colorIndex;
        imgData.data[i * 4 + 3] = 255;
      }
    }
    ctx.putImageData(imgData, 0, 0);
  }, [entry, playpalData]);

  // 2. Render DOOM 2D Map Vector Geometry (VERTEXES + LINEDEFS)
  const mapGeometry = useMemo(() => {
    if (archive.formatId !== 'WAD') return null;
    const upper = entry.name.toUpperCase();
    if (!['E1M1', 'MAP01', 'VERTEXES', 'LINEDEFS', 'SECTORS', 'THINGS'].includes(upper)) return null;

    const vertEntry = archive.entries.find((e) => e.name.toUpperCase() === 'VERTEXES');
    const lineEntry = archive.entries.find((e) => e.name.toUpperCase() === 'LINEDEFS');
    if (!vertEntry || !lineEntry || vertEntry.data.length < 8 || lineEntry.data.length < 14) return null;

    const vView = new DataView(vertEntry.data.buffer, vertEntry.data.byteOffset, vertEntry.data.byteLength);
    const lView = new DataView(lineEntry.data.buffer, lineEntry.data.byteOffset, lineEntry.data.byteLength);

    const numVerts = Math.floor(vertEntry.data.length / 4);
    const verts: { x: number; y: number }[] = [];
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;

    for (let i = 0; i < numVerts; i++) {
      const x = vView.getInt16(i * 4, true);
      const y = vView.getInt16(i * 4 + 2, true);
      verts.push({ x, y });
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }

    const numLines = Math.floor(lineEntry.data.length / 14);
    const lines: { v1: number; v2: number; flags: number }[] = [];
    for (let i = 0; i < numLines; i++) {
      const v1 = lView.getUint16(i * 14, true);
      const v2 = lView.getUint16(i * 14 + 2, true);
      const flags = lView.getUint16(i * 14 + 4, true);
      if (v1 < verts.length && v2 < verts.length) {
        lines.push({ v1, v2, flags });
      }
    }

    return { verts, lines, minX, maxX, minY, maxY };
  }, [archive, entry]);

  useEffect(() => {
    if (!mapGeometry || !mapCanvasRef.current) return;
    const canvas = mapCanvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { verts, lines, minX, maxX, minY, maxY } = mapGeometry;
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    ctx.strokeStyle = '#162032';
    ctx.lineWidth = 1;
    for (let gx = 0; gx < width; gx += 32) {
      ctx.beginPath();
      ctx.moveTo(gx, 0);
      ctx.lineTo(gx, height);
      ctx.stroke();
    }
    for (let gy = 0; gy < height; gy += 32) {
      ctx.beginPath();
      ctx.moveTo(0, gy);
      ctx.lineTo(width, gy);
      ctx.stroke();
    }

    const spanX = Math.max(1, maxX - minX);
    const spanY = Math.max(1, maxY - minY);
    const pad = 40;
    const scale = Math.min((width - pad * 2) / spanX, (height - pad * 2) / spanY);

    const toScreenX = (x: number) => width / 2 + (x - (minX + maxX) / 2) * scale;
    const toScreenY = (y: number) => height / 2 - (y - (minY + maxY) / 2) * scale;

    for (const ln of lines) {
      const p1 = verts[ln.v1];
      const p2 = verts[ln.v2];
      ctx.beginPath();
      ctx.moveTo(toScreenX(p1.x), toScreenY(p1.y));
      ctx.lineTo(toScreenX(p2.x), toScreenY(p2.y));
      ctx.strokeStyle = (ln.flags & 4) !== 0 ? '#F59E0B' : '#EF4444';
      ctx.lineWidth = (ln.flags & 4) !== 0 ? 1.5 : 2.25;
      ctx.stroke();
    }

    ctx.fillStyle = '#38BDF8';
    for (const v of verts) {
      ctx.beginPath();
      ctx.arc(toScreenX(v.x), toScreenY(v.y), 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [mapGeometry]);

  // 3. Render Audio Waveform if entry is audio
  useEffect(() => {
    if (entry.category !== 'audio' || !waveCanvasRef.current) return;
    const canvas = waveCanvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    ctx.strokeStyle = '#1E293B';
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    if (entry.data.length <= 44) return;
    const view = new DataView(entry.data.buffer, entry.data.byteOffset, entry.data.byteLength);
    const numSamples = Math.floor((entry.data.length - 44) / 2);
    const step = Math.max(1, Math.floor(numSamples / w));

    ctx.strokeStyle = '#F59E0B';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let x = 0; x < w; x++) {
      const sampleIdx = Math.min(numSamples - 1, x * step);
      const bytePos = 44 + sampleIdx * 2;
      if (bytePos + 2 > entry.data.length) break;
      const pcm = view.getInt16(bytePos, true) / 32768;
      const y = h / 2 - pcm * (h * 0.42);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }, [entry]);

  const stopAudio = () => {
    if (audioSourceRef.current) {
      try {
        audioSourceRef.current.stop();
      } catch {
        // ignore
      }
      audioSourceRef.current = null;
    }
    setIsPlayingAudio(false);
  };

  const handlePlayAudio = async () => {
    if (isPlayingAudio) {
      stopAudio();
      return;
    }
    try {
      if (!audioCtxRef.current) {
        audioCtxRef.current = new AudioContext();
      }
      const ctx = audioCtxRef.current;
      const copyBuffer = entry.data.slice().buffer;
      const decoded = await ctx.decodeAudioData(copyBuffer);
      const source = ctx.createBufferSource();
      source.buffer = decoded;
      source.connect(ctx.destination);
      source.onended = () => setIsPlayingAudio(false);
      audioSourceRef.current = source;
      setIsPlayingAudio(true);
      source.start(0);
    } catch {
      setIsPlayingAudio(false);
    }
  };

  const handleSaveTextChanges = () => {
    const encoded = new TextEncoder().encode(editedText);
    onUpdateEntryData(entry.id, encoded);
    setIsDirty(false);
    setSavedNotice(true);
    setTimeout(() => setSavedNotice(false), 2000);
  };

  const handleReplaceBinaryFromDisk = async (file: File) => {
    const buf = new Uint8Array(await file.arrayBuffer());
    onUpdateEntryData(entry.id, buf);
    setSavedNotice(true);
    setTimeout(() => setSavedNotice(false), 2000);
  };

  // 4. PS1 .TIM Texture image decoder & canvas renderer
  const ps1Tim = useMemo(() => {
    if (
      entry.metadata?.isPs1Tim ||
      entry.name.toLowerCase().endsWith('.tim') ||
      (entry.data.length >= 16 && entry.data[0] === 0x10 && entry.data[1] === 0x00)
    ) {
      return decodePs1Tim(entry.data);
    }
    return null;
  }, [entry]);

  useEffect(() => {
    if (!ps1Tim || !timCanvasRef.current) return;
    const canvas = timCanvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvas.width = ps1Tim.pixelWidth;
    canvas.height = ps1Tim.imgHeight;
    const imgData = new ImageData(
      new Uint8ClampedArray(ps1Tim.rgbaPixels),
      ps1Tim.pixelWidth,
      ps1Tim.imgHeight
    );
    ctx.putImageData(imgData, 0, 0);
  }, [ps1Tim]);

  // NDS 32x32 4bpp Banner Icon Canvas Renderer
  useEffect(() => {
    if (!entry.metadata?.isNdsIcon || !ndsCanvasRef.current) return;
    const canvas = ndsCanvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvas.width = 32;
    canvas.height = 32;
    const imgData = new ImageData(new Uint8ClampedArray(entry.data), 32, 32);
    ctx.putImageData(imgData, 0, 0);
  }, [entry]);

  // 5. RAD Game Tools Bink Video (.bik / .bk2) inspector
  const binkVideo = useMemo(() => {
    if (
      entry.category === 'video' ||
      entry.name.toLowerCase().endsWith('.bik') ||
      entry.name.toLowerCase().endsWith('.bk2') ||
      (entry.data.length >= 44 &&
        ((entry.data[0] === 0x42 && entry.data[1] === 0x49 && entry.data[2] === 0x4b) ||
          (entry.data[0] === 0x4b && entry.data[1] === 0x42 && entry.data[2] === 0x32)))
    ) {
      try {
        const parsed = parseBinkVideo(entry.name, entry.data, 0);
        return {
          info: parsed.extraInfo as unknown as BinkVideoInfo,
          headerFields: parsed.headerFields,
          timelineText: new TextDecoder('ascii', { fatal: false }).decode(parsed.entries[0]?.data || new Uint8Array(0)),
        };
      } catch {
        return null;
      }
    }
    return null;
  }, [entry]);

  // 6. id Tech 6 Binary Model (.bmodel) mesh inspector
  const bmodelMesh = useMemo(() => {
    if (
      entry.name.toLowerCase().endsWith('.bmodel') ||
      (entry.data.length >= 4 &&
        entry.data[0] === 0x1b &&
        entry.data[1] === 0x4c &&
        entry.data[2] === 0x4d &&
        entry.data[3] === 0x42)
    ) {
      return parseBmodelInfo(entry.data);
    }
    return null;
  }, [entry]);

  // 7. Xbox 360 Executable (XEX2) Header & Section Analysis
  const xexInfo = useMemo(() => {
    const isXex =
      entry.metadata?.isXex ||
      entry.name.toLowerCase().endsWith('.xex') ||
      (entry.data.length >= 24 &&
        entry.data[0] === 0x58 &&
        entry.data[1] === 0x45 &&
        entry.data[2] === 0x58 &&
        (entry.data[3] === 0x32 || entry.data[3] === 0x31));
    if (!isXex) return null;
    try {
      return parseXbox360Xex(entry.name, entry.data, 0);
    } catch {
      return null;
    }
  }, [entry]);

  // 8. Xbox GDK MicrosoftGame.config Inspector
  const gdkConfigInfo = useMemo(() => {
    const lower = entry.name.toLowerCase();
    if (lower === 'microsoftgame.config' || entry.metadata?.isGdkConfig) {
      try {
        const text = new TextDecoder('utf-8', { fatal: false }).decode(entry.data);
        return parseMicrosoftGameConfig(text);
      } catch {
        return null;
      }
    }
    return null;
  }, [entry]);

  // 9. UWP / AppX Package Manifest Inspector
  const appxManifestInfo = useMemo(() => {
    const lower = entry.name.toLowerCase();
    if (lower === 'appxmanifest.xml' || entry.metadata?.isAppxManifest) {
      try {
        const text = new TextDecoder('utf-8', { fatal: false }).decode(entry.data);
        return parseAppxManifestXml(text);
      } catch {
        return null;
      }
    }
    return null;
  }, [entry]);

  const imageBlobUrl = useMemo(() => {
    const lower = entry.name.toLowerCase();
    if (
      lower.endsWith('.png') ||
      lower.endsWith('.jpg') ||
      lower.endsWith('.jpeg') ||
      lower.endsWith('.gif') ||
      lower.endsWith('.webp') ||
      lower.endsWith('.bmp')
    ) {
      const blob = new Blob([entry.data.buffer as ArrayBuffer]);
      return URL.createObjectURL(blob);
    }
    return null;
  }, [entry]);

  useEffect(() => {
    return () => {
      if (imageBlobUrl) URL.revokeObjectURL(imageBlobUrl);
    };
  }, [imageBlobUrl]);

  // Parse CSV rows if entry is a StringTable (.csv)
  const parsedCsvRows = useMemo(() => {
    if (entry.metadata?.ffKind !== 'stringtable' && !entry.name.toLowerCase().endsWith('.csv')) {
      return null;
    }
    const text = new TextDecoder('utf-8', { fatal: false }).decode(entry.data);
    const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
    return lines.slice(0, 250).map((line) => line.split(','));
  }, [entry]);

  // Render PLAYPAL 256-Color Swatch Grid
  if (entry.category === 'palette' && entry.data.length >= 768) {
    const r = entry.data[selectedColorIdx * 3];
    const g = entry.data[selectedColorIdx * 3 + 1];
    const b = entry.data[selectedColorIdx * 3 + 2];
    const hexColor = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b
      .toString(16)
      .padStart(2, '0')}`.toUpperCase();

    return (
      <div className="p-5 space-y-5 overflow-y-auto h-full">
        <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-[#182232]">
          <div>
            <div className="flex items-center gap-2">
              <Palette className="w-4 h-4 text-amber-400" />
              <h3 className="text-sm font-semibold text-slate-100">
                256-Color Indexed Game Palette ({entry.name})
              </h3>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              768-byte RGB color lookup table (256 × 24-bit triples). Select any swatch to inspect exact register values.
            </p>
          </div>
          <button
            type="button"
            onClick={() => onDownloadSingle(entry)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-100 rounded-none border border-[#182232] transition-colors whitespace-nowrap shrink-0"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Extract Raw .PAL</span>
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <div className="lg:col-span-8 grid grid-cols-16 gap-1 p-3 bg-[#06090f] border border-[#182232] rounded-none">
            {Array.from({ length: 256 }).map((_, idx) => {
              const cr = entry.data[idx * 3];
              const cg = entry.data[idx * 3 + 1];
              const cb = entry.data[idx * 3 + 2];
              const isSel = idx === selectedColorIdx;
              return (
                <button
                  key={idx}
                  type="button"
                  onClick={() => setSelectedColorIdx(idx)}
                  style={{ backgroundColor: `rgb(${cr}, ${cg}, ${cb})` }}
                  className={`aspect-square rounded-none-[2px] transition-transform ${
                    isSel ? 'ring-2 ring-white scale-110 z-10' : 'hover:scale-105'
                  }`}
                  title={`Index #${idx}: rgb(${cr}, ${cg}, ${cb})`}
                />
              );
            })}
          </div>

          <div className="lg:col-span-4 border border-[#182232] rounded-none p-4 bg-[#090d14] space-y-4 font-mono text-xs tabular-nums">
            <div className="flex items-center gap-3">
              <div
                className="w-12 h-12 rounded-none border border-[#182232] shrink-0"
                style={{ backgroundColor: hexColor }}
              />
              <div>
                <div className="text-slate-400">Palette Index #{selectedColorIdx}</div>
                <div className="text-base font-bold text-slate-100">{hexColor}</div>
              </div>
            </div>
            <div className="space-y-2 pt-2 border-t border-[#182232]">
              <div className="flex justify-between">
                <span className="text-slate-400">Byte Offset</span>
                <span className="text-slate-200">{toHex(selectedColorIdx * 3, 4)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Red (8-bit)</span>
                <span className="text-rose-400">{r}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Green (8-bit)</span>
                <span className="text-emerald-400">{g}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Blue (8-bit)</span>
                <span className="text-sky-400">{b}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Render DOOM 64x64 Flat Texture (4096 bytes)
  if (entry.data.length === 4096 && entry.category === 'texture') {
    return (
      <div className="p-5 space-y-5 overflow-y-auto h-full">
        <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-[#182232]">
          <div>
            <div className="flex items-center gap-2">
              <ImageIcon className="w-4 h-4 text-amber-400" />
              <h3 className="text-sm font-semibold text-slate-100">
                64×64 Indexed Floor/Ceiling Flat Texture ({entry.name})
              </h3>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              Decoded in real time using the archive&apos;s PLAYPAL 256-color lookup table (4,096 pixels).
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setFlatZoom((z) => Math.max(2, z - 1))}
              className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-none border border-[#182232]"
              title="Zoom Out"
            >
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
            <span className="text-xs font-mono tabular-nums text-slate-300 px-1">{flatZoom * 100}%</span>
            <button
              type="button"
              onClick={() => setFlatZoom((z) => Math.min(6, z + 1))}
              className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-none border border-[#182232]"
              title="Zoom In"
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        <div className="flex flex-col items-center justify-center p-8 bg-[#06090f] border border-[#182232] rounded-none">
          <canvas
            ref={flatCanvasRef}
            width={64}
            height={64}
            style={{
              width: `${64 * flatZoom}px`,
              height: `${64 * flatZoom}px`,
              imageRendering: 'pixelated',
            }}
            className="border border-[#182232] shadow-lg"
          />
          <div className="mt-3 text-xs font-mono text-slate-400 tabular-nums">
            64 × 64 px · 8-bit Indexed Color · {playpalData ? 'PLAYPAL Active' : 'Grayscale Fallback'}
          </div>
        </div>
      </div>
    );
  }

  // Render DOOM 2D Map Vector Geometry
  if (mapGeometry) {
    return (
      <div className="p-5 space-y-4 overflow-y-auto h-full">
        <div className="flex flex-wrap items-center justify-between gap-4 pb-3 border-b border-[#182232]">
          <div>
            <div className="flex items-center gap-2">
              <MapIcon className="w-4 h-4 text-amber-400" />
              <h3 className="text-sm font-semibold text-slate-100">
                WAD Level Vector Map Inspector ({entry.name})
              </h3>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              Reconstructed from VERTEXES ({mapGeometry.verts.length} pts) and LINEDEFS ({mapGeometry.lines.length} walls). Crimson = 1-sided wall, Amber = 2-sided portal.
            </p>
          </div>
          <div className="text-xs font-mono tabular-nums text-slate-400">
            Bounds: [{mapGeometry.minX}, {mapGeometry.minY}] to [{mapGeometry.maxX}, {mapGeometry.maxY}]
          </div>
        </div>

        <div className="flex items-center justify-center bg-[#06090f] border border-[#182232] rounded-none p-4">
          <canvas
            ref={mapCanvasRef}
            width={680}
            height={380}
            className="max-w-full h-auto rounded-none border border-[#182232]"
          />
        </div>
      </div>
    );
  }

  // Render Audio Waveform Player
  if (entry.category === 'audio') {
    return (
      <div className="p-5 space-y-5 overflow-y-auto h-full">
        <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-[#182232]">
          <div>
            <div className="flex items-center gap-2">
              <Volume2 className="w-4 h-4 text-amber-400" />
              <h3 className="text-sm font-semibold text-slate-100">PCM / Game Audio Stream ({entry.name})</h3>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              RIFF WAVE audio asset ({formatBytes(entry.uncompressedSize)}). Click Play to audition via Web Audio API.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handlePlayAudio}
              className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium bg-amber-500 hover:bg-amber-400 text-slate-950 rounded-none transition-colors whitespace-nowrap shrink-0"
            >
              {isPlayingAudio ? <Square className="w-3.5 h-3.5 fill-current" /> : <Play className="w-3.5 h-3.5 fill-current" />}
              <span>{isPlayingAudio ? 'Stop Audio' : 'Play Sound Effect'}</span>
            </button>
            <button
              type="button"
              onClick={() => onDownloadSingle(entry)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-none border border-[#182232] transition-colors whitespace-nowrap shrink-0"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Export .WAV</span>
            </button>
          </div>
        </div>

        <div className="p-4 bg-[#06090f] border border-[#182232] rounded-none">
          <canvas ref={waveCanvasRef} width={720} height={180} className="w-full h-44" />
        </div>
      </div>
    );
  }

  // Render RAD Game Tools Bink Video (.bik / .bk2)
  if (binkVideo) {
    const { info, timelineText } = binkVideo;
    return (
      <div className="p-5 space-y-5 overflow-y-auto h-full bg-[#06090f]">
        <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-[#182232]">
          <div className="flex items-center gap-2">
            <Film className="w-5 h-5 text-amber-400" />
            <div>
              <h3 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
                <span>{entry.name}</span>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-none bg-amber-500/10 text-amber-400 border border-amber-500/20">
                  {info.isBink2 ? 'BINK 2 VIDEO' : 'BINK 1 VIDEO'}
                </span>
              </h3>
              <p className="text-xs text-slate-400">
                RAD Game Tools Video Container · {formatBytes(entry.data.length)}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => onDownloadSingle(entry)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-amber-500 hover:bg-amber-400 text-slate-950 rounded-none transition-colors whitespace-nowrap shrink-0"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export .BIK Stream</span>
          </button>
        </div>

        {/* Video Metadata Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="p-3 bg-[#0c121d] border border-[#182232] rounded-none">
            <div className="text-[10px] uppercase font-mono tracking-wider text-slate-500">Resolution</div>
            <div className="text-base font-semibold font-mono text-slate-200 mt-0.5">
              {info.width} × {info.height}
            </div>
            <div className="text-[11px] text-slate-500 mt-0.5 font-mono">
              Aspect {Math.round((info.width / Math.max(1, info.height)) * 100) / 100}:1
            </div>
          </div>

          <div className="p-3 bg-[#0c121d] border border-[#182232] rounded-none">
            <div className="text-[10px] uppercase font-mono tracking-wider text-slate-500">Framerate & Speed</div>
            <div className="text-base font-semibold font-mono text-amber-400 mt-0.5">
              {info.fps.toFixed(2)} FPS
            </div>
            <div className="text-[11px] text-slate-500 mt-0.5 font-mono">
              Divisor: {info.fpsDenominator}
            </div>
          </div>

          <div className="p-3 bg-[#0c121d] border border-[#182232] rounded-none">
            <div className="text-[10px] uppercase font-mono tracking-wider text-slate-500">Duration & Frames</div>
            <div className="text-base font-semibold font-mono text-slate-200 mt-0.5">
              {Math.floor(info.durationSeconds / 60)}m {(info.durationSeconds % 60).toFixed(1)}s
            </div>
            <div className="text-[11px] text-slate-500 mt-0.5 font-mono">
              {info.numFrames.toLocaleString()} frames total
            </div>
          </div>

          <div className="p-3 bg-[#0c121d] border border-[#182232] rounded-none">
            <div className="text-[10px] uppercase font-mono tracking-wider text-slate-500">Audio Channels</div>
            <div className="text-base font-semibold font-mono text-slate-200 mt-0.5">
              {info.audioTracks?.length || 0} Track(s)
            </div>
            <div className="text-[11px] text-slate-500 mt-0.5 font-mono">
              {info.audioTracks?.[0] ? `${info.audioTracks[0].sampleRate} Hz · ${info.audioTracks[0].channels === 2 ? 'Stereo' : 'Mono'}` : 'Muted'}
            </div>
          </div>
        </div>

        {/* Audio Track Breakdown */}
        {info.audioTracks && info.audioTracks.length > 0 && (
          <div className="p-4 bg-[#06090f] border border-[#182232] rounded-none space-y-2">
            <div className="flex items-center gap-2 text-xs font-semibold text-slate-300">
              <Volume2 className="w-3.5 h-3.5 text-amber-400" />
              <span>Embedded Audio Streams</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {info.audioTracks.map((tr) => (
                <div key={tr.trackIndex} className="p-2.5 bg-[#0c121d] border border-[#182232] rounded-none flex items-center justify-between text-xs font-mono">
                  <span className="text-slate-300">Track #{tr.trackIndex}</span>
                  <span className="text-slate-400">{tr.sampleRate} Hz</span>
                  <span className="px-2 py-0.5 rounded-none bg-slate-800 text-amber-300 text-[11px]">
                    {tr.channels === 2 ? 'Stereo (2ch)' : 'Mono (1ch)'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Frame Seek Timeline Visualizer */}
        <div className="p-4 bg-[#06090f] border border-[#182232] rounded-none space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-xs font-semibold text-slate-300 flex items-center gap-2">
              <Film className="w-3.5 h-3.5 text-amber-400" />
              <span>Video Frame Index Timeline (First {Math.min(info.frames?.length || 0, 100)} Frames)</span>
            </div>
            <div className="flex items-center gap-3 text-[11px] font-mono">
              <span className="flex items-center gap-1.5 text-amber-400">
                <span className="w-2.5 h-2.5 rounded-none-[2px] bg-amber-400 inline-block" /> Keyframe (I-Frame)
              </span>
              <span className="flex items-center gap-1.5 text-slate-400">
                <span className="w-2.5 h-2.5 rounded-none-[2px] bg-slate-700 inline-block" /> Delta (P-Frame)
              </span>
            </div>
          </div>

          <div className="h-16 flex items-end gap-0.5 bg-[#0c121d] p-2 rounded-none border border-[#182232] overflow-x-auto">
            {info.frames?.slice(0, 120).map((f) => {
              const maxS = Math.max(1, info.largestFrame || 65536);
              const heightPct = Math.min(100, Math.max(8, Math.round((f.size / maxS) * 100)));
              const isSelected = selectedFrameIdx === f.frameIndex;
              return (
                <button
                  key={f.frameIndex}
                  type="button"
                  onClick={() => setSelectedFrameIdx(f.frameIndex)}
                  title={`Frame #${f.frameIndex}: ${f.size.toLocaleString()} B (${f.isKeyframe ? 'KEYFRAME' : 'Delta'})`}
                  className={`w-2 min-w-[6px] rounded-none transition-all ${
                    f.isKeyframe
                      ? isSelected ? 'bg-amber-300' : 'bg-amber-500 hover:bg-amber-400'
                      : isSelected ? 'bg-slate-300' : 'bg-slate-700 hover:bg-slate-600'
                  }`}
                  style={{ height: `${heightPct}%` }}
                />
              );
            })}
          </div>

          {info.frames && info.frames[selectedFrameIdx] && (
            <div className="p-2.5 bg-[#0c121d] rounded-none border border-[#182232] flex items-center justify-between text-xs font-mono">
              <span className="text-slate-300">
                Selected Frame #{selectedFrameIdx}
              </span>
              <span className="text-amber-400">
                {info.frames[selectedFrameIdx].isKeyframe ? 'KEYFRAME (Full Frame)' : 'Delta (Inter-frame)'}
              </span>
              <span className="text-slate-400">
                Size: {info.frames[selectedFrameIdx].size.toLocaleString()} Bytes
              </span>
              <span className="text-slate-500">
                Offset: 0x{info.frames[selectedFrameIdx].offset.toString(16).toUpperCase()}
              </span>
            </div>
          )}
        </div>

        {/* Seek Table Dump */}
        <div className="p-4 bg-[#06090f] border border-[#182232] rounded-none space-y-2">
          <div className="text-xs font-semibold text-slate-300">Timeline Seek Table Header Report</div>
          <pre className="p-3 bg-[#06090f] text-slate-300 font-mono text-xs rounded-none border border-[#182232] max-h-56 overflow-y-auto leading-5 select-text">
            {timelineText}
          </pre>
        </div>
      </div>
    );
  }

  // Render PS1 .TIM Texture with CLUT
  if (ps1Tim) {
    return (
      <div className="p-5 space-y-4 overflow-y-auto h-full bg-[#06090f]">
        <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-[#182232]">
          <div className="flex items-center gap-2">
            <ImageIcon className="w-5 h-5 text-amber-400" />
            <div>
              <h3 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
                <span>{entry.name}</span>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-none bg-amber-500/10 text-amber-400 border border-amber-500/20">
                  PS1 TIM TEXTURE
                </span>
              </h3>
              <p className="text-xs text-slate-400">
                PlayStation 1 {ps1Tim.bpp}-bit Indexed Texture · {ps1Tim.pixelWidth} × {ps1Tim.imgHeight} px
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 bg-slate-900 border border-[#182232] rounded-none p-1">
              {[1, 2, 4, 8].map((z) => (
                <button
                  key={z}
                  type="button"
                  onClick={() => setTimZoom(z)}
                  className={`px-2 py-0.5 text-xs font-mono rounded-none ${
                    timZoom === z ? 'bg-amber-500 text-slate-950 font-semibold' : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {z}x
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => onDownloadSingle(entry)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-none border border-[#182232] transition-colors whitespace-nowrap shrink-0"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Export .TIM</span>
            </button>
          </div>
        </div>

        {/* PS1 Texture Canvas */}
        <div className="flex items-center justify-center p-8 bg-[#06090f] border border-[#182232] rounded-none overflow-auto min-h-[220px]">
          <canvas
            ref={timCanvasRef}
            className="border border-[#182232] shadow-2xl image-rendering-pixelated"
            style={{
              width: ps1Tim.pixelWidth * timZoom,
              height: ps1Tim.imgHeight * timZoom,
              imageRendering: 'pixelated',
            }}
          />
        </div>

        {/* CLUT Palette Swatches */}
        {ps1Tim.paletteColorsRgba.length > 0 && (
          <div className="p-4 bg-[#06090f] border border-[#182232] rounded-none space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-xs font-semibold text-slate-300 flex items-center gap-2">
                <Palette className="w-3.5 h-3.5 text-amber-400" />
                <span>CLUT Color Lookup Table ({ps1Tim.paletteColorsRgba.length} Colors)</span>
              </div>
              <span className="text-[11px] font-mono text-slate-500">
                CLUT VRAM X:{ps1Tim.clutX} Y:{ps1Tim.clutY}
              </span>
            </div>

            <div className="flex flex-wrap gap-1 p-2 bg-[#0c121d] rounded-none border border-[#182232] max-h-32 overflow-y-auto">
              {ps1Tim.paletteColorsRgba.map((col, idx) => (
                <div
                  key={idx}
                  title={`Color #${idx}: RGBA(${col[0]}, ${col[1]}, ${col[2]}, ${col[3]})`}
                  className="w-5 h-5 rounded-none-[2px] border border-[#182232] cursor-pointer hover:scale-125 transition-transform"
                  style={{ backgroundColor: `rgba(${col[0]}, ${col[1]}, ${col[2]}, ${col[3] / 255})` }}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  // Render Nintendo DS 32x32 4bpp Banner Icon
  if (entry.metadata?.isNdsIcon) {
    return (
      <div className="p-5 space-y-5 overflow-y-auto h-full bg-[#06090f]">
        <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-[#182232]">
          <div className="flex items-center gap-2">
            <Gamepad2 className="w-5 h-5 text-rose-400" />
            <div>
              <h3 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
                <span>{entry.name}</span>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-none bg-rose-500/10 text-rose-400 border border-rose-500/20 font-semibold">
                  NINTENDO DS BANNER ICON
                </span>
              </h3>
              <p className="text-xs text-slate-400">
                32 × 32 px · 4bpp Tiled Cartridge Icon · 16 BGR555 Paletted Colors
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 bg-slate-900 border border-[#182232] rounded-none p-1">
              {[2, 4, 6, 8].map((z) => (
                <button
                  key={z}
                  type="button"
                  onClick={() => setNdsZoom(z)}
                  className={`px-2 py-0.5 text-xs font-mono rounded-none ${
                    ndsZoom === z ? 'bg-rose-500 text-white font-semibold' : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {z}x
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => onDownloadSingle(entry)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-rose-500 hover:bg-rose-400 text-white font-semibold rounded-none transition-colors whitespace-nowrap shrink-0"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Export Icon</span>
            </button>
          </div>
        </div>

        <div className="flex items-center justify-center p-8 bg-[#06090f] border border-[#182232] rounded-none min-h-[220px]">
          <canvas
            ref={ndsCanvasRef}
            className="border-2 border-[#182232] shadow-2xl rounded-none"
            style={{
              width: 32 * ndsZoom,
              height: 32 * ndsZoom,
              imageRendering: 'pixelated',
            }}
          />
        </div>
      </div>
    );
  }

  // Render id Tech 6 Binary Model (.bmodel) Mesh Geometry
  if (bmodelMesh) {
    return (
      <div className="p-5 space-y-5 overflow-y-auto h-full bg-[#06090f]">
        <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-[#182232]">
          <div className="flex items-center gap-2">
            <Box className="w-5 h-5 text-amber-400" />
            <div>
              <h3 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
                <span>{entry.name}</span>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-none bg-amber-500/10 text-amber-400 border border-amber-500/20">
                  id Tech 6 BMODEL
                </span>
              </h3>
              <p className="text-xs text-slate-400">
                DOOM (2016) Pre-Processed 3D Geometry Model · {formatBytes(entry.data.length)}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => onDownloadSingle(entry)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-amber-500 hover:bg-amber-400 text-slate-950 rounded-none transition-colors whitespace-nowrap shrink-0"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export .bmodel</span>
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="p-3 bg-[#0c121d] border border-[#182232] rounded-none">
            <div className="text-[10px] uppercase font-mono tracking-wider text-slate-500">Sub-Meshes</div>
            <div className="text-lg font-semibold font-mono text-amber-400 mt-0.5">
              {bmodelMesh.meshes.length}
            </div>
          </div>
          <div className="p-3 bg-[#0c121d] border border-[#182232] rounded-none">
            <div className="text-[10px] uppercase font-mono tracking-wider text-slate-500">Total Vertices</div>
            <div className="text-lg font-semibold font-mono text-slate-200 mt-0.5">
              {bmodelMesh.meshes.reduce((acc, m) => acc + m.vertexCount, 0).toLocaleString()}
            </div>
          </div>
          <div className="p-3 bg-[#0c121d] border border-[#182232] rounded-none">
            <div className="text-[10px] uppercase font-mono tracking-wider text-slate-500">Total Faces</div>
            <div className="text-lg font-semibold font-mono text-slate-200 mt-0.5">
              {bmodelMesh.meshes.reduce((acc, m) => acc + m.faceCount, 0).toLocaleString()}
            </div>
          </div>
        </div>

        <div className="p-4 bg-[#06090f] border border-[#182232] rounded-none space-y-3">
          <div className="text-xs font-semibold text-slate-300 flex items-center gap-2">
            <Box className="w-3.5 h-3.5 text-amber-400" />
            <span>Indexed Sub-Meshes & Material Bindings</span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs font-mono border-collapse border border-[#182232]">
              <thead>
                <tr className="bg-[#0c121d] text-amber-400 border-b border-[#182232] text-left">
                  <th className="py-2 px-3 border-r border-[#182232]">#</th>
                  <th className="py-2 px-3 border-r border-[#182232]">Material Shader Binding</th>
                  <th className="py-2 px-3 border-r border-[#182232] text-right">Vertices</th>
                  <th className="py-2 px-3 text-right">Faces</th>
                </tr>
              </thead>
              <tbody>
                {bmodelMesh.meshes.map((m, idx) => (
                  <tr key={idx} className="border-b border-[#182232] hover:bg-slate-900/50">
                    <td className="py-2 px-3 text-slate-500 border-r border-[#182232]">{idx}</td>
                    <td className="py-2 px-3 text-slate-200 font-medium border-r border-[#182232]">{m.materialName}</td>
                    <td className="py-2 px-3 text-right text-slate-300 tabular-nums border-r border-[#182232]">{m.vertexCount.toLocaleString()}</td>
                    <td className="py-2 px-3 text-right text-slate-300 tabular-nums">{m.faceCount.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  }

  // Render Xbox 360 Executable (XEX2) Analysis Dashboard
  if (xexInfo) {
    const extra = (xexInfo.extraInfo || {}) as Record<string, any>;
    return (
      <div className="p-5 space-y-5 overflow-y-auto h-full bg-[#06090f]">
        <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-[#182232]">
          <div className="flex items-center gap-2">
            <Gamepad2 className="w-5 h-5 text-emerald-400" />
            <div>
              <h3 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
                <span>{entry.name}</span>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-none bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-semibold">
                  XBOX 360 XEX2
                </span>
              </h3>
              <p className="text-xs text-slate-400">
                Native PowerPC Executable · Title ID: 0x{extra.titleId || '415608C3'} · Entry Point: {extra.entryPoint || '0x821D38A0'}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => onDownloadSingle(entry)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold rounded-none transition-colors whitespace-nowrap shrink-0"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export .XEX</span>
          </button>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="p-3 bg-[#0c121d] border border-[#182232] rounded-none">
            <div className="text-[10px] uppercase font-mono tracking-wider text-slate-500">Title ID</div>
            <div className="text-base font-semibold font-mono text-emerald-400 mt-0.5">
              0x{extra.titleId || '415608C3'}
            </div>
          </div>
          <div className="p-3 bg-[#0c121d] border border-[#182232] rounded-none">
            <div className="text-[10px] uppercase font-mono tracking-wider text-slate-500">Original PE</div>
            <div className="text-base font-semibold font-mono text-slate-200 mt-0.5 truncate">
              {extra.originalPeName || 'default.exe'}
            </div>
          </div>
          <div className="p-3 bg-[#0c121d] border border-[#182232] rounded-none">
            <div className="text-[10px] uppercase font-mono tracking-wider text-slate-500">Entry Point</div>
            <div className="text-base font-semibold font-mono text-slate-200 mt-0.5">
              {extra.entryPoint || '0x82000000'}
            </div>
          </div>
          <div className="p-3 bg-[#0c121d] border border-[#182232] rounded-none">
            <div className="text-[10px] uppercase font-mono tracking-wider text-slate-500">Base Address</div>
            <div className="text-base font-semibold font-mono text-slate-200 mt-0.5">
              {extra.baseAddress || '0x82000000'}
            </div>
          </div>
        </div>

        {extra.staticLibraries && extra.staticLibraries.length > 0 && (
          <div className="p-4 bg-[#06090f] border border-[#182232] rounded-none space-y-2">
            <div className="text-xs font-semibold text-slate-300 flex items-center gap-2">
              <Layers className="w-3.5 h-3.5 text-emerald-400" />
              <span>Linked Xbox 360 SDK Static Libraries ({extra.staticLibraries.length})</span>
            </div>
            <div className="flex flex-wrap gap-2 pt-1">
              {extra.staticLibraries.map((lib: string, i: number) => (
                <span
                  key={i}
                  className="px-2.5 py-1 text-xs font-mono rounded-none bg-slate-900 border border-[#182232] text-slate-300 flex items-center gap-1.5"
                >
                  <ShieldCheck className="w-3 h-3 text-emerald-400" />
                  <span>{lib}</span>
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="p-4 bg-[#06090f] border border-[#182232] rounded-none space-y-3">
          <div className="text-xs font-semibold text-slate-300 flex items-center gap-2">
            <Layers className="w-3.5 h-3.5 text-emerald-400" />
            <span>Virtual Executable Payload & PE Sections ({xexInfo.entries.length} Components)</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs font-mono border-collapse border border-[#182232]">
              <thead>
                <tr className="bg-[#0c121d] text-emerald-400 border-b border-[#182232] text-left">
                  <th className="py-2 px-3 border-r border-[#182232]">Section / Resource</th>
                  <th className="py-2 px-3 border-r border-[#182232]">Virtual Size</th>
                  <th className="py-2 px-3 border-r border-[#182232]">Offset</th>
                  <th className="py-2 px-3 text-right">Method</th>
                </tr>
              </thead>
              <tbody>
                {xexInfo.entries.map((sect, idx) => (
                  <tr key={idx} className="border-b border-[#182232] hover:bg-slate-900/50">
                    <td className="py-2 px-3 text-slate-200 font-medium border-r border-[#182232]">{sect.name}</td>
                    <td className="py-2 px-3 text-slate-300 border-r border-[#182232]">{formatBytes(sect.uncompressedSize)}</td>
                    <td className="py-2 px-3 text-slate-400 border-r border-[#182232]">0x{toHex(sect.offset, 6)}</td>
                    <td className="py-2 px-3 text-right text-emerald-400/90">{sect.compressionMethod}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="p-4 bg-[#06090f] border border-[#182232] rounded-none space-y-3">
          <div className="text-xs font-semibold text-slate-300 flex items-center gap-2">
            <Terminal className="w-3.5 h-3.5 text-emerald-400" />
            <span>XEX2 Descriptors & Security Certificate</span>
          </div>
          <div className="space-y-1.5 font-mono text-xs">
            {xexInfo.headerFields.map((hf, i) => (
              <div key={i} className="flex flex-wrap items-baseline justify-between p-2 rounded-none bg-[#0c121d] border border-[#182232]">
                <span className="text-slate-400 font-medium">{hf.label} ({hf.offset})</span>
                <span className="text-emerald-300 font-semibold">{hf.value}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // Render Xbox GDK MicrosoftGame.config Inspector
  if (gdkConfigInfo) {
    return (
      <div className="p-5 space-y-5 overflow-y-auto h-full bg-[#06090f]">
        <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-[#182232]">
          <div className="flex items-center gap-2">
            <Package className="w-5 h-5 text-cyan-400" />
            <div>
              <h3 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
                <span>MicrosoftGame.config</span>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-none bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 font-semibold">
                  XBOX GDK CONFIG
                </span>
              </h3>
              <p className="text-xs text-slate-400">
                Official Xbox Gaming Development Kit title descriptor · Target Platform: {gdkConfigInfo.targetPlatform || 'Scarlett'}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => onDownloadSingle(entry)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold rounded-none transition-colors whitespace-nowrap shrink-0"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export Config</span>
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="p-3 bg-[#0c121d] border border-[#182232] rounded-none">
            <div className="text-[10px] uppercase font-mono tracking-wider text-slate-500">Game Title</div>
            <div className="text-base font-semibold font-mono text-cyan-400 mt-0.5">
              {gdkConfigInfo.displayName || 'Call of Duty: Modern Warfare'}
            </div>
          </div>
          <div className="p-3 bg-[#0c121d] border border-[#182232] rounded-none">
            <div className="text-[10px] uppercase font-mono tracking-wider text-slate-500">Xbox Title ID</div>
            <div className="text-base font-semibold font-mono text-slate-200 mt-0.5">
              0x{gdkConfigInfo.titleId?.toUpperCase() || '415608E4'}
            </div>
          </div>
          <div className="p-3 bg-[#0c121d] border border-[#182232] rounded-none">
            <div className="text-[10px] uppercase font-mono tracking-wider text-slate-500">Target Generation</div>
            <div className="text-base font-semibold font-mono text-emerald-400 mt-0.5">
              {gdkConfigInfo.targetPlatform || 'Xbox Series X|S (Scarlett)'}
            </div>
          </div>
        </div>

        <div className="p-4 bg-[#06090f] border border-[#182232] rounded-none space-y-3">
          <div className="text-xs font-semibold text-slate-300 flex items-center gap-2">
            <Layers className="w-3.5 h-3.5 text-cyan-400" />
            <span>Registered Executables</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {gdkConfigInfo.executables.map((exe, i) => (
              <span key={i} className="px-2.5 py-1 text-xs font-mono rounded-none bg-slate-900 border border-[#182232] text-slate-200 flex items-center gap-1.5">
                <Terminal className="w-3 h-3 text-cyan-400" />
                <span>{exe}</span>
              </span>
            ))}
          </div>
        </div>

        <div className="p-4 bg-[#06090f] border border-[#182232] rounded-none space-y-2">
          <div className="text-xs font-semibold text-slate-300">Raw MicrosoftGame.config XML</div>
          <pre className="p-3 bg-[#0c121d] text-slate-300 font-mono text-xs rounded-none border border-[#182232] max-h-56 overflow-y-auto leading-5 select-text">
            {new TextDecoder('utf-8', { fatal: false }).decode(entry.data)}
          </pre>
        </div>
      </div>
    );
  }

  // Render UWP / AppX Package Manifest Inspector
  if (appxManifestInfo) {
    return (
      <div className="p-5 space-y-5 overflow-y-auto h-full bg-[#06090f]">
        <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-[#182232]">
          <div className="flex items-center gap-2">
            <Package className="w-5 h-5 text-indigo-400" />
            <div>
              <h3 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
                <span>AppxManifest.xml</span>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-none bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 font-semibold">
                  APPX MANIFEST
                </span>
              </h3>
              <p className="text-xs text-slate-400">
                Package Identity: {appxManifestInfo.packageName} (v{appxManifestInfo.version || '1.0.0.0'}) · Arch: {appxManifestInfo.processorArchitecture?.toUpperCase() || 'X64'}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => onDownloadSingle(entry)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-indigo-500 hover:bg-indigo-400 text-slate-950 font-semibold rounded-none transition-colors whitespace-nowrap shrink-0"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export Manifest</span>
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="p-3 bg-[#0c121d] border border-[#182232] rounded-none">
            <div className="text-[10px] uppercase font-mono tracking-wider text-slate-500">Package Name</div>
            <div className="text-sm font-semibold font-mono text-indigo-400 mt-0.5 truncate">
              {appxManifestInfo.packageName}
            </div>
          </div>
          <div className="p-3 bg-[#0c121d] border border-[#182232] rounded-none">
            <div className="text-[10px] uppercase font-mono tracking-wider text-slate-500">Device Family</div>
            <div className="text-sm font-semibold font-mono text-slate-200 mt-0.5">
              {appxManifestInfo.targetDeviceFamily || 'Windows.Xbox'}
            </div>
          </div>
          <div className="p-3 bg-[#0c121d] border border-[#182232] rounded-none">
            <div className="text-[10px] uppercase font-mono tracking-wider text-slate-500">Entry Binary</div>
            <div className="text-sm font-semibold font-mono text-emerald-400 mt-0.5">
              {appxManifestInfo.executable || 'App.exe'}
            </div>
          </div>
        </div>

        <div className="p-4 bg-[#06090f] border border-[#182232] rounded-none space-y-2">
          <div className="text-xs font-semibold text-slate-300">Raw AppxManifest.xml</div>
          <pre className="p-3 bg-[#0c121d] text-slate-300 font-mono text-xs rounded-none border border-[#182232] max-h-56 overflow-y-auto leading-5 select-text">
            {new TextDecoder('utf-8', { fatal: false }).decode(entry.data)}
          </pre>
        </div>
      </div>
    );
  }

  // Render Standard Image Texture (PNG/JPG/BMP)
  if (imageBlobUrl) {
    return (
      <div className="p-5 space-y-4 overflow-y-auto h-full">
        <div className="flex items-center justify-between pb-3 border-b border-[#182232]">
          <div className="flex items-center gap-2">
            <ImageIcon className="w-4 h-4 text-amber-400" />
            <h3 className="text-sm font-semibold text-slate-100">Texture Asset Preview ({entry.name})</h3>
          </div>
          <button
            type="button"
            onClick={() => onDownloadSingle(entry)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-none border border-[#182232] transition-colors whitespace-nowrap shrink-0"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Extract Image</span>
          </button>
        </div>
        <div className="flex items-center justify-center p-6 bg-[#06090f] border border-[#182232] rounded-none">
          <img
            src={imageBlobUrl}
            alt={entry.name}
            referrerPolicy="no-referrer"
            className="max-h-96 object-contain border border-[#182232]"
          />
        </div>
      </div>
    );
  }

  // Render StringTable (.csv) Interactive Spreadsheet Grid
  if (parsedCsvRows && csvViewMode === 'grid') {
    return (
      <div className="flex flex-col h-full bg-[#06090f]">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 border-b border-[#182232] bg-[#0c121d]">
          <div className="flex items-center gap-2 text-xs text-slate-300">
            <Table className="w-4 h-4 text-amber-400 shrink-0" />
            <span className="font-mono font-medium">{entry.path}</span>
            <span aria-hidden="true" className="text-slate-600">·</span>
            <span className="text-slate-400 font-mono tabular-nums">
              {entry.metadata?.cols || parsedCsvRows[0]?.length || 0} cols ×{' '}
              {entry.metadata?.rows || parsedCsvRows.length} rows
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCsvViewMode('raw')}
              className="px-2.5 py-1 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-none border border-[#182232] transition-colors whitespace-nowrap shrink-0"
            >
              View Raw CSV Text
            </button>
            <button
              type="button"
              onClick={() => onDownloadSingle(entry)}
              className="flex items-center gap-1.5 px-3 py-1 text-xs font-medium bg-amber-500 hover:bg-amber-400 text-slate-950 rounded-none transition-colors whitespace-nowrap shrink-0"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Export .CSV</span>
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-auto p-4">
          <table className="w-full border-collapse text-xs font-mono tabular-nums border border-[#182232]">
            <tbody>
              {parsedCsvRows.map((row, rIdx) => (
                <tr
                  key={rIdx}
                  className={
                    rIdx === 0
                      ? 'bg-[#0c121d] text-amber-300 font-semibold border-b border-[#182232]'
                      : 'border-b border-[#182232]/70 hover:bg-slate-900/60 text-slate-200'
                  }
                >
                  <td className="py-1.5 px-2.5 text-slate-500 border-r border-[#182232] w-12 text-right select-none">
                    {rIdx}
                  </td>
                  {row.map((cell, cIdx) => (
                    <td key={cIdx} className="py-1.5 px-3 border-r border-[#182232]/60 whitespace-nowrap">
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  // Render Compiled T6/T5 GSC Bytecode Disassembly OR Editable Script / Rawfile / Localize Editor
  return (
    <div className="flex flex-col h-full bg-[#06090f]">
      <input
        ref={replaceFileInputRef}
        type="file"
        className="hidden"
        onChange={(e) => {
          if (e.target.files && e.target.files[0]) {
            handleReplaceBinaryFromDisk(e.target.files[0]);
            e.target.value = '';
          }
        }}
      />

      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 border-b border-[#182232] bg-[#0c121d]">
        <div className="flex items-center gap-2 text-xs text-slate-300">
          {isCompiledT6Gsc ? (
            <Cpu className="w-4 h-4 text-amber-400 shrink-0" />
          ) : (
            <FileCode className="w-4 h-4 text-amber-400 shrink-0" />
          )}
          <span className="font-mono font-medium">{entry.path}</span>
          <span aria-hidden="true" className="text-slate-600">·</span>
          <span className="text-slate-400 font-mono tabular-nums">{formatBytes(entry.data.length)}</span>
          <span aria-hidden="true" className="text-slate-600">·</span>
          <span className="text-slate-400 font-mono tabular-nums">CRC32 {toHex(computeCRC32(entry.data), 8)}</span>
        </div>

        <div className="flex items-center gap-2">
          {parsedCsvRows && csvViewMode === 'raw' && (
            <button
              type="button"
              onClick={() => setCsvViewMode('grid')}
              className="px-2.5 py-1 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-none border border-[#182232] transition-colors whitespace-nowrap shrink-0"
            >
              Grid View
            </button>
          )}

          {(entry.metadata?.ffKind === 'script' || entry.metadata?.ffKind === 'rawfile' || isBinaryPayload) &&
            entry.id !== 'ff-zone-master' && (
              <button
                type="button"
                onClick={() => replaceFileInputRef.current?.click()}
                className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-amber-300 rounded-none border border-[#182232] transition-colors whitespace-nowrap shrink-0"
                title="Replace this asset in the FastFile zone with an external binary/script file"
              >
                <Upload className="w-3.5 h-3.5" />
                <span>{savedNotice ? 'Replaced in Zone' : 'Replace Asset from Disk'}</span>
              </button>
            )}

          {!isBinaryPayload && isDirty && (
            <button
              type="button"
              onClick={() => {
                setEditedText(decodedString);
                setIsDirty(false);
              }}
              className="flex items-center gap-1 px-2.5 py-1 text-xs text-slate-300 hover:text-white bg-slate-800 rounded-none border border-[#182232] transition-colors whitespace-nowrap shrink-0"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Revert</span>
            </button>
          )}

          {!isBinaryPayload && (
            <button
              type="button"
              disabled={!isDirty}
              onClick={handleSaveTextChanges}
              className={`flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-none transition-colors whitespace-nowrap shrink-0 ${
                savedNotice
                  ? 'bg-emerald-600 text-white'
                  : isDirty
                  ? 'bg-amber-500 hover:bg-amber-400 text-slate-950'
                  : 'bg-slate-800/60 text-slate-500 border border-[#182232] cursor-not-allowed'
              }`}
            >
              {savedNotice ? <Check className="w-3.5 h-3.5" /> : <Save className="w-3.5 h-3.5" />}
              <span>{savedNotice ? 'Committed to Zone' : 'Commit Edit to Archive'}</span>
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 relative min-h-[320px]">
        <textarea
          value={editedText}
          readOnly={isBinaryPayload}
          onChange={(e) => {
            if (!isBinaryPayload) {
              setEditedText(e.target.value);
              setIsDirty(true);
            }
          }}
          spellCheck={false}
          className="w-full h-full p-4 bg-[#06090f] text-slate-200 font-mono text-xs leading-6 focus:outline-none resize-none selection:bg-amber-500/30"
        />
      </div>
    </div>
  );
};
