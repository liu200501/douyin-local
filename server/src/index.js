import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { config, ensureRuntimeDirs } from './config.js';
import { bootstrapSettings } from './db.js';
import { checkFfmpeg, detectHwAccel } from './ffmpeg.js';
import { jobs, remuxForRow, runScan } from './scanner.js';
import videosRoutes from './routes/videos.js';
import userRoutes from './routes/user.js';
import adminRoutes from './routes/admin.js';

/**
 * Locate the built frontend. In the container WEB_DIR is set explicitly to
 * /app/web; for local runs we probe the usual layouts so the server does not
 * silently fall back to "API only" when it is started from server/.
 */
function resolveWebDir() {
  const candidates = [
    process.env.WEB_DIR,
    path.resolve(process.cwd(), 'web'),
    path.resolve(process.cwd(), 'web/dist'),
    path.resolve(process.cwd(), '../web/dist'),
    path.resolve(process.cwd(), '../web'),
  ].filter(Boolean);

  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
  }
  return process.env.WEB_DIR || path.resolve(process.cwd(), 'web');
}

const WEB_DIR = resolveWebDir();

async function main() {
  ensureRuntimeDirs();
  bootstrapSettings();

  const app = Fastify({
    logger: { level: config.logLevel },
    trustProxy: config.trustProxy,
    bodyLimit: 4 * 1024 * 1024,
  });

  app.decorate('jobsStats', () => jobs.stats());
  app.decorate('prepareRemux', (row) => jobs.push(`remux:${row.id}`, () => remuxForRow(row.id)));

  await app.register(cors, { origin: config.corsOrigin });
  await app.register(multipart, {
    limits: { fileSize: 20 * 1024 * 1024 * 1024, files: 20 },
    // Browsers send multipart filenames as UTF-8. Stating it explicitly keeps
    // Chinese filenames intact instead of relying on the library default.
    defParamCharset: 'utf8',
  });

  await app.register(videosRoutes);
  await app.register(userRoutes);
  await app.register(adminRoutes);

  app.get('/api/health', async () => ({ ok: true, version: config.version }));

  if (fs.existsSync(WEB_DIR)) {
    await app.register(fastifyStatic, {
      root: WEB_DIR,
      prefix: '/',
      index: ['index.html'],
      // cacheControl is disabled so setHeaders below is authoritative; the
      // plugin would otherwise overwrite Cache-Control after the callback.
      cacheControl: false,
      setHeaders(res, filePath) {
        if (/\.(js|css|woff2?|png|jpe?g|svg|webp|ico)$/i.test(filePath)) {
          res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
        } else {
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    });
  } else {
    app.log.warn(`web assets not found at ${WEB_DIR}, API-only mode`);
  }

  app.setNotFoundHandler((req, reply) => {
    if (req.raw.url?.startsWith('/api/')) {
      return reply.code(404).send({ error: 'not found' });
    }
    const indexFile = path.join(WEB_DIR, 'index.html');
    if (fs.existsSync(indexFile)) {
      return reply.type('text/html').header('Cache-Control', 'no-cache').send(fs.createReadStream(indexFile));
    }
    return reply.code(404).send({ error: 'not found' });
  });

  const ffmpegReady = await checkFfmpeg();
  const hw = await detectHwAccel();
  if (!ffmpegReady) {
    app.log.warn('ffmpeg/ffprobe not found: indexing and thumbnails will be disabled');
  }

  try {
    await app.listen({ port: config.port, host: config.host });
    app.log.info(
      `douyin-local ${config.version} listening on ${config.host}:${config.port} ` +
        `(ffmpeg=${ffmpegReady}, hwaccel=${hw.vendor}, videoDirs=${JSON.stringify(
          config.videoDirs
        )})`
    );
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }

  if (ffmpegReady && config.scanOnStart) {
    runScan({ full: false })
      .then((state) => app.log.info({ scan: state }, 'initial scan finished'))
      .catch((error) => app.log.error(error, 'initial scan failed'));
  }

  if (config.rescanInterval > 0) {
    const timer = setInterval(() => {
      runScan({ full: false }).catch((error) => app.log.error(error, 'scheduled scan failed'));
    }, config.rescanInterval * 1000);
    timer.unref();
  }

  const shutdown = async (signal) => {
    app.log.info(`${signal} received, shutting down`);
    try {
      await app.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
