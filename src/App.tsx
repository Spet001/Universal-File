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
  Layers,
  ChevronRight,
  Check,
  Cpu,
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
import { THEMES, ThemeId, DEFAULT_THEME } from './theme';

type InspectorDockTab = 'preview' | 'hex' | 'archive_hex' | 'headers' | 'zlib' | 'formats';
type SortField = 'name' | 'size' | 'offset' | 'category';

const getBaseUrl = (): string => {
  const meta = import.meta as unknown as { env?: { BASE_URL?: string } };
  return meta.env?.BASE_URL || './';
};

function getEntryIconUrl(entry: ArchiveEntry): string {
  const base = getBaseUrl();
  const name = entry.name.toLowerCase();
  if (entry.category === 'map' || name.startsWith('map') || /^e\dm\d/i.test(name)) {
    return `${base}icons/world-0.png`;
  }
  if (entry.category === 'audio' || name.endsWith('.wav') || name.endsWith('.mp3') || name.endsWith('.ogg') || name.endsWith('.hca') || name.endsWith('.adx')) {
    return `${base}icons/loudspeaker_rays-0.png`;
  }
  if (entry.category === 'texture' || entry.category === 'palette' || name.endsWith('.png') || name.endsWith('.tga') || name.endsWith('.dds') || name.endsWith('.bmp') || name.endsWith('.tim')) {
    return `${base}icons/paint_file-0.png`;
  }
  if (entry.category === 'script' || entry.category === 'config' || name.endsWith('.gsc') || name.endsWith('.csc') || name.endsWith('.txt') || name.endsWith('.cfg') || name.endsWith('.json') || name.endsWith('.csv')) {
    return `${base}icons/notepad_file-0.png`;
  }
  if (entry.category === 'package' || name.endsWith('.pak') || name.endsWith('.wad') || name.endsWith('.zip') || name.endsWith('.pk3') || name.endsWith('.jar') || name.endsWith('.pkg')) {
    return `${base}icons/package-0.png`;
  }
  return `${base}icons/executable-0.png`;
}

function getCompactTypeTag(entry: ArchiveEntry): string {
  const name = entry.name.toLowerCase();
  if (entry.uncompressedSize === 0 && entry.category === 'map') {
    return 'MAP/MARK';
  }
  if (entry.category === 'map' || name.endsWith('.bsp') || /^map\d\d/i.test(name)) {
    return 'MAP/RAW';
  }
  if (entry.category === 'texture' || entry.category === 'palette' || name.endsWith('.dds') || name.endsWith('.tga') || name.endsWith('.png') || name.endsWith('.tim')) {
    return 'TEX/PAL';
  }
  if (entry.category === 'audio' || name.endsWith('.wav') || name.endsWith('.hca') || name.endsWith('.adx') || name.endsWith('.ogg')) {
    return 'SND/RAW';
  }
  if (entry.category === 'script' || name.endsWith('.gsc') || name.endsWith('.csc') || name.endsWith('.lua')) {
    return 'SCR/GSC';
  }
  if (entry.category === 'model' || name.endsWith('.mdl') || name.endsWith('.bmodel')) {
    return 'MOD/3D';
  }
  if (entry.category === 'package' || name.endsWith('.zip') || name.endsWith('.pk3') || name.endsWith('.pak')) {
    return 'ARC/SUB';
  }
  if (entry.category === 'config' || name.endsWith('.cfg') || name.endsWith('.csv') || name.endsWith('.json')) {
    return 'CFG/TXT';
  }
  return 'BIN/RAW';
}

export default function App() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [currentTheme, setCurrentTheme] = useState<ThemeId>(() => {
    const saved = localStorage.getItem('spet-file-opener-theme');
    if (saved === 'slade' || saved === 'oled' || saved === 'cobalt' || saved === 'ida') {
      return saved as ThemeId;
    }
    return DEFAULT_THEME;
  });

  useEffect(() => {
    localStorage.setItem('spet-file-opener-theme', currentTheme);
    document.documentElement.setAttribute('data-theme', currentTheme);
    document.body.setAttribute('data-theme', currentTheme);
  }, [currentTheme]);

  const [showAboutModal, setShowAboutModal] = useState<boolean>(false);

  const [archive, setArchive] = useState<ParsedArchive | null>(null);
  const [isLoadingArchive, setIsLoadingArchive] = useState<boolean>(false);
  const [loadingStatus, setLoadingStatus] = useState<string>('');
  const [activePresetId, setActivePresetId] = useState<string>('');
  const [activeDockTab, setActiveDockTab] = useState<InspectorDockTab>('preview');
  const [selectedFolder, setSelectedFolder] = useState<string>('ALL');
  const [selectedCategory, setSelectedCategory] = useState<AssetCategory | 'ALL'>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [sortField, setSortField] = useState<SortField>('offset');
  const [sortAsc, setSortAsc] = useState<boolean>(true);
  const [selectedEntryId, setSelectedEntryId] = useState<string>('');
  const [isDraggingOver, setIsDraggingOver] = useState<boolean>(false);
  const [isInjectModalOpen, setIsInjectModalOpen] = useState<boolean>(false);
  const [repackTarget, setRepackTarget] = useState<'ZIP' | 'PK3' | 'PAK' | 'WAD' | 'FF'>('FF');
  const [openMenu, setOpenMenu] = useState<string | null>(null);

  // Standalone Zlib Workbench state
  const [zlibInputText, setZlibInputText] = useState<string>(
    '// RFC 1950 Zlib Deflate test block\nsetdvar("r_fullscreen", "1");\nsetdvar("com_maxfps", "250");'
  );
  const [zlibLevel, setZlibLevel] = useState<number>(6);

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
      setActiveDockTab('preview');
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
      setActiveDockTab('preview');
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
      className="h-screen w-screen overflow-hidden flex flex-col bg-[#06090f] text-[#cbd5e1] select-none font-mono"
      onDragOver={(e) => {
        e.preventDefault();
        setIsDraggingOver(true);
      }}
      onDragLeave={() => setIsDraggingOver(false)}
      onDrop={handleDrop}
      onClick={() => {
        if (openMenu) setOpenMenu(null);
      }}
    >
      {/* Hidden File Input */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".ff,.zip,.rar,.wad,.pak,.iso,.pk3,.pk4,.iwd,.par,.vpk,.big,.zlib,.dat,.bin,.bsa,.ba2,.forge,.rpf,.jar,.pkg,.awb,.acb,.usm,.adx,.hca,.bnd,.bnd4,.dcx,.sdat,.pfs,.rpa,*"
        className="hidden"
        onChange={(e) => {
          if (e.target.files && e.target.files[0]) {
            handleFileUpload(e.target.files[0]);
            e.target.value = '';
          }
        }}
      />

      {/* Drag & Drop Overlay */}
      {isDraggingOver && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-[#06090f]/90">
          <div className="flex flex-col items-center gap-2 border border-[#38bdf8] bg-[#090d14] p-8 text-center font-mono">
            <HardDrive className="h-8 w-8 text-[#38bdf8]" />
            <div className="text-sm font-semibold text-white">
              Drop Any Game Archive for Pure Local Parsing
            </div>
            <div className="text-[11px] text-[#64748b]">
              BSA/BA2 · FORGE · RPF · JAR · PKG · CRIWARE (AWB/USM) · FromSoft BND/DCX · CoD FastFiles (.ff) · id Tech (WAD/PAK/PK3)
            </div>
          </div>
        </div>
      )}

      {/* ============================================================== */}
      {/* ZONE A: Native Menu & Telemetry Topbar (h-[28px])              */}
      {/* ============================================================== */}
      <header className="h-[28px] shrink-0 bg-[#06090f] border-b border-[#182232] px-2.5 flex items-center justify-between text-[11px] font-mono z-30 select-none">
        {/* Left: Tool Brand + Menu Triggers */}
        <div className="flex items-center gap-2 shrink-0">
          <div className="flex items-center gap-1.5 pr-2 select-none">
            <img
              src={`${getBaseUrl()}icons/hard_disk_drive-0.png`}
              alt=""
              className="pixelated shrink-0 w-3.5 h-3.5"
            />
            <span className="font-sans font-bold tracking-tight text-[#f59e0b]">Spet's</span>
            <span className="font-mono font-semibold text-slate-100 tracking-tight">Universal Game File Opener</span>
          </div>

          <nav className="relative flex items-center gap-0.5 text-[11px]">
            {/* FILE MENU */}
            <div className="relative">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setOpenMenu(openMenu === 'file' ? null : 'file');
                }}
                className={`px-1.5 py-0.5 text-slate-300 hover:text-white hover:bg-[#111a29] ${
                  openMenu === 'file' ? 'bg-[#111a29] text-white' : ''
                }`}
              >
                File
              </button>
              {openMenu === 'file' && (
                <div
                  onClick={(e) => e.stopPropagation()}
                  className="absolute left-0 top-full mt-0.5 w-64 border border-[#182232] bg-[#090d14] py-1 shadow-2xl z-50 text-[11px]"
                >
                  <button
                    type="button"
                    onClick={() => {
                      setOpenMenu(null);
                      fileInputRef.current?.click();
                    }}
                    className="flex w-full items-center justify-between px-3 py-1 text-left text-slate-200 hover:bg-[#111a29] hover:text-[#38bdf8]"
                  >
                    <span>Open Game Archive...</span>
                    <span className="text-[10px] text-[#64748b]">Ctrl+O</span>
                  </button>
                  <div className="my-1 border-t border-[#182232]" />
                  <div className="px-3 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[#64748b]">
                    Open Source Demo Presets
                  </div>
                  {SAMPLE_ARCHIVES.map((smp) => (
                    <button
                      key={smp.id}
                      type="button"
                      onClick={async () => {
                        setOpenMenu(null);
                        await handleLoadSample(smp.id);
                      }}
                      className="flex w-full items-center justify-between px-3 py-1 text-left text-slate-300 hover:bg-[#111a29] hover:text-white"
                    >
                      <span className="truncate">{smp.fileName}</span>
                      <span className="ml-2 shrink-0 border border-[#182232] bg-[#06090f] px-1 text-[10px] text-[#38bdf8]">
                        {smp.formatBadge}
                      </span>
                    </button>
                  ))}
                  <div className="my-1 border-t border-[#182232]" />
                  <button
                    type="button"
                    onClick={() => {
                      setOpenMenu(null);
                      setIsInjectModalOpen(true);
                    }}
                    className="flex w-full items-center px-3 py-1 text-left text-slate-200 hover:bg-[#111a29]"
                  >
                    Inject File / Lump Payload...
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setOpenMenu(null);
                      handleRepackAndDownload(repackTarget);
                    }}
                    className="flex w-full items-center justify-between px-3 py-1 text-left text-[#38bdf8] hover:bg-[#111a29]"
                  >
                    <span>Rebuild & Save Container ({repackTarget})</span>
                  </button>
                </div>
              )}
            </div>

            {/* ANALYSIS MENU */}
            <div className="relative">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setOpenMenu(openMenu === 'analysis' ? null : 'analysis');
                }}
                className={`px-1.5 py-0.5 text-slate-300 hover:text-white hover:bg-[#111a29] ${
                  openMenu === 'analysis' ? 'bg-[#111a29] text-white' : ''
                }`}
              >
                Analysis
              </button>
              {openMenu === 'analysis' && (
                <div
                  onClick={(e) => e.stopPropagation()}
                  className="absolute left-0 top-full mt-0.5 w-60 border border-[#182232] bg-[#090d14] py-1 shadow-2xl z-50 text-[11px]"
                >
                  <button
                    type="button"
                    onClick={() => {
                      setActiveDockTab('headers');
                      setOpenMenu(null);
                    }}
                    className="flex w-full items-center px-3 py-1 text-left text-slate-200 hover:bg-[#111a29]"
                  >
                    Binary Header & Extent Inspection
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setActiveDockTab('zlib');
                      setOpenMenu(null);
                    }}
                    className="flex w-full items-center px-3 py-1 text-left text-slate-200 hover:bg-[#111a29]"
                  >
                    Zlib RFC 1950 Stream Transcoder
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setActiveDockTab('formats');
                      setOpenMenu(null);
                    }}
                    className="flex w-full items-center px-3 py-1 text-left text-slate-200 hover:bg-[#111a29]"
                  >
                    Supported Engine Formats Matrix
                  </button>
                </div>
              )}
            </div>

            {/* VIEW MENU */}
            <div className="relative">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setOpenMenu(openMenu === 'view' ? null : 'view');
                }}
                className={`px-1.5 py-0.5 text-slate-300 hover:text-white hover:bg-[#111a29] ${
                  openMenu === 'view' ? 'bg-[#111a29] text-white' : ''
                }`}
              >
                View
              </button>
              {openMenu === 'view' && (
                <div
                  onClick={(e) => e.stopPropagation()}
                  className="absolute left-0 top-full mt-0.5 w-60 border border-[#182232] bg-[#090d14] py-1 shadow-2xl z-50 text-[11px]"
                >
                  {(
                    [
                      ['preview', 'Asset Previewer & Hex Editor'],
                      ['hex', 'Entry Hex Stream View'],
                      ['archive_hex', 'Raw Container Hex View'],
                      ['headers', 'Binary Headers Table'],
                      ['zlib', 'Zlib Stream Transcoder'],
                      ['formats', 'Supported Formats Matrix'],
                    ] as Array<[InspectorDockTab, string]>
                  ).map(([tabId, label]) => (
                    <button
                      key={tabId}
                      type="button"
                      onClick={() => {
                        setActiveDockTab(tabId);
                        setOpenMenu(null);
                      }}
                      className="flex w-full items-center justify-between px-3 py-1 text-left text-slate-200 hover:bg-[#111a29]"
                    >
                      <span>{label}</span>
                      {activeDockTab === tabId && <Check className="h-3 w-3 text-[#38bdf8]" />}
                    </button>
                  ))}
                  <div className="my-1 border-t border-[#182232]" />
                  <div className="px-3 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-[#64748b]">
                    UI Color Theme
                  </div>
                  {THEMES.map((th) => (
                    <button
                      key={th.id}
                      type="button"
                      onClick={() => {
                        setCurrentTheme(th.id);
                        setOpenMenu(null);
                      }}
                      className="flex w-full items-center justify-between px-3 py-1 text-left text-slate-200 hover:bg-[#111a29]"
                    >
                      <span>{th.name}</span>
                      {currentTheme === th.id && <Check className="h-3 w-3 text-[#38bdf8]" />}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* HEX MENU */}
            <button
              type="button"
              onClick={() => setActiveDockTab('hex')}
              className={`px-1.5 py-0.5 text-slate-300 hover:text-white hover:bg-[#111a29] ${
                activeDockTab === 'hex' ? 'bg-[#111a29] text-[#38bdf8]' : ''
              }`}
            >
              Hex
            </button>

            {/* HELP MENU */}
            <div className="relative">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setOpenMenu(openMenu === 'help' ? null : 'help');
                }}
                className={`px-1.5 py-0.5 text-slate-300 hover:text-white hover:bg-[#111a29] ${
                  openMenu === 'help' ? 'bg-[#111a29] text-white' : ''
                }`}
              >
                Help
              </button>
              {openMenu === 'help' && (
                <div
                  onClick={(e) => e.stopPropagation()}
                  className="absolute left-0 top-full mt-0.5 w-60 border border-[#182232] bg-[#090d14] py-1 shadow-2xl z-50 text-[11px]"
                >
                  <button
                    type="button"
                    onClick={() => {
                      setActiveDockTab('formats');
                      setOpenMenu(null);
                    }}
                    className="flex w-full items-center justify-between px-3 py-1 text-left text-slate-200 hover:bg-[#111a29]"
                  >
                    <span>Supported Formats Matrix</span>
                    <span className="text-[10px] text-[#64748b]">25+ Engines</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setActiveDockTab('archive_hex');
                      setOpenMenu(null);
                    }}
                    className="flex w-full items-center px-3 py-1 text-left text-slate-200 hover:bg-[#111a29]"
                  >
                    Raw Container Hex Inspector
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setActiveDockTab('headers');
                      setOpenMenu(null);
                    }}
                    className="flex w-full items-center px-3 py-1 text-left text-slate-200 hover:bg-[#111a29]"
                  >
                    Master Binary Headers Table
                  </button>
                  <div className="my-1 border-t border-[#182232]" />
                  <button
                    type="button"
                    onClick={() => {
                      setShowAboutModal(true);
                      setOpenMenu(null);
                    }}
                    className="flex w-full items-center justify-between px-3 py-1 text-left text-[#38bdf8] hover:bg-[#111a29]"
                  >
                    <span>About Game File Opener</span>
                    <span className="text-[10px] text-emerald-400 font-semibold">[Pure WASM]</span>
                  </button>
                </div>
              )}
            </div>
          </nav>
        </div>

        {/* Center/Right: Active Archive Telemetry + Theme Switcher + Load Button */}
        <div className="flex items-center gap-2">
          {/* Active Container Telemetry */}
          <div className="hidden lg:flex items-center gap-1.5 text-[11px] text-[#64748b] truncate max-w-xl">
            {isLoadingArchive ? (
              <span className="text-[#38bdf8] animate-pulse">{loadingStatus}</span>
            ) : archive ? (
              <>
                <span className="text-slate-300 font-semibold truncate">Target: {archive.fileName}</span>
                <span>|</span>
                <span className="text-[#38bdf8]">{archive.formatName}</span>
                <span>|</span>
                <span>{formatBytes(archive.fileSize)}</span>
                <span>|</span>
                <span className="text-amber-400">{archive.entries.length.toLocaleString()} lumps</span>
                <span>|</span>
                <span>{archive.parseTimeMs} ms</span>
              </>
            ) : (
              <span>Target: (No archive loaded)</span>
            )}
          </div>

          {/* Theme Selector */}
          <div className="flex items-center gap-1 shrink-0">
            <span className="text-[10px] text-[#64748b]">Theme:</span>
            <select
              value={currentTheme}
              onChange={(e) => setCurrentTheme(e.target.value as ThemeId)}
              className="h-[20px] px-1 bg-[#090d14] border border-[#182232] text-[10px] text-slate-300 font-mono focus:border-[#38bdf8] focus:outline-none"
            >
              {THEMES.map((th) => (
                <option key={th.id} value={th.id}>
                  {th.name}
                </option>
              ))}
            </select>
          </div>

          {/* Compact Sample Selector Dropdown */}
          <div className="flex items-center gap-1">
            <select
              value={activePresetId}
              onChange={(e) => handleLoadSample(e.target.value)}
              className="h-[20px] px-1 bg-[#090d14] border border-[#182232] text-[10px] text-slate-300 font-mono focus:border-[#38bdf8] focus:outline-none"
            >
              <option value="" disabled>
                Open Demo...
              </option>
              {SAMPLE_ARCHIVES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.fileName} ({s.formatBadge})
                </option>
              ))}
            </select>

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="h-[20px] px-2 bg-[#111a29] border border-[#26354d] hover:border-[#38bdf8] text-[10px] text-slate-200 font-mono flex items-center gap-1.5 cursor-pointer"
            >
              <img
                src={`${getBaseUrl()}icons/directory_open_file_mydocs-4.png`}
                alt=""
                className="pixelated shrink-0 w-3 h-3"
              />
              <span>[Load File]</span>
            </button>
          </div>
        </div>
      </header>

      {/* ============================================================== */}
      {/* ZONE B: Quick-Load Ribbon (h-[24px])                            */}
      {/* ============================================================== */}
      <div className="h-[24px] shrink-0 bg-[#0c121d] border-b border-[#182232] px-2.5 flex items-center gap-1.5 text-[11px] font-mono shrink-0 overflow-x-auto whitespace-nowrap select-none">
        <span className="text-[10px] uppercase tracking-wider text-[#64748b] shrink-0 mr-1">
          Quick Demos:
        </span>
        {SAMPLE_ARCHIVES.map((sample) => {
          const active = activePresetId === sample.id;
          const engineTag = sample.formatBadge.split(' ')[0].replace(/[\(\)]/g, '');
          return (
            <button
              key={sample.id}
              type="button"
              onClick={() => handleLoadSample(sample.id)}
              disabled={isLoadingArchive && active}
              className={`h-[18px] px-1.5 flex items-center gap-1 border border-[#182232] bg-[#090d14] text-[10px] font-mono transition-colors whitespace-nowrap shrink-0 ${
                active
                  ? 'bg-[#111a29] text-[#38bdf8] border-[#38bdf8] font-bold'
                  : 'text-slate-300 hover:text-white hover:border-[#38bdf8]'
              }`}
              title={`${sample.title} (${sample.formatBadge})`}
            >
              <span>[{sample.fileName} · {engineTag}]</span>
            </button>
          );
        })}
      </div>

      {/* Warning Alert Strip if any */}
      {archive && archive.warnings.length > 0 && (
        <div className="h-[22px] shrink-0 bg-amber-950/40 border-b border-amber-900/40 px-3 flex items-center gap-1.5 text-[10px] text-amber-300 font-mono">
          <AlertTriangle className="h-3 w-3 text-amber-400 shrink-0" />
          <span className="truncate">{archive.warnings[0]}</span>
        </div>
      )}

      {/* ============================================================== */}
      {/* 3-COLUMN WORKBENCH: Left Dock, Entry Table, Center Workspace   */}
      {/* ============================================================== */}
      <div className="flex-1 min-h-0 flex overflow-hidden">
        {/* ============================================================== */}
        {/* ZONE C: Left Dock Pane (w-[270px] shrink-0 border-r border-[#182232]) */}
        {/* ============================================================== */}
        <aside className="w-[270px] shrink-0 border-r border-[#182232] flex flex-col min-h-0 bg-[#090d14] overflow-hidden select-none">
          {/* Clean 4-Row Engine Key-Value Table */}
          <div className="p-2 border-b border-[#182232] bg-[#070a10] font-mono text-[10px] space-y-1 shrink-0">
            <div className="flex items-center justify-between gap-1">
              <span className="text-[#64748b] uppercase tracking-wider shrink-0 w-[54px]">Engine:</span>
              <span className="text-white font-semibold truncate text-right flex-1" title={archive ? archive.engineFamily : 'Generic Binary Engine'}>
                {archive ? archive.engineFamily : 'Generic Binary Engine'}
              </span>
            </div>
            <div className="flex items-center justify-between gap-1">
              <span className="text-[#64748b] uppercase tracking-wider shrink-0 w-[54px]">Format:</span>
              <span className="text-[#38bdf8] font-bold truncate text-right flex-1">
                {archive ? `${archive.formatId} (${archive.formatName})` : 'AUTO'}
              </span>
            </div>
            <div className="flex items-center justify-between gap-1">
              <span className="text-[#64748b] uppercase tracking-wider shrink-0 w-[54px]">Magic:</span>
              <span className="text-[#f59e0b] font-mono tabular-nums text-right flex-1">
                {archive ? archive.magicBytes : '0x00000000'}
              </span>
            </div>
            <div className="flex items-center justify-between gap-1">
              <span className="text-[#64748b] uppercase tracking-wider shrink-0 w-[84px]">Disk / Entries:</span>
              <span className="text-slate-300 tabular-nums text-right flex-1 truncate">
                {archive ? `${formatBytes(archive.fileSize)} / ${archive.entries.length.toLocaleString()} lumps` : '0 B / 0 lumps'}
              </span>
            </div>
          </div>

          {/* Directory Tree Header */}
          <div className="h-[22px] px-2 bg-[#0c121d] border-b border-[#182232] flex items-center justify-between text-[10px] font-mono text-[#64748b] uppercase tracking-wider shrink-0">
            <span>Virtual Directories</span>
            <span>{folders.length}</span>
          </div>

          {/* Virtual Directories Tree (100% of remaining vertical height) */}
          <div className="flex-1 min-h-0 overflow-y-auto py-1 font-mono text-[11px] divide-y divide-[#182232]/40 bg-[#090d14]">
            <button
              type="button"
              onClick={() => setSelectedFolder('ALL')}
              className={`w-full h-[20px] px-2 flex items-center justify-between text-[11px] font-mono cursor-pointer transition-colors ${
                selectedFolder === 'ALL'
                  ? 'bg-[#111a29] text-[#38bdf8] border-l-2 border-l-[#38bdf8] font-semibold'
                  : 'text-slate-300 hover:bg-[#38bdf8]/[0.08]'
              }`}
            >
              <span className="flex items-center gap-1.5 truncate">
                <img
                  src={`${getBaseUrl()}icons/directory_open_file_mydocs-4.png`}
                  alt=""
                  className="pixelated shrink-0 w-3.5 h-3.5"
                />
                <span className="truncate">All Directories</span>
              </span>
              <span className="text-[10px] text-[#64748b]">
                {archive ? archive.entries.length : 0}
              </span>
            </button>

            {folders.map(([folderName, count]) => {
              const isSel = selectedFolder === folderName;
              const depth = folderName === '(root)' ? 0 : Math.max(0, folderName.split('/').length - 1);
              const displayName = folderName === '(root)' ? '(root)' : folderName.split('/').pop() || folderName;
              return (
                <button
                  key={folderName}
                  type="button"
                  onClick={() => setSelectedFolder(folderName)}
                  style={{ paddingLeft: `${8 + depth * 10}px` }}
                  className={`w-full h-[20px] pr-2 flex items-center justify-between text-[11px] font-mono cursor-pointer transition-colors ${
                    isSel
                      ? 'bg-[#111a29] text-[#38bdf8] border-l-2 border-l-[#38bdf8] font-semibold'
                      : 'text-slate-400 hover:bg-[#38bdf8]/[0.08] hover:text-slate-200'
                  }`}
                  title={folderName}
                >
                  <span className="flex items-center gap-1 truncate">
                    <ChevronRight className={`w-2.5 h-2.5 ${isSel ? 'text-[#38bdf8]' : 'text-[#64748b]'} shrink-0`} />
                    <img
                      src={`${getBaseUrl()}icons/directory_closed-4.png`}
                      alt=""
                      className="pixelated shrink-0 w-3.5 h-3.5"
                    />
                    <span className="truncate">{displayName}</span>
                  </span>
                  <span className="text-[10px] text-[#64748b] shrink-0 ml-1">{count}</span>
                </button>
              );
            })}
          </div>

          {/* Bottom Injection & Repack Bar */}
          <div className="p-1.5 border-t border-[#182232] bg-[#070a10] space-y-1.5 shrink-0 text-[10px]">
            <button
              type="button"
              onClick={() => setIsInjectModalOpen(true)}
              className="w-full h-[22px] flex items-center justify-center gap-1 bg-[#111a29] hover:border-[#38bdf8] text-[#38bdf8] border border-[#26354d]"
            >
              <Plus className="w-3 h-3" />
              <span>Inject Lump / Asset</span>
            </button>
            <div className="flex items-center gap-1">
              <select
                value={repackTarget}
                onChange={(e) =>
                  setRepackTarget(e.target.value as 'ZIP' | 'PK3' | 'PAK' | 'WAD' | 'FF')
                }
                className="flex-1 h-[20px] px-1 bg-[#06090f] border border-[#182232] text-slate-300 font-mono text-[10px] focus:outline-none focus:border-[#38bdf8]"
              >
                <option value="FF">.FF (FastFile)</option>
                <option value="ZIP">.ZIP (Container)</option>
                <option value="PK3">.PK3 (Quake3)</option>
                <option value="PAK">.PAK (Quake1)</option>
                <option value="WAD">.WAD (DOOM)</option>
              </select>
              <button
                type="button"
                onClick={() => handleRepackAndDownload(repackTarget)}
                className="h-[20px] px-2 bg-[#38bdf8] hover:bg-[#38bdf8]/90 text-slate-950 font-bold text-[10px]"
              >
                Save
              </button>
            </div>
          </div>
        </aside>

        {/* ============================================================== */}
        {/* ZONE D: Center Workspace                                      */}
        {/* ============================================================== */}
        <div className="flex-1 flex flex-col min-w-0 bg-[#080b11] overflow-hidden">
          {/* Horizontal Asset Type Filter Strip (Moved here from Left Sidebar!) */}
          <div className="h-[26px] bg-[#0c121d] border-b border-[#182232] px-2 flex items-center gap-1 overflow-x-auto shrink-0 text-[10px] font-mono select-none">
            <span className="text-[#64748b] uppercase tracking-wider text-[9px] mr-1">Filter:</span>
            {(
              [
                ['ALL', 'All Types'],
                ['executable', 'Executables'],
                ['package', 'Packages'],
                ['script', 'Scripts / GSC'],
                ['config', 'Configs / CSV'],
                ['texture', 'Textures / TIM'],
                ['video', 'Video / BIK'],
                ['audio', 'Audio / SFX'],
                ['model', '3D Models'],
                ['map', 'Maps / Geometry'],
                ['palette', 'Palettes'],
                ['binary', 'Binaries'],
              ] as const
            ).map(([catKey, label]) => (
              <button
                key={catKey}
                type="button"
                onClick={() => setSelectedCategory(catKey)}
                className={`h-[18px] px-1.5 flex items-center whitespace-nowrap transition-colors border ${
                  selectedCategory === catKey
                    ? 'bg-[#111a29] text-[#38bdf8] border-[#38bdf8] font-bold'
                    : 'bg-[#090d14] border-[#182232] text-slate-400 hover:text-white'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Split: Table Column + Right Inspector / Viewport */}
          <div className="flex-1 min-h-0 flex overflow-hidden">
            {/* High-Density Archive Entry Table (5-column layout per spec) */}
            <section className="w-[480px] 2xl:w-[540px] shrink-0 border-r border-[#182232] flex flex-col bg-[#090d14] min-h-0 h-full overflow-hidden select-none">
              {/* Search Strip */}
              <div className="h-[26px] shrink-0 px-2 bg-[#06090f] border-b border-[#182232] flex items-center justify-between gap-1.5">
                <div className="relative flex-1">
                  <Search className="w-3 h-3 text-[#64748b] absolute left-1.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Filter lumps / paths..."
                    className="w-full h-[20px] pl-6 pr-1 text-[11px] font-mono bg-[#090d14] border border-[#182232] text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-[#38bdf8]"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="h-[20px] px-1.5 bg-[#111a29] border border-[#182232] text-[10px] text-slate-300 hover:text-white"
                >
                  Open
                </button>
              </div>

              {/* Sticky 22px Header: Entry Path / Lump, Type, Offset, Size, Action */}
              <div className="h-[22px] shrink-0 flex items-center px-2 bg-[#0c121d] border-b border-[#182232] text-[10px] font-mono uppercase tracking-wider text-[#64748b]">
                <button
                  type="button"
                  onClick={() => toggleSort('name')}
                  className="flex-1 min-w-[140px] flex items-center gap-1 text-left hover:text-slate-200 truncate cursor-pointer"
                  title="Sort by Entry Path"
                >
                  <span>Entry Path / Lump</span>
                  <ArrowUpDown className="w-2.5 h-2.5 opacity-60 shrink-0" />
                </button>
                <button
                  type="button"
                  onClick={() => toggleSort('category')}
                  className="w-[95px] shrink-0 text-left hover:text-slate-200 truncate pl-1 cursor-pointer"
                  title="Sort by Category"
                >
                  <span>Type</span>
                </button>
                <button
                  type="button"
                  onClick={() => toggleSort('offset')}
                  className="w-[82px] shrink-0 text-right hover:text-slate-200 font-mono cursor-pointer"
                  title="Sort by Offset"
                >
                  <span>Offset</span>
                </button>
                <button
                  type="button"
                  onClick={() => toggleSort('size')}
                  className="w-[68px] shrink-0 text-right hover:text-slate-200 font-mono pr-2 cursor-pointer"
                  title="Sort by Size"
                >
                  <span>Size</span>
                </button>
                <span className="w-[58px] shrink-0 text-right">Action</span>
              </div>

              {/* Rows (h-[23px] per row, 28-35 rows visible per viewport) */}
              <div className="flex-1 min-h-0 overflow-y-auto divide-y divide-[#182232]/30 bg-[#090d14]">
                {!archive ? (
                  <div className="p-4 text-center text-[#64748b] text-[11px] font-mono space-y-1.5">
                    <p className="text-slate-300 font-semibold">Ready to inspect game archives</p>
                    <p>Drag & drop any archive here, click [Open], or select a Quick Demo above.</p>
                  </div>
                ) : filteredEntries.length === 0 ? (
                  <div className="p-3 text-center text-[#64748b] text-[11px] font-mono">
                    No entries matching current filter query.
                  </div>
                ) : (
                  filteredEntries.map((entry) => {
                    const isSelected = selectedEntry?.id === entry.id;
                    return (
                      <div
                        key={entry.id}
                        onClick={() => setSelectedEntryId(entry.id)}
                        className={`group h-[23px] px-2 flex items-center text-[11px] font-mono cursor-pointer border-b border-white/[0.02] even:bg-white/[0.01] hover:bg-[#38bdf8]/[0.08] transition-colors ${
                          isSelected
                            ? 'bg-[#111a29] text-[#38bdf8] border-l-2 border-l-[#38bdf8]'
                            : 'text-slate-300'
                        }`}
                      >
                        {/* Entry Path / Lump: flex-1 min-w-[140px] truncate */}
                        <div className="flex-1 min-w-[140px] truncate flex items-center gap-1.5 pr-2">
                          <img
                            src={getEntryIconUrl(entry)}
                            alt=""
                            className="pixelated shrink-0 w-3.5 h-3.5"
                          />
                          <span
                            className={`truncate ${
                              isSelected ? 'text-[#38bdf8] font-bold' : 'text-[#e2e8f0]'
                            }`}
                            title={entry.path || entry.name}
                          >
                            {entry.name}
                          </span>
                          {entry.isModified && (
                            <span className="text-amber-400 text-[9px] shrink-0">*mod</span>
                          )}
                        </div>

                        {/* Type: w-[95px] shrink-0 truncate */}
                        <div className="w-[95px] shrink-0 truncate text-[10px] pl-1">
                          <span className="inline-block px-1 py-0 rounded-[2px] bg-black/40 border border-white/10 text-slate-300 font-semibold text-[9px] tracking-wide">
                            {getCompactTypeTag(entry)}
                          </span>
                        </div>

                        {/* Offset: w-[82px] shrink-0 text-right font-mono */}
                        <div className="w-[82px] shrink-0 text-right text-[#64748b] tabular-nums text-[10px] font-mono">
                          {toHex(entry.offset, 6)}
                        </div>

                        {/* Size: w-[68px] shrink-0 text-right font-mono pr-2 */}
                        <div className="w-[68px] shrink-0 text-right text-[#cbd5e1] tabular-nums text-[10px] font-mono pr-2">
                          {formatBytes(entry.uncompressedSize)}
                        </div>

                        {/* Action: w-[58px] shrink-0 text-right */}
                        <div className="w-[58px] shrink-0 text-right">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDownloadSingle(entry);
                            }}
                            className="hidden group-hover:inline-block px-1.5 py-0 bg-[#111a29] border border-slate-700 hover:border-[#38bdf8] text-[9px] text-slate-300 cursor-pointer"
                            title={`Extract ${entry.name}`}
                          >
                            [Extract]
                          </button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </section>

            {/* Right Center Column: IDE Dock Tabs & Active Viewport */}
            <section className="flex-1 min-w-0 flex flex-col bg-[#080b11] min-h-0 h-full overflow-hidden">
              {/* Rectangular IDE Dock Tabs */}
              <div className="h-[28px] shrink-0 bg-[#06090f] border-b border-[#182232] flex items-center justify-between select-none overflow-x-auto no-scrollbar">
                <div className="flex items-center h-full shrink-0">
                  {(
                    [
                      ['preview', 'Preview', FileText],
                      ['hex', 'Entry Hex', Binary],
                      ['archive_hex', 'Container Hex', HardDrive],
                      ['headers', 'Headers', Layers],
                      ['zlib', 'Zlib', Cpu],
                      ['formats', 'Formats', Check],
                    ] as Array<[InspectorDockTab, string, any]>
                  ).map(([id, label, Icon]) => {
                    const active = activeDockTab === id;
                    return (
                      <button
                        key={id}
                        type="button"
                        onClick={() => setActiveDockTab(id)}
                        className={`h-full px-3 text-[11px] font-mono whitespace-nowrap shrink-0 flex items-center gap-1.5 transition-colors cursor-pointer border-r border-[#182232] ${
                          active
                            ? 'text-white bg-[#090d14] border-t-2 border-t-[#38bdf8]'
                            : 'text-slate-400 hover:bg-[#0c121d] hover:text-slate-200'
                        }`}
                      >
                        <Icon className="h-3 w-3 shrink-0" />
                        <span>{label}</span>
                      </button>
                    );
                  })}
                </div>

                {selectedEntry && (
                  <div className="pr-3 text-[10px] font-mono text-[#64748b] hidden md:flex items-center gap-2">
                    <span>{selectedEntry.compressionMethod}</span>
                    <span>·</span>
                    <span>CRC {toHex(selectedEntry.crc32, 8)}</span>
                  </div>
                )}
              </div>

              {/* Viewport Content */}
              <div className="flex-1 min-h-0 overflow-hidden bg-[#06090f]">
                {activeDockTab === 'preview' && (
                  selectedEntry ? (
                    <AssetPreviewer
                      entry={selectedEntry}
                      archive={archive!}
                      onUpdateEntryData={handleUpdateEntryData}
                      onDownloadSingle={handleDownloadSingle}
                    />
                  ) : (
                    <div className="h-full flex items-center justify-center text-xs text-[#64748b] font-mono">
                      Select an entry from the archive table to inspect its payload.
                    </div>
                  )
                )}

                {activeDockTab === 'hex' && (
                  selectedEntry ? (
                    <HexViewer
                      data={selectedEntry.data}
                      baseOffset={selectedEntry.offset}
                      title={`Entry: ${selectedEntry.path}`}
                    />
                  ) : (
                    <div className="h-full flex items-center justify-center text-xs text-[#64748b] font-mono">
                      No entry selected.
                    </div>
                  )
                )}

                {activeDockTab === 'archive_hex' && (
                  archive ? (
                    <HexViewer
                      data={archive.rawBytes}
                      baseOffset={0}
                      title={`Raw Container: ${archive.fileName}`}
                    />
                  ) : (
                    <div className="h-full flex items-center justify-center text-xs text-[#64748b] font-mono">
                      No archive loaded.
                    </div>
                  )
                )}

                {/* BINARY HEADERS */}
                {activeDockTab === 'headers' && (
                  <div className="h-full overflow-y-auto p-2.5 space-y-2.5 font-mono text-xs">
                    {!archive ? (
                      <div className="p-4 text-center text-[#64748b]">No archive loaded.</div>
                    ) : (
                      <>
                        <div className="border border-[#182232] bg-[#090d14] p-2.5">
                          <h3 className="text-xs font-bold text-[#38bdf8] uppercase tracking-wider mb-2">
                            Binary Header Fields ({archive.fileName})
                          </h3>
                          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                            {archive.headerFields.map((field, idx) => (
                              <div
                                key={idx}
                                className="p-2 bg-[#06090f] border border-[#182232] space-y-1"
                              >
                                <div className="text-[10px] text-[#64748b]">
                                  Offset {field.offset} · {field.length}B
                                </div>
                                <div className="text-[11px] font-semibold text-slate-200">
                                  {field.label}
                                </div>
                                <div className="text-xs font-bold text-[#f59e0b] break-all">
                                  {field.value}
                                </div>
                                <p className="text-[10px] text-[#64748b] leading-tight">
                                  {field.description}
                                </p>
                              </div>
                            ))}
                          </div>
                        </div>

                        <div className="border border-[#182232] h-[360px]">
                          <HexViewer
                            data={archive.rawBytes}
                            baseOffset={0}
                            title={`${archive.fileName} — Master Header Dump`}
                          />
                        </div>
                      </>
                    )}
                  </div>
                )}

                {/* ZLIB TRANSCODER */}
                {activeDockTab === 'zlib' && (
                  <div className="h-full overflow-y-auto p-2.5 space-y-2.5 font-mono text-xs">
                    <div className="flex items-center justify-between border-b border-[#182232] pb-1.5">
                      <div className="text-xs font-bold text-[#38bdf8] uppercase tracking-wider">
                        RFC 1950 Zlib Stream Transcoder
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-[#64748b]">Deflate Level:</span>
                        <select
                          value={zlibLevel}
                          onChange={(e) => setZlibLevel(Number(e.target.value))}
                          className="h-[20px] px-1 bg-[#090d14] border border-[#182232] text-slate-200 text-[10px]"
                        >
                          <option value={1}>Level 1 (Fastest)</option>
                          <option value={6}>Level 6 (Default)</option>
                          <option value={9}>Level 9 (Maximum)</option>
                        </select>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-2.5">
                      <div className="border border-[#182232] bg-[#090d14] flex flex-col">
                        <div className="h-[24px] px-2.5 bg-[#0c121d] border-b border-[#182232] flex items-center justify-between text-[10px] text-[#64748b]">
                          <span>Input Payload</span>
                          <span>{zlibBenchResult.rawBytes.length} bytes</span>
                        </div>
                        <textarea
                          rows={12}
                          value={zlibInputText}
                          onChange={(e) => setZlibInputText(e.target.value)}
                          className="w-full flex-1 p-2 bg-[#06090f] text-slate-200 font-mono text-[11px] leading-5 focus:outline-none"
                        />
                      </div>

                      <div className="border border-[#182232] bg-[#090d14] flex flex-col">
                        <div className="h-[24px] px-2.5 bg-[#0c121d] border-b border-[#182232] flex items-center justify-between text-[10px]">
                          <span className="text-[#38bdf8]">
                            Compressed: {zlibBenchResult.compressedBytes.length}B ({zlibBenchResult.ratio}%)
                          </span>
                          <button
                            type="button"
                            onClick={() => {
                              const blob = new Blob([zlibBenchResult.compressedBytes], {
                                type: 'application/octet-stream',
                              });
                              const url = URL.createObjectURL(blob);
                              const a = document.createElement('a');
                              a.href = url;
                              a.download = 'payload.zlib';
                              a.click();
                              URL.revokeObjectURL(url);
                            }}
                            className="h-[18px] px-1.5 bg-[#111a29] border border-[#182232] text-[#38bdf8] text-[9px]"
                          >
                            Export .ZLIB
                          </button>
                        </div>
                        <div className="flex-1 h-[260px]">
                          <HexViewer
                            data={zlibBenchResult.compressedBytes}
                            baseOffset={0}
                            title="Zlib Compressed Stream"
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* SUPPORTED FORMATS */}
                {activeDockTab === 'formats' && (
                  <div className="h-full overflow-y-auto p-2.5 font-mono text-xs">
                    <div className="border border-[#182232] bg-[#090d14]">
                      <table className="w-full text-left border-collapse text-[11px]">
                        <thead>
                          <tr className="h-[24px] bg-[#0c121d] border-b border-[#182232] text-[#64748b] text-[10px] uppercase">
                            <th className="px-3">Format</th>
                            <th className="px-3">Ext</th>
                            <th className="px-3">Magic</th>
                            <th className="px-3">Engines</th>
                            <th className="px-3">Layout</th>
                            <th className="px-3 text-right">Access</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[#182232]">
                          {FORMAT_SPECS.map((spec) => (
                            <tr key={spec.id} className="hover:bg-[#38bdf8]/[0.06] h-[22px]">
                              <td className="px-3 font-semibold text-white whitespace-nowrap">{spec.name}</td>
                              <td className="px-3 text-[#38bdf8] whitespace-nowrap">{spec.ext}</td>
                              <td className="px-3 text-[#f59e0b] tabular-nums">{spec.magicSignature}</td>
                              <td className="px-3 text-slate-300">{spec.engines}</td>
                              <td className="px-3 text-[#64748b]">{spec.compression}</td>
                              <td className="px-3 text-right">
                                {spec.canRepack ? (
                                  <span className="text-[#34d399]">Read / Write</span>
                                ) : (
                                  <span className="text-[#64748b]">Read / Extract</span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            </section>
          </div>
        </div>
      </div>

      {/* ============================================================== */}
      {/* ZONE E: Global Footer Status Bar (h-[22px])                    */}
      {/* ============================================================== */}
      <footer className="h-[22px] shrink-0 z-20 bg-[#05070b] border-t border-[#182232] px-3 flex items-center justify-between text-[10px] font-mono text-slate-400 select-none">
        <div className="flex items-center gap-2 truncate">
          <span className="inline-flex items-center gap-1.5">
            <span
              className={`h-1.5 w-1.5 ${
                isLoadingArchive ? 'bg-amber-400 animate-pulse' : 'bg-[#34d399]'
              }`}
            />
            <span>{isLoadingArchive ? 'PARSING' : 'READY'}</span>
          </span>
          <span>|</span>
          <span>Worker: {isLoadingArchive ? 'Active' : 'Idle'}</span>
          <span>|</span>
          <span>Memory: WebAssembly Linear</span>
          {archive && (
            <>
              <span>|</span>
              <span className="truncate">Active: {archive.fileName} ({archive.formatName})</span>
            </>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[#34d399] flex items-center gap-1 font-semibold">
            [Sandbox ID: WASM_LOCAL // NO_NET]
          </span>
        </div>
      </footer>

      {/* About Modal */}
      {showAboutModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div className="w-full max-w-lg bg-[#090d14] border border-[#182232] shadow-2xl overflow-hidden font-mono text-xs">
            <div className="h-[28px] flex items-center justify-between px-3 bg-[#0c121d] border-b border-[#182232]">
              <span className="font-bold text-slate-100 uppercase tracking-wider text-[11px]">
                About Spet's Universal Game File Opener
              </span>
              <button
                type="button"
                onClick={() => setShowAboutModal(false)}
                className="text-slate-400 hover:text-white text-xs px-1"
              >
                ✕
              </button>
            </div>
            <div className="p-4 space-y-3 bg-[#06090f] text-slate-300 text-[11px]">
              <div className="flex items-center gap-2">
                <img
                  src={`${getBaseUrl()}icons/hard_disk_drive-0.png`}
                  alt=""
                  className="pixelated w-5 h-5"
                />
                <div>
                  <div className="font-bold text-white text-xs">Spet's Universal Game File Opener</div>
                  <div className="text-[10px] text-amber-400">Pure Local WASM Virtual Filesystem & Stream Carver</div>
                </div>
              </div>
              <p className="leading-relaxed text-slate-400">
                In-browser virtual filesystem inspector and carver supporting 25+ PC and console game engines:
                Bethesda (BSA/BA2), Ubisoft (FORGE), Rockstar (RPF), Minecraft (JAR), PlayStation (PKG),
                CRIWARE (AWB/USM/ADX), FromSoftware (BND/DCX), Square Enix (SDAT/PFS), Call of Duty FastFiles (.ff),
                id Tech (WAD/PAK/PK3), and RFC 1950 Zlib deflated streams.
              </p>
              <div className="p-2 border border-[#182232] bg-[#090d14] space-y-1 text-[10px]">
                <div className="text-slate-400">Security & Isolation: <span className="text-emerald-400 font-semibold">Client-Side Web Workers [WASM Sandbox]</span></div>
                <div className="text-slate-400">Network Telemetry: <span className="text-emerald-400 font-semibold">Local Memory Only // Zero Network Calls</span></div>
                <div className="text-slate-400">Supported Platforms: <span className="text-white">Windows / Linux / macOS (Chrome, Edge, Firefox, Safari)</span></div>
              </div>
            </div>
            <div className="h-[32px] px-3 bg-[#0c121d] border-t border-[#182232] flex items-center justify-end">
              <button
                type="button"
                onClick={() => setShowAboutModal(false)}
                className="h-[22px] px-3 bg-[#111a29] border border-[#182232] hover:border-[#38bdf8] text-white text-[10px]"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal for injecting new files or scripts */}
      <ArchiveBuilderModal
        isOpen={isInjectModalOpen}
        onClose={() => setIsInjectModalOpen(false)}
        onAddTextEntry={handleAddTextEntry}
        onAddBinaryFiles={handleAddBinaryFiles}
      />
    </div>
  );
}
