<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '@/api';
import { useLibraryStore } from '@/stores/library';
import { usePlayerStore } from '@/stores/player';

const library = useLibraryStore();
const player = usePlayerStore();

const dirs = ref<string[]>([]);
const newDir = ref('');
const candidates = ref<{ dir: string; exists: boolean }[]>([]);
const mountHint = ref('');
const saving = ref(false);
const message = ref('');
const scanAfterSave = ref(true);

const info = computed(() => library.info);

const reachability = computed(() => {
  const map = new Map<string, { exists: boolean; writable: boolean }>();
  info.value?.videoDirsReachable.forEach((item) => map.set(item.dir, item));
  return map;
});

watch(
  () => info.value?.videoDirs,
  (value) => {
    if (value && value.length) dirs.value = [...value];
  },
  { immediate: true }
);

function addDir(value?: string) {
  const trimmed = (value ?? newDir.value).trim();
  if (!trimmed || dirs.value.includes(trimmed)) return;
  dirs.value = [...dirs.value, trimmed];
  newDir.value = '';
}

function removeDir(dir: string) {
  dirs.value = dirs.value.filter((item) => item !== dir);
}

async function save() {
  saving.value = true;
  message.value = '';
  try {
    const result = await api.setDirs(dirs.value);
    dirs.value = result.dirs;
    message.value = result.warning ?? '已保存';
    await library.loadSystem();
    if (scanAfterSave.value) {
      await api.scan(false);
      message.value = `${message.value} · 已触发扫描`;
    }
  } catch (error) {
    message.value = (error as Error).message;
  } finally {
    saving.value = false;
  }
}

async function detect() {
  const result = await api.detectDirs();
  candidates.value = result.candidates;
  mountHint.value = result.mountHint;
}

async function savePreferences() {
  await api.saveSettings({ defaultView: player.mode });
  message.value = '偏好已保存';
}

onMounted(async () => {
  await library.loadSystem();
  await detect();
});
</script>

<template>
  <div>
    <div class="panel">
      <div class="panel__title">视频目录</div>
      <div class="alert">
        这里填写的是 <strong>容器内</strong> 的路径。宿主机目录需要先在
        <code>docker-compose.yml</code> 里挂载进来，例如
        <code>- /vol1/1000/videos:/media/videos</code>。保存后会立即开始扫描。
        <br />
        注意不要挂成只读（<code>:ro</code>）——网页上传和删除都需要目录可写。
      </div>

      <div class="list" style="margin-top: 14px">
        <div v-for="dir in dirs" :key="dir" class="input-row" style="justify-content: space-between">
          <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap">{{ dir }}</span>
          <span style="display: flex; gap: 8px; align-items: center">
            <span v-if="!reachability.get(dir)?.exists" class="chip chip--bad">不可访问</span>
            <span v-else-if="reachability.get(dir)?.writable" class="chip chip--ok">可访问 · 可写</span>
            <span
              v-else
              class="chip chip--warn"
              title="只读挂载：网页上传和删除会失败，去掉 compose 里该 volume 末尾的 :ro 即可"
            >
              可访问 · 只读
            </span>
            <button class="icon-btn" title="移除" @click="removeDir(dir)">✕</button>
          </span>
        </div>
        <div v-if="dirs.length === 0" class="alert alert--warn">还没有配置任何目录，播放器将是空的。</div>
      </div>

      <div class="input-row" style="margin-top: 14px">
        <input v-model="newDir" placeholder="/media/videos" style="flex: 1; min-width: 200px" @keyup.enter="addDir()" />
        <button class="btn btn--sm" @click="addDir()">添加</button>
        <button class="btn btn--sm btn--primary" :disabled="saving" @click="save">保存并扫描</button>
      </div>

      <div class="input-row" style="margin-top: 10px">
        <label style="display: flex; gap: 6px; align-items: center; font-size: 13px; color: var(--text-muted)">
          <input v-model="scanAfterSave" type="checkbox" style="width: auto" />
          保存后自动扫描
        </label>
        <span v-if="message" class="chip">{{ message }}</span>
      </div>
    </div>

    <div class="panel">
      <div class="panel__title">探测到的候选目录</div>
      <div class="alert">{{ mountHint }}</div>
      <div class="input-row" style="margin-top: 12px; gap: 6px">
        <button
          v-for="candidate in candidates"
          :key="candidate.dir"
          class="chip"
          :class="candidate.exists ? 'chip--ok' : ''"
          :disabled="!candidate.exists"
          @click="addDir(candidate.dir)"
        >
          {{ candidate.dir }}{{ candidate.exists ? '' : '（不存在）' }}
        </button>
      </div>
    </div>

    <div class="panel">
      <div class="panel__title">播放偏好</div>
      <div class="input-row">
        <select v-model="player.mode" style="min-width: 160px" @change="player.persist()">
          <option value="auto">自动（窄屏用竖屏）</option>
          <option value="feed">始终竖屏播放</option>
          <option value="grid">始终桌面网格</option>
        </select>
        <label style="display: flex; gap: 6px; align-items: center; font-size: 13px; color: var(--text-muted)">
          <input v-model="player.muted" type="checkbox" style="width: auto" @change="player.persist()" />
          默认静音
        </label>
        <button class="btn btn--sm" @click="savePreferences">保存偏好</button>
      </div>
    </div>

    <div v-if="info" class="panel">
      <div class="panel__title">运行环境</div>
      <div class="list" style="font-size: 13px; color: var(--text-muted)">
        <div class="input-row" style="justify-content: space-between">
          <span>版本</span><span>{{ info.version }}</span>
        </div>
        <div class="input-row" style="justify-content: space-between">
          <span>数据目录</span><span><code>{{ info.dataDir }}</code></span>
        </div>
        <div class="input-row" style="justify-content: space-between">
          <span>转封装缓存</span><span><code>{{ info.cacheDir }}/remux</code></span>
        </div>
        <div class="input-row" style="justify-content: space-between">
          <span>硬件加速</span>
          <span>
            {{ info.hwaccel.vendor }}
            <span class="chip" :class="info.hwaccel.available ? 'chip--ok' : ''">{{ info.hwaccel.detail }}</span>
          </span>
        </div>
        <div class="input-row" style="justify-content: space-between">
          <span>并发任务</span><span>{{ info.jobs.active }} 运行 / {{ info.jobs.pending }} 排队</span>
        </div>
        <div class="input-row" style="justify-content: space-between">
          <span>识别扩展名</span><span>{{ info.supportedExts.join(', ') }}</span>
        </div>
        <div class="input-row" style="justify-content: space-between">
          <span>原生容器</span><span>{{ info.nativeContainers.join(', ') }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
code {
  background: var(--surface-hover);
  padding: 1px 6px;
  border-radius: 5px;
  font-size: 12px;
}
</style>
