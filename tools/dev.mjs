#!/usr/bin/env node
/**
 * douyin-local 本机启动器（不需要 Docker / WSL）
 *
 * 做四件事：
 *   1. 读取配置；.env.local 不存在时自动生成一份带注释的默认配置
 *   2. 缺 node_modules 就装依赖，缺 web/dist 就构建前端
 *   3. 以前台进程启动 Fastify 服务（日志直接打在控制台）
 *   4. 打印本机与局域网访问地址
 *
 * 用法：
 *   node tools/dev.mjs                 常规启动
 *   node tools/dev.mjs --rebuild       强制重新构建前端
 *   node tools/dev.mjs --reinstall     强制重装后端依赖
 *   node tools/dev.mjs --port 8080     临时覆盖端口（不改配置文件）
 *   node tools/dev.mjs --no-scan       启动时不扫描
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const IS_WIN = process.platform === 'win32';
const ENV_FILE = path.join(ROOT, '.env.local');
const SERVER_DIR = path.join(ROOT, 'server');
const WEB_DIR = path.join(ROOT, 'web');

const argv = process.argv.slice(2);
const hasFlag = (name) => argv.includes(`--${name}`);
const flagValue = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};

/* ------------------------------------------------------------------ 输出 */

const color = (code) => (s) => (process.stdout.isTTY ? `\u001b[${code}m${s}\u001b[0m` : String(s));
const dim = color('2');
const bold = color('1');
const green = color('32');
const yellow = color('33');
const red = color('31');

const step = (msg) => console.log(`${dim('·')} ${msg}`);
const ok = (msg) => console.log(`  ${green('✓')} ${msg}`);
const warn = (msg) => console.log(`  ${yellow('!')} ${msg}`);
const bad = (msg) => console.log(`  ${red('×')} ${msg}`);

function fail(msg, hint) {
  console.log('');
  bad(msg);
  if (hint) console.log(dim(`    ${hint}`));
  console.log('');
  process.exit(1);
}

/* ------------------------------------------------------------- 配置文件 */

const DEFAULT_ENV = `# douyin-local 本机直跑配置（不用 Docker）
# 改完重新运行 start 脚本生效。这个文件不会被提交到 git。

# 视频库目录。多个目录用英文逗号分隔。
# 想用已有目录就直接改成绝对路径，例如：
#   VIDEO_DIRS=D:\\视频
VIDEO_DIRS=${path.join(ROOT, 'videos')}

# 数据目录：数据库、封面缓存、换封装缓存、回收站都在这里
DATA_DIR=${path.join(ROOT, 'data')}

# 网页上传的落盘目录。留空 = 使用第一个视频目录
UPLOAD_DIR=

# 访问端口
PORT=6688
HOST=0.0.0.0

# 同时运行的 ffmpeg 任务数（封面抽帧 / 换封装）。老爷机填 1
JOB_CONCURRENCY=2
FFMPEG_THREADS=1

# 启动时自动扫描
SCAN_ON_START=true

# debug | info | warn | error
LOG_LEVEL=info
`;

function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

let env = {};
let envCreated = false;

if (!fs.existsSync(ENV_FILE)) {
  fs.writeFileSync(ENV_FILE, DEFAULT_ENV, 'utf8');
  envCreated = true;
}
env = parseEnvFile(fs.readFileSync(ENV_FILE, 'utf8'));

const port = flagValue('port') || env.PORT || '6688';

const runtime = {
  ...process.env,
  ...env,
  PORT: String(port),
  HOST: env.HOST || '0.0.0.0',
  // 兜底：用户删掉 .env.local 里的路径时不要落到容器默认的 /data
  DATA_DIR: env.DATA_DIR || path.join(ROOT, 'data'),
  WEB_DIR: path.join(WEB_DIR, 'dist'),
  SCAN_ON_START: hasFlag('no-scan') ? 'false' : env.SCAN_ON_START || 'true',
};

if (envCreated) {
  step(`已生成配置文件 .env.local`);
}

/* --------------------------------------------------------- 依赖与构建 */

function nodeBin(name) {
  // 优先用当前 node 安装目录里的同族工具，避免 PATH 里混进别的版本
  const dir = path.dirname(process.execPath);
  const candidates = IS_WIN
    ? [path.join(dir, `${name}.cmd`), path.join(dir, `${name}.exe`)]
    : [path.join(dir, name), path.join(dir, '..', 'bin', name)];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return name;
}

/**
 * 用当前 node 自带的 npm-cli.js 直接调用，绕开 Windows 上 `npm` 是 .cmd
 * 需要 shell 才能执行的问题。
 */
function runNpm(args, cwd) {
  const npmCli = path.join(
    path.dirname(process.execPath),
    'node_modules',
    'npm',
    'bin',
    'npm-cli.js'
  );
  const useCli = fs.existsSync(npmCli);
  const res = spawnSync(
    useCli ? process.execPath : nodeBin('npm'),
    useCli ? [npmCli, ...args] : args,
    {
      cwd,
      stdio: 'inherit',
      // 只有回退到系统 npm 时才需要 shell（.cmd 包装脚本）
      shell: !useCli && IS_WIN,
      env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false' },
    }
  );
  return res.status === 0;
}

function npmRun(script, cwd, label) {
  step(`${label}…`);
  if (!runNpm(['run', script], cwd)) fail(`${label} 失败，请查看上面的输出`);
}

function npmInstall(cwd) {
  step('安装依赖（首次运行需要一两分钟）…');
  if (!runNpm(['install', '--no-audit', '--no-fund'], cwd)) fail('依赖安装失败');
}

/* 后端依赖 */
const sqliteBinary = path.join(
  SERVER_DIR,
  'node_modules',
  'better-sqlite3',
  'build',
  'Release',
  'better_sqlite3.node'
);
if (hasFlag('reinstall') || !fs.existsSync(sqliteBinary)) {
  npmInstall(SERVER_DIR);
}

/* 前端依赖 + 构建产物 */
const webDist = path.join(WEB_DIR, 'dist', 'index.html');
const needWebInstall = !fs.existsSync(path.join(WEB_DIR, 'node_modules', 'vite'));
if (needWebInstall) npmInstall(WEB_DIR);
if (hasFlag('rebuild') || needWebInstall || !fs.existsSync(webDist)) {
  npmRun('build', WEB_DIR, '构建前端');
}

/* ------------------------------------------------------------ 目录准备 */

function splitList(value) {
  return String(value || '')
    .split(/[,;\n|]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const videoDirs = splitList(runtime.VIDEO_DIRS || runtime.TRIM_DATA_SHARE_PATHS);
if (videoDirs.length === 0) {
  videoDirs.push(path.join(ROOT, 'videos'));
  runtime.VIDEO_DIRS = videoDirs.join(',');
}

const videoExts = new Set(
  splitList(
    runtime.VIDEO_EXTS || 'mp4,m4v,mov,webm,ogv,mkv,avi,flv,ts,m2ts,wmv,mpg,mpeg,3gp'
  ).map((e) => e.replace(/^\./, '').toLowerCase())
);

function countVideos(dir, depth = 0) {
  let n = 0;
  if (depth > 3) return 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (e.isDirectory()) n += countVideos(path.join(dir, e.name), depth + 1);
    else if (videoExts.has(path.extname(e.name).slice(1).toLowerCase())) n += 1;
  }
  return n;
}

const dirStatus = [];
for (const dir of videoDirs) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    dirStatus.push({ dir, count: countVideos(dir), ok: true });
  } catch (error) {
    dirStatus.push({ dir, count: 0, ok: false, error: error.message });
  }
}

try {
  fs.mkdirSync(runtime.DATA_DIR, { recursive: true });
} catch {
  /* ensureRuntimeDirs 会再试一次并给出明确报错 */
}

/* --------------------------------------------------------------- 地址 */

function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal) out.push(item.address);
    }
  }
  return out;
}

/* --------------------------------------------------------------- 启动 */

console.log('');
console.log(bold('  douyin-local ') + dim(`本机模式 · Node ${process.version}`));
console.log('');

ok(`前端产物  ${path.relative(ROOT, path.join(WEB_DIR, 'dist'))}`);
ok(`后端依赖  ${path.relative(ROOT, path.join(SERVER_DIR, 'node_modules'))}`);
for (const item of dirStatus) {
  if (!item.ok) {
    bad(`视频目录  ${item.dir}  (${item.error})`);
  } else if (item.count === 0) {
    warn(`视频目录  ${item.dir}  (空目录)`);
  } else {
    ok(`视频目录  ${item.dir}  (${item.count} 个视频)`);
  }
}
ok(`数据目录  ${runtime.DATA_DIR}`);

const anyVideo = dirStatus.some((d) => d.count > 0);
if (!anyVideo) {
  console.log('');
  console.log(
    dim(`  提示：把视频放进上面的目录，或在 .env.local 里把 VIDEO_DIRS 改成你自己的路径。`)
  );
}

console.log('');
console.log(`  ${bold('本机访问')}  http://127.0.0.1:${port}`);
for (const ip of lanAddresses()) {
  console.log(`  ${bold('局域网')}    http://${ip}:${port}`);
}
console.log('');
console.log(dim('  Ctrl+C 停止服务'));
console.log('');

const child = spawn(process.execPath, [path.join(SERVER_DIR, 'src', 'index.js')], {
  cwd: SERVER_DIR,
  env: runtime,
  stdio: 'inherit',
});

const forward = (signal) => {
  if (!child.killed) child.kill(signal);
};
process.on('SIGINT', () => forward('SIGINT'));
process.on('SIGTERM', () => forward('SIGTERM'));

child.on('exit', (code, signal) => {
  if (signal && signal !== 'SIGINT' && signal !== 'SIGTERM') {
    bad(`服务被信号 ${signal} 终止`);
  }
  process.exit(code ?? (signal ? 1 : 0));
});

child.on('error', (error) => {
  fail(`无法启动服务：${error.message}`);
});
