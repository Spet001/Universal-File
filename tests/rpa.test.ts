import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { parseGameArchive } from '../src/services/archiveParser';
import {
  isRenpyArchive,
  parseRenpyArchive,
  parsePickle,
  buildRenpyArchive,
  RenpyBuildFile,
} from '../src/services/renpyParser';

describe('Ren\'Py Archive (RPA) Parser Suite', () => {
  it('1. Detects RPA-3.0 and RPA-2.0 headers accurately', () => {
    const textEnc = new TextEncoder();
    const rpa3 = textEnc.encode('RPA-3.0 0000000000000040 3a5f2b1c\n');
    const rpa2 = textEnc.encode('RPA-2.0 0000000000000028\n');
    const notRpa = textEnc.encode('IWffu100\0\0\0\0');

    expect(isRenpyArchive(rpa3, 'archive.rpa')).toBe(true);
    expect(isRenpyArchive(rpa2, 'archive.rpa')).toBe(true);
    expect(isRenpyArchive(notRpa, 'not_rpa.bin')).toBe(false);
  });

  it('2. Safely decodes Python Pickle protocol 0/1/2/3 opcodes', () => {

    const p2Bytes = new Uint8Array([
      128, 2, 125, 113, 0, 88, 10, 0, 0, 0, 115, 99, 114, 105, 112, 116, 46,
      114, 112, 121, 113, 1, 93, 113, 2, 77, 0, 16, 77, 0, 2, 88, 2, 0, 0, 0,
      80, 75, 113, 3, 135, 113, 4, 97, 115, 46,
    ]);

    const decoded = parsePickle(p2Bytes);
    expect(decoded).toBeDefined();
    expect(decoded['script.rpy']).toBeDefined();
    expect(decoded['script.rpy'][0][0]).toBe(4096);
    expect(decoded['script.rpy'][0][1]).toBe(512);
    expect(decoded['script.rpy'][0][2]).toBe('PK');
  });

  it('3. Performs 100% round-trip extraction integrity on synthetic RPA-3.0 archive', () => {
    const textEnc = new TextEncoder();
    const testFiles: RenpyBuildFile[] = [
      {
        path: 'scripts/story.rpy',
        data: textEnc.encode('label start:\n    scene bg classroom\n    "Hello Ren\'Py VN!"\n    return\n'),
      },
      {
        path: 'scripts/options.rpy',
        data: textEnc.encode('define config.name = "Spet VN"\ndefine config.version = "1.0"\n'),
      },
      {
        path: 'images/bg_classroom.png',

        prefix: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        data: new Uint8Array([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
          0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x07, 0x80, 0x00, 0x00, 0x04, 0x38,
          0x08, 0x06, 0x00, 0x00, 0x00, 0x55, 0xaa, 0xff, 0x00, 0x11, 0x22, 0x33,
        ]),
      },
      {
        path: 'audio/bgm_theme.ogg',
        prefix: new Uint8Array([0x4f, 0x67, 0x67, 0x53]),
        data: new Uint8Array([
          0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
          0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0, 0x01, 0x02, 0x03, 0x04,
        ]),
      },
    ];

    const xorKey = 0x5a1b3c7d;
    const rpaBytes = buildRenpyArchive(testFiles, {
      version: 'RPA-3.0',
      key: xorKey,
    });

    expect(isRenpyArchive(rpaBytes, 'archive.rpa')).toBe(true);

    const parsed = parseGameArchive('archive.rpa', rpaBytes);

    expect(parsed.formatId).toBe('RPA');
    expect(parsed.formatName).toContain('RPA-3.0');
    expect(parsed.engineFamily).toBe("Ren'Py Visual Novel Engine");
    expect(parsed.entries.length).toBe(testFiles.length);

    const keyField = parsed.headerFields.find((f) => f.label === 'Obfuscation Key');
    expect(keyField).toBeDefined();
    expect(keyField?.value).toContain('5A1B3C7D');

    for (const original of testFiles) {
      const entry = parsed.entries.find((e) => e.path === original.path);
      expect(entry, `Entry for ${original.path} must exist`).toBeDefined();
      expect(entry!.data.length).toBe(original.data.length);
      expect(entry!.uncompressedSize).toBe(original.data.length);

      for (let i = 0; i < original.data.length; i++) {
        expect(entry!.data[i]).toBe(original.data[i]);
      }
    }

    const storyEntry = parsed.entries.find((e) => e.path === 'scripts/story.rpy');
    expect(storyEntry?.category).toBe('script');

    const imageEntry = parsed.entries.find((e) => e.path === 'images/bg_classroom.png');
    expect(imageEntry?.category).toBe('texture');

    const audioEntry = parsed.entries.find((e) => e.path === 'audio/bgm_theme.ogg');
    expect(audioEntry?.category).toBe('audio');
  });

  it('4. Performs 100% round-trip extraction integrity on synthetic RPA-2.0 archive', () => {
    const textEnc = new TextEncoder();
    const testFiles: RenpyBuildFile[] = [
      {
        path: 'scripts/main.rpy',
        data: textEnc.encode('init python:\n    gui.text_color = "#ffffff"\n'),
      },
      {
        path: 'sprites/heroine.png',
        data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02, 0x03, 0x04, 0x05]),
      },
    ];

    const rpa2Bytes = buildRenpyArchive(testFiles, { version: 'RPA-2.0' });
    expect(isRenpyArchive(rpa2Bytes, 'legacy.rpa')).toBe(true);

    const parsed = parseRenpyArchive('legacy.rpa', rpa2Bytes, performance.now());
    expect(parsed.formatId).toBe('RPA');
    expect(parsed.formatName).toContain('RPA-2.0');
    expect(parsed.entries.length).toBe(testFiles.length);

    for (const original of testFiles) {
      const entry = parsed.entries.find((e) => e.path === original.path);
      expect(entry).toBeDefined();
      expect(entry!.data.length).toBe(original.data.length);
      for (let i = 0; i < original.data.length; i++) {
        expect(entry!.data[i]).toBe(original.data[i]);
      }
    }
  });

  it('5. Handles large offsets and 32-bit keys without bitwise truncation', () => {
    const textEnc = new TextEncoder();
    const testFile: RenpyBuildFile = {
      path: 'data/secret.bin',
      data: textEnc.encode('RenPyObfuscationTestSecretPayload1234567890'),
    };

    const highKey = 0x8a9b0c1d;
    const rpa = buildRenpyArchive([testFile], {
      version: 'RPA-3.0',
      key: highKey,
    });

    const parsed = parseGameArchive('highkey.rpa', rpa);
    expect(parsed.entries.length).toBe(1);
    const entry = parsed.entries[0];
    expect(entry.data.length).toBe(testFile.data.length);
    for (let i = 0; i < testFile.data.length; i++) {
      expect(entry.data[i]).toBe(testFile.data[i]);
    }
  });

  it('6. Successfully parses authentic public/samples/sample.rpa with genuine Ogg Vorbis soundtrack', () => {
    const rpaPath = path.resolve(__dirname, '../public/samples/sample.rpa');
    const rpaBuffer = fs.readFileSync(rpaPath);
    const rpaBytes = new Uint8Array(rpaBuffer);

    expect(isRenpyArchive(rpaBytes, 'sample.rpa')).toBe(true);

    const parsed = parseGameArchive('sample.rpa', rpaBytes);
    expect(parsed.formatId).toBe('RPA');
    expect(parsed.formatName).toContain('RPA-3.0');
    expect(parsed.entries.length).toBe(6);

    const themeEntry = parsed.entries.find((e) => e.path === 'audio/theme.ogg');
    expect(themeEntry, 'theme.ogg entry must exist').toBeDefined();
    expect(themeEntry!.category).toBe('audio');
    expect(themeEntry!.data.length).toBeGreaterThan(10000);

    expect(themeEntry!.data[0]).toBe(0x4f);
    expect(themeEntry!.data[1]).toBe(0x67);
    expect(themeEntry!.data[2]).toBe(0x67);
    expect(themeEntry!.data[3]).toBe(0x53);

    const oggString = new TextDecoder('latin1').decode(themeEntry!.data.slice(0, 200));
    expect(oggString).toContain('vorbis');

    const bgEntry = parsed.entries.find((e) => e.path === 'images/bg_room.png');
    expect(bgEntry, 'bg_room.png entry must exist').toBeDefined();
    expect(bgEntry!.category).toBe('texture');
    expect(bgEntry!.data[0]).toBe(0x89);
    expect(bgEntry!.data[1]).toBe(0x50);
    expect(bgEntry!.data[2]).toBe(0x4e);
    expect(bgEntry!.data[3]).toBe(0x47);

    const webpEntry = parsed.entries.find((e) => e.path === 'images/eileen_happy.webp');
    expect(webpEntry, 'eileen_happy.webp entry must exist').toBeDefined();
    expect(webpEntry!.category).toBe('texture');
    expect(webpEntry!.data[0]).toBe(0x52);
    expect(webpEntry!.data[1]).toBe(0x49);
    expect(webpEntry!.data[2]).toBe(0x46);
    expect(webpEntry!.data[3]).toBe(0x46);

    const scriptEntry = parsed.entries.find((e) => e.path === 'script.rpy');
    expect(scriptEntry, 'script.rpy entry must exist').toBeDefined();
    expect(scriptEntry!.category).toBe('script');
    const scriptText = new TextDecoder().decode(scriptEntry!.data);
    expect(scriptText).toContain('label start:');
    expect(scriptText).toContain("Welcome to Spet's Universal Game File Opener!");

    const optionsEntry = parsed.entries.find((e) => e.path === 'options.rpy');
    expect(optionsEntry, 'options.rpy entry must exist').toBeDefined();
    expect(optionsEntry!.category).toBe('script');

    const guiEntry = parsed.entries.find((e) => e.path === 'gui.rpy');
    expect(guiEntry, 'gui.rpy entry must exist').toBeDefined();
    expect(guiEntry!.category).toBe('script');
  });
});
