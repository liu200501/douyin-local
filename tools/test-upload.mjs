// 模拟浏览器上传：用 undici 的 FormData 发送 UTF-8 文件名，
// 验证服务端 multipart 解析是否会把手写的中文文件名解成乱码。
//
// 注意：文件名写死在脚本里，不要从命令行传入中文参数 —— Windows 下
// PowerShell 会按 ANSI 代码页传参，导致还没到服务端就已经乱码。
//
// 用法：node tools/test-upload.mjs <源视频路径（建议纯 ASCII）> [baseUrl]
import fs from 'node:fs';

const TARGET_NAME = '上传测试片段【中文】.mp4';

const src = process.argv[2];
const base = process.argv[3] || 'http://127.0.0.1:6699';

if (!src || !fs.existsSync(src)) {
  console.error(`源文件不存在: ${src}`);
  process.exit(1);
}

const buf = fs.readFileSync(src);
const form = new FormData();
form.append('files', new Blob([buf], { type: 'video/mp4' }), TARGET_NAME);

const res = await fetch(`${base}/api/upload`, { method: 'POST', body: form });
const body = await res.json();

console.log('sent filename :', JSON.stringify(TARGET_NAME));
console.log('status        :', res.status);
console.log('saved as      :', JSON.stringify(body.saved?.map((s) => s.name) ?? null));
console.log('name match    :', body.saved?.[0]?.name === TARGET_NAME);
console.log('skipped       :', JSON.stringify(body.skipped ?? null));
console.log('indexed ids   :', JSON.stringify(body.indexed ?? null));

const list = await (await fetch(`${base}/api/videos?limit=100`)).json();
const match = list.items.find((v) => v.id === body.indexed?.[0]) ?? list.items[0];
console.log('indexed title :', JSON.stringify(match?.title ?? null));
console.log('indexed rel   :', JSON.stringify(match?.relPath ?? null));
