import { describe, it, expect } from 'vitest';
import { zlibSync, zipSync } from 'fflate';
import { parseGameArchive, computeCRC32, classifyEntry } from '../src/services/archiveParser';
import { isBethesdaArchive, parseBethesdaArchive } from '../src/services/bethesdaParser';
import { isUbisoftForge, parseUbisoftForge } from '../src/services/ubisoftParser';
import { isRockstarRage, parseRockstarRage } from '../src/services/rockstarParser';
import { isMinecraftJar, parseMinecraftJar } from '../src/services/minecraftParser';
import { isPlaystationPkg, parsePlaystationPkg } from '../src/services/playstationPkgParser';
import { isCriwareArchive, parseCriwareArchive } from '../src/services/criwareParser';
import { isFromSoftArchive, parseFromSoftArchive } from '../src/services/fromSoftParser';
import { isSquareArchive, parseSquareArchive } from '../src/services/squareParser';

describe('Universal Game Archive Parsers Suite', () => {
  it('1. Computes CRC32 accurately and classifies assets correctly', () => {
    const testData = new TextEncoder().encode('Hello SpetDev Gaming');
    const crc = computeCRC32(testData);
    expect(crc).toBeGreaterThan(0);

    expect(classifyEntry('scripts/main.gsc', new Uint8Array())).toBe('script');
    expect(classifyEntry('textures/wall.dds', new Uint8Array())).toBe('texture');
    expect(classifyEntry('audio/bgm.wav', new Uint8Array())).toBe('audio');
    expect(classifyEntry('models/player.bmodel', new Uint8Array())).toBe('model');
    expect(classifyEntry('levels/e1m1.bsp', new Uint8Array())).toBe('map');
  });

  it('2. Parses Bethesda BSA (v104 Skyrim/FO3/FNV) and BA2 (Fallout 4 / Starfield)', () => {

    const bsa = new Uint8Array(256);
    bsa[0] = 0x42; bsa[1] = 0x53; bsa[2] = 0x41; bsa[3] = 0x00;
    const view = new DataView(bsa.buffer);
    view.setUint32(4, 0x68, true);
    view.setUint32(8, 0x24, true);
    view.setUint32(12, 0x00, true);
    view.setUint32(16, 1, true);
    view.setUint32(20, 1, true);

    expect(isBethesdaArchive(bsa)).toBe(true);
    const parsedBsa = parseBethesdaArchive('Skyrim - Textures.bsa', bsa, performance.now());
    expect(parsedBsa.formatId).toBe('BSA');
    expect(parsedBsa.engineFamily).toContain('Bethesda');

    const ba2 = new Uint8Array(256);
    ba2[0] = 0x42; ba2[1] = 0x54; ba2[2] = 0x44; ba2[3] = 0x58;
    const bView = new DataView(ba2.buffer);
    bView.setUint32(4, 1, true);
    ba2[8] = 0x47; ba2[9] = 0x4e; ba2[10] = 0x52; ba2[11] = 0x4c;
    bView.setUint32(12, 0, true);

    expect(isBethesdaArchive(ba2)).toBe(true);
    const parsedBa2 = parseBethesdaArchive('Fallout4 - Main.ba2', ba2, performance.now());
    expect(parsedBa2.formatId).toBe('BA2');
    expect(parsedBa2.formatName).toContain('GNRL');
  });

  it('3. Parses Ubisoft FORGE container (scimitar\\0 / Assassin\'s Creed Anvil)', () => {
    const forge = new Uint8Array(256);
    const encoder = new TextEncoder();
    forge.set(encoder.encode('scimitar\0'), 0);
    const view = new DataView(forge.buffer);
    view.setUint32(12, 27, true);
    view.setUint32(16, 2, true);
    view.setBigUint64(20, 64n, true);

    expect(isUbisoftForge(forge, 'AssassinsCreed.forge')).toBe(true);
    const parsedForge = parseUbisoftForge('AssassinsCreed.forge', forge, performance.now());
    expect(parsedForge.formatId).toBe('FORGE');
    expect(parsedForge.engineFamily).toContain('Ubisoft Anvil');
  });

  it('4. Parses Rockstar RAGE Package (RPF2/RPF7 GTA IV & GTA V)', () => {
    const rpf = new Uint8Array(256);
    rpf[0] = 0x52; rpf[1] = 0x50; rpf[2] = 0x46; rpf[3] = 0x37;
    const view = new DataView(rpf.buffer);
    view.setUint32(4, 2, true);
    view.setUint32(8, 32, true);
    view.setUint32(12, 0, true);

    expect(isRockstarRage(rpf, 'update.rpf')).toBe(true);
    const parsedRpf = parseRockstarRage('update.rpf', rpf, performance.now());
    expect(parsedRpf.formatId).toBe('RPF');
    expect(parsedRpf.formatName).toContain('Grand Theft Auto V (RPF7)');
  });

  it('5. Parses Minecraft Mod JAR (Fabric / Forge / Quilt manifests)', () => {
    const fabricManifest = JSON.stringify({
      id: 'spet_mod',
      name: 'Spet Game Utilities',
      version: '1.4.2',
    });
    const jarBytes = zipSync({
      'fabric.mod.json': new TextEncoder().encode(fabricManifest),
      'assets/spet/textures/icon.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      'com/spet/Main.class': new Uint8Array([0xca, 0xfe, 0xba, 0xbe]),
    });

    expect(isMinecraftJar(jarBytes, 'spet-mod-1.4.2.jar')).toBe(true);
    const parsedJar = parseMinecraftJar('spet-mod-1.4.2.jar', jarBytes, performance.now());
    expect(parsedJar.formatId).toBe('JAR');
    expect(parsedJar.formatName).toContain('Fabric Mod');
    expect(parsedJar.entries.length).toBe(3);
  });

  it('6. Parses Sony PlayStation PKG (\\x7fPKG header & PARAM.SFO mapping)', () => {
    const pkg = new Uint8Array(512);
    pkg[0] = 0x7f; pkg[1] = 0x50; pkg[2] = 0x4b; pkg[3] = 0x47;
    const view = new DataView(pkg.buffer);
    view.setUint16(4, 1, false);
    view.setUint32(0x14, 5, false);
    view.setUint32(0x18, 0x200, false);

    const enc = new TextEncoder();
    pkg.set(enc.encode('UP0001-CUSA00001_00-0000000000000000'), 0x30);

    expect(isPlaystationPkg(pkg, 'game.pkg')).toBe(true);
    const parsedPkg = parsePlaystationPkg('game.pkg', pkg, performance.now());
    expect(parsedPkg.formatId).toBe('PKG');
    expect(parsedPkg.formatName).toContain('PlayStation');
    expect(parsedPkg.entries.some((e) => e.name === 'PARAM.SFO')).toBe(true);
  });

  it('7. Parses CRIWARE Audio & Video (AWB AFS2, ACB @UTF, USM CRID, ADX, HCA)', () => {

    const awb = new Uint8Array(256);
    awb.set(new TextEncoder().encode('AFS2'), 0);
    const aView = new DataView(awb.buffer);
    awb[4] = 2;
    awb[5] = 4;
    aView.setUint32(8, 2, true);
    aView.setUint32(12, 0x20, true);

    aView.setUint32(0x14, 0x40, true);
    aView.setUint32(0x18, 0x80, true);
    aView.setUint32(0x1C, 0xC0, true);

    expect(isCriwareArchive(awb, 'bgm.awb')).toBe(true);
    const parsedAwb = parseCriwareArchive('bgm.awb', awb, performance.now());
    expect(parsedAwb.formatId).toBe('CRIWARE');
    expect(parsedAwb.entries.length).toBe(2);

    const usm = new Uint8Array(128);
    usm.set(new TextEncoder().encode('CRID'), 0);
    const uView = new DataView(usm.buffer);
    uView.setUint32(4, 32, false);

    expect(isCriwareArchive(usm, 'opening.usm')).toBe(true);
    const parsedUsm = parseCriwareArchive('opening.usm', usm, performance.now());
    expect(parsedUsm.formatId).toBe('CRIWARE');
    expect(parsedUsm.entries.some((e) => e.name.endsWith('.m2v'))).toBe(true);

    const adx = new Uint8Array(64);
    adx[0] = 0x80; adx[1] = 0x00;
    adx[7] = 2;
    new DataView(adx.buffer).setUint32(8, 44100, false);

    expect(isCriwareArchive(adx, 'sound.adx')).toBe(true);
    const parsedAdx = parseCriwareArchive('sound.adx', adx, performance.now());
    expect(parsedAdx.formatId).toBe('CRIWARE');
    expect(parsedAdx.formatName).toContain('ADX');
  });

  it('8. Parses FromSoftware Binder (BND3, BND4) & DCX Deflate Envelope', () => {

    const bnd4 = new Uint8Array(256);
    bnd4.set(new TextEncoder().encode('BND4'), 0);
    const bView = new DataView(bnd4.buffer);
    bView.setBigUint64(12, 1n, true);
    bnd4.set(new TextEncoder().encode('GRACE\0\0\0'), 24);
    bView.setBigUint64(44, 64n, true);

    expect(isFromSoftArchive(bnd4, 'c1000.chrbnd')).toBe(true);
    const parsedBnd4 = parseFromSoftArchive('c1000.chrbnd', bnd4, performance.now());
    expect(parsedBnd4.formatId).toBe('FROMSOFT');
    expect(parsedBnd4.formatName).toContain('BND4');

    const compressedBnd = zlibSync(bnd4);
    const dcx = new Uint8Array(0x48 + compressedBnd.length);
    dcx.set(new TextEncoder().encode('DCX\0'), 0);
    dcx.set(new TextEncoder().encode('DCS\0'), 0x10);
    const dView = new DataView(dcx.buffer);
    dView.setUint32(0x14, bnd4.length, false);
    dView.setUint32(0x18, compressedBnd.length, false);
    dcx.set(new TextEncoder().encode('DCP\0'), 0x1C);
    dcx.set(new TextEncoder().encode('DFLT'), 0x20);
    dcx.set(new TextEncoder().encode('DCA\0'), 0x28);
    dView.setUint32(0x2C, 0x1c, false);
    dcx.set(compressedBnd, 0x48);

    expect(isFromSoftArchive(dcx, 'c1000.chrbnd.dcx')).toBe(true);
    const parsedDcx = parseFromSoftArchive('c1000.chrbnd.dcx', dcx, performance.now());
    expect(parsedDcx.formatId).toBe('FROMSOFT');
    expect(parsedDcx.formatName).toContain('DCX ->');
  });

  it('9. Parses Square Enix Sound (SDAT) & PFS Containers', () => {

    const sdat = new Uint8Array(256);
    sdat.set(new TextEncoder().encode('SDAT'), 0);
    const sView = new DataView(sdat.buffer);
    sView.setUint16(4, 0xfeff, true);
    sView.setUint16(6, 0x0100, true);
    sView.setUint32(8, 256, true);
    sView.setUint16(12, 0x40, true);
    sView.setUint16(14, 4, true);

    sView.setUint32(32, 0x40, true);
    sView.setUint32(36, 0x30, true);
    sdat.set(new TextEncoder().encode('FAT '), 0x40);
    sView.setUint32(0x48, 1, true);
    sView.setUint32(0x4C, 0x80, true);
    sView.setUint32(0x50, 0x20, true);

    sdat.set(new TextEncoder().encode('SSEQ'), 0x80);

    expect(isSquareArchive(sdat, 'sound_data.sdat')).toBe(true);
    const parsedSdat = parseSquareArchive('sound_data.sdat', sdat, performance.now());
    expect(parsedSdat.formatId).toBe('SQUARE');
    expect(parsedSdat.entries.length).toBe(1);
    expect(parsedSdat.entries[0].name.endsWith('.sseq')).toBe(true);
  });

  it('10. Main parseGameArchive universal dispatcher accurately dispatches to all engines', () => {

    const pak = new Uint8Array(64);
    pak.set(new TextEncoder().encode('PACK'), 0);
    new DataView(pak.buffer).setUint32(4, 12, true);
    new DataView(pak.buffer).setUint32(8, 0, true);
    const parsedPak = parseGameArchive('pak0.pak', pak);
    expect(parsedPak.formatId).toBe('PAK');

    const ba2 = new Uint8Array(64);
    ba2.set(new TextEncoder().encode('BTDX'), 0);
    new DataView(ba2.buffer).setUint32(4, 1, true);
    const parsedBa2 = parseGameArchive('Starfield.ba2', ba2);
    expect(parsedBa2.formatId).toBe('BA2');

    const forge = new Uint8Array(64);
    forge.set(new TextEncoder().encode('scimitar\0'), 0);
    const parsedForge = parseGameArchive('PrinceOfPersia.forge', forge);
    expect(parsedForge.formatId).toBe('FORGE');

    const rpf = new Uint8Array(64);
    rpf.set(new TextEncoder().encode('RPF7'), 0);
    const parsedRpf = parseGameArchive('gta5.rpf', rpf);
    expect(parsedRpf.formatId).toBe('RPF');

    const pkg = new Uint8Array(64);
    pkg[0] = 0x7f; pkg[1] = 0x50; pkg[2] = 0x4b; pkg[3] = 0x47;
    const parsedPkg = parseGameArchive('patch.pkg', pkg);
    expect(parsedPkg.formatId).toBe('PKG');

    const awb = new Uint8Array(64);
    awb.set(new TextEncoder().encode('AFS2'), 0);
    const parsedAwb = parseGameArchive('voice.awb', awb);
    expect(parsedAwb.formatId).toBe('CRIWARE');

    const bnd = new Uint8Array(64);
    bnd.set(new TextEncoder().encode('BND4'), 0);
    const parsedBnd = parseGameArchive('item.bnd', bnd);
    expect(parsedBnd.formatId).toBe('FROMSOFT');

    const sdat = new Uint8Array(64);
    sdat.set(new TextEncoder().encode('SDAT'), 0);
    const parsedSdat = parseGameArchive('sound.sdat', sdat);
    expect(parsedSdat.formatId).toBe('SQUARE');
  });
});
