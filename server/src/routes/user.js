import { db } from '../db.js';
import { BASE_SELECT, buildFilters, findVideo, serializeVideo } from './videos.js';

const hasVideo = (id) => Boolean(db.prepare('SELECT 1 FROM videos WHERE id = ?').get(id));

export default async function userRoutes(fastify) {
  fastify.post('/api/videos/:id/favorite', async (req, reply) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!hasVideo(id)) return reply.code(404).send({ error: 'video not found' });
    const on = req.body?.on !== false;
    if (on) {
      db.prepare(
        'INSERT INTO favorites (video_id, created_at) VALUES (?, ?) ON CONFLICT(video_id) DO NOTHING'
      ).run(id, Date.now());
    } else {
      db.prepare('DELETE FROM favorites WHERE video_id = ?').run(id);
    }
    return { id, favorite: on };
  });

  fastify.post('/api/videos/:id/like', async (req, reply) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!hasVideo(id)) return reply.code(404).send({ error: 'video not found' });
    const on = req.body?.on !== false;
    if (on) {
      db.prepare(
        'INSERT INTO likes (video_id, created_at) VALUES (?, ?) ON CONFLICT(video_id) DO NOTHING'
      ).run(id, Date.now());
    } else {
      db.prepare('DELETE FROM likes WHERE video_id = ?').run(id);
    }
    return { id, liked: on, likes: db.prepare('SELECT COUNT(*) AS c FROM likes').get().c };
  });

  fastify.post('/api/videos/:id/progress', async (req, reply) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!hasVideo(id)) return reply.code(404).send({ error: 'video not found' });
    const position = Number(req.body?.position) || 0;
    const duration = Number(req.body?.duration) || 0;
    const finished = Boolean(req.body?.finished);

    db.prepare(
      `INSERT INTO history (video_id, position, duration, play_count, played_at)
       VALUES (@id, @position, @duration, 1, @now)
       ON CONFLICT(video_id) DO UPDATE SET
         position = @position,
         duration = CASE WHEN @duration > 0 THEN @duration ELSE history.duration END,
         play_count = history.play_count + @inc,
         played_at = @now`
    ).run({
      id,
      position: finished ? 0 : position,
      duration,
      now: Date.now(),
      inc: req.body?.countPlay ? 1 : 0,
    });
    return { ok: true };
  });

  fastify.get('/api/history', async (req) => {
    const limit = Math.min(Math.max(Number.parseInt(req.query?.limit, 10) || 60, 1), 200);
    const offset = Math.max(Number.parseInt(req.query?.offset, 10) || 0, 0);
    const rows = db
      .prepare(
        `${BASE_SELECT} WHERE v.missing = 0
         AND EXISTS (SELECT 1 FROM history h WHERE h.video_id = v.id)
         ORDER BY played_at DESC LIMIT ? OFFSET ?`
      )
      .all(limit, offset);
    const total = db.prepare('SELECT COUNT(*) AS c FROM history').get().c;
    return { total, items: rows.map((row) => serializeVideo(row)) };
  });

  fastify.delete('/api/history', async () => {
    db.prepare('DELETE FROM history').run();
    return { ok: true };
  });

  fastify.delete('/api/history/:id', async (req) => {
    db.prepare('DELETE FROM history WHERE video_id = ?').run(Number.parseInt(req.params.id, 10));
    return { ok: true };
  });

  fastify.get('/api/favorites', async (req) => {
    const limit = Math.min(Math.max(Number.parseInt(req.query?.limit, 10) || 60, 1), 200);
    const offset = Math.max(Number.parseInt(req.query?.offset, 10) || 0, 0);
    const rows = db
      .prepare(
        `${BASE_SELECT} WHERE v.missing = 0
         AND EXISTS (SELECT 1 FROM favorites f WHERE f.video_id = v.id)
         ORDER BY favorite DESC LIMIT ? OFFSET ?`
      )
      .all(limit, offset);
    const total = db.prepare('SELECT COUNT(*) AS c FROM favorites').get().c;
    return { total, items: rows.map((row) => serializeVideo(row)) };
  });

  /** Replace the tag set of one video. */
  fastify.put('/api/videos/:id/tags', async (req, reply) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!hasVideo(id)) return reply.code(404).send({ error: 'video not found' });
    const names = Array.isArray(req.body?.tags)
      ? [...new Set(req.body.tags.map((t) => String(t).trim()).filter(Boolean))].slice(0, 32)
      : [];

    const apply = db.transaction(() => {
      db.prepare('DELETE FROM video_tags WHERE video_id = ?').run(id);
      for (const name of names) {
        db.prepare('INSERT INTO tags (name) VALUES (?) ON CONFLICT(name) DO NOTHING').run(name);
        const tag = db.prepare('SELECT id FROM tags WHERE name = ?').get(name);
        db.prepare(
          'INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?) ON CONFLICT DO NOTHING'
        ).run(id, tag.id);
      }
      db.prepare(
        'DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM video_tags)'
      ).run();
    });
    apply();
    return { id, tags: names };
  });

  fastify.get('/api/videos/:id/related', async (req, reply) => {
    const id = Number.parseInt(req.params.id, 10);
    const row = findVideo(id);
    if (!row) return reply.code(404).send({ error: 'video not found' });
    const { clause, params } = buildFilters({ collection: row.collection });
    const rows = db
      .prepare(`${BASE_SELECT} ${clause} AND v.id != @self ORDER BY RANDOM() LIMIT 12`)
      .all({ ...params, self: id });
    return { items: rows.map((item) => serializeVideo(item)) };
  });
}
