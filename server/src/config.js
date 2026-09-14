import fs from 'node:fs';
import path from 'node:path';

const toBool = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
};

const toInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toList = (value) =>
  String(value ?? '')
    .split(/[,;\n|]/)
    .map((item) => item.trim())
    .filter(Boolean);

const DATA_DIR = process.env.DATA_DIR || '/data';
const CACHE_DIR = process.env.CACHE_DIR || path.join(DATA_DIR, 'cache');

export const config = {
  version: process.env.APP_VERSION || '1.0.0',
  port: toInt(process.env.PORT, 6688),
  host: process.env.HOST || '0.0.0.0',

  dataDir: DATA_DIR,
  dbPath: process.env.DB_PATH || path.join(DATA_DIR, 'library.db'),
  cacheDir: CACHE_DIR,
  posterDir: path.join(CACHE_DIR, 'poster'),
  remuxDir: path.join(CACHE_DIR, 'remux'),

  // Initial video roots. Runtime changes are persisted in the settings table.
  videoDirs: toList(process.env.VIDEO_DIRS || process.env.TRIM_DATA_SHARE_PATHS || '/media/videos'),

  // Extensions the scanner will index.
  videoExts: toList(
    process.env.VIDEO_EXTS ||
      'mp4,m4v,mov,webm,ogv,mkv,avi,flv,ts,m2ts,wmv,mpg,mpeg,3gp'
  ).map((ext) => ext.replace(/^\./, '').toLowerCase()),

  // Containers a browser can play directly.
  nativeContainers: toList(process.env.NATIVE_CONTAINERS || 'mp4,m4v,mov,webm,ogv').map((c) =>
    c.toLowerCase()
  ),

  // Codecs that are safe to play without re-encoding.
  nativeCodecs: toList(process.env.NATIVE_CODECS || 'h264,avc1,vp8,vp9,av1,theora').map((c) =>
    c.toLowerCase()
  ),

  // Number of concurrent ffmpeg jobs (poster / remux). Keep low on a NAS.
  jobConcurrency: Math.max(1, toInt(process.env.JOB_CONCURRENCY, 2)),
  // Threads handed to each ffmpeg process.
  ffmpegThreads: Math.max(1, toInt(process.env.FFMPEG_THREADS, 1)),

  // "auto" probes /dev/dri and falls back to CPU. Only affects future use of
  // real transcoding; the default pipeline never re-encodes video.
  hwaccel: (process.env.HWACCEL || 'auto').toLowerCase(),
  driDevice: process.env.DRI_DEVICE || '/dev/dri',

  scanOnStart: toBool(process.env.SCAN_ON_START, true),
  watchLibrary: toBool(process.env.WATCH_LIBRARY, false),
  // Seconds between automatic rescans when watchLibrary is enabled (0 = off).
  rescanInterval: toInt(process.env.RESCAN_INTERVAL, 0),

  // Writable directory for uploads. Empty = first video root.
  uploadDir: process.env.UPLOAD_DIR || '',

  logLevel: process.env.LOG_LEVEL || 'info',
  trustProxy: toBool(process.env.TRUST_PROXY, true),
  corsOrigin: process.env.CORS_ORIGIN || true,
};

export function ensureRuntimeDirs() {
  for (const dir of [
    config.dataDir,
    config.cacheDir,
    config.posterDir,
    config.remuxDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function resolveReadableDirs(dirs) {
  const seen = new Set();
  const result = [];
  for (const dir of dirs) {
    const abs = path.resolve(dir);
    if (seen.has(abs)) continue;
    seen.add(abs);
    result.push(abs);
  }
  return result;
}
