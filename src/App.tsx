import React, { useState, useMemo, useRef, useEffect } from 'react';
import {
  Folder,
  FolderOpen,
  Search,
  Upload,
  Download,
  FileText,
  Binary,
  Plus,
  ArrowUpDown,
  HardDrive,
  AlertTriangle,
} from 'lucide-react';
import { ArchiveEntry, AssetCategory, ParsedArchive } from './types/archive';
import {
  FORMAT_SPECS,
  parseGameArchive,
  repackArchiveAsFormat,
  formatBytes,
  toHex,
  computeCRC32,
  classifyEntry,
} from './services/archiveParser';
import { replaceItemInZoneState } from './services/t5t6FastFile';
import { SAMPLE_ARCHIVES, fetchPresetBinary } from './services/demoArchives';
import { HexViewer } from './components/HexViewer';
import { AssetPreviewer } from './components/AssetPreviewer';
import { ArchiveBuilderModal } from './components/ArchiveBuilderModal';
import { zlibSync, unzlibSync } from 'fflate';

type TopSection = 'workspace' | 'headers' | 'formats' | 'zlib';
type InspectorTab = 'preview' | 'hex' | 'archive_hex';
type SortField = 'name' | 'size' | 'offset' | 'category';

export default function App() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Initialize with null - start with clean empty state and load samples only when chosen
  const [archive, setArchive] = useState<ParsedArchive | null>(null);
  const [isLoadingArchive, setIsLoadingArchive] = useState<boolean>(false);
  const [loadingStatus, setLoadingStatus] = useState<string>('');
  const [activePresetId, setActivePresetId] = useState<string>('');
  const [activeTopSection, setActiveTopSection] = useState<TopSection>('workspace');
  const [selectedFolder, setSelectedFolder] = useState<string>('ALL');
  const [selectedCategory, setSelectedCategory] = useState<AssetCategory | 'ALL'>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [sortField, setSortField] = useState<SortField>('offset');
  const [sortAsc, setSortAsc] = useState<boolean>(true);
  const [selectedEntryId, setSelectedEntryId] = useState<string>('');
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('preview');
  const [isDraggingOver, setIsDraggingOver] = useState<boolean>(false);
  const [isInjectModalOpen, setIsInjectModalOpen] = useState<boolean>(false);
  const [repackTarget, setRepackTarget] = useState<'ZIP' | 'PK3' | 'PAK' | 'WAD' | 'FF'>('FF');

  // Standalone Zlib Workbench state
  const [zlibInputText, setZlibInputText] = useState<string>(
    '// Paste text or load a binary block to test RFC 1950 Zlib Deflate compression\nsetdvar("r_fullscreen", "1");\nsetdvar("com_maxfps", "250");'
  );
  const [zlibLevel, setZlibLevel] = useState<number>(6);

  // Keep selectedEntryId and default repack format synced whenever archive changes
  // Keep selectedEntryId and default repack format synced whenever archive changes
  useEffect(() => {
    if (!archive) return;
    if (archive.entries.length > 0) {
      const preferred =
        archive.entries.find(
          (e) => e.id !== 'ff-zone-master' && !e.id.startsWith('ff-meta-')
        ) || archive.entries[0];
      setSelectedEntryId(preferred.id);
    } else {
      setSelectedEntryId('');
    }
    if (archive.formatId === 'FF') setRepackTarget('FF');
    else if (archive.formatId === 'WAD') setRepackTarget('WAD');
    else if (archive.formatId === 'PAK') setRepackTarget('PAK');
    else if (archive.formatId === 'PK3') setRepackTarget('PK3');
    else setRepackTarget('ZIP');

    setSelectedFolder('ALL');
    setSelectedCategory('ALL');
  }, [archive?.fileName, archive?.formatId]);

  const folders = useMemo(() => {
    if (!archive) return [];
    const counts = new Map<string, number>();
    for (const e of archive.entries) {
      counts.set(e.folder, (counts.get(e.folder) || 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [archive?.entries]);

  const filteredEntries = useMemo(() => {
    if (!archive) return [];
    const q = searchQuery.trim().toLowerCase();
    const list = archive.entries.filter((entry) => {
      if (selectedFolder !== 'ALL' && entry.folder !== selectedFolder) return false;
      if (selectedCategory !== 'ALL' && entry.category !== selectedCategory) return false;
      if (
        q &&
        !entry.path.toLowerCase().includes(q) &&
        !entry.compressionMethod.toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });

    list.sort((a, b) => {
      let cmp = 0;
      if (sortField === 'name') cmp = a.name.localeCompare(b.name);
      else if (sortField === 'size') cmp = a.uncompressedSize - b.uncompressedSize;
      else if (sortField === 'offset') cmp = a.offset - b.offset;
      else if (sortField === 'category') cmp = a.category.localeCompare(b.category);
      return sortAsc ? cmp : -cmp;
    });

    return list;
  }, [archive?.entries, selectedFolder, selectedCategory, searchQuery, sortField, sortAsc]);

  const selectedEntry = useMemo(() => {
    if (!archive) return null;
    return (
      archive.entries.find((e) => e.id === selectedEntryId) ||
      filteredEntries[0] ||
      archive.entries[0] ||
      null
    );
  }, [archive?.entries, filteredEntries, selectedEntryId]);

  const handleLoadSample = async (presetId: string) => {
    const found = SAMPLE_ARCHIVES.find((p) => p.id === presetId);
    if (!found) return;
    setIsLoadingArchive(true);
    setLoadingStatus(`Loading ${found.title} (${found.fileName})...`);
    setActivePresetId(presetId);
    try {
      const bytes = await fetchPresetBinary(found);
      const parsed = parseGameArchive(found.fileName, bytes);
      setArchive(parsed);
      setActiveTopSection('workspace');
    } catch (err) {
      console.error('Failed to load sample:', err);
    } finally {
      setIsLoadingArchive(false);
    }
  };

  const handleFileUpload = async (file: File) => {
    setIsLoadingArchive(true);
    setLoadingStatus(`Parsing ${file.name} (${formatBytes(file.size)})...`);
    try {
      const arrayBuffer = await file.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      const parsed = parseGameArchive(file.name, bytes);
      setActivePresetId('');
      setArchive(parsed);
      setActiveTopSection('workspace');
    } finally {
      setIsLoadingArchive(false);
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      await handleFileUpload(e.dataTransfer.files[0]);
    }
  };

  const handleDownloadSingle = (entry: ArchiveEntry) => {
    const blob = new Blob([entry.data.buffer as ArrayBuffer], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = entry.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleRepackAndDownload = (fmt: 'ZIP' | 'PK3' | 'PAK' | 'WAD' | 'FF') => {
    if (!archive) return;
    const { bytes, extension, mimeType } = repackArchiveAsFormat(
      archive.entries,
      fmt,
      archive.zoneState
    );
    const baseName = archive.fileName.replace(/\.[^.]+$/, '');
    const outName = `${baseName}_rebuilt${extension}`;
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = outName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleUpdateEntryData = (entryId: string, newData: Uint8Array) => {
    setArchive((prev) => {
      if (!prev) return null;
      // If this is a T5/T6 FastFile with an active zoneState, update the zone in-place using Spet's replace() logic
      if (prev.zoneState) {
        try {
          replaceItemInZoneState(prev.zoneState, entryId, newData, false);
        } catch {
          // Non-zone metadata entry
        }
      }

      return {
        ...prev,
        unpackedZoneSize: prev.zoneState ? prev.zoneState.zone.length : prev.unpackedZoneSize,
        entries: prev.entries.map((e) =>
          e.id === entryId
            ? {
                ...e,
                data: newData,
                uncompressedSize: newData.length,
                crc32: computeCRC32(newData),
                isModified: true,
              }
            : e.id === 'ff-zone-master' && prev.zoneState
            ? {
                ...e,
                data: prev.zoneState.zone,
                uncompressedSize: prev.zoneState.zone.length,
                crc32: computeCRC32(prev.zoneState.zone),
                isModified: true,
              }
            : e
        ),
      };
    });
  };

  const handleAddTextEntry = (path: string, content: string) => {
    if (!archive) return;
    const data = new TextEncoder().encode(content);
    const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '');
    const parts = normalized.split('/').filter(Boolean);
    const name = parts[parts.length - 1] || 'injected.txt';
    const folder = parts.length > 1 ? parts.slice(0, parts.length - 1).join('/') : '(root)';
    const newEntry: ArchiveEntry = {
      id: `injected-${Date.now()}`,
      name,
      path: normalized,
      folder,
      offset: archive.fileSize,
      compressedSize: data.length,
      uncompressedSize: data.length,
      compressionMethod: 'Injected Stream',
      crc32: computeCRC32(data),
      category: classifyEntry(normalized, data),
      data,
      isModified: true,
    };
    setArchive((prev) => (prev ? {
      ...prev,
      entries: [...prev.entries, newEntry],
    } : null));
    setSelectedEntryId(newEntry.id);
  };

  const handleAddBinaryFiles = async (files: FileList) => {
    if (!archive) return;
    const added: ArchiveEntry[] = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const buf = new Uint8Array(await f.arrayBuffer());
      added.push({
        id: `injected-file-${Date.now()}-${i}`,
        name: f.name,
        path: f.name,
        folder: '(root)',
        offset: archive.fileSize,
        compressedSize: buf.length,
        uncompressedSize: buf.length,
        compressionMethod: 'Injected File',
        crc32: computeCRC32(buf),
        category: classifyEntry(f.name, buf),
        data: buf,
        isModified: true,
      });
    }
    if (added.length > 0) {
      setArchive((prev) => (prev ? {
        ...prev,
        entries: [...prev.entries, ...added],
      } : null));
      setSelectedEntryId(added[0].id);
    }
  };

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortAsc((prev) => !prev);
    } else {
      setSortField(field);
      setSortAsc(true);
    }
  };

  const totalUncompressedBytes = useMemo(() => {
    if (!archive) return 0;
    if (archive.unpackedZoneSize && archive.unpackedZoneSize > 0) {
      return archive.unpackedZoneSize;
    }
    return archive.entries
      .filter((e) => e.id !== 'ff-zone-master')
      .reduce((acc, e) => acc + e.uncompressedSize, 0);
  }, [archive?.entries, archive?.unpackedZoneSize]);

  // Live Zlib Workbench output
  const zlibBenchResult = useMemo(() => {
    const raw = new TextEncoder().encode(zlibInputText);
    const compressed = zlibSync(raw, { level: zlibLevel as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 });
    const roundtrip = unzlibSync(compressed);
    return {
      rawBytes: raw,
      compressedBytes: compressed,
      roundtripOk: roundtrip.length === raw.length,
      ratio: raw.length > 0 ? ((compressed.length / raw.length) * 100).toFixed(1) : '100.0',
    };
  }, [zlibInputText, zlibLevel]);

  return (
    <div
      className="h-screen max-h-screen flex flex-col overflow-hidden bg-[#0B0F17] text-slate-100"
      onDragOver={(e) => {
        e.preventDefault();
        setIsDraggingOver(true);
      }}
      onDragLeave={() => setIsDraggingOver(false)}
      onDrop={handleDrop}
    >
      {/* Hidden File Input */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".ff,.zip,.rar,.wad,.pak,.iso,.pk3,.pk4,.iwd,.par,.vpk,.big,.zlib,.dat,.bin,.bsa,.ba2,.forge,.rpf,.jar,.pkg,.awb,.acb,.usm,.adx,.hca,.bnd,.bnd4,.dcx,.sdat,.pfs,*"
        className="hidden"
        onChange={(e) => {
          if (e.target.files && e.target.files[0]) {
            handleFileUpload(e.target.files[0]);
            e.target.value = '';
          }
        }}
      />

      {/* Top Bar Contract: 1-row, 3-zone header separated by gap-8 */}
      <header className="shrink-0 flex items-center justify-between gap-8 px-6 py-3.5 border-b border-slate-800/90 bg-[#0D131F]">
        {/* Zone 1: Single text element wordmark */}
        <a
          href="#workspace"
          onClick={(e) => {
            e.preventDefault();
            setActiveTopSection('workspace');
          }}
          className="text-lg font-bold tracking-tight text-slate-100 font-display whitespace-nowrap shrink-0"
        >
          Spet&apos;s Universal Game File Opener
        </a>

        {/* Zone 2: 4 clean single-line navigation links */}
        <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-400">
          <a
            href="#workspace"
            onClick={(e) => {
              e.preventDefault();
              setActiveTopSection('workspace');
            }}
            className={`hover:text-slate-100 hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0 ${
              activeTopSection === 'workspace' ? 'text-amber-400 underline' : ''
            }`}
          >
            Archive Explorer
          </a>
          <a
            href="#headers"
            onClick={(e) => {
              e.preventDefault();
              setActiveTopSection('headers');
            }}
            className={`hover:text-slate-100 hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0 ${
              activeTopSection === 'headers' ? 'text-amber-400 underline' : ''
            }`}
          >
            Binary Headers
          </a>
          <a
            href="#zlib"
            onClick={(e) => {
              e.preventDefault();
              setActiveTopSection('zlib');
            }}
            className={`hover:text-slate-100 hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0 ${
              activeTopSection === 'zlib' ? 'text-amber-400 underline' : ''
            }`}
          >
            Zlib Transcoder
          </a>
          <a
            href="#formats"
            onClick={(e) => {
              e.preventDefault();
              setActiveTopSection('formats');
            }}
            className={`hover:text-slate-100 hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0 ${
              activeTopSection === 'formats' ? 'text-amber-400 underline' : ''
            }`}
          >
            Supported Formats
          </a>
        </nav>

        {/* Zone 3: 1 primary action */}
        <div className="flex items-center shrink-0">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="px-4 py-2 text-xs font-semibold text-slate-950 bg-amber-500 hover:bg-amber-400 rounded-lg transition-colors whitespace-nowrap shrink-0"
          >
            Open Game Archive
          </button>
        </div>
      </header>

      {/* Drag-and-drop overlay indicator */}
      {isDraggingOver && (
        <div className="fixed inset-0 z-50 bg-amber-500/10 backdrop-blur-xs border-2 border-dashed border-amber-400 flex items-center justify-center pointer-events-none">
          <div className="px-6 py-4 bg-[#0D131F] border border-amber-500/50 rounded-lg text-center shadow-2xl">
            <p className="text-base font-semibold text-amber-300">
              Drop Game Archive (.BSA, .BA2, .FORGE, .RPF, .JAR, .PKG, .AWB, .USM, .BND, .DCX, .SDAT, .PFS, .NDS, .FF, .PAK, .WAD, .PK3, .ISO)
            </p>
            <p className="text-xs text-slate-400 mt-1">
              Bethesda BSA/BA2, Ubisoft FORGE, Rockstar RAGE, Minecraft JAR, PlayStation PKG, CRIWARE, FromSoftware, Square Enix, CoD FastFiles, and more.
            </p>
          </div>
        </div>
      )}

      {/* Contextual Bar: Open Source Binary Presets + Active Archive Telemetry */}
      <div className="shrink-0 px-6 py-3 border-b border-slate-800/80 bg-[#0F1623]/70 flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-slate-400 mr-1 whitespace-nowrap">
            Open Source Demos:
          </span>
          <div className="flex flex-wrap items-center gap-1 p-1 bg-[#0B0F17] border border-slate-800 rounded-lg">
            {SAMPLE_ARCHIVES.map((sample) => {
              const active = activePresetId === sample.id;
              return (
                <button
                  key={sample.id}
                  type="button"
                  onClick={() => handleLoadSample(sample.id)}
                  disabled={isLoadingArchive && active}
                  className={`px-2.5 py-1 text-xs font-mono rounded transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 ${
                    active
                      ? 'bg-amber-500 text-slate-950 font-semibold'
                      : 'text-slate-300 hover:text-white hover:bg-slate-800/70'
                  }`}
                  title={`${sample.title} (${sample.formatBadge}) — ${sample.license}\n${sample.summary}\nSource: ${sample.sourceUrl}`}
                >
                  <span>{sample.fileName}</span>
                  <span
                    className={`text-[9px] px-1 py-0.5 rounded font-sans uppercase font-bold tracking-wider ${
                      active ? 'bg-slate-950/20 text-slate-950' : 'bg-slate-800 text-amber-400'
                    }`}
                  >
                    {sample.formatBadge}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Unboxed Metadata Telemetry (Zero-Pill Discipline) */}
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400 font-mono tabular-nums">
          {isLoadingArchive ? (
            <span className="text-amber-400 animate-pulse font-medium">{loadingStatus}</span>
          ) : archive ? (
            <>
              <span className="text-slate-200 font-semibold">{archive.fileName}</span>
              <span aria-hidden="true">·</span>
              <span className="text-amber-300">{archive.formatName}</span>
              <span aria-hidden="true">·</span>
              <span>Disk {formatBytes(archive.fileSize)}</span>
              <span aria-hidden="true">·</span>
              <span>Unpacked {formatBytes(totalUncompressedBytes)}</span>
              <span aria-hidden="true">·</span>
              <span>{archive.entries.length} entries</span>
              <span aria-hidden="true">·</span>
              <span>Parsed in {archive.parseTimeMs} ms</span>
            </>
          ) : (
            <span className="text-slate-500">Ready · Drag & drop a game archive or pick a demo preset</span>
          )}
        </div>
      </div>

      {/* Warnings Bar if any */}
      {archive && archive.warnings.length > 0 && (
        <div className="shrink-0 px-6 py-2 bg-amber-950/30 border-b border-amber-800/40 flex items-center gap-2 text-xs text-amber-200">
          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
          <span>{archive.warnings[0]}</span>
        </div>
      )}

      {/* VIEW 1: PRIMARY ARCHIVE EXPLORER WORKSPACE */}
      {activeTopSection === 'workspace' && (
        isLoadingArchive ? (
          <main className="flex-1 flex flex-col items-center justify-center p-6 bg-[#0B0F17]">
            <div className="flex flex-col items-center gap-4 max-w-md w-full text-center p-8 bg-[#0D131F] border border-slate-800 rounded-2xl shadow-2xl">
              <div className="w-12 h-12 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-400">
                <HardDrive className="w-6 h-6 animate-pulse" />
              </div>
              <div>
                <h2 className="text-base font-semibold text-slate-100 font-display">Parsing Game Archive</h2>
                <p className="text-xs text-slate-400 mt-1">{loadingStatus || 'Reading binary stream...'}</p>
              </div>
              <div className="w-full bg-slate-800/80 h-1.5 rounded-full overflow-hidden">
                <div className="bg-amber-500 h-full w-2/3 rounded-full animate-pulse" />
              </div>
            </div>
          </main>
        ) : !archive ? (
          <main className="flex-1 min-h-0 overflow-y-auto p-6 md:p-10 flex flex-col items-center justify-center bg-[#0B0F17]">
            <div className="max-w-3xl w-full flex flex-col items-center text-center space-y-6">
              <div
                onClick={() => fileInputRef.current?.click()}
                className="w-full p-10 border-2 border-dashed border-slate-700/80 hover:border-amber-500/60 rounded-2xl bg-[#0D131F]/90 hover:bg-[#0D131F] transition-all cursor-pointer flex flex-col items-center gap-4 group shadow-xl"
              >
                <div className="w-16 h-16 rounded-2xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-400 group-hover:scale-105 transition-transform">
                  <Upload className="w-8 h-8" />
                </div>
                <div className="space-y-1.5">
                  <h2 className="text-xl font-bold text-slate-100 font-display">
                    Open or Drop a Game Archive
                  </h2>
                  <p className="text-xs text-slate-400 max-w-md mx-auto">
                    Inspect, browse, and carve virtual filesystems from 25+ PC and console game engines. Pure client-side WebAssembly execution, zero server uploads.
                  </p>
                </div>
                <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      fileInputRef.current?.click();
                    }}
                    className="px-5 py-2.5 text-xs font-semibold text-slate-950 bg-amber-500 hover:bg-amber-400 rounded-lg transition-colors shadow-lg shadow-amber-500/10"
                  >
                    Select File from Disk
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleLoadSample(SAMPLE_ARCHIVES[0].id);
                    }}
                    className="px-4 py-2.5 text-xs font-semibold text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg transition-colors"
                  >
                    Load Freedoom Demo
                  </button>
                </div>
              </div>

              {/* Supported Format Grid */}
              <div className="space-y-3 w-full text-left">
                <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider text-center">
                  Engine Parsers Included
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 text-xs">
                  {[
                    { label: 'Bethesda BSA / BA2', desc: 'Oblivion, Skyrim, FO3/NV, FO4, Starfield' },
                    { label: 'Ubisoft FORGE', desc: 'Assassin\'s Creed, Anvil Engine' },
                    { label: 'Rockstar RAGE .rpf', desc: 'GTA IV, GTA V, RDR, Max Payne 3' },
                    { label: 'Minecraft Mod .jar', desc: 'Fabric, Forge, NeoForge, Quilt' },
                    { label: 'PlayStation .pkg', desc: 'PS3, PS4, PS Vita' },
                    { label: 'CRIWARE Multimedia', desc: 'AWB, ACB, USM, ADX, HCA' },
                    { label: 'FromSoftware BND/DCX', desc: 'Dark Souls 1-3, Bloodborne, Elden Ring' },
                    { label: 'Square Enix SDAT/PFS', desc: 'NDS SDAT sound, Crystal Tools PFS' },
                    { label: 'CoD FastFiles .ff', desc: 'Treyarch T4-T10 & Infinity Ward IW3-IW10' },
                    { label: 'Classic ROMs & NDS', desc: 'NitroFS, GBA, N64, SNES' },
                    { label: 'Unreal & Unity', desc: 'UE4/5 PAK & UnityFS Bundles' },
                    { label: 'id Tech DOOM/Quake', desc: 'WAD, PACK, PK3, DOOM 2016' },
                  ].map((f, i) => (
                    <div key={i} className="p-2.5 bg-[#0D131F] border border-slate-800/80 rounded-lg">
                      <div className="font-semibold text-amber-300 text-[11px] truncate">{f.label}</div>
                      <div className="text-[10px] text-slate-500 truncate mt-0.5">{f.desc}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </main>
        ) : (
          <main className="flex-1 min-h-0 flex flex-col lg:flex-row overflow-hidden bg-[#09090b]">
            {/* Left Sidebar: Virtual Directory Tree & Repack Controls */}
            <aside className="w-full lg:w-56 xl:w-64 shrink-0 border-b lg:border-b-0 lg:border-r border-[#27272a] bg-[#121214] p-3.5 flex flex-col justify-between gap-4 overflow-y-auto h-full min-h-0">
              <div className="space-y-4">
                {/* Archive Summary Block */}
                <div className="space-y-1.5 pb-3 border-b border-[#27272a]">
                  <div className="text-[11px] font-medium text-zinc-400">Engine Signature</div>
                  <div className="text-xs font-semibold text-zinc-100">{archive.engineFamily}</div>
                  <div className="text-xs font-mono text-zinc-400 tabular-nums pt-0.5">
                    Magic: <span className="text-amber-400">{archive.magicBytes}</span>
                  </div>
                  {archive.zoneState && (
                    <div className="text-xs font-mono text-emerald-400 tabular-nums">
                      Zone: {formatBytes(archive.zoneState.zone.length)} ({archive.zoneState.items.length} XAssets)
                    </div>
                  )}
                </div>

                {/* Virtual Folder Hierarchy */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-xs font-semibold text-zinc-300">Virtual Directories</span>
                    <span className="text-xs font-mono text-zinc-500 tabular-nums">{folders.length}</span>
                  </div>
                  <div className="space-y-0.5 max-h-56 overflow-y-auto pr-1">
                    <button
                      type="button"
                      onClick={() => setSelectedFolder('ALL')}
                      className={`w-full flex items-center justify-between px-2.5 py-1.5 text-xs rounded-sm transition-colors ${
                        selectedFolder === 'ALL'
                          ? 'bg-[#27272a] text-amber-300 font-medium border-l-2 border-amber-400'
                          : 'text-zinc-300 hover:bg-zinc-800/60'
                      }`}
                    >
                      <span className="flex items-center gap-2 truncate">
                        <FolderOpen className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                        <span className="truncate">All Directories</span>
                      </span>
                      <span className="font-mono text-zinc-400 tabular-nums">{archive.entries.length}</span>
                    </button>

                    {folders.map(([folderName, count]) => {
                      const isSel = selectedFolder === folderName;
                      return (
                        <button
                          key={folderName}
                          type="button"
                          onClick={() => setSelectedFolder(folderName)}
                          className={`w-full flex items-center justify-between px-2.5 py-1.5 text-xs rounded-sm transition-colors ${
                            isSel
                              ? 'bg-[#27272a] text-amber-300 font-medium border-l-2 border-amber-400'
                              : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60'
                          }`}
                        >
                          <span className="flex items-center gap-2 truncate">
                            <Folder className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                            <span className="font-mono truncate">{folderName}</span>
                          </span>
                          <span className="font-mono text-zinc-500 tabular-nums">{count}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Asset Category Filter */}
                <div>
                  <div className="text-xs font-semibold text-zinc-300 mb-1.5">Asset Type Filter</div>
                  <div className="grid grid-cols-2 gap-1">
                    {(
                      [
                        ['ALL', 'All Types'],
                        ['executable', 'Executables'],
                        ['package', 'Packages'],
                        ['script', 'Scripts / GSC'],
                        ['config', 'Raw / CSV / Loc'],
                        ['texture', 'Textures / TIM'],
                        ['video', 'Video / BIK / STR'],
                        ['audio', 'Audio / SFX'],
                        ['model', '3D Models'],
                        ['map', 'Maps / Geometry'],
                        ['palette', 'Palettes'],
                        ['binary', 'Binaries / Payloads'],
                      ] as const
                    ).map(([catKey, label]) => (
                      <button
                        key={catKey}
                        type="button"
                        onClick={() => setSelectedCategory(catKey)}
                        className={`px-2 py-1 text-[11px] font-medium rounded-sm text-left transition-colors whitespace-nowrap truncate ${
                          selectedCategory === catKey
                            ? 'bg-amber-500/15 text-amber-300 border border-amber-500/40'
                            : 'bg-[#18181b] text-zinc-400 hover:text-zinc-200 border border-[#27272a]'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Archive Modification & Repack Controls */}
              <div className="space-y-2.5 pt-3 border-t border-[#27272a]">
                <button
                  type="button"
                  onClick={() => setIsInjectModalOpen(true)}
                  className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[#18181b] hover:bg-zinc-800 text-zinc-200 rounded-sm border border-[#27272a] transition-colors whitespace-nowrap"
                >
                  <Plus className="w-3.5 h-3.5 text-amber-400" />
                  <span>Inject File / Lump</span>
                </button>

                <div className="space-y-1">
                  <label className="block text-[11px] text-zinc-400">Rebuild / Export Container As:</label>
                  <div className="flex items-center gap-1.5">
                    <select
                      value={repackTarget}
                      onChange={(e) =>
                        setRepackTarget(e.target.value as 'ZIP' | 'PK3' | 'PAK' | 'WAD' | 'FF')
                      }
                      className="flex-1 min-w-0 px-2 py-1 text-xs font-mono bg-[#09090b] border border-[#27272a] rounded-sm text-zinc-200 focus:outline-none focus:border-amber-500"
                    >
                      <option value="FF">.FF (T5/T6 FastFile)</option>
                      <option value="ZIP">.ZIP (All Assets)</option>
                      <option value="PK3">.PK3 (id Tech 3)</option>
                      <option value="PAK">.PAK (Quake PACK)</option>
                      <option value="WAD">.WAD (DOOM PWAD)</option>
                    </select>
                    <button
                      type="button"
                      onClick={() => handleRepackAndDownload(repackTarget)}
                      className="flex items-center gap-1 px-3 py-1 text-xs font-semibold bg-amber-500 hover:bg-amber-400 text-zinc-950 rounded-sm transition-colors whitespace-nowrap shrink-0"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>Save</span>
                    </button>
                  </div>
                </div>
              </div>
            </aside>

            {/* Middle Column: High-Density Archive Entry Table with STRICT INDEPENDENT SCROLL */}
            <section className="w-full lg:w-80 xl:w-96 2xl:w-[440px] shrink-0 border-b lg:border-b-0 lg:border-r border-[#27272a] flex flex-col bg-[#09090b] min-h-0 h-full overflow-hidden">
              {/* Search & Upload Bar */}
              <div className="shrink-0 p-2.5 border-b border-[#27272a] bg-[#121214] flex items-center justify-between gap-2">
                <div className="relative flex-1">
                  <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Filter rawfiles, scripts, CSVs..."
                    className="w-full pl-8 pr-2.5 py-1 text-xs bg-[#09090b] border border-[#27272a] rounded-sm text-zinc-200 placeholder:text-zinc-500 focus:outline-none focus:border-amber-500"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium bg-[#18181b] hover:bg-zinc-800 text-zinc-200 rounded-sm border border-[#27272a] transition-colors whitespace-nowrap shrink-0"
                  title="Open another archive from disk"
                >
                  <Upload className="w-3.5 h-3.5" />
                  <span>Open Disk</span>
                </button>
              </div>

              {/* Table Header (Sticky / Shrink-0) */}
              <div className="shrink-0 grid grid-cols-12 px-3 py-1.5 border-b border-[#27272a] bg-[#18181b] text-[11px] font-semibold text-zinc-400 select-none">
                <button
                  type="button"
                  onClick={() => toggleSort('name')}
                  className="col-span-6 flex items-center gap-1 text-left hover:text-zinc-200"
                >
                  <span>Entry Path / Lump</span>
                  <ArrowUpDown className="w-3 h-3 opacity-60" />
                </button>
                <button
                  type="button"
                  onClick={() => toggleSort('offset')}
                  className="col-span-2 flex items-center justify-end gap-1 text-right hover:text-zinc-200"
                >
                  <span>Offset</span>
                </button>
                <button
                  type="button"
                  onClick={() => toggleSort('size')}
                  className="col-span-2 flex items-center justify-end gap-1 text-right hover:text-zinc-200"
                >
                  <span>Size</span>
                </button>
                <span className="col-span-2 text-right">Action</span>
              </div>

              {/* High-Density Entry Rows (flex-1 min-h-0 overflow-y-auto) */}
              <div className="flex-1 min-h-0 overflow-y-auto divide-y divide-[#27272a]/60">
                {filteredEntries.length === 0 ? (
                  <div className="p-8 text-center space-y-3">
                    <p className="text-xs text-zinc-400">
                      No entries match the current directory or search filter.
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedFolder('ALL');
                        setSelectedCategory('ALL');
                        setSearchQuery('');
                      }}
                      className="px-3 py-1.5 text-xs font-medium bg-[#18181b] hover:bg-zinc-800 text-zinc-200 rounded-sm border border-[#27272a] transition-colors"
                    >
                      Reset Filters
                    </button>
                  </div>
                ) : (
                  filteredEntries.map((entry) => {
                    const isSelected = selectedEntry?.id === entry.id;
                    return (
                      <div
                        key={entry.id}
                        onClick={() => setSelectedEntryId(entry.id)}
                        className={`grid grid-cols-12 items-center px-3 py-1.5 text-xs cursor-pointer transition-colors ${
                          isSelected
                            ? 'bg-[#18181b] border-l-2 border-amber-400 text-zinc-100'
                            : 'hover:bg-zinc-800/50 text-zinc-300'
                        }`}
                      >
                        <div className="col-span-6 pr-2 min-w-0">
                          <div className="font-mono font-medium truncate flex items-center gap-1.5">
                            <span
                              className={
                                isSelected ? 'text-amber-300 font-semibold' : 'text-zinc-200'
                              }
                            >
                              {entry.name}
                            </span>
                            {entry.isModified && (
                              <span className="text-amber-400 text-[10px]">*mod</span>
                            )}
                          </div>
                          <div className="text-[10px] text-zinc-500 truncate font-mono">
                            {entry.folder} · {entry.compressionMethod}
                          </div>
                        </div>

                        <div className="col-span-2 text-right font-mono text-zinc-400 tabular-nums text-[11px]">
                          {toHex(entry.offset, 6)}
                        </div>

                        <div className="col-span-2 text-right font-mono text-zinc-300 tabular-nums text-[11px]">
                          {formatBytes(entry.uncompressedSize)}
                        </div>

                        <div className="col-span-2 flex justify-end">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDownloadSingle(entry);
                            }}
                            className="px-2 py-0.5 text-[11px] font-medium text-zinc-300 hover:text-zinc-950 hover:bg-amber-400 bg-[#18181b] border border-[#27272a] rounded-sm transition-colors whitespace-nowrap shrink-0"
                            title={`Extract ${entry.name}`}
                          >
                            Extract
                          </button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </section>

            {/* Right Column: Deep Asset Previewer & Synchronized Hex Inspector */}
            <section className="flex-1 min-w-0 flex flex-col bg-[#09090b] min-h-0 h-full overflow-hidden">
              {/* Inspector Mode Switcher Bar */}
              <div className="shrink-0 px-3 py-1.5 border-b border-[#27272a] bg-[#121214] flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setInspectorTab('preview')}
                    className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-sm border transition-colors whitespace-nowrap shrink-0 ${
                      inspectorTab === 'preview'
                        ? 'bg-amber-500 text-zinc-950 font-semibold border-amber-500'
                        : 'border-[#27272a] bg-[#18181b] text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    <FileText className="w-3.5 h-3.5" />
                    <span>Asset Preview & Editor</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setInspectorTab('hex')}
                    className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-sm border transition-colors whitespace-nowrap shrink-0 ${
                      inspectorTab === 'hex'
                        ? 'bg-amber-500 text-zinc-950 font-semibold border-amber-500'
                        : 'border-[#27272a] bg-[#18181b] text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    <Binary className="w-3.5 h-3.5" />
                    <span>Entry Hex View</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setInspectorTab('archive_hex')}
                    className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-sm border transition-colors whitespace-nowrap shrink-0 ${
                      inspectorTab === 'archive_hex'
                        ? 'bg-amber-500 text-zinc-950 font-semibold border-amber-500'
                        : 'border-[#27272a] bg-[#18181b] text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    <HardDrive className="w-3.5 h-3.5" />
                    <span>Raw Container Hex ({formatBytes(archive.fileSize)})</span>
                  </button>
                </div>

                {selectedEntry && (
                  <div className="text-[11px] font-mono text-zinc-400 tabular-nums">
                    <span>{selectedEntry.compressionMethod}</span>
                    <span aria-hidden="true" className="mx-1.5">·</span>
                    <span>CRC {toHex(selectedEntry.crc32, 8)}</span>
                  </div>
                )}
              </div>

              {/* Active Inspector Viewport */}
              <div className="flex-1 min-h-0 overflow-hidden">
                {!selectedEntry ? (
                  <div className="h-full flex items-center justify-center text-xs text-zinc-500">
                    Select an entry from the archive table to inspect its payload.
                  </div>
                ) : inspectorTab === 'preview' ? (
                  <AssetPreviewer
                    entry={selectedEntry}
                    archive={archive}
                    onUpdateEntryData={handleUpdateEntryData}
                    onDownloadSingle={handleDownloadSingle}
                  />
                ) : inspectorTab === 'hex' ? (
                  <HexViewer
                    data={selectedEntry.data}
                    baseOffset={selectedEntry.offset}
                    title={`Entry: ${selectedEntry.path}`}
                  />
                ) : (
                  <HexViewer
                    data={archive.rawBytes}
                    baseOffset={0}
                    title={`Raw Container: ${archive.fileName}`}
                  />
                )}
              </div>
            </section>
          </main>
        )
      )}

      {/* VIEW 2: BINARY HEADER & STRUCTURE TELEMETRY */}
      {activeTopSection === 'headers' && (
        <main className="flex-1 min-h-0 overflow-y-auto max-w-7xl w-full mx-auto px-6 py-8 space-y-8">
          {!archive ? (
            <div className="p-12 text-center border border-slate-800 rounded-xl bg-[#0D131F] space-y-4">
              <h2 className="text-lg font-semibold text-slate-200">No Archive Loaded</h2>
              <p className="text-xs text-slate-400">
                Please open a game archive or select a demo preset to inspect its binary headers and extent tables.
              </p>
              <button
                type="button"
                onClick={() => setActiveTopSection('workspace')}
                className="px-4 py-2 text-xs font-semibold bg-amber-500 hover:bg-amber-400 text-slate-950 rounded transition-colors"
              >
                Go to Archive Explorer
              </button>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-end justify-between gap-4 border-b border-slate-800 pb-5">
                <div>
                  <h1 className="text-2xl font-bold text-slate-100 font-display">
                    Container Binary Header & Directory Structure
                  </h1>
                  <p className="text-sm text-slate-400 mt-1">
                    Exact byte offsets, magic identifiers, and endianness decoded from{' '}
                    <span className="font-mono text-amber-300">{archive.fileName}</span>.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setActiveTopSection('workspace')}
                  className="px-4 py-2 text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-100 rounded border border-slate-700 transition-colors whitespace-nowrap shrink-0"
                >
                  Return to Archive Explorer
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                {archive.headerFields.map((field, idx) => (
                  <div
                    key={idx}
                    className="p-5 bg-[#0D131F] border border-slate-800 rounded-lg space-y-2"
                  >
                    <div className="text-xs font-mono text-slate-400 tabular-nums">
                      Offset {field.offset} · {field.length} bytes
                    </div>
                    <div className="text-sm font-semibold text-slate-200">{field.label}</div>
                    <div className="text-base font-mono font-bold text-amber-400 tabular-nums break-all">
                      {field.value}
                    </div>
                    <p className="text-xs text-slate-400 leading-relaxed pt-1">{field.description}</p>
                  </div>
                ))}
              </div>

              <div className="border border-slate-800 rounded-lg overflow-hidden h-[520px]">
                <HexViewer
                  data={archive.rawBytes}
                  baseOffset={0}
                  title={`${archive.fileName} — Master Header Hex Dump`}
                />
              </div>
            </>
          )}
        </main>
      )}

      {/* VIEW 3: STANDALONE ZLIB RFC 1950 TRANSCODER & CARVER */}
      {activeTopSection === 'zlib' && (
        <main className="flex-1 min-h-0 overflow-y-auto max-w-7xl w-full mx-auto px-6 py-8 space-y-6">
          <div className="flex flex-wrap items-end justify-between gap-4 border-b border-slate-800 pb-5">
            <div>
              <h1 className="text-2xl font-bold text-slate-100 font-display">
                RFC 1950 Zlib Stream Compressor & FastFile Block Builder
              </h1>
              <p className="text-sm text-slate-400 mt-1">
                Compress plain scripts or binary payloads into raw Zlib streams (0x78 0x9C / 0x78 0xDA) used inside Call of Duty .FF, RGG .PAR, and proprietary console archives.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <label className="text-xs text-slate-400 font-mono">Deflate Level:</label>
              <select
                value={zlibLevel}
                onChange={(e) => setZlibLevel(Number(e.target.value))}
                className="px-3 py-1.5 text-xs font-mono bg-[#0D131F] border border-slate-700 rounded text-slate-100"
              >
                <option value={1}>Level 1 (Fastest - 0x78 0x01)</option>
                <option value={6}>Level 6 (Default - 0x78 0x9C)</option>
                <option value={9}>Level 9 (Maximum - 0x78 0xDA)</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="flex flex-col border border-slate-800 rounded-lg bg-[#0D131F] overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between text-xs">
                <span className="font-semibold text-slate-200">Uncompressed Input Payload</span>
                <span className="font-mono text-slate-400 tabular-nums">
                  {zlibBenchResult.rawBytes.length.toLocaleString()} bytes
                </span>
              </div>
              <textarea
                rows={14}
                value={zlibInputText}
                onChange={(e) => setZlibInputText(e.target.value)}
                spellCheck={false}
                className="w-full flex-1 p-4 bg-[#0B0F17] text-slate-200 font-mono text-xs leading-6 focus:outline-none"
              />
            </div>

            <div className="flex flex-col border border-slate-800 rounded-lg bg-[#0D131F] overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between text-xs">
                <div className="font-mono tabular-nums text-slate-300">
                  <span>Zlib Output: {zlibBenchResult.compressedBytes.length} B</span>
                  <span aria-hidden="true" className="mx-1.5">·</span>
                  <span className="text-amber-300">Ratio {zlibBenchResult.ratio}%</span>
                  <span aria-hidden="true" className="mx-1.5">·</span>
                  <span className="text-emerald-400">
                    Adler32 Verified ({zlibBenchResult.roundtripOk ? 'OK' : 'ERR'})
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    const blob = new Blob([zlibBenchResult.compressedBytes], {
                      type: 'application/octet-stream',
                    });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = 'stream_payload.zlib';
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                  className="px-3 py-1 text-xs font-semibold bg-amber-500 hover:bg-amber-400 text-slate-950 rounded transition-colors whitespace-nowrap shrink-0"
                >
                  Download .ZLIB
                </button>
              </div>
              <div className="flex-1 h-[340px]">
                <HexViewer
                  data={zlibBenchResult.compressedBytes}
                  baseOffset={0}
                  title="RFC 1950 Zlib Compressed Stream"
                />
              </div>
            </div>
          </div>
        </main>
      )}

      {/* VIEW 4: SUPPORTED ARCHIVE FORMATS SPECIFICATION MATRIX */}
      {activeTopSection === 'formats' && (
        <main className="flex-1 min-h-0 overflow-y-auto max-w-7xl w-full mx-auto px-6 py-8 space-y-6">
          <div className="border-b border-slate-800 pb-5">
            <h1 className="text-2xl font-bold text-slate-100 font-display">
              Supported Game Archive Specifications & Magic Signatures
            </h1>
            <p className="text-sm text-slate-400 mt-1">
              Spet&apos;s Universal Game File Opener inspects file headers at byte offset 0x00000000 and sector 16 (0x8000) rather than relying solely on file extensions.
            </p>
          </div>

          <div className="border border-slate-800 rounded-lg overflow-hidden bg-[#0D131F]">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-800 bg-[#0B0F17] text-slate-400 font-medium">
                  <th className="py-3 px-4">Format</th>
                  <th className="py-3 px-4">Extension</th>
                  <th className="py-3 px-4">Magic Signature (Hex)</th>
                  <th className="py-3 px-4">Target Game Engines</th>
                  <th className="py-3 px-4">Compression / Layout</th>
                  <th className="py-3 px-4 text-right">Repackable</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70">
                {FORMAT_SPECS.map((spec) => (
                  <tr key={spec.id} className="hover:bg-slate-900/60 transition-colors">
                    <td className="py-3 px-4 font-semibold text-slate-100 whitespace-nowrap">
                      {spec.name}
                    </td>
                    <td className="py-3 px-4 font-mono text-amber-300 whitespace-nowrap">
                      {spec.ext}
                    </td>
                    <td className="py-3 px-4 font-mono text-slate-300 tabular-nums">
                      {spec.magicSignature}
                    </td>
                    <td className="py-3 px-4 text-slate-300">{spec.engines}</td>
                    <td className="py-3 px-4 text-slate-400">{spec.compression}</td>
                    <td className="py-3 px-4 text-right font-mono">
                      {spec.canRepack ? (
                        <span className="text-emerald-400">Read / Write</span>
                      ) : (
                        <span className="text-slate-400">Read / Extract</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </main>
      )}

      {/* Modal for injecting new files or scripts into the active archive */}
      <ArchiveBuilderModal
        isOpen={isInjectModalOpen}
        onClose={() => setIsInjectModalOpen(false)}
        onAddTextEntry={handleAddTextEntry}
        onAddBinaryFiles={handleAddBinaryFiles}
      />
    </div>
  );
}
