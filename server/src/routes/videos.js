import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { db } from '../db.js';

const MIME_BY_EXT = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  flv: 'video/x-flv',
  ts: 'video/mp2t',
  m2ts: 'video/mp2t',
  wmv: 'video/x-ms-wmv',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
  '3gp': 'video/3gpp',
  jpg: 'image/jpeg',
};

export function mimeFor(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

export function serializeVideo(row, extras = {}) {
  return {
    id: row.id,
    title: row.title,
    filename: row.filename,
    collection: row.collection,
    relPath: row.rel_path,
    ext: row.ext,
    size: row.size,
    mtime: row.mtime,
    duration: row.duration,
    width: row.width,
    height: row.height,
    aspectRatio: row.width && row.height ? row.width / row.height : 9 / 16,
    videoCodec: row.video_codec,
    audioCodec: row.audio_codec,
    container: row.container,
    compat: row.compat,
    compatReason: row.compat_reason,
    hasPoster: Boolean(row.poster),
    missing: Boolean(row.missing),
    favorite: Boolean(row.favorite),
    liked: Boolean(row.liked),
    tags: row.tag_names ? String(row.tag_names).split('\u0001').filter(Boolean) : [],
    position: row.position ?? 0,
    playedAt: row.played_at ?? null,
    playCount: row.play_count ?? 0,
    ...extras,
  };
}

const SORT_MAP = {
  newest: 'v.mtime DESC, v.id DESC',
  oldest: 'v.mtime ASC, v.id ASC',
  name: 'v.title COLLATE NOCASE ASC, v.id ASC',
  duration: 'v.duration DESC, v.id DESC',
  size: 'v.size DESC, v.id DESC',
  random: 'RANDOM()',
};

export const BASE_SELECT = `
  SELECT v.*,
         (SELECT f.created_at FROM favorites f WHERE f.video_id = v.id) AS favorite,
         (SELECT l.created_at FROM likes l WHERE l.video_id = v.id) AS liked,
         (SELECT h.position FROM history h WHERE h.video_id = v.id) AS position,
         (SELECT h.played_at FROM history h WHERE h.video_id = v.id) AS played_at,
         (SELECT h.play_count FROM history h WHERE h.video_id = v.id) AS play_count,
         (SELECT GROUP_CONCAT(t.name, char(1)) FROM video_tags vt
            JOIN tags t ON t.id = vt.tag_id WHERE vt.video_id = v.id) AS tag_names
  FROM videos v
`;

export function buildFilters(query) {
  const where = ['v.missing = 0'];
  const params = {};

  if (query.q) {
    where.push('(v.title LIKE @q OR v.rel_path LIKE @q OR v.collection LIKE @q)');
    params.q = `%${query.q}%`;
  }
  if (query.collection) {
    where.push('v.collection = @collection');
    params.collection = query.collection;
  }
  if (query.compat) {
    where.push('v.compat = @compat');
    params.compat = query.compat;
  }
  if (query.ext) {
    where.push('v.ext = @ext');
    params.ext = String(query.ext).toLowerCase();
  }
  if (query.tag) {
    where.push(
      'EXISTS (SELECT 1 FROM video_tags vt JOIN tags t ON t.id = vt.tag_id WHERE vt.video_id = v.id AND t.name = @tag)'
    );
    params.tag = query.tag;
  }
  if (String(query.favorite) === '1') {
    where.push('EXISTS (SELECT 1 FROM favorites f WHERE f.video_id = v.id)');
  }
  if (String(query.played) === '1') {
    where.push('EXISTS (SELECT 1 FROM history h WHERE h.video_id = v.id)');
  }
  if (query.ids) {
    const ids = String(query.ids)
      .split(',')
      .map((n) => Number.parseInt(n, 10))
      .filter(Number.isFinite);
    if (ids.length === 0) {
      where.push('1 = 0');
    } else {
      where.push(`v.id IN (${ids.join(',')})`);
    }
  }
  return { clause: `WHERE ${where.join(' AND ')}`, params };
}

export function findVideo(id) {
  return db.prepare(`${BASE_SELECT} WHERE v.id = ?`).get(id);
}

export function playableFile(row) {
  if (row.play_path && fs.existsSync(row.play_path)) return row.play_path;
  if (fs.existsSync(row.path)) return row.path;
  return null;
}

function sendFileRange(req, reply, file) {
  const stat = fs.statSync(file);
  const size = stat.size;
  const type = mimeFor(file);
  const range = req.headers.range;

  const headers = {
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600',
  };

  if (!range) {
    reply
      .code(200)
      .headers({ ...headers, 'Content-Length': String(size) })
      .type(type);
    return reply.send(fs.createReadStream(file));
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
  if (!match) {
    reply.code(416).headers({ ...headers, 'Content-Range': `bytes */${size}` }).send();
    return reply;
  }

  let start = match[1] === '' ? null : Number.parseInt(match[1], 10);
  let end = match[2] === '' ? null : Number.parseInt(match[2], 10);

  if (start === null && end === null) {
    reply.code(416).headers({ ...headers, 'Content-Range': `bytes */${size}` }).send();
    return reply;
  }
  if (start === null) {
    // Suffix range: last N bytes.
    start = Math.max(size - end, 0);
    end = size - 1;
  } else if (end === null || end >= size) {
    end = size - 1;
  }

  if (start > end || start >= size) {
    reply.code(416).headers({ ...headers, 'Content-Range': `bytes */${size}` }).send();
    return reply;
  }

  const chunkSize = end - start + 1;
  reply
    .code(206)
    .headers({
      ...headers,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(chunkSize),
    })
    .type(type);
  return reply.send(fs.createReadStream(file, { start, end }));
}

export function guessUploadDir() {
  if (config.uploadDir && fs.existsSync(config.uploadDir)) return config.uploadDir;
  return null;
}

export default async function videosRoutes(fastify) {
  fastify.get('/api/videos', async (req) => {
    const query = req.query || {};
    const limit = Math.min(Math.max(Number.parseInt(query.limit, 10) || 40, 1), 200);
    const offset = Math.max(Number.parseInt(query.offset, 10) || 0, 0);
    const order = SORT_MAP[query.sort] || SORT_MAP.newest;
    const { clause, params } = buildFilters(query);

    const rows = db
      .prepare(`${BASE_SELECT} ${clause} ORDER BY ${order} LIMIT @limit OFFSET @offset`)
      .all({ ...params, limit, offset });
    const total = db
      .prepare(`SELECT COUNT(*) AS c FROM videos v ${clause}`)
      .get(params).c;

    return {
      total,
      offset,
      limit,
      items: rows.map((row) => serializeVideo(row)),
    };
  });

  fastify.get('/api/videos/:id', async (req, reply) => {
    const row = findVideo(Number.parseInt(req.params.id, 10));
    if (!row) return reply.code(404).send({ error: 'video not found' });
    return serializeVideo(row);
  });

  fastify.get('/api/videos/:id/play', async (req, reply) => {
    const id = Number.parseInt(req.params.id, 10);
    const row = findVideo(id);
    if (!row) return reply.code(404).send({ error: 'video not found' });

    if (!playableFile(row)) {
      return { status: 'missing', url: null, compat: row.compat, reason: '文件不存在或未挂载' };
    }
    if (row.compat === 'broken') {
      return { status: 'unsupported', url: null, compat: row.compat, reason: row.compat_reason };
    }
    if (row.compat === 'remux') {
      // Queue the repack and tell the client to poll.
      fastify.prepareRemux(row).catch((error) => {
        req.log.warn({ err: error, id }, 'remux failed');
      });
      return {
        status: 'preparing',
        url: null,
        compat: row.compat,
        reason: row.compat_reason,
        queue: fastify.jobsStats(),
      };
    }
    return {
      status: 'ready',
      url: `/api/stream/${row.id}`,
      compat: row.compat,
      reason: row.compat_reason,
    };
  });

  fastify.get('/api/stream/:id', async (req, reply) => {
    const row = findVideo(Number.parseInt(req.params.id, 10));
    if (!row) return reply.code(404).send({ error: 'video not found' });
    const file = playableFile(row);
    if (!file) return reply.code(404).send({ error: 'file not available' });
    return sendFileRange(req, reply, file);
  });

  fastify.get('/api/poster/:id', async (req, reply) => {
    const row = findVideo(Number.parseInt(req.params.id, 10));
    if (!row) return reply.code(404).send({ error: 'video not found' });
    if (row.poster && fs.existsSync(row.poster)) {
      return reply.type('image/jpeg').header('Cache-Control', 'public, max-age=604800').send(fs.createReadStream(row.poster));
    }
    reply.header('Cache-Control', 'no-store');
    return reply.code(404).send({ error: 'poster not ready' });
  });

  fastify.get('/api/download/:id', async (req, reply) => {
    const row = findVideo(Number.parseInt(req.params.id, 10));
    if (!row) return reply.code(404).send({ error: 'video not found' });
    if (!fs.existsSync(row.path)) return reply.code(404).send({ error: 'file not available' });
    const asciiName = `video-${row.id}${path.extname(row.path)}`;
    const encoded = encodeURIComponent(row.filename);
    return reply
      .type('application/octet-stream')
      .header(
        'Content-Disposition',
        `attachment; filename="${asciiName}"; filename*=UTF-8''${encoded}`
      )
      .send(fs.createReadStream(row.path));
  });

  fastify.get('/api/collections', async () => {
    const rows = db
      .prepare(
        `SELECT collection AS name,
                COUNT(*) AS count,
                (SELECT id FROM videos v2 WHERE v2.collection = v.collection AND v2.missing = 0
                  ORDER BY mtime DESC LIMIT 1) AS coverId,
                SUM(duration) AS totalDuration
         FROM videos v WHERE v.missing = 0
         GROUP BY collection ORDER BY count DESC, name COLLATE NOCASE ASC`
      )
      .all();
    return { items: rows };
  });

  fastify.get('/api/tags', async () => {
    const rows = db
      .prepare(
        `SELECT t.name, COUNT(vt.video_id) AS count FROM tags t
         LEFT JOIN video_tags vt ON vt.tag_id = t.id
         GROUP BY t.id ORDER BY count DESC, t.name COLLATE NOCASE ASC`
      )
      .all();
    return { items: rows };
  });
}
