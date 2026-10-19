import React, { useState } from 'react';
import { X, Plus, Upload, PackageCheck } from 'lucide-react';

interface ArchiveBuilderModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAddTextEntry: (path: string, content: string) => void;
  onAddBinaryFiles: (files: FileList) => void;
}

export const ArchiveBuilderModal: React.FC<ArchiveBuilderModalProps> = ({
  isOpen,
  onClose,
  onAddTextEntry,
  onAddBinaryFiles,
}) => {
  const [entryPath, setEntryPath] = useState('maps/mp/custom_patch.gsc');
  const [entryContent, setEntryContent] = useState(
    `// Injected Game Asset Script\nmain()\n{\n    setdvar("sv_cheats", "0");\n    setdvar("cg_fov", "95");\n}\n`
  );

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!entryPath.trim()) return;
    onAddTextEntry(entryPath.trim(), entryContent);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
      <div className="w-full max-w-xl bg-[#0F1623] border border-slate-800 rounded-lg shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-800">
          <div className="flex items-center gap-2">
            <PackageCheck className="w-4 h-4 text-amber-400" />
            <h3 className="text-sm font-semibold text-slate-100">Inject Asset into Current Archive</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-200 p-1 rounded transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-5">
          {/* Option 1: Upload raw files from disk */}
          <div className="p-4 bg-[#0B0F17] border border-dashed border-slate-700 rounded-lg flex items-center justify-between gap-4">
            <div>
              <div className="text-xs font-semibold text-slate-200">Import External File(s) from Disk</div>
              <div className="text-xs text-slate-400 mt-0.5">
                Inject .gsc, .cfg, .wav, .png, .dds, or raw lump binaries directly into the virtual directory.
              </div>
            </div>
            <label className="cursor-pointer flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-100 rounded border border-slate-700 transition-colors whitespace-nowrap shrink-0">
              <Upload className="w-3.5 h-3.5" />
              <span>Choose Files</span>
              <input
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files && e.target.files.length > 0) {
                    onAddBinaryFiles(e.target.files);
                    onClose();
                  }
                }}
              />
            </label>
          </div>

          {/* Option 2: Create new script/lump in-place */}
          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Virtual Path / Lump Name (8 chars max for WAD, 55 chars for PAK)
              </label>
              <input
                type="text"
                value={entryPath}
                onChange={(e) => setEntryPath(e.target.value)}
                placeholder="maps/mp/custom_script.gsc"
                className="w-full px-3 py-1.5 text-xs font-mono bg-[#0B0F17] border border-slate-700 rounded text-slate-100 focus:outline-none focus:border-amber-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Asset Payload (ASCII / UTF-8 Script or Config)
              </label>
              <textarea
                rows={7}
                value={entryContent}
                onChange={(e) => setEntryContent(e.target.value)}
                spellCheck={false}
                className="w-full p-3 text-xs font-mono bg-[#0B0F17] border border-slate-700 rounded text-slate-200 focus:outline-none focus:border-amber-500"
              />
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="px-3.5 py-1.5 text-xs font-medium text-slate-300 hover:text-white bg-slate-800 rounded transition-colors whitespace-nowrap shrink-0"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium bg-amber-500 hover:bg-amber-400 text-slate-950 rounded transition-colors whitespace-nowrap shrink-0"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Inject into Archive</span>
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};
