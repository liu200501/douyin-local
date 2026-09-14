import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { config } from '../config.js';
import { db, settings } from '../db.js';
import { detectHwAccel, getHwAccel } from '../ffmpeg.js';
import {
  getVideoDirs,
  indexOneFile,
  isUnderVideoRoot,
  jobs,
  remuxForRow,
  runScan,
  scanState,
  setVideoDirs,
} from '../scanner.js';
import { findVideo, serializeVideo } from './videos.js';

const TRASH_DIR = () => path.join(config.dataDir, 'trash');

/**
 * 视频目录是否可写。
 *
 * compose / fpk 里如果把视频目录挂成只读（volumes 末尾的 `:ro`），上传和删除
 * 都会以 EACCES 失败。这里提前拦一道，把 errno 换成人能看懂的话，而不是让前端
 * 显示 "EACCES: permission denied, open '/media/videos/xxx.mp4'"。
 */
function writableIssue(dir) {
  if (!fs.existsSync(dir)) return `目录不存在：${dir}`;
  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch {
    return `目录不可写：${dir}。容器里可能是只读挂载，去掉 compose 中该 volume 末尾的 :ro 后重启容器即可。`;
  }
  return null;
}

function stats() {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(size) AS bytes,
              SUM(duration) AS seconds,
              SUM(CASE WHEN compat = 'remux' THEN 1 ELSE 0 END) AS pendingRemux,
              SUM(CASE WHEN compat = 'remuxed' THEN 1 ELSE 0 END) AS remuxed,
              SUM(CASE WHEN compat = 'hevc' THEN 1 ELSE 0 END) AS hevc,
              SUM(CASE WHEN compat = 'broken' THEN 1 ELSE 0 END) AS broken
       FROM videos WHERE missing = 0`
    )
    .get();
  return {
    total: row.total || 0,
    bytes: row.bytes || 0,
    seconds: row.seconds || 0,
    pendingRemux: row.pendingRemux || 0,
    remuxed: row.remuxed || 0,
    hevc: row.hevc || 0,
    broken: row.broken || 0,
    favorites: db.prepare('SELECT COUNT(*) AS c FROM favorites').get().c,
    likes: db.prepare('SELECT COUNT(*) AS c FROM likes').get().c,
    history: db.prepare('SELECT COUNT(*) AS c FROM history').get().c,
    collections: db.prepare('SELECT COUNT(DISTINCT collection) AS c FROM videos').get().c,
    tags: db.prepare('SELECT COUNT(*) AS c FROM tags').get().c,
  };
}

export default async function adminRoutes(fastify) {
  fastify.get('/api/system/info', async () => {
    const hw = await detectHwAccel();
    return {
      version: config.version,
      port: config.port,
      dataDir: config.dataDir,
      cacheDir: config.cacheDir,
      videoDirs: getVideoDirs(),
      videoDirsReachable: getVideoDirs().map((dir) => ({
        dir,
        exists: fs.existsSync(dir),
        writable: (() => {
          try {
            fs.accessSync(dir, fs.constants.W_OK);
            return true;
          } catch {
            return false;
          }
        })(),
      })),
      nativeContainers: config.nativeContainers,
      nativeCodecs: config.nativeCodecs,
      supportedExts: config.videoExts,
      hwaccel: hw,
      jobs: jobs.stats(),
      scan: scanState,
      stats: stats(),
      settings: settings.all(),
    };
  });

  fastify.post('/api/system/scan', async (req) => {
    const full = req.body?.full !== false;
    const promise = runScan({ full });
    if (req.body?.wait) {
      await promise.catch(() => {});
      return { scan: scanState };
    }
    promise.catch((error) => fastify.log.error(error, 'scan failed'));
    return { started: true, scan: scanState };
  });

  fastify.get('/api/system/scan', async () => ({ scan: scanState, jobs: jobs.stats() }));

  fastify.put('/api/system/dirs', async (req, reply) => {
    const dirs = Array.isArray(req.body?.dirs) ? req.body.dirs : [];
    if (dirs.length === 0) return reply.code(400).send({ error: '至少需要一个视频目录' });
    const cleaned = setVideoDirs(dirs);
    const invalid = cleaned.filter((dir) => !fs.existsSync(dir));
    if (invalid.length > 0) {
      return { dirs: cleaned, warning: `以下目录当前不可访问：${invalid.join(', ')}` };
    }
    return { dirs: cleaned };
  });

  fastify.put('/api/system/settings', async (req) => {
    const allowed = ['sort', 'autoplay', 'defaultView', 'uploadDir', 'showHevcWarning'];
    const changed = {};
    for (const key of allowed) {
      if (req.body && key in req.body) changed[key] = settings.set(key, req.body[key]);
    }
    return { changed, settings: settings.all() };
  });

  fastify.get('/api/system/detect-dirs', async () => {
    const guesses = ['/media/videos', '/media', '/vol1/1000/videos', '/vol1/1000/影视', '/mnt', '/data/videos'];
    return {
      candidates: guesses.map((dir) => ({ dir, exists: fs.existsSync(dir) })),
      mountHint: '在 compose 里把宿主视频目录挂到 /media/videos 即可被自动发现。',
    };
  });

  /** Re-queue a repack for one video and wait for it. */
  fastify.post('/api/videos/:id/remux', async (req, reply) => {
    const row = findVideo(Number.parseInt(req.params.id, 10));
    if (!row) return reply.code(404).send({ error: 'video not found' });
    try {
      await jobs.push(`remux:${row.id}`, () => remuxForRow(row.id));
      return serializeVideo(findVideo(row.id));
    } catch (error) {
      return reply.code(500).send({ error: error.message });
    }
  });

  fastify.post('/api/upload', async (req, reply) => {
    const targetDir = settings.get('uploadDir') || getVideoDirs()[0];
    if (!targetDir) {
      return reply.code(400).send({ error: '尚未配置视频目录，请先在设置页添加目录' });
    }

    const issue = writableIssue(targetDir);
    if (issue) {
      return reply.code(400).send({
        error: issue,
        hint: '也可以在设置页把「上传目录」指到一个可写的目录',
      });
    }

    const parts = req.parts({ limits: { fileSize: 20 * 1024 * 1024 * 1024, files: 20 } });
    const saved = [];
    const skipped = [];

    try {
      for await (const part of parts) {
        if (part.type !== 'file') continue;
        const ext = path.extname(part.filename || '').slice(1).toLowerCase();
        if (!config.videoExts.includes(ext)) {
          skipped.push({ name: part.filename, reason: `不支持的格式 .${ext}` });
          await part.toBuffer().catch(() => {});
          continue;
        }
        const safeName = path
          .basename(part.filename)
          .replace(/[\\/:*?"<>|]/g, '_')
          .slice(-180);
        let dest = path.join(targetDir, safeName);
        let counter = 1;
        while (fs.existsSync(dest)) {
          const parsed = path.parse(safeName);
          dest = path.join(targetDir, `${parsed.name} (${counter})${parsed.ext}`);
          counter += 1;
        }
        await pipeline(part.file, fs.createWriteStream(dest));
        saved.push({ name: path.basename(dest), dir: targetDir });
      }
    } catch (error) {
      return reply.code(500).send({ error: error.message, saved, skipped });
    }

    const indexed = [];
    for (const item of saved) {
      try {
        const id = await indexOneFile(path.join(item.dir, item.name));
        indexed.push(id);
      } catch (error) {
        fastify.log.warn({ err: error }, 'index after upload failed');
      }
    }

    return { saved, skipped, indexed, dir: targetDir };
  });

  /**
   * Destructive. Files are moved into <dataDir>/trash instead of being unlinked,
   * and only paths inside a configured video root can be touched.
   */
  fastify.delete('/api/videos/:id', async (req, reply) => {
    if (String(req.query?.confirm) !== '1') {
      return reply
        .code(428)
        .send({ error: '需要确认删除，请带上 confirm=1', hint: '文件会被移动到 data/trash 而不是直接删除' });
    }
    const row = findVideo(Number.parseInt(req.params.id, 10));
    if (!row) return reply.code(404).send({ error: 'video not found' });
    if (!isUnderVideoRoot(row.path)) {
      return reply.code(403).send({ error: '拒绝操作配置视频目录之外的路径' });
    }

    const trashDir = TRASH_DIR();
    await fs.promises.mkdir(trashDir, { recursive: true });
    let movedTo = null;

    if (fs.existsSync(row.path)) {
      const issue = writableIssue(path.dirname(row.path));
      if (issue) {
        return reply.code(400).send({
          error: `无法移除：${issue}`,
          hint: '文件没有被删除，索引也保持原样',
        });
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      movedTo = path.join(trashDir, `${stamp}__${path.basename(row.path)}`);
      try {
        await fs.promises.rename(row.path, movedTo);
      } catch (error) {
        // 视频目录和 data 目录常常不在同一个卷上（NAS 上尤其常见），
        // rename 会以 EXDEV 失败。退化成「复制 + 删源」，否则删除功能整条挂掉。
        if (error.code === 'EXDEV') {
          await fs.promises.copyFile(row.path, movedTo);
          await fs.promises.rm(row.path, { force: true });
        } else {
          return reply
            .code(500)
            .send({ error: `移动文件失败：${error.message}`, hint: '文件没有被删除' });
        }
      }
    }
    if (row.play_path && fs.existsSync(row.play_path)) {
      await fs.promises.rm(row.play_path, { force: true }).catch(() => {});
    }
    if (row.poster && fs.existsSync(row.poster)) {
      await fs.promises.rm(row.poster, { force: true }).catch(() => {});
    }
    db.prepare('DELETE FROM videos WHERE id = ?').run(row.id);

    return { ok: true, id: row.id, trash: movedTo };
  });

  fastify.get('/api/system/trash', async () => {
    const dir = TRASH_DIR();
    if (!fs.existsSync(dir)) return { items: [] };
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const items = await Promise.all(
      entries
        .filter((entry) => entry.isFile())
        .map(async (entry) => {
          const stat = await fs.promises.stat(path.join(dir, entry.name));
          return { name: entry.name, size: stat.size, mtime: stat.mtimeMs };
        })
    );
    items.sort((a, b) => b.mtime - a.mtime);
    return { items, dir };
  });
}
