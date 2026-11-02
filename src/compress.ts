import { execFile } from 'node:child_process';
import os from 'node:os';


/**
 * Fallback for the largest clip the server accepts, until /api/kick/clips/limits answers: the Free plan's
 * maxUploadBytes (60 s + 8 s grace at the default 60 Mbps). The real cap is per plan and comes from the server.
 */
export const CLIP_MAX_BYTES_FALLBACK = Math.ceil((68 * 60_000_000) / 8);

// A packaged app keeps the binary next to the code (asar is off), so the path ffmpeg-static resolves is runnable as is.
const FFMPEG = require('ffmpeg-static') as string | null;

/** Half the cores (at least 2): x264 would otherwise take every core from the game and OBS. */
const ENCODE_THREADS = Math.max(2, Math.floor(os.availableParallelism() / 2));

function run(args: string[], timeoutMs: number): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (!FFMPEG) return reject(new Error('ffmpeg_missing'));
    const child = execFile(FFMPEG, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, _out, stderr) => {
      // ffmpeg exits non-zero on bad input and when probing with no output file: that is data, not a failure to run.
      if (err && typeof err.code !== 'number') return reject(err);
      resolve({ code: err ? (err.code as number) : 0, stderr: String(stderr) });
    });
    // It usually runs mid-stream: the game and OBS's own encoder come first.
    try {
      if (child.pid) os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
    } catch {
      /* not allowed here: normal priority */
    }
  });
}

/** What a video is (ffmpeg prints it when asked to read a file and do nothing). */
export interface VideoInfo {
  seconds: number;
  videoCodec: string | null;
  audioCodec: string | null;
  height: number | null;
}

/** Pure: reads ffmpeg's `-i` banner. */
export function parseProbe(stderr: string): VideoInfo {
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  if (!d) throw new Error('no_duration');
  const v = /Stream #[^\n]*?Video: (\w+)[^\n]*?, (\d{2,5})x(\d{2,5})/.exec(stderr);
  const a = /Stream #[^\n]*?Audio: (\w+)/.exec(stderr);
  return {
    seconds: Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]),
    videoCodec: v?.[1] ?? null,
    audioCodec: a?.[1] ?? null,
    height: v ? Math.min(Number(v[2]), Number(v[3])) : null,
  };
}

async function probe(file: string): Promise<VideoInfo> {
  return parseProbe((await run(['-hide_banner', '-i', file], 30_000)).stderr);
}

/**
 * Pure: the OBS file can go up untouched (the server only swaps the container and serves it as the top quality) when
 * every browser plays it (H.264 + AAC or silent), it fits the plan's byte cap and no smaller size was asked for.
 */
export function canSkipEncode(info: VideoInfo, bytes: number, maxBytes: number, maxHeight: number | null): boolean {
  return info.videoCodec === 'h264' && (info.audioCodec === null || info.audioCodec === 'aac') && bytes <= maxBytes && (!maxHeight || (info.height ?? Infinity) <= maxHeight);
}

/** H.264 encoders, best first: the GPU's own encoder leaves the CPU to the game and OBS; x264 is the fallback. */
const ENCODERS = ['h264_nvenc', 'h264_amf', 'h264_qsv', 'libx264'] as const;
type Encoder = (typeof ENCODERS)[number];

function encoderArgs(enc: Encoder, video: number): string[] {
  const rate = ['-maxrate', String(video), '-bufsize', String(video * 2)];
  switch (enc) {
    case 'h264_nvenc':
      return ['-c:v', enc, '-preset', 'p5', '-rc', 'vbr', '-cq', '23', '-b:v', '0', ...rate, '-pix_fmt', 'yuv420p'];
    case 'h264_amf':
      return ['-c:v', enc, '-quality', 'balanced', '-rc', 'vbr_peak', '-b:v', String(Math.floor(video * 0.8)), ...rate, '-pix_fmt', 'yuv420p'];
    case 'h264_qsv':
      return ['-c:v', enc, '-preset', 'medium', '-b:v', String(Math.floor(video * 0.8)), ...rate, '-pix_fmt', 'nv12'];
    case 'libx264':
      return ['-threads', String(ENCODE_THREADS), '-c:v', enc, '-preset', 'veryfast', '-crf', '23', ...rate, '-pix_fmt', 'yuv420p'];
  }
}

/** The first encoder that worked on this PC (a missing GPU/driver fails in well under a second, then the next is tried). */
let workingEncoder: Encoder | null = null;

/**
 * Makes an OBS replay uploadable. Returns `encoded: false` when the original already qualifies (canSkipEncode) and
 * nothing was written; otherwise re-encodes to a web MP4 (H.264 + AAC) whose bitrate is capped from the clip's LENGTH
 * so the file always fits the byte cap: a longer clip gets a lower bitrate, never a refusal. `maxHeight` null keeps
 * OBS's output size (1440p, 4K…); the frame rate is never touched.
 */
export async function compressReplay(input: string, output: string, maxBytes: number, maxHeight: number | null, bytes: number): Promise<{ durationSeconds: number; encoded: boolean }> {
  const info = await probe(input);
  const durationSeconds = info.seconds;
  if (canSkipEncode(info, bytes, maxBytes, maxHeight)) return { durationSeconds, encoded: false };
  const audio = 128_000;
  // Aim 8% under the cap so audio/container overhead and rate-control drift still land below it. 12 Mbps tops out
  // at clean 1080p60, 24 Mbps leaves 1440p60 room; the byte cap (sized from the length) still wins on long clips.
  const targetBytes = maxBytes * 0.92;
  const ceiling = maxHeight && maxHeight <= 1080 ? 12_000_000 : 24_000_000;
  const video = Math.max(500_000, Math.min(ceiling, Math.floor((targetBytes * 8) / Math.max(durationSeconds, 1)) - audio));
  let last = '';
  for (const enc of workingEncoder ? [workingEncoder, ...ENCODERS.filter((e) => e !== workingEncoder)] : ENCODERS) {
    const { code, stderr } = await run(
      [
        '-y', '-hide_banner', '-i', input,
        // Downscale by the short side so portrait canvases shrink too; never upscale.
        ...(maxHeight ? ['-vf', `scale=w='if(gte(iw,ih),-2,min(iw,${maxHeight}))':h='if(gte(iw,ih),min(ih,${maxHeight}),-2)'`] : []),
        ...encoderArgs(enc, video),
        '-c:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart',
        output,
      ],
      10 * 60_000,
    );
    if (code === 0) {
      workingEncoder = enc;
      return { durationSeconds, encoded: true };
    }
    last = `${enc}: ${stderr.split('\n').slice(-3).join(' ').trim()}`;
  }
  throw new Error(`ffmpeg_failed: ${last}`);
}
