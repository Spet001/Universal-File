import { ArchiveEntry, ArchiveHeaderField, ParsedArchive } from '../types/archive';
import { computeCRC32, toHex, bytesToHexPreview, readAscii } from './archiveParser';

export interface BinkAudioTrack {
  trackIndex: number;
  sampleRate: number;
  channels: number;
  flags: number;
}

export interface BinkFrameEntry {
  frameIndex: number;
  offset: number;
  size: number;
  isKeyframe: boolean;
}

export interface BinkVideoInfo {
  magic: string;
  isBink2: boolean;
  versionLetter: string;
  fileSize: number;
  numFrames: number;
  largestFrame: number;
  width: number;
  height: number;
  fpsNumerator: number;
  fpsDenominator: number;
  fps: number;
  durationSeconds: number;
  flags: number;
  numAudioTracks: number;
  audioTracks: BinkAudioTrack[];
  frames: BinkFrameEntry[];
}

/**
 * Universal Bink Video (.bik / .bk2) parser for Call of Duty, DOOM 2016, and modern game cinematics
 */
export function parseBinkVideo(fileName: string, bytes: Uint8Array, startTime: number): ParsedArchive {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = readAscii(bytes, 0, 4);
  const isBink2 = magic.startsWith('KB2');
  const versionLetter = magic.charAt(3);

  const fileSize = view.getUint32(4, true);
  const numFrames = view.getUint32(8, true);
  const largestFrame = view.getUint32(12, true);
  const numFrames2 = view.getUint32(16, true);
  const width = view.getUint32(20, true);
  const height = view.getUint32(24, true);
  const fpsNum = view.getUint32(28, true);
  const fpsDen = view.getUint32(32, true);
  const flags = view.getUint32(36, true);
  const numAudioTracks = view.getUint32(40, true);

  const fps = fpsDen > 0 ? fpsNum / fpsDen : 30;
  const durationSeconds = fps > 0 ? numFrames / fps : 0;

  const audioTracks: BinkAudioTrack[] = [];
  let p = 44;

  // Read audio track descriptors (if numAudioTracks > 0)
  if (numAudioTracks > 0 && numAudioTracks < 32 && p + numAudioTracks * 4 <= bytes.length) {
    for (let a = 0; a < numAudioTracks; a++) {
      const trackFlags = view.getUint32(p, true);
      p += 4;
      const isStereo = (trackFlags & 0x2000) !== 0;
      const sampleRate = trackFlags & 0x00ffffff;
      audioTracks.push({
        trackIndex: a,
        sampleRate: sampleRate > 8000 && sampleRate < 192000 ? sampleRate : 44100,
        channels: isStereo ? 2 : 1,
        flags: trackFlags,
      });
    }
  }

  // Read Frame Offset Seek Table
  const frames: BinkFrameEntry[] = [];
  const frameTablePos = p;
  const maxFramesToRead = Math.min(numFrames, 1000);

  if (frameTablePos + (numFrames + 1) * 4 <= bytes.length) {
    let prevOffset = 0;
    for (let f = 0; f <= maxFramesToRead; f++) {
      const rawOffset = view.getUint32(frameTablePos + f * 4, true);
      const offset = rawOffset & ~0x01; // low bit indicates keyframe
      const isKeyframe = (rawOffset & 0x01) !== 0;

      if (f > 0) {
        const frameSize = Math.max(0, offset - prevOffset);
        frames.push({
          frameIndex: f - 1,
          offset: prevOffset,
          size: frameSize,
          isKeyframe,
        });
      }
      prevOffset = offset;
    }
  }

  const minStr = Math.floor(durationSeconds / 60);
  const secStr = (durationSeconds % 60).toFixed(2);
  const durationFormatted = `${minStr}m ${secStr}s`;

  const headerFields: ArchiveHeaderField[] = [
    {
      label: 'Bink Video Signature',
      offset: '0x00000000',
      length: 4,
      value: `${magic} (${isBink2 ? 'Bink 2' : 'Bink 1'})`,
      description: 'RAD Game Tools Bink Video Codec identifier',
    },
    {
      label: 'Video Resolution',
      offset: '0x00000014',
      length: 8,
      value: `${width} × ${height} (${Math.round((width / height) * 100) / 100}:1 aspect)`,
      description: 'Native video display dimensions',
    },
    {
      label: 'Frame Rate & Duration',
      offset: '0x0000001C',
      length: 8,
      value: `${fps.toFixed(2)} FPS · ${durationFormatted} (${numFrames.toLocaleString()} frames)`,
      description: `Dividend: ${fpsNum.toLocaleString()} / Divisor: ${fpsDen.toLocaleString()}`,
    },
    {
      label: 'Audio Tracks',
      offset: '0x00000028',
      length: 4,
      value: numAudioTracks > 0 ? `${numAudioTracks} track(s) (${audioTracks.map((t) => `${t.channels}ch @ ${t.sampleRate}Hz`).join(', ')})` : 'No Audio (Muted)',
      description: 'Embedded multichannel Bink audio streams',
    },
    {
      label: 'Largest Frame Size',
      offset: '0x0000000C',
      length: 4,
      value: `${largestFrame.toLocaleString()} bytes`,
      description: 'Peak keyframe video buffer requirement',
    },
  ];

  const entries: ArchiveEntry[] = [];
  const enc = new TextEncoder();

  // Create formatted metadata text descriptor
  const binkReport = [
    `// ==========================================`,
    `// RAD Game Tools Bink Video Inspection Report`,
    `// File: ${fileName}`,
    `// Container: ${isBink2 ? 'Bink 2 (Next-Gen)' : 'Bink 1 (Classic)'} [${magic}]`,
    `// Resolution: ${width} x ${height}`,
    `// Framerate: ${fps.toFixed(3)} FPS (${fpsNum} / ${fpsDen})`,
    `// Duration: ${durationFormatted} (${durationSeconds.toFixed(2)} seconds)`,
    `// Total Frames: ${numFrames}`,
    `// Largest Frame: ${largestFrame.toLocaleString()} bytes`,
    `// Audio Tracks: ${numAudioTracks}`,
    `// ==========================================`,
    '',
    '=== AUDIO TRACKS ===',
    ...(audioTracks.length > 0
      ? audioTracks.map((t) => `[Track #${t.trackIndex}] ${t.channels === 2 ? 'Stereo' : 'Mono'} · ${t.sampleRate} Hz · Flags: 0x${t.flags.toString(16).toUpperCase()}`)
      : ['No audio tracks found']),
    '',
    '=== FIRST 100 VIDEO FRAMES (TIMELINE SEEK TABLE) ===',
    ...frames.slice(0, 100).map(
      (f) =>
        `Frame #${f.frameIndex.toString().padStart(4, '0')} | Offset: 0x${toHex(f.offset, 8)} | Size: ${f.size
          .toLocaleString()
          .padStart(7, ' ')} B | ${f.isKeyframe ? '[KEYFRAME / I-FRAME]' : '[Delta / P-FRAME]'}`
    ),
  ].join('\n');

  const repBytes = enc.encode(binkReport);

  entries.push({
    id: 'bik-meta',
    name: `${fileName.replace(/\.(bik|bk2)$/i, '')}_timeline.txt`,
    path: `metadata/${fileName.replace(/\.(bik|bk2)$/i, '')}_timeline.txt`,
    folder: 'metadata',
    offset: 0,
    compressedSize: repBytes.length,
    uncompressedSize: repBytes.length,
    compressionMethod: 'Decoded Bink Seek Table',
    crc32: computeCRC32(repBytes),
    category: 'config',
    data: repBytes,
  });

  // Include the video file itself with video category
  entries.push({
    id: 'bik-video-stream',
    name: fileName,
    path: fileName,
    folder: '(root)',
    offset: 0,
    compressedSize: bytes.length,
    uncompressedSize: bytes.length,
    compressionMethod: `${isBink2 ? 'Bink 2 Video' : 'Bink 1 Video'} (${width}x${height} @ ${fps.toFixed(1)}fps)`,
    crc32: computeCRC32(bytes),
    category: 'video',
    data: bytes,
    metadata: {
      width,
      height,
      fps: fps.toFixed(2),
      duration: durationFormatted,
      numFrames,
      isBink2,
      audioTracks: numAudioTracks,
    },
  });

  return {
    fileName,
    fileSize: bytes.length,
    formatId: 'BIK',
    formatName: `${isBink2 ? 'Bink 2' : 'Bink 1'} Video (${width}×${height} @ ${fps.toFixed(1)}fps)`,
    engineFamily: 'RAD Game Tools (Call of Duty, DOOM 2016, Unreal, Source)',
    magicBytes: bytesToHexPreview(bytes.subarray(0, 8), 8),
    endianness: 'Little Endian',
    headerFields,
    entries,
    rawBytes: bytes,
    parseTimeMs: Math.max(1, Math.round(performance.now() - startTime)),
    warnings: [],
    extraInfo: {
      width,
      height,
      fps,
      durationSeconds,
      numFrames,
      audioTracks,
      framesCount: frames.length,
    },
  };
}
