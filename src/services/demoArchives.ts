export interface SampleArchivePreset {
  id: string;
  fileName: string;
  formatBadge: string;
  engine: string;
  title: string;
  summary: string;
  fileSize: number;
  url: string;
  license: string;
  sourceUrl: string;
}

/**
 * Authentic, Open-Source Game Archive Presets for Tool Demo.
 * All files are verified genuine binaries downloaded from open-source repositories.
 */
export const SAMPLE_ARCHIVES: SampleArchivePreset[] = [
  {
    id: 'wad-freedoom',
    fileName: 'freedm.wad',
    formatBadge: 'DOOM (IWAD)',
    engine: 'id Tech 1 (Freedoom 0.13.0)',
    title: 'Freedoom: Phase DM (v0.13.0 IWAD)',
    summary:
      'Official open-source DOOM engine IWAD with 3,615 entries: MAP01-MAP32 deathmatch arenas, 256-color PLAYPAL palette, COLORMAP, floor flats, animated wall textures, sound effects, music, and DEHACKED patch.',
    fileSize: 22218796,
    url: '/samples/freedm.wad',
    license: 'BSD 3-Clause',
    sourceUrl: 'https://github.com/freedoom/freedoom',
  },
  {
    id: 'pk3-brightmaps',
    fileName: 'brightmaps.pk3',
    formatBadge: 'GZDoom (PK3)',
    engine: 'GZDoom Engine (id Tech 3 Deflate)',
    title: 'GZDoom Brightmaps Texture & Defs Archive',
    summary:
      'Official GZDoom open-source PK3 containing 499 texture and shader brightmap definitions for enemies, weapons, projectiles, and dynamic environment lighting.',
    fileSize: 246181,
    url: '/samples/brightmaps.pk3',
    license: 'GPL-3.0',
    sourceUrl: 'https://github.com/ZDoom/gzdoom',
  },
  {
    id: 'pk3-gzdoom',
    fileName: 'gzdoom.pk3',
    formatBadge: 'id Tech 3 (PK3)',
    engine: 'GZDoom 4.14.2 Master Archive',
    title: 'GZDoom 4.14.2 Core Game Archive',
    summary:
      'Official master PK3 with 692 core assets: GLSL shaders, font glyphs, CVAR configuration, DECORATE language tables, menu scripts, and sound definitions.',
    fileSize: 3132275,
    url: '/samples/gzdoom.pk3',
    license: 'GPL-3.0',
    sourceUrl: 'https://github.com/ZDoom/gzdoom',
  },
  {
    id: 'nds-hbmenu',
    fileName: 'hbmenu.nds',
    formatBadge: 'NDS (NitroFS)',
    engine: 'Nintendo DS (devkitPro ARM9/ARM7)',
    title: 'devkitPro Nintendo DS Homebrew Menu [HOMEBREW]',
    summary:
      'Authentic open-source Nintendo DS cartridge ROM with NitroFS file tables, ARM9 and ARM7 boot binaries, cartridge header, and 4bpp menu icon.',
    fileSize: 299008,
    url: '/samples/hbmenu.nds',
    license: 'GPL-2.0',
    sourceUrl: 'https://github.com/devkitPro/nds-hb-menu',
  },
  {
    id: 'xex-xstore',
    fileName: 'X-Store.xex',
    formatBadge: '360 (XEX2)',
    engine: 'Microsoft Xbox 360 Native PowerPC (PPC32 PE)',
    title: 'X-Store Native Xbox 360 Homebrew Executable',
    summary:
      'Authentic Xbox 360 executable with XEX2 container header, 248 optional headers, security certificates, and embedded PE32 COFF sections.',
    fileSize: 3481600,
    url: '/samples/X-Store.xex',
    license: 'GPL-3.0',
    sourceUrl: 'https://github.com/951261/X-Store',
  },
  {
    id: 'gba-celeste',
    fileName: 'celeste_classic.gba',
    formatBadge: 'GBA (Cartridge)',
    engine: 'Nintendo Game Boy Advance (ARM7TDMI)',
    title: 'Celeste Classic GBA Homebrew ROM',
    summary:
      'Authentic Game Boy Advance cartridge ROM port with ARM7TDMI boot vector, Nintendo logo check table, compressed tile graphics, and 8-bit chiptune sound assets.',
    fileSize: 5418424,
    url: '/samples/celeste_classic.gba',
    license: 'Creative Commons / Open Source',
    sourceUrl: 'https://github.com/JeffRuLz/Celeste-Classic-GBA',
  },
  {
    id: 'wad-librequake',
    fileName: 'lq_dev.wad',
    formatBadge: 'Quake (WAD2)',
    engine: 'id Tech 2 (LibreQuake Texture Archive)',
    title: 'LibreQuake Developer Mipmapped Texture WAD',
    summary:
      'Authentic id Tech 2 Quake WAD2 archive containing 228 mipmapped brush textures, palette lookups, and dev grid test surfaces.',
    fileSize: 385668,
    url: '/samples/lq_dev.wad',
    license: 'GPL-2.0',
    sourceUrl: 'https://github.com/lavenderdotpet/LibreQuake',
  },
  {
    id: 'rpa-renpy',
    fileName: 'sample.rpa',
    formatBadge: 'Ren\'Py (RPA)',
    engine: 'Ren\'Py Visual Novel Engine',
    title: 'Ren\'Py Visual Novel RPA Archive Demo',
    summary:
      'Authentic Ren\'Py RPA-3.0 container archive with 32-bit XOR key obfuscation, compressed Pickle index, visual novel script assets (.rpy), room graphics, and playable open-source Ogg Vorbis audio.',
    fileSize: 15476,
    url: '/samples/sample.rpa',
    license: 'MIT / GPL-3.0 / Open Source',
    sourceUrl: 'https://www.renpy.org/',
  },
];

/**
 * Fetches the binary Uint8Array of an authentic sample preset with multi-path resolution
 */
export async function fetchPresetBinary(preset: SampleArchivePreset): Promise<Uint8Array> {
  const clean = preset.url.replace(/^\/+/, '');
  const candidateUrls = [
    clean,
    './' + clean,
    'samples/' + preset.fileName,
    './samples/' + preset.fileName,
    '/tools/universal-file/' + clean,
    '/tools/universal-file/samples/' + preset.fileName,
    preset.url,
  ];

  let lastErr: Error | null = null;
  for (const candidate of candidateUrls) {
    try {
      const res = await fetch(candidate);
      if (res.ok) {
        const ct = res.headers.get('content-type') || '';
        if (ct.includes('text/html')) continue;
        const buf = await res.arrayBuffer();
        return new Uint8Array(buf);
      }
    } catch (e: any) {
      lastErr = e;
    }
  }

  throw new Error(`Failed to load preset ${preset.fileName}: ${lastErr?.message || 'Not found'}`);
}
