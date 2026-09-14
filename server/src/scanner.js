import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { db, settings } from './db.js';
import { classify, generatePoster, probe, remuxToMp4 } from './ffmpeg.js';
import { createQueue } from './queue.js';

export const jobs = createQueue({ concurrency: config.jobConcurrency, name: 'ffmpeg' });

export const scanState = {
  running: false,
  phase: 'idle',
  scanned: 0,
  total: 0,
  indexed: 0,
  updated: 0,
  removed: 0,
  error: null,
  startedAt: null,
  finishedAt: null,
};

/**
 * Video roots are always normalized with path.resolve() before they are used.
 * Without this, a root written with forward slashes (e.g. "D:/media/videos" on
 * Windows, or a hand-copied path) would never match the joined file paths and
 * the whole library would silently index zero files.
 */
export function getVideoDirs() {
  const dirs = settings.get('videoDirs');
  const raw = Array.isArray(dirs) && dirs.length > 0 ? dirs : config.videoDirs;
  return raw.map((dir) => path.resolve(String(dir)));
}

export function setVideoDirs(dirs) {
  const cleaned = [...new Set(dirs.map((d) => path.resolve(String(d).trim())).filter(Boolean))];
  settings.set('videoDirs', cleaned);
  return cleaned;
}

export function isUnderVideoRoot(target) {
  const abs = path.resolve(target);
  return getVideoDirs().some((root) => abs === root || abs.startsWith(root + path.sep));
}

const VIDEO_EXT_SET = () => new Set(config.videoExts);

async function walk(root, out, exts, depth = 0) {
  if (depth > 24) return;
  let entries;
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await walk(full, out, exts, depth + 1);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).slice(1).toLowerCase();
      if (exts.has(ext)) out.push(full);
    }
  }
}

const selectByPath = db.prepare('SELECT * FROM videos WHERE path = ?');
const insertVideo = db.prepare(`
  INSERT INTO videos (path, root_dir, rel_path, collection, filename, title, ext, size, mtime,
                      duration, width, height, video_codec, audio_codec, container, compat,
                      compat_reason, indexed_at)
  VALUES (@path, @root_dir, @rel_path, @collection, @filename, @title, @ext, @size, @mtime,
          @duration, @width, @height, @video_codec, @audio_codec, @container, @compat,
          @compat_reason, @indexed_at)
`);
const updateVideo = db.prepare(`
  UPDATE videos SET size = @size, mtime = @mtime, duration = @duration, width = @width,
                    height = @height, video_codec = @video_codec, audio_codec = @audio_codec,
                    container = @container, compat = @compat, compat_reason = @compat_reason,
                    indexed_at = @indexed_at, missing = 0
  WHERE path = @path
`);

function deriveMeta(absPath, root) {
  const rel = path.relative(root, absPath);
  const parts = rel.split(path.sep);
  const collection = parts.length > 1 ? parts[0] : '未分类';
  const filename = parts[parts.length - 1];
  return {
    root_dir: root,
    rel_path: rel.split(path.sep).join('/'),
    collection,
    filename,
    title: path.basename(filename, path.extname(filename)),
    ext: path.extname(filename).slice(1).toLowerCase(),
  };
}

/** Kick off poster + remux work for a freshly indexed row. */
function scheduleAssets(row) {
  if (row.compat === 'broken') return;

  if (!row.poster) {
    jobs.push(`poster:${row.id}`, async () => {
      const output = path.join(config.posterDir, `${row.id}.jpg`);
      await generatePoster(row.path, output, { duration: row.duration });
      db.prepare('UPDATE videos SET poster = ? WHERE id = ?').run(output, row.id);
    }).catch((error) => {
      console.warn(`[scanner] poster failed for ${row.path}: ${error.message}`);
    });
  }

  if (row.compat === 'remux' && !row.play_path) {
    jobs.push(`remux:${row.id}`, () => remuxForRow(row.id)).catch((error) => {
      console.warn(`[scanner] remux failed for ${row.path}: ${error.message}`);
    });
  }
}

/** Repack a row into MP4 and persist the result. Resolves with the play path. */
export async function remuxForRow(rowOrId) {
  const row =
    typeof rowOrId === 'object'
      ? rowOrId
      : db.prepare('SELECT * FROM videos WHERE id = ?').get(rowOrId);
  if (!row) throw new Error('video not found');
  if (row.play_path) return row.play_path;

  const output = path.join(config.remuxDir, `${row.id}.mp4`);
  const result = await remuxToMp4(row.path, output);
  db.prepare('UPDATE videos SET play_path = ?, compat = ?, compat_reason = ? WHERE id = ?').run(
    result.output,
    'remuxed',
    `repacked from ${row.ext} (${result.mode})`,
    row.id
  );
  return result.output;
}

export async function runScan({ full = false } = {}) {
  if (scanState.running) return scanState;

  const roots = getVideoDirs();
  scanState.running = true;
  scanState.phase = 'walking';
  scanState.error = null;
  scanState.scanned = 0;
  scanState.indexed = 0;
  scanState.updated = 0;
  scanState.removed = 0;
  scanState.startedAt = Date.now();
  scanState.finishedAt = null;

  try {
    const exts = VIDEO_EXT_SET();
    const found = [];
    for (const root of roots) {
      if (!fs.existsSync(root)) {
        console.warn(`[scanner] skipping missing root: ${root}`);
        continue;
      }
      await walk(root, found, exts);
    }

    scanState.total = found.length;
    scanState.phase = 'indexing';
    const seenIds = new Set();

    for (const absPath of found) {
      scanState.scanned += 1;
      // Longest matching root wins so nested roots do not double-report.
      const root = roots
        .filter((r) => absPath === r || absPath.startsWith(r + path.sep))
        .sort((a, b) => b.length - a.length)[0];
      if (!root) continue;

      let stat;
      try {
        stat = await fs.promises.stat(absPath);
      } catch {
        continue;
      }

      const existing = selectByPath.get(absPath);
      const unchanged =
        existing && !full && existing.size === stat.size && existing.mtime === stat.mtime;

      if (unchanged) {
        seenIds.add(existing.id);
        continue;
      }

      const meta = await probe(absPath);
      const derived = deriveMeta(absPath, root);
      const classified = classify(meta, derived.ext);
      let { compat, reason } = classified;

      const mtime = Math.round(stat.mtimeMs);
      const contentChanged = !existing || existing.size !== stat.size || existing.mtime !== mtime;

      // A repack is only invalid once the source bytes actually change. Without
      // this, a "full rescan" would discard every cached remux and redo the whole
      // library — painful on a large folder. The cache file must still exist.
      const keepRepack =
        Boolean(existing?.play_path) && !contentChanged && fs.existsSync(existing.play_path);
      if (keepRepack) {
        compat = existing.compat;
        reason = existing.compat_reason;
      }

      const record = {
        ...derived,
        path: absPath,
        size: stat.size,
        mtime,
        duration: meta?.duration ?? 0,
        width: meta?.width ?? 0,
        height: meta?.height ?? 0,
        video_codec: meta?.videoCodec ?? '',
        audio_codec: meta?.audioCodec ?? '',
        container: meta?.container ?? derived.ext,
        compat,
        compat_reason: reason,
        indexed_at: Date.now(),
      };

      if (existing) {
        updateVideo.run(record);
        scanState.updated += 1;
        seenIds.add(existing.id);
        // Drop the cached repack when the source changed, or when it is no
        // longer needed at all (the file became directly playable).
        if (!keepRepack || compat === 'direct') {
          db.prepare("UPDATE videos SET play_path = '' WHERE id = ?").run(existing.id);
        }
      } else {
        const info = insertVideo.run(record);
        scanState.indexed += 1;
        seenIds.add(info.lastInsertRowid);
      }
    }

    scanState.phase = 'cleanup';
    if (roots.length > 0) {
      const knownRows = db.prepare('SELECT id, path FROM videos').all();
      const removeStmt = db.prepare('DELETE FROM videos WHERE id = ?');
      const missingStmt = db.prepare('UPDATE videos SET missing = 1 WHERE id = ?');
      const cleanup = db.transaction((rows) => {
        for (const row of rows) {
          if (seenIds.has(row.id)) continue;
          if (!isUnderVideoRoot(row.path)) continue;
          if (!fs.existsSync(row.path)) {
            removeStmt.run(row.id);
            scanState.removed += 1;
          } else {
            missingStmt.run(row.id);
          }
        }
      });
      cleanup(knownRows);
    }

    scanState.phase = 'assets';
    const pendingAssets = db
      .prepare("SELECT * FROM videos WHERE compat != 'broken' AND (poster = '' OR compat = 'remux')")
      .all();
    for (const row of pendingAssets) scheduleAssets(row);

    scanState.phase = 'done';
    return scanState;
  } catch (error) {
    scanState.phase = 'error';
    scanState.error = error.message;
    throw error;
  } finally {
    scanState.running = false;
    scanState.finishedAt = Date.now();
  }
}

/** Single-file index used by the upload endpoint. */
export async function indexOneFile(target) {
  const absPath = path.resolve(target);
  const stat = await fs.promises.stat(absPath);
  const roots = getVideoDirs();
  const root =
    roots
      .filter((r) => absPath === r || absPath.startsWith(r + path.sep))
      .sort((a, b) => b.length - a.length)[0] || path.dirname(absPath);

  const meta = await probe(absPath);
  const derived = deriveMeta(absPath, root);
  const { compat, reason } = classify(meta, derived.ext);
  const record = {
    ...derived,
    path: absPath,
    size: stat.size,
    mtime: Math.round(stat.mtimeMs),
    duration: meta?.duration ?? 0,
    width: meta?.width ?? 0,
    height: meta?.height ?? 0,
    video_codec: meta?.videoCodec ?? '',
    audio_codec: meta?.audioCodec ?? '',
    container: meta?.container ?? derived.ext,
    compat,
    compat_reason: reason,
    indexed_at: Date.now(),
  };

  const existing = selectByPath.get(absPath);
  if (existing) {
    updateVideo.run(record);
    const row = db.prepare('SELECT * FROM videos WHERE id = ?').get(existing.id);
    scheduleAssets(row);
    return row.id;
  }
  const info = insertVideo.run(record);
  const row = db.prepare('SELECT * FROM videos WHERE id = ?').get(info.lastInsertRowid);
  scheduleAssets(row);
  return row.id;
}
