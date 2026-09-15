#!/usr/bin/env node
/**
 * 跨平台 fpk 打包脚本（Windows / macOS / Linux 通用）。
 *
 * 做四件事：
 *   1. 找不到 fnpack 就按当前平台下载官方二进制到 tools/bin/
 *   2. 打包前置校验（必须文件缺失、镜像地址还是占位符 → 直接失败）
 *   3. 补齐图标、给 cmd/* 可执行权限
 *   4. fnpack build，把产物收敛到 fnos/douyin-local.fpk
 *
 * 用法：
 *   node tools/build-fpk.mjs
 *   node tools/build-fpk.mjs --keep-going   # 占位符只警告不中断
 */

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const FNPACK_VERSION = '1.2.3'
const PLACEHOLDER = 'YOUR_GITHUB_NAME'
const KEEP_GOING = process.argv.includes('--keep-going')

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const APP_NAME = 'douyin-local'
const APP_DIR = path.join(ROOT, 'fnos', APP_NAME)
const OUT = path.join(ROOT, 'fnos', `${APP_NAME}.fpk`)
const BIN_DIR = path.join(ROOT, 'tools', 'bin')

// fnpack 要求 cmd/ 下的生命周期脚本齐全，缺一个就直接拒绝打包
const LIFECYCLE = [
  'main',
  'install_init',
  'install_callback',
  'upgrade_init',
  'upgrade_callback',
  'uninstall_init',
  'uninstall_callback',
  'config_init',
  'config_callback',
]

const log = (msg) => console.log(msg)
const fail = (msg) => {
  console.error(`错误：${msg}`)
  process.exit(1)
}

// --------------------------------------------------------------- fnpack 准备

function fnpackDownloadUrl() {
  const { platform, arch } = process
  const archName = arch === 'arm64' ? 'arm64' : 'amd64'
  if (platform === 'win32') {
    if (archName !== 'amd64') fail(`fnpack 官方没有 Windows ${arch} 版本`)
    return `https://static2.fnnas.com/fnpack/fnpack-${FNPACK_VERSION}-windows-amd64`
  }
  if (platform === 'darwin') return `https://static2.fnnas.com/fnpack/fnpack-${FNPACK_VERSION}-darwin-${archName}`
  if (platform === 'linux') return `https://static2.fnnas.com/fnpack/fnpack-${FNPACK_VERSION}-linux-${archName}`
  fail(`不支持的平台：${platform}`)
}

async function download(url, dest) {
  log(`==> 下载 fnpack ${FNPACK_VERSION} → ${path.relative(ROOT, dest)}`)
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) fail(`下载失败 ${res.status} ${res.statusText}：${url}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length < 1024 * 100) fail(`下载内容只有 ${buf.length} 字节，不像是二进制`)
  writeFileSync(dest, buf)
  if (process.platform !== 'win32') chmodSync(dest, 0o755)
}

async function ensureFnpack() {
  // 1) PATH 里已有就用系统的（飞牛设备、CI 上常见）
  const probe = spawnSync('fnpack', ['--help'], { encoding: 'utf8', shell: process.platform === 'win32' })
  if (probe.status === 0) {
    log('==> 使用 PATH 中的 fnpack')
    return 'fnpack'
  }

  // 2) 本地缓存
  const exe = path.join(BIN_DIR, process.platform === 'win32' ? 'fnpack.exe' : 'fnpack')
  if (!existsSync(exe)) {
    mkdirSync(BIN_DIR, { recursive: true })
    await download(fnpackDownloadUrl(), exe)
  } else {
    log(`==> 使用已缓存的 ${path.relative(ROOT, exe)}`)
  }

  const check = spawnSync(exe, ['--help'], { encoding: 'utf8' })
  if (check.status !== 0) {
    fail(`fnpack 无法执行：${check.error?.message ?? check.stderr ?? `exit ${check.status}`}`)
  }
  return exe
}

// ------------------------------------------------------------------ 前置校验

const REQUIRED = [
  'manifest',
  'config/privilege',
  'config/resource',
  'ICON.PNG',
  'ICON_256.PNG',
  'app/docker/docker-compose.yaml',
  'app/ui/config',
  ...LIFECYCLE.map((f) => `cmd/${f}`),
]

function checkRequired() {
  log('==> 校验必须存在的文件')
  const missing = REQUIRED.filter((rel) => !existsSync(path.join(APP_DIR, rel)))
  if (missing.length) {
    fail(`缺少文件：\n      - ${missing.join('\n      - ')}`)
  }
}

function checkJson(rel) {
  const file = path.join(APP_DIR, rel)
  try {
    JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    fail(`${rel} 不是合法 JSON：${err.message}`)
  }
}

/**
 * 生命周期脚本必须是 LF + 正确的 shebang。
 *
 * 这两个错误在 Windows 上完全看不出来，到飞牛上就是全体脚本 `bad interpreter`
 * 或权限拒绝。Git 的 autocrlf 会把工作区文件转成 CRLF，所以在打包前拦一道。
 */
function checkScriptHealth() {
  const badEol = []
  const badShebang = []
  for (const f of LIFECYCLE) {
    const file = path.join(APP_DIR, 'cmd', f)
    const buf = readFileSync(file)
    if (buf.includes(0x0d)) badEol.push(`cmd/${f}`)
    const firstLine = buf.toString('utf8').split('\n')[0]
    if (!/^#!\/bin\/(ba)?sh$/.test(firstLine)) badShebang.push(`cmd/${f} → ${JSON.stringify(firstLine)}`)
  }
  if (badEol.length) {
    fail(
      `以下脚本含 CRLF 换行，Linux 上会报 bad interpreter：\n      - ${badEol.join('\n      - ')}\n` +
        '      （检查 .gitattributes 里的 `* text=auto eol=lf`，或编辑器换行符设置）',
    )
  }
  if (badShebang.length) {
    fail(`以下脚本首行不是 #!/bin/bash：\n      - ${badShebang.join('\n      - ')}`)
  }
  log(`==> ${LIFECYCLE.length} 个生命周期脚本均为 LF + 正确 shebang`)
}

function checkManifest() {
  const raw = readFileSync(path.join(APP_DIR, 'manifest'), 'utf8')
  const get = (key) => raw.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1]?.trim()
  const must = ['appname', 'version', 'display_name', 'platform', 'desktop_applaunchname', 'service_port']
  const absent = must.filter((k) => !get(k))
  if (absent.length) fail(`manifest 缺少字段：${absent.join(', ')}`)

  const ui = JSON.parse(readFileSync(path.join(APP_DIR, 'app/ui/config'), 'utf8'))
  const key = get('desktop_applaunchname')
  if (!ui['.url']?.[key]) {
    fail(`manifest.desktop_applaunchname=${key} 在 app/ui/config 里没有对应入口`)
  }
  const port = String(ui['.url'][key].port)
  if (port !== get('service_port')) {
    fail(`端口不一致：manifest.service_port=${get('service_port')}，app/ui/config.port=${port}`)
  }

  // compose 里的 container_name 必须和 cmd/main 查的名字一致，否则状态永远查不到
  const compose = readFileSync(path.join(APP_DIR, 'app/docker/docker-compose.yaml'), 'utf8')
  const containerName = compose.match(/container_name:\s*(\S+)/)?.[1]
  const cmdMain = readFileSync(path.join(APP_DIR, 'cmd/main'), 'utf8')
  if (containerName && !cmdMain.includes(containerName)) {
    fail(`cmd/main 里查的容器名和 compose 的 container_name(${containerName}) 对不上`)
  }
  log(`==> manifest 自检通过（${get('appname')} ${get('version')} / ${get('platform')} / 端口 ${port}）`)
}

function checkPlaceholders() {
  const files = [
    'fnos/douyin-local/manifest',
    'fnos/douyin-local/app/docker/docker-compose.yaml',
    'Dockerfile',
    'docker-compose.yml',
    '.env.example',
  ]
  const pending = files.filter((rel) => {
    const abs = path.join(ROOT, rel)
    return existsSync(abs) && readFileSync(abs, 'utf8').includes(PLACEHOLDER)
  })
  if (!pending.length) {
    log('==> 镜像地址已填好，无占位符')
    return
  }
  const msg = `以下文件仍有 ${PLACEHOLDER}：\n      - ${pending.join('\n      - ')}`
  if (KEEP_GOING) {
    console.warn(`警告：${msg}\n      装上去会拉不到镜像（--keep-going：继续打包）`)
  } else {
    fail(`${msg}\n      替换成真实镜像地址后重试，或加 --keep-going 强行打包。`)
  }
}

function ensureIcons() {
  for (const rel of ['ICON.PNG', 'ICON_256.PNG']) {
    if (existsSync(path.join(APP_DIR, rel))) return
  }
  log('==> 图标缺失，尝试生成')
  const script = path.join(ROOT, 'tools', 'make-icons.py')
  const py = ['python3', 'python'].find(
    (bin) => spawnSync(bin, ['--version'], { encoding: 'utf8' }).status === 0,
  )
  if (!py) {
    fail('图标缺失且找不到 python，无法生成（或手动放入 ICON.PNG / ICON_256.PNG）')
  }
  const res = spawnSync(py, [script], { encoding: 'utf8', cwd: ROOT })
  if (res.status !== 0) fail(`生成图标失败：${res.stderr || res.stdout}`)
}

// ------------------------------------------------------- 修正 cmd/* 可执行位
//
// Windows 上给不了文件 Unix 可执行位，于是 fnpack 打出来的 tar 里 cmd/* 全是 0666。
// 官方在 Linux/macOS 上打包时是 0755，我们在这里把 tar 头里的权限位补回来，
// 否则飞牛可能直接 exec 这些脚本时报 Permission denied（或状态永远显示未运行）。
//
// .fpk 就是 gzip(tar)，改动只发生在 512 字节头的 mode 字段与校验和里，
// 归档长度、文件内容、内层 app.tgz 全部原样不动。

const OCT = (s) => s.replace(/\0.*$/, '').trim()

/** 遍历 tar 的 512 字节头，回调里给出可改写的 header 视图与数据偏移 */
function walkTar(tar, onEntry) {
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((b) => b === 0)) break
    const name = OCT(header.subarray(0, 100).toString('utf8'))
    const prefix = OCT(header.subarray(345, 500).toString('utf8'))
    const size = parseInt(OCT(header.subarray(124, 136).toString('utf8')), 8) || 0
    const typeFlag = header[156] === 0 ? '0' : String.fromCharCode(header[156])
    onEntry({
      offset,
      name: prefix ? `${prefix}/${name}` : name,
      mode: OCT(header.subarray(100, 108).toString('utf8')),
      typeFlag,
      size,
    })
    offset += 512 + Math.ceil(size / 512) * 512
  }
}

/** 改写单个 tar 头的 mode 并重算 chksum（chksum 字段按规范先填空格再求和） */
function setMode(tar, offset, octal) {
  Buffer.from(octal.padStart(7, '0') + '\0', 'utf8').copy(tar, offset + 100, 0, 8)
  tar.fill(0x20, offset + 148, offset + 156)
  let sum = 0
  for (let i = 0; i < 512; i++) sum += tar[offset + i]
  Buffer.from(`${sum.toString(8).padStart(6, '0')}\0 `, 'utf8').copy(tar, offset + 148)
}

function patchCmdModes(fpkPath) {
  const tar = zlib.gunzipSync(readFileSync(fpkPath))
  let patched = 0
  walkTar(tar, (e) => {
    if (!e.name.startsWith('cmd/')) return
    if (e.typeFlag !== '0' && e.typeFlag !== '5') return
    if (e.mode === '0000755') return
    setMode(tar, e.offset, '755')
    patched++
  })
  if (patched) writeFileSync(fpkPath, zlib.gzipSync(tar))
  return patched
}

/** 打包后自检：文件齐全、cmd/* 可执行、内层 app.tgz 还能正常解开 */
function verifyFpk(fpkPath) {
  const tar = zlib.gunzipSync(readFileSync(fpkPath))
  const entries = []
  walkTar(tar, (e) => entries.push(e))
  const byName = new Map(entries.map((e) => [e.name, e]))

  const needed = [
    'manifest',
    'config/privilege',
    'config/resource',
    'ICON.PNG',
    'ICON_256.PNG',
    'LICENSE',
    'app.tgz',
    ...LIFECYCLE.map((f) => `cmd/${f}`),
  ]
  const absent = needed.filter((n) => !byName.has(n))
  if (absent.length) fail(`产物里缺少：${absent.join(', ')}`)

  const notExec = LIFECYCLE.map((f) => `cmd/${f}`).filter(
    (n) => byName.get(n).mode !== '0000755',
  )
  if (notExec.length) fail(`产物里这些脚本没有可执行位：${notExec.join(', ')}`)

  const appTgz = byName.get('app.tgz')
  const inner = zlib.gunzipSync(
    tar.subarray(appTgz.offset + 512, appTgz.offset + 512 + appTgz.size),
  )
  const innerEntries = []
  walkTar(inner, (e) => innerEntries.push(e))
  const innerNames = innerEntries.map((e) => e.name)
  const innerByName = new Map(innerEntries.map((e) => [e.name, e]))
  if (!innerByName.has('docker/docker-compose.yaml')) {
    fail('app.tgz 里没有 docker/docker-compose.yaml，应用中心会无编排文件可用')
  }

  // 向导里的「镜像地址」默认值必须和 compose 的兜底值一致。不一致时，安装向导显示的
  // 是一个地址、用户清空后实际用的是另一个地址，出问题极难排查（本机拉不动 = 装不上）。
  const readInner = (n) => {
    const e = innerByName.get(n)
    return e ? inner.subarray(e.offset + 512, e.offset + 512 + e.size).toString('utf8') : null
  }
  const composeDefault = readInner('docker/docker-compose.yaml').match(
    /\$\{wizard_image:-([^}]+)\}/,
  )?.[1]
  for (const w of ['wizard/install', 'wizard/config']) {
    const e = byName.get(w)
    if (!e) continue // 向导文件缺失由 fnpack 自己兜着
    let parsed
    try {
      parsed = JSON.parse(tar.subarray(e.offset + 512, e.offset + 512 + e.size).toString('utf8'))
    } catch (err) {
      fail(`${w} 不是合法 JSON：${err.message}`)
    }
    const field = (parsed?.[0]?.items || []).find((i) => i.field === 'wizard_image')
    if (!field) {
      fail(`${w} 里没有 wizard_image 字段，用户在安装向导里将无法改镜像地址`)
    } else if (composeDefault && field.initValue !== composeDefault) {
      fail(
        `${w} 的 wizard_image 默认值(${field.initValue}) 与 compose 的兜底值` +
          `(${composeDefault}) 不一致，安装向导显示的地址会和实际拉取的不一样`,
      )
    }
  }

  // fnpack 会把 md5(app.tgz) 写进 manifest 的 checksum 字段，飞牛安装时按它校验。
  // 上面刚改写的是 app.tgz 之外的 tar 头，这个不变量必须仍然成立。
  const manifestEntry = byName.get('manifest')
  const manifestText = tar
    .subarray(manifestEntry.offset + 512, manifestEntry.offset + 512 + manifestEntry.size)
    .toString('utf8')
  const declaredSum = manifestText.match(/^checksum\s*=\s*(\w+)/m)?.[1]
  if (declaredSum) {
    const actual = createHash('md5')
      .update(tar.subarray(appTgz.offset + 512, appTgz.offset + 512 + appTgz.size))
      .digest('hex')
    if (actual !== declaredSum) {
      fail(
        `manifest 的 checksum 与实际 md5(app.tgz) 不一致（${declaredSum} vs ${actual}），` +
          '打包过程动了 app.tgz 的内容，飞牛会拒收。',
      )
    }
  }

  log(
    `==> 产物自检通过（${entries.length} 个条目，cmd/* 均为 0755，` +
      `app.tgz 含 ${innerNames.length} 项，checksum ${declaredSum ? '一致' : '未声明'}）`,
  )
}

// ------------------------------------------------------------------- 主流程

async function main() {
  if (!existsSync(APP_DIR)) fail(`找不到应用工程目录：${APP_DIR}`)

  checkRequired()
  checkJson('config/privilege')
  checkJson('config/resource')
  checkJson('app/ui/config')
  checkManifest()
  checkScriptHealth()
  checkPlaceholders()
  ensureIcons()

  // 设置可执行位。POSIX 上直接 chmod；Windows 上没有这个概念，
  // 由 fnpack 自己按脚本内容打 0755（下面 buildTar 之后会复查一遍）。
  if (process.platform !== 'win32') {
    for (const f of LIFECYCLE) {
      const p = path.join(APP_DIR, 'cmd', f)
      if (existsSync(p)) chmodSync(p, 0o755)
    }
  }

  rmSync(OUT, { force: true })

  const fnpack = await ensureFnpack()
  log('==> fnpack build')
  const res = spawnSync(fnpack, ['build', '--directory', APP_DIR], {
    encoding: 'utf8',
    cwd: ROOT,
  })
  process.stdout.write(res.stdout ?? '')
  process.stderr.write(res.stderr ?? '')
  if (res.status !== 0) fail(`fnpack build 失败（exit ${res.status}）`)

  // fnpack 的产物位置在不同版本/平台上不完全一致，三个候选都找一遍
  const candidates = [
    path.join(APP_DIR, `${APP_NAME}.fpk`),
    path.join(APP_DIR, 'build', `${APP_NAME}.fpk`),
    path.join(process.cwd(), `${APP_NAME}.fpk`),
  ]
  const built = candidates.find((p) => existsSync(p))
  if (!built) fail(`fnpack 退出码为 0 但没找到 .fpk 产物（找过：${candidates.join(', ')}）`)
  if (built !== OUT) {
    copyFileSync(built, OUT)
    rmSync(built, { force: true })
  }

  const fixed = patchCmdModes(OUT)
  if (fixed) log(`==> 补正 ${fixed} 个 cmd/* 的可执行位（Windows 打包时 fnpack 只写 0666）`)
  verifyFpk(OUT)

  const size = statSync(OUT).size
  log(`==> 打包完成：${path.relative(ROOT, OUT)}  (${(size / 1024 / 1024).toFixed(2)} MB)`)
  log('    在飞牛「应用中心 → 手动安装」上传即可。')
}

main().catch((err) => fail(err.stack ?? String(err)))
