# douyin-local

把**你自己 NAS 里的短视频**用抖音的方式刷起来：竖屏全屏上下无限滑动、进入即自动播放、双击点赞；
换到电脑打开自动变成封面墙，支持合集、标签、搜索、收藏、观看历史、上传和回收站。

**不抓取、不依赖任何在线接口**，片源 100% 来自你挂载的本地目录。没有风控、没有失效的第三方解析、没有版权风险。

> 灵感来自 [zyronon/douyin](https://github.com/zyronon/douyin) 的移动端交互。
> 那个项目是纯前端演示，片源写死在构建产物里；本项目把它补成了一个真正能用自己片源的后端服务。

---

## 目录

- [功能](#功能)
- [和参考项目的区别](#和参考项目的区别)
- [格式兼容策略](#格式兼容策略)
- [快速开始](#快速开始)
- [本机直接运行（不用 Docker）](#本机直接运行不用-docker)
- [飞牛 fnOS 应用包](#飞牛-fnos-应用包)
- [配置项](#配置项)
- [目录结构](#目录结构)
- [HTTP 接口](#http-接口)
- [常见问题](#常见问题)

---

## 功能

| 模块 | 说明 |
| --- | --- |
| 竖屏播放 | 全屏上下滑动、触摸/滚轮/方向键三种操作、进入可视区自动播放、只渲染当前 ±1 个视频 |
| 桌面网格 | 封面墙 + 排序（最新/最早/名称/时长/体积/随机）+ 兼容性筛选 |
| 合集 | 按视频目录下的一级子文件夹自动归集，带封面和总时长 |
| 搜索与标签 | 按文件名、相对路径、合集名搜索；可给视频打自定义标签并按标签筛选 |
| 收藏 / 喜欢 / 历史 | 断点续播，进度每 5 秒上报一次，网格卡片上显示进度条 |
| 封面自动生成 | 扫描时用 ffmpeg 抽帧，不用手工准备海报 |
| 换封装 | mkv / avi / flv / ts 等浏览器不认的容器，后台自动 `-c copy` 重封装成 mp4 并缓存 |
| 上传与下载 | 网页拖拽上传、原片直下 |
| 回收站 | 「删除」是把文件移到 `data/trash`，不是 `unlink`，可以手动恢复 |
| 硬件加速 | 自动探测 `/dev/dri`，支持 VAAPI/QSV，可关闭 |

## 和参考项目的区别

| | zyronon/douyin | douyin-local |
| --- | --- | --- |
| 定位 | 移动端交互演示 | 自托管播放器 |
| 片源 | 打包进镜像的静态文件 | 你挂载的本地目录 |
| 后端 | 无（`axios-mock-adapter` 拦接口返 JSON） | Node 22 + Fastify + SQLite |
| 容器 | nginx 托管静态站点 | 单容器：Node 服务 + 内置 ffmpeg |
| 片源替换 | 要改代码重新构建 | 挂个目录就行 |

---

## 格式兼容策略

这是本项目最需要先讲清楚的一点。**默认流水线只做换封装，不做视频转码**，所以 CPU 占用极低。

| 你的文件 | 浏览器能直接播吗 | 本项目的处理 |
| --- | --- | --- |
| mp4 / m4v / mov（H.264） | ✅ | 原片通过 HTTP Range 直推，零成本 |
| webm / ogv（VP8/VP9/AV1） | ✅ | 原片直推 |
| mkv / avi / flv / ts / m2ts / wmv | ❌ 容器不支持 | **后台 `ffmpeg -c copy` 换封装成 mp4**，存进缓存目录，之后可拖动、可缓存 |
| mp4 + H.265/HEVC | ⚠️ 看设备 | 原片直推，前端打 `HEVC` 标记并提示；不做转码 |
| 其它编码（如 ProRes） | ❌ | 尝试换封装；失败则标记为「无法解析」并列在媒体管理页 |

关于「换封装」的两个实现细节：

1. **必须落盘缓存，不能实时管道输出。** MP4 的 `moov` 索引需要放在文件头（`+faststart`），
   边转边播的输出流没有索引，进度条会完全无法拖动。所以第一次播放会短暂等待，之后就是秒开。
2. **优先纯流复制，失败才转音频。** 先试 `-c:v copy -c:a copy`；如果音轨是 MP4 装不下的编码，
   再退一步只把音频转成 AAC（`-c:v copy -c:a aac`）。视频流始终不重编码。

`HEVC` 只在 iOS/Safari 和支持 HEVC 硬解的 Windows Chrome 上能播，安卓多数浏览器会黑屏。
需要安卓也能看的话，把 `HWACCEL` 打开并自行扩展转码逻辑——代码里的 `server/src/ffmpeg.js`
已经预留了硬件加速探测和转码入口。

---

## 快速开始

### 1. 准备目录

```
/your/videos/          <- 你的短视频目录
  ├── 旅行/            <- 一级子目录 = 一个「合集」
  │   ├── a.mp4
  │   └── b.mkv
  └── 随手拍/
      └── c.mov
```

> 视频目录在 compose 里是**可写**挂载：网页上传要写进来，删除是把文件移到 `data/trash`
> （`rename` 需要源目录的写权限）。如果你只打算在网页端浏览、不碰上传和删除，
> 可以把 volume 改回 `:/media/videos:ro`，更安全。

### 2. 用预构建镜像启动（推荐）

```bash
cd douyin-local
cp .env.example .env
# 改 .env 里的 IMAGE 和 VIDEO_HOST_DIR
docker compose pull
docker compose up -d
```

打开 `http://<NAS_IP>:6688`。

### 3. 或者本地构建

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

### 4. Intel 核显（可选）

```bash
docker compose -f docker-compose.yml -f docker-compose.hwaccel.yml up -d
```

### 5. 不用 compose 的单行命令

```bash
docker run -d \
  --name douyin-local \
  --restart unless-stopped \
  -p 6688:6688 \
  -v /your/videos:/media/videos \
  -v /your/douyin-data:/data \
  -e VIDEO_DIRS=/media/videos \
  -e JOB_CONCURRENCY=2 \
  -e TZ=Asia/Shanghai \
  ghcr.io/gaoyubao0917/douyin-local:latest
```

首次启动会自动扫描。如果视频目录挂错了，容器日志里会有明确的 `WARNING: video directory ... does not exist`。

---

## 本机直接运行（不用 Docker）

想在 Windows / macOS 开发机上先看效果，或者手边没有 Docker，可以跳过容器直接用 Node 跑。

**Windows**：双击项目根目录的 `start.bat`
**macOS / Linux**：`./start.sh`

等价于：

```bash
node tools/dev.mjs
```

启动器会自动处理：首次运行生成 `.env.local` → 缺依赖就装 → 缺前端产物就构建 → 启动服务并打印地址。

```
  douyin-local 本机模式 · Node v22.22.2

  ✓ 前端产物  web\dist
  ✓ 后端依赖  server\node_modules
  ✓ 视频目录  C:\...\douyin-local\videos  (3 个视频)
  ✓ 数据目录  C:\...\douyin-local\data

  本机访问  http://127.0.0.1:6688
  局域网    http://192.168.0.24:6688

  Ctrl+C 停止服务
```

| 参数 | 作用 |
| --- | --- |
| `--rebuild` | 强制重新构建前端（改过 `web/src` 之后用） |
| `--reinstall` | 强制重装后端依赖 |
| `--port 8080` | 临时换端口，不改配置文件 |
| `--no-scan` | 启动时跳过扫描 |

前提只有两条：**Node 20+** 和 **ffmpeg / ffprobe** 在 PATH 里（`ffmpeg -version` 能跑通即可，用来抽封面和换封装）。

视频目录改 `.env.local` 里的 `VIDEO_DIRS`，默认是项目下的 `videos/`：

```ini
VIDEO_DIRS=D:\视频
DATA_DIR=C:\douyin-data
PORT=6688
```

> 本机模式是**前台进程**，窗口关掉服务就停了，适合开发和试看。
> 要长期挂着（开机自启、手机随时刷）请用上面的 Docker 方式。

---

## 飞牛 fnOS 应用包

`fnos/douyin-local/` 是一个符合飞牛开放平台规范的 Docker 类应用工程：

```
fnos/douyin-local/
├── manifest                      # 应用元数据，service_port=6688，platform=x86
├── app/
│   ├── docker/docker-compose.yaml  # 应用中心直接执行的编排文件
│   └── ui/config                   # 桌面入口，type=iframe
├── cmd/                            # 生命周期脚本（fnpack 要求 9 个齐全）
│   ├── main                        # status 检查容器运行状态
│   ├── install_init / install_callback      # 安装前建目录、安装后检查目录是否存在
│   ├── upgrade_init / upgrade_callback      # 升级前提示数据保留、升级后提示拉新镜像
│   ├── uninstall_init / uninstall_callback  # 卸载前列出不会删的数据、卸载后提示清镜像
│   └── config_init / config_callback        # 改目录前校验绝对路径、改完提示重扫
├── config/
│   ├── privilege                   # run-as=package
│   └── resource                    # 声明 docker-project
├── wizard/
│   ├── install                     # 安装时填视频目录
│   └── config                      # 之后在「应用设置」里改
├── ICON.PNG / ICON_256.PNG
└── LICENSE
```

打包步骤：

1. 执行 `node tools/build-fpk.mjs`（Windows / macOS / Linux 都可以）。
   脚本会自动下载对应平台的 `fnpack` 到 `tools/bin/`、校验必须文件、补齐图标，然后打包。
   Linux 上也可以用等价的老脚本 `./tools/build-fpk.sh`。
2. 产物是 `fnos/douyin-local.fpk`。
3. 在飞牛「应用中心 → 手动安装」上传该文件。

脚本在打包前后会做几项飞牛特有的校验，都是踩过坑才加的：

| 检查 | 不加会怎样 |
| --- | --- |
| `cmd/` 下 9 个生命周期脚本齐全 | fnpack 直接拒绝打包（`Required file "cmd/install_init" is missing`） |
| `manifest.desktop_applaunchname` 在 `app/ui/config` 里有对应入口、端口三处一致 | 桌面图标点了打不开，或指向错误端口 |
| compose 的 `container_name` 与 `cmd/main` 里查的名字一致 | 应用中心永远显示「未运行」 |
| 镜像地址无 `YOUR_GITHUB_NAME` 占位符 | 装上去 pull 失败（加 `--keep-going` 可强行打包） |
| 打完包把 `cmd/*` 补成 `0755` | Windows 上 fnpack 只写 `0666`，到飞牛上脚本可能无法执行 |
| `manifest` 的 `checksum` 等于 `md5(app.tgz)` | fnpack 安装时会按这个字段校验，对不上会被拒收 |

安装后**应用中心不会替你拉镜像**，它只会照 `app/docker/docker-compose.yaml` 里的
`ghcr.io/gaoyubao0917/douyin-local:latest` 去 pull。所以要先让镜像存在：

```bash
git push        # GitHub Actions 会自动构建并推送到 GHCR（见 .github/workflows/build.yml）
```

镜像推上去之前想先在飞牛上试，把 `fnos/douyin-local/app/docker/docker-compose.yaml`
的 `image:` 换成你自己 `docker build` 出来的 tag，或者改用根目录的 `docker-compose.yml` 部署。

**为什么视频目录用向导字段而不是系统授权目录？**
飞牛的 `TRIM_DATA_ACCESSIBLE_PATHS` 是冒号分隔的**多路径**变量，没法直接作为一个 volume 挂载点。
所以这里用 `wizard_video_dir` 文本字段（安装时填、之后在「应用设置」里随时改），
compose 里以 `${wizard_video_dir:-/vol1/1000/videos}` 引用，缺省也能降级到默认值。

---

## 配置项

全部通过环境变量控制，`docker-compose.yml` 里都有默认值。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `6688` | 容器内监听端口 |
| `DATA_DIR` | `/data` | SQLite、封面、缓存、回收站的根目录 |
| `CACHE_DIR` | `/data/cache` | 封面 `poster/` 与换封装产物 `remux/` |
| `VIDEO_DIRS` | `/media/videos` | 扫描根目录，多个用 `,` 或 `;` 分隔 |
| `VIDEO_EXTS` | 见 compose | 参与索引的扩展名白名单 |
| `UPLOAD_DIR` | 空 | 网页上传的落盘目录，空则用第一个视频目录 |
| `JOB_CONCURRENCY` | `2` | 并发 ffmpeg 任务数，低功耗 NAS 建议 `1` |
| `FFMPEG_THREADS` | `1` | 单个 ffmpeg 进程的线程数 |
| `HWACCEL` | `auto` | `auto` / `vaapi` / `off` |
| `SCAN_ON_START` | `true` | 启动后自动增量扫描 |
| `RESCAN_INTERVAL` | `0` | 定时增量扫描间隔（秒），`0` 关闭 |
| `LOG_LEVEL` | `info` | pino 日志级别 |
| `TZ` | `Asia/Shanghai` | 时区，影响日志时间 |

---

## 目录结构

```
douyin-local/
├── server/                      # Node 22 + Fastify 后端
│   └── src/
│       ├── index.js             # 服务入口、静态资源、SPA 回退
│       ├── config.js            # 环境变量解析
│       ├── db.js                # SQLite schema + settings 读写
│       ├── scanner.js           # 递归扫描、增量索引、封面/换封装调度
│       ├── ffmpeg.js            # ffprobe 探测、抽帧、换封装、硬解探测
│       ├── queue.js             # 并发受限 + 按 key 去重的任务队列
│       └── routes/
│           ├── videos.js        # 列表、详情、播放协商、Range 流式、封面、下载、合集、标签
│           ├── user.js          # 收藏、喜欢、播放进度、历史、标签写入、同合集推荐
│           └── admin.js         # 系统信息、扫描、目录配置、上传、回收站
├── web/                         # Vue3 + Vite5 + Pinia + TypeScript
│   └── src/
│       ├── views/FeedView.vue   # 竖屏无限滑动播放器（手势/滚轮/键盘、预加载、进度上报）
│       ├── views/WatchView.vue  # 桌面单视频页 + 同合集推荐
│       ├── views/*.vue          # 网格、合集、搜索、收藏、历史、媒体管理、设置
│       ├── components/VideoGrid.vue
│       └── stores/              # library / player
├── docker/entrypoint.sh         # 启动自检（目录是否存在、有无 /dev/dri）
├── fnos/douyin-local/           # 飞牛 fpk 应用包工程
├── start.bat / start.sh         # 本机直跑入口（Windows / Linux-macOS）
├── tools/dev.mjs                # 本机启动器：自动装依赖、构建前端、打印访问地址
├── tools/make-icons.py          # 生成应用图标（纯标准库，无 Pillow 依赖）
├── tools/build-fpk.sh           # 打包 .fpk
├── tools/test-upload.mjs        # multipart 上传冒烟测试（含中文文件名）
├── .github/workflows/build.yml  # CI：校验 → 镜像冒烟 → 构建推送 GHCR
├── Dockerfile                   # 三阶段构建
└── docker-compose*.yml
```

---

## HTTP 接口

服务同时托管前端静态资源，所以只有一个端口。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/health` | 健康检查 |
| `GET` | `/api/system/info` | 版本、目录可达性、任务队列、扫描状态、统计 |
| `POST` | `/api/system/scan` | 触发扫描，`{ full: true }` 为全量重扫 |
| `PUT` | `/api/system/dirs` | 修改视频目录 |
| `GET` | `/api/videos` | 列表，支持 `q` `collection` `tag` `compat` `sort` `limit` `offset` |
| `GET` | `/api/videos/:id/play` | 播放协商，返回 `ready` / `preparing` / `unsupported` |
| `GET` | `/api/stream/:id` | 实际字节流，支持 `Range` |
| `GET` | `/api/poster/:id` | 封面 jpg |
| `GET` | `/api/download/:id` | 原片下载（RFC 5987 中文文件名） |
| `GET` | `/api/collections` · `/api/tags` | 合集与标签聚合 |
| `POST` | `/api/videos/:id/favorite` · `/like` · `/progress` | 收藏 / 喜欢 / 进度上报 |
| `PUT` | `/api/videos/:id/tags` | 覆盖标签集合 |
| `POST` | `/api/upload` | multipart 上传，落盘后立即索引 |
| `DELETE` | `/api/videos/:id?confirm=1` | 移到回收站（必须带 `confirm=1`） |

`/api/stream/:id` 的实现要点：只接受单段 `bytes=start-end`（含后缀范围 `bytes=-N`），
非法范围返回 `416` 并带 `Content-Range: bytes */size`，这是 Safari 正常拖动进度条的前提。

---

## 常见问题

**本机启动报 `ffmpeg/ffprobe not found`**
服务会照常起来，但抽封面和换封装会被禁用（日志里有一条 warn）。把 ffmpeg 加进 PATH 后重启即可：
Windows `winget install Gyan.FFmpeg`，macOS `brew install ffmpeg`，Debian/Ubuntu `apt install ffmpeg`。

**本机跑起来了，但手机打不开**
看启动横幅里打印的 `局域网 http://192.168.x.x:6688`，用这个地址。打不开多半是防火墙拦了
Node 的入站连接（Windows 首次运行时会弹网络授权，选「专用网络」）。另外 `HOST` 要是 `0.0.0.0`，
如果被改成 `127.0.0.1` 就只有本机能访问。

**上传或删除报「目录不可写」**
视频目录被挂成了只读（compose 里 volume 末尾带 `:ro`）。去掉 `:ro` 再 `docker compose up -d` 重建容器。
如果确实想让视频库保持只读，可以在设置页把「上传目录」指到另一个可写目录，但**删除功能会不可用**——
删除是把文件 `rename` 进 `data/trash`，需要源目录的写权限。

**扫不到视频 / 列表是空的**
先去「媒体管理」看视频目录是否显示「不可访问」。容器里看到的是 `VIDEO_DIRS` 指定的路径，
宿主机目录必须先在 compose 里挂进来。`docker compose logs` 里会有明确的缺失目录告警。

**mkv 第一次播放要等几秒**
正在换封装。一个 5 分钟的视频通常 1~3 秒完成。完成后写入 `data/cache/remux/`，之后秒开。
进度可以在竖屏播放页和媒体管理页看到。

**进度条拖不动**
说明播的是还没换封装完的原始文件。等换封装完成，或去视频详情页点「重新换封装」。

**HEVC 视频在安卓上黑屏**
这是编码层面的限制，不是 bug。默认不转码，前端会给出提示。

**NAS 风扇狂转**
把 `JOB_CONCURRENCY` 降到 `1`，`FFMPEG_THREADS` 保持 `1`，并把 `RESCAN_INTERVAL` 设为 `0`。

**能暴露到公网吗**
默认没有任何鉴权，**不要直接映射到公网**。放内网、走 tailscale/WireGuard，或在前面套一层带
Basic Auth 的反向代理。

**升级镜像后数据还在吗**
在。`./data` 是宿主机目录，存着 SQLite（索引、收藏、历史、标签）、封面和换封装缓存。
备份就是拷这个目录，或者只拷 `library.db`。

---

## 许可

MIT。仅供个人在自己的设备上播放自有视频使用。
