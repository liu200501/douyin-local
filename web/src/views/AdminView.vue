<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api } from '@/api';
import { useLibraryStore } from '@/stores/library';
import type { Video } from '@/types';
import { formatBytes, formatDuration } from '@/utils';

const library = useLibraryStore();

const files = ref<File[]>([]);
const uploading = ref(false);
const uploadPercent = ref(0);
const uploadResult = ref<{ saved: { name: string }[]; skipped: { name: string; reason: string }[] } | null>(null);
const dragActive = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);
const broken = ref<Video[]>([]);
const trash = ref<{ name: string; size: number; mtime: number }[]>([]);
const message = ref('');

const info = computed(() => library.info);
const scan = computed(() => info.value?.scan);
const scanning = computed(() => Boolean(scan.value?.running));
const scanPercent = computed(() => {
  if (!scan.value?.total) return 0;
  return Math.min(Math.round((scan.value.scanned / scan.value.total) * 100), 100);
});

async function refresh() {
  await library.loadSystem();
  const [brokenPage, trashPage] = await Promise.all([
    api.videos({ compat: 'broken', limit: 50 }),
    api.trash(),
  ]);
  broken.value = brokenPage.items;
  trash.value = trashPage.items;
}

async function startScan(full: boolean) {
  message.value = '';
  await api.scan(full);
  await refresh();
  message.value = full ? '已启动全量扫描（会重新探测已索引的文件）' : '已启动增量扫描';
}

function pickFiles(list: FileList | null) {
  if (!list) return;
  files.value = [...files.value, ...Array.from(list)];
}

function onDrop(event: DragEvent) {
  dragActive.value = false;
  pickFiles(event.dataTransfer?.files ?? null);
}

async function doUpload() {
  if (files.value.length === 0) return;
  uploading.value = true;
  uploadPercent.value = 0;
  uploadResult.value = null;
  message.value = '';
  try {
    uploadResult.value = await api.upload(files.value, (percent) => {
      uploadPercent.value = percent;
    });
    files.value = [];
    await refresh();
  } catch (error) {
    message.value = (error as Error).message;
  } finally {
    uploading.value = false;
  }
}

const totalUploadSize = computed(() => files.value.reduce((sum, file) => sum + file.size, 0));

onMounted(refresh);
</script>

<template>
  <div>
    <div class="panel">
      <div class="panel__title">
        媒体库状态
        <span v-if="scanning" class="chip chip--warn">
          <span class="spinner" style="width: 12px; height: 12px"></span>
          {{ scan?.phase }} {{ scan?.scanned }}/{{ scan?.total }}
        </span>
      </div>

      <div v-if="info" class="stat-row">
        <div class="stat"><div class="stat__value">{{ info.stats.total }}</div><div class="stat__label">视频总数</div></div>
        <div class="stat"><div class="stat__value">{{ formatBytes(info.stats.bytes) }}</div><div class="stat__label">占用空间</div></div>
        <div class="stat"><div class="stat__value">{{ formatDuration(info.stats.seconds) }}</div><div class="stat__label">总时长</div></div>
        <div class="stat"><div class="stat__value">{{ info.stats.collections }}</div><div class="stat__label">合集</div></div>
        <div class="stat"><div class="stat__value">{{ info.stats.pendingRemux }}</div><div class="stat__label">待换封装</div></div>
        <div class="stat"><div class="stat__value">{{ info.stats.hevc }}</div><div class="stat__label">HEVC</div></div>
        <div class="stat"><div class="stat__value">{{ info.stats.broken }}</div><div class="stat__label">无法解析</div></div>
        <div class="stat"><div class="stat__value">{{ info.jobs.active }}/{{ info.jobs.pending }}</div><div class="stat__label">任务 运行/排队</div></div>
      </div>

      <div v-if="scanning" class="bar" style="margin-top: 14px">
        <span :style="{ width: `${scanPercent}%` }"></span>
      </div>

      <div class="input-row" style="margin-top: 14px">
        <button class="btn btn--primary btn--sm" :disabled="scanning" @click="startScan(false)">增量扫描</button>
        <button class="btn btn--sm" :disabled="scanning" @click="startScan(true)">全量重扫</button>
        <button class="btn btn--sm" @click="refresh">刷新状态</button>
        <span v-if="message" class="chip">{{ message }}</span>
      </div>

      <div v-if="scan?.error" class="alert alert--bad" style="margin-top: 12px">{{ scan.error }}</div>
    </div>

    <div class="panel">
      <div class="panel__title">上传视频</div>
      <div
        class="dropzone"
        :class="{ 'is-active': dragActive }"
        @dragover.prevent="dragActive = true"
        @dragleave.self="dragActive = false"
        @drop.prevent="onDrop"
        @click="fileInput?.click()"
      >
        <div>把视频拖到这里，或点击选择文件</div>
        <div class="stat__label" style="margin-top: 6px">
          会被复制到 <code>{{ info?.settings?.uploadDir || info?.videoDirs?.[0] || '首个视频目录' }}</code>
        </div>
        <input
          ref="fileInput"
          type="file"
          accept="video/*"
          multiple
          style="display: none"
          @change="pickFiles(($event.target as HTMLInputElement).files)"
        />
      </div>

      <div v-if="files.length" class="list" style="margin-top: 12px">
        <div v-for="(file, i) in files" :key="i" class="input-row" style="justify-content: space-between">
          <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap">{{ file.name }}</span>
          <span class="chip">{{ formatBytes(file.size) }}</span>
        </div>
        <div class="input-row" style="margin-top: 6px">
          <button class="btn btn--primary btn--sm" :disabled="uploading" @click="doUpload">
            {{ uploading ? `上传中 ${uploadPercent}%` : `开始上传 ${files.length} 个文件` }}
          </button>
          <button class="btn btn--sm" :disabled="uploading" @click="files = []">清空</button>
          <span class="chip">共 {{ formatBytes(totalUploadSize) }}</span>
        </div>
        <div v-if="uploading" class="bar"><span :style="{ width: `${uploadPercent}%` }"></span></div>
      </div>

      <div v-if="uploadResult" class="alert" style="margin-top: 12px">
        上传完成：成功 {{ uploadResult.saved.length }} 个<template v-if="uploadResult.skipped.length">，跳过
          {{ uploadResult.skipped.length }} 个（{{ uploadResult.skipped.map((s) => `${s.name}: ${s.reason}`).join('；') }}）</template>
      </div>
    </div>

    <div class="panel">
      <div class="panel__title">无法解析的文件（{{ broken.length }}）</div>
      <div v-if="broken.length === 0" class="alert">没有无法解析的文件。</div>
      <div v-else class="list">
        <div v-for="item in broken" :key="item.id" class="input-row" style="justify-content: space-between">
          <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap">{{ item.relPath }}</span>
          <span class="chip chip--bad">{{ formatBytes(item.size) }}</span>
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="panel__title">回收站（{{ trash.length }}）</div>
      <div class="alert">
        从库里移除的文件会被移动到这里，而不是直接删除。目录：<code>{{ info?.dataDir }}/trash</code>。
        确认无误后请到文件管理器里自行清理。
      </div>
      <div v-if="trash.length" class="list" style="margin-top: 12px">
        <div v-for="item in trash" :key="item.name" class="input-row" style="justify-content: space-between">
          <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap">{{ item.name }}</span>
          <span class="chip">{{ formatBytes(item.size) }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dropzone {
  border: 1.5px dashed var(--border-strong);
  border-radius: var(--radius);
  padding: 32px 20px;
  text-align: center;
  color: var(--text-muted);
  cursor: pointer;
  transition: border-color 0.16s ease, background 0.16s ease;
}

.dropzone:hover,
.dropzone.is-active {
  border-color: var(--accent);
  background: var(--accent-soft);
}

code {
  background: var(--surface-hover);
  padding: 1px 6px;
  border-radius: 5px;
  font-size: 12px;
}
</style>
