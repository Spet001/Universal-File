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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 font-mono select-none">
      <div className="w-full max-w-xl bg-[#090d14] border border-[#182232] shadow-2xl overflow-hidden">
        <div className="h-[28px] flex items-center justify-between px-3 bg-[#0c121d] border-b border-[#182232]">
          <div className="flex items-center gap-1.5">
            <PackageCheck className="w-3.5 h-3.5 text-[#38bdf8]" />
            <h3 className="text-xs font-semibold text-slate-100 uppercase tracking-wider">
              Inject Asset into Container
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-white p-0.5"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="p-4 space-y-4 text-xs">
          {/* Option 1: Upload raw files from disk */}
          <div className="p-3 bg-[#06090f] border border-[#182232] flex items-center justify-between gap-3">
            <div>
              <div className="text-[11px] font-semibold text-slate-200">Import External File(s) from Disk</div>
              <div className="text-[10px] text-[#64748b] mt-0.5">
                Inject .gsc, .cfg, .wav, .png, .dds, or lump binaries directly.
              </div>
            </div>
            <label className="cursor-pointer flex items-center gap-1.5 h-[24px] px-2.5 text-[10px] bg-[#111a29] hover:border-[#38bdf8] text-slate-200 border border-[#26354d] whitespace-nowrap shrink-0">
              <Upload className="w-3 h-3 text-[#38bdf8]" />
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
              <label className="block text-[10px] font-medium text-slate-400 mb-1">
                Virtual Path / Lump Name (e.g. maps/mp/patch.gsc)
              </label>
              <input
                type="text"
                value={entryPath}
                onChange={(e) => setEntryPath(e.target.value)}
                placeholder="maps/mp/custom_script.gsc"
                className="w-full h-[24px] px-2 text-[11px] bg-[#06090f] border border-[#182232] text-slate-100 focus:outline-none focus:border-[#38bdf8]"
              />
            </div>

            <div>
              <label className="block text-[10px] font-medium text-slate-400 mb-1">
                Asset Payload (ASCII / UTF-8 Script or Config)
              </label>
              <textarea
                rows={7}
                value={entryContent}
                onChange={(e) => setEntryContent(e.target.value)}
                spellCheck={false}
                className="w-full p-2 text-xs bg-[#06090f] border border-[#182232] text-slate-200 focus:outline-none focus:border-[#38bdf8] font-mono leading-relaxed"
              />
            </div>

            <div className="flex items-center justify-end gap-2 pt-1 border-t border-[#182232]">
              <button
                type="button"
                onClick={onClose}
                className="h-[24px] px-3 text-[10px] text-slate-400 hover:text-white border border-[#182232] bg-[#06090f]"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="h-[24px] flex items-center gap-1.5 px-3 text-[10px] font-semibold bg-[#111a29] hover:bg-[#38bdf8]/20 text-[#38bdf8] border border-[#38bdf8]"
              >
                <Plus className="w-3 h-3" />
                <span>Inject into Archive</span>
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};
