import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

const hwState = {
  detected: false,
  available: false,
  vendor: 'cpu',
  detail: 'not probed',
};

function run(bin, args, { timeout = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timer = null;

    if (timeout > 0) {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`${bin} timed out after ${timeout}ms`));
      }, timeout);
    }

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      // ffprobe JSON output is small; guard against runaway output.
      if (stdout.length > 8 * 1024 * 1024) stdout = stdout.slice(-1024);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-4096);
    });

    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${bin} exited with code ${code}: ${stderr.trim().slice(-800)}`));
    });
  });
}

let ffmpegOk = null;

export async function checkFfmpeg() {
  if (ffmpegOk !== null) return ffmpegOk;
  try {
    await run(FFMPEG, ['-version'], { timeout: 10000 });
    ffmpegOk = true;
  } catch {
    ffmpegOk = false;
  }
  return ffmpegOk;
}

/**
 * "auto" -> probe /dev/dri. Falls back to CPU when nothing usable is present.
 * The default pipeline only remuxes, so this mostly matters for diagnostics.
 */
export async function detectHwAccel(force = false) {
  if (hwState.detected && !force) return hwState;

  hwState.detected = true;
  hwState.available = false;
  hwState.vendor = 'cpu';
  hwState.detail = 'CPU only';

  if (config.hwaccel === 'off' || config.hwaccel === 'none') {
    hwState.detail = 'disabled by HWACCEL';
    return hwState;
  }

  const driPresent = fs.existsSync(config.driDevice);
  if (!driPresent) {
    hwState.detail = `${config.driDevice} not present, using CPU`;
    return hwState;
  }

  try {
    const { stdout } = await run(FFMPEG, ['-hide_banner', '-hwaccels'], { timeout: 10000 });
    if (/vaapi/i.test(stdout)) {
      hwState.available = true;
      hwState.vendor = 'vaapi';
      hwState.detail = 'VAAPI/QSV available via /dev/dri';
      return hwState;
    }
    hwState.detail = 'no vaapi support in this ffmpeg build';
  } catch (error) {
    hwState.detail = `probe failed: ${error.message}`;
  }
  return hwState;
}

export function getHwAccel() {
  return { ...hwState };
}

/** Probe a video file. Returns null when ffprobe cannot read it. */
export async function probe(file) {
  const args = [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    file,
  ];

  try {
    const { stdout } = await run(FFPROBE, args, { timeout: 60000 });
    const parsed = JSON.parse(stdout);
    const streams = parsed.streams || [];
    const video = streams.find((s) => s.codec_type === 'video') || null;
    const audio = streams.find((s) => s.codec_type === 'audio') || null;
    const format = parsed.format || {};

    return {
      duration: Number.parseFloat(format.duration || video?.duration || '0') || 0,
      size: Number.parseInt(format.size || '0', 10) || 0,
      container: (format.format_name || '').split(',')[0] || '',
      videoCodec: video?.codec_name || '',
      audioCodec: audio?.codec_name || '',
      width: video?.width || 0,
      height: video?.height || 0,
      pixFmt: video?.pix_fmt || '',
    };
  } catch {
    return null;
  }
}

/**
 * Decide how a file can be played:
 *  - direct    : native container + native codec, stream the original file
 *  - hevc      : native container but HEVC video, stream original and warn in UI
 *  - remux     : container the browser rejects, needs a -c copy repack
 *  - broken    : ffprobe failed
 */
export function classify(meta, ext) {
  if (!meta) return { compat: 'broken', reason: 'ffprobe could not read this file' };

  const extName = ext.toLowerCase();
  const nativeContainer = config.nativeContainers.includes(extName);
  const codec = (meta.videoCodec || '').toLowerCase();
  const nativeCodec = config.nativeCodecs.some((c) => codec.startsWith(c));

  if (!nativeContainer) {
    return {
      compat: 'remux',
      reason: `${extName} container is not playable in browsers`,
    };
  }
  if (codec === 'hevc' || codec === 'h265') {
    return {
      compat: 'hevc',
      reason: 'H.265/HEVC: playable on Safari/iOS and Windows Chrome, may fail on Android',
    };
  }
  if (!nativeCodec) {
    return {
      compat: 'remux',
      reason: `${codec || 'unknown'} video codec needs a repack`,
    };
  }
  return { compat: 'direct', reason: '' };
}

export async function generatePoster(file, output, { duration = 0 } = {}) {
  await fs.promises.mkdir(path.dirname(output), { recursive: true });
  const seek = duration > 20 ? Math.min(duration * 0.15, 12) : Math.max(duration * 0.05, 0.5);
  const args = [
    '-nostdin',
    '-y',
    '-ss',
    String(Math.max(seek, 0.1)),
    '-i',
    file,
    '-frames:v',
    '1',
    '-vf',
    'scale=540:-2:force_original_aspect_ratio=decrease',
    '-q:v',
    '4',
    output,
  ];
  await run(FFMPEG, args, { timeout: 90000 });
  return output;
}

/**
 * Repack a file into MP4 without re-encoding the video stream.
 * Tries a pure stream copy first; if the audio codec cannot live inside MP4
 * it retries transcoding only the audio (cheap, unlike a full video transcode).
 */
export async function remuxToMp4(input, output, { onStep = () => {} } = {}) {
  await fs.promises.mkdir(path.dirname(output), { recursive: true });
  // ffmpeg picks the muxer from the output extension. A bare ".part" suffix
  // makes it fail with "Unable to choose an output format", so the temp file
  // has to keep a recognizable .mp4 ending.
  const temp = output.toLowerCase().endsWith('.mp4')
    ? `${output.slice(0, -4)}.part.mp4`
    : `${output}.part.mp4`;

  const base = [
    '-nostdin',
    '-y',
    '-i',
    input,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-sn',
    '-dn',
    '-movflags',
    '+faststart',
    '-threads',
    String(config.ffmpegThreads),
  ];

  const attempts = [
    { label: 'stream copy', args: [...base, '-c', 'copy', '-f', 'mp4', temp] },
    {
      label: 'video copy + aac audio',
      args: [...base, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-f', 'mp4', temp],
    },
  ];

  let lastError = null;
  for (const attempt of attempts) {
    onStep(attempt.label);
    try {
      await run(FFMPEG, attempt.args, { timeout: 0 });
      await fs.promises.rename(temp, output);
      return { output, mode: attempt.label };
    } catch (error) {
      lastError = error;
      await fs.promises.rm(temp, { force: true }).catch(() => {});
    }
  }

  throw lastError || new Error('remux failed');
}

export async function extractFrame(input, output, at = 0) {
  await fs.promises.mkdir(path.dirname(output), { recursive: true });
  await run(
    FFMPEG,
    ['-nostdin', '-y', '-ss', String(Math.max(at, 0)), '-i', input, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '5', output],
    { timeout: 60000 }
  );
  return output;
}
