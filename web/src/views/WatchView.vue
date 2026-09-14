<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, downloadUrl, posterUrl } from '@/api';
import { useLibraryStore } from '@/stores/library';
import { usePlayerStore } from '@/stores/player';
import type { PlayInfo, Video } from '@/types';
import { compatLabel, formatBytes, formatDuration } from '@/utils';

const route = useRoute();
const router = useRouter();
const library = useLibraryStore();
const player = usePlayerStore();

const video = ref<Video | null>(null);
const play = ref<PlayInfo | null>(null);
const related = ref<Video[]>([]);
const videoEl = ref<HTMLVideoElement | null>(null);
const loading = ref(true);
const errorText = ref('');
const currentTime = ref(0);
const duration = ref(0);
const paused = ref(false);
const tagInput = ref('');

const id = computed(() => Number.parseInt(String(route.params.id), 10));
const progress = computed(() => (duration.value > 0 ? (currentTime.value / duration.value) * 100 : 0));

let pollTimer: number | undefined;
let lastReport = 0;

async function resolvePlay() {
  if (!video.value) return;
  play.value = await api.play(video.value.id);
  if (play.value.status === 'preparing') {
    pollTimer = window.setTimeout(() => {
      resolvePlay();
      lastReport = Number.MAX_SAFE_INTEGER;
    }, 2500);
  } else {
    await nextTick();
    if (play.value.status === 'ready' && videoEl.value && !paused.value) {
      videoEl.value.muted = player.effectiveMuted;
      videoEl.value.play().catch(() => {
        paused.value = true;
      });
    }
  }
}

async function load() {
  loading.value = true;
  errorText.value = '';
  paused.value = false;
  try {
    const [detail, rel] = await Promise.all([api.video(id.value), api.related(id.value)]);
    video.value = detail;
    related.value = rel.items;
    tagInput.value = detail.tags.join(', ');
    await resolvePlay();
  } catch (error) {
    errorText.value = (error as Error).message;
  } finally {
    loading.value = false;
  }
}

function onTimeUpdate() {
  const el = videoEl.value;
  if (!el) return;
  currentTime.value = el.currentTime;
  duration.value = el.duration || 0;
  const now = Date.now();
  if (now - lastReport > 5000 && video.value) {
    lastReport = now;
    api
      .progress(video.value.id, { position: el.currentTime, duration: el.duration })
      .catch(() => {});
  }
}

function onLoadedMetadata() {
  const el = videoEl.value;
  if (!el || !video.value) return;
  duration.value = el.duration || 0;
  const resume = video.value.position || 0;
  if (resume > 3 && (!el.duration || resume < el.duration - 5)) el.currentTime = resume;
}

function togglePlay() {
  if (!videoEl.value) return;
  player.unlock();
  paused.value = !paused.value;
  if (paused.value) videoEl.value.pause();
  else videoEl.value.play().catch(() => {});
}

function toggleMute() {
  player.unlock();
  player.setMuted(!player.muted);
  if (videoEl.value) videoEl.value.muted = player.muted;
}

async function saveTags() {
  if (!video.value) return;
  const tags = tagInput.value
    .split(/[,，\s]+/)
    .map((tag) => tag.trim())
    .filter(Boolean);
  const result = await api.setTags(video.value.id, tags);
  video.value.tags = result.tags;
  await library.refreshMetadata();
}

async function forceRemux() {
  if (!video.value) return;
  const updated = await api.remux(video.value.id);
  video.value = updated;
  await resolvePlay();
}

async function removeVideo() {
  if (!video.value) return;
  const ok = window.confirm(
    `确认从库中移除「${video.value.title}」？\n文件会被移动到 data/trash 目录，不会直接删除，可以手动恢复。`
  );
  if (!ok) return;
  await api.remove(video.value.id);
  router.push('/grid');
}

async function like() {
  if (!video.value) return;
  await library.toggleLike(video.value);
  video.value.liked = !video.value.liked;
}

async function favorite() {
  if (!video.value) return;
  await library.toggleFavorite(video.value);
  video.value.favorite = !video.value.favorite;
}

function onKey(event: KeyboardEvent) {
  const tag = (event.target as HTMLElement)?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (event.key === ' ') {
    event.preventDefault();
    togglePlay();
  }
  if (event.key === 'm') toggleMute();
  if (event.key === 'f') favorite();
  if (event.key === 'Escape') router.back();
}

watch(id, load);

onMounted(() => {
  load();
  window.addEventListener('keydown', onKey);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
  if (pollTimer) window.clearTimeout(pollTimer);
  if (video.value && videoEl.value) {
    api
      .progress(video.value.id, {
        position: videoEl.value.currentTime,
        duration: videoEl.value.duration,
      })
      .catch(() => {});
  }
});
</script>

<template>
  <div class="watch">
    <header class="watch__bar">
      <button class="feed__glass" @click="router.back()">←</button>
      <div class="watch__title">{{ video?.title ?? '播放' }}</div>
      <div style="flex: 1"></div>
      <button class="feed__glass" @click="toggleMute">{{ player.muted ? '🔇' : '🔊' }}</button>
      <router-link class="btn btn--sm" to="/feed">竖屏模式</router-link>
    </header>

    <div class="watch__body">
      <section class="watch__stage">
        <div v-if="loading" class="empty"><span class="spinner" style="margin: 0 auto"></span></div>

        <div v-else-if="errorText" class="empty alert alert--bad">{{ errorText }}</div>

        <template v-else-if="video">
          <div class="watch__player">
            <img
              v-if="video.hasPoster && play?.status !== 'ready'"
              class="watch__poster"
              :src="posterUrl(video.id)"
              alt=""
            />
            <video
              v-if="play?.status === 'ready'"
              ref="videoEl"
              class="watch__video"
              :src="play.url ?? undefined"
              :poster="video.hasPoster ? posterUrl(video.id) : undefined"
              playsinline
              :muted="player.effectiveMuted"
              @timeupdate="onTimeUpdate"
              @loadedmetadata="onLoadedMetadata"
              @click="togglePlay"
              @ended="paused = true"
            ></video>

            <div v-else-if="play?.status === 'preparing'" class="watch__overlay">
              <span class="spinner" style="width: 24px; height: 24px"></span>
              <div>正在换封装（{{ video.ext }} → mp4），完成后自动播放</div>
              <div class="progress-line">{{ video.compatReason }}</div>
            </div>

            <div v-else-if="play && play.status !== 'ready'" class="watch__overlay">
              <div>{{ play.reason || '无法播放' }}</div>
            </div>

            <div v-if="paused && play?.status === 'ready'" class="watch__bigplay" @click="togglePlay">▶</div>
          </div>

          <div class="watch__controls">
            <span class="progress-line">{{ formatDuration(currentTime) }}</span>
            <div class="bar" style="flex: 1">
              <span :style="{ width: `${progress}%` }"></span>
            </div>
            <span class="progress-line">{{ formatDuration(duration || video.duration) }}</span>
          </div>

          <div class="input-row" style="margin-top: 12px">
            <button class="btn btn--sm" @click="like">{{ video.liked ? '❤️ 已喜欢' : '🤍 喜欢' }}</button>
            <button class="btn btn--sm" @click="favorite">
              {{ video.favorite ? '★ 已收藏' : '☆ 收藏' }}
            </button>
            <a class="btn btn--sm" :href="downloadUrl(video.id)">⇩ 下载原片</a>
            <button v-if="video.compat === 'remux'" class="btn btn--sm" @click="forceRemux">重新换封装</button>
            <button class="btn btn--sm btn--danger" @click="removeVideo">移至回收站</button>
          </div>

          <div class="panel" style="margin-top: 16px">
            <div class="panel__title">详细信息</div>
            <div class="watch__facts">
              <div><span>合集</span>{{ video.collection || '未分类' }}</div>
              <div><span>文件</span>{{ video.relPath }}</div>
              <div><span>规格</span>{{ video.width }}×{{ video.height }} · {{ formatBytes(video.size) }}</div>
              <div><span>编码</span>{{ video.videoCodec || '—' }} / {{ video.audioCodec || '—' }}（{{ video.container }}）</div>
              <div>
                <span>兼容性</span>
                {{ compatLabel(video.compat).text }}
                <template v-if="video.compatReason">— {{ video.compatReason }}</template>
              </div>
              <div><span>播放次数</span>{{ video.playCount }}</div>
            </div>

            <div class="input-row" style="margin-top: 12px">
              <input v-model="tagInput" placeholder="用逗号分隔标签，例如：风景, 旅行" style="flex: 1" />
              <button class="btn btn--sm btn--primary" @click="saveTags">保存标签</button>
            </div>
          </div>
        </template>
      </section>

      <aside class="watch__side">
        <div class="panel__title">同合集推荐</div>
        <div class="watch__related">
          <router-link
            v-for="item in related"
            :key="item.id"
            class="watch__related-item"
            :to="`/watch/${item.id}`"
          >
            <div class="watch__related-thumb">
              <img v-if="item.hasPoster" :src="posterUrl(item.id)" alt="" loading="lazy" />
              <span class="card__duration">{{ formatDuration(item.duration) }}</span>
            </div>
            <div class="watch__related-info">
              <div class="card__title">{{ item.title }}</div>
              <div class="card__meta">{{ item.collection }}</div>
            </div>
          </router-link>
        </div>
        <div v-if="related.length === 0" class="alert" style="margin-top: 8px">这个合集里还没有其他视频。</div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.watch {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg);
  overflow: hidden;
}

.watch__bar {
  height: 56px;
  flex: 0 0 56px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-elevated);
}

.watch__title {
  font-weight: 650;
  font-size: 15px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 46vw;
}

.watch__body {
  flex: 1;
  display: flex;
  gap: 20px;
  padding: 20px;
  overflow: hidden;
}

.watch__stage {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding-right: 4px;
}

.watch__player {
  position: relative;
  background: #000;
  border-radius: var(--radius-lg);
  overflow: hidden;
  display: grid;
  place-items: center;
  min-height: 320px;
  max-height: 62vh;
}

.watch__video,
.watch__poster {
  width: 100%;
  max-height: 62vh;
  object-fit: contain;
  display: block;
}

.watch__poster {
  opacity: 0.55;
}

.watch__overlay {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  gap: 10px;
  align-content: center;
  color: var(--text-muted);
  background: rgba(0, 0, 0, 0.55);
  font-size: 13px;
  text-align: center;
  padding: 20px;
}

.watch__bigplay {
  position: absolute;
  width: 68px;
  height: 68px;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.55);
  display: grid;
  place-items: center;
  font-size: 26px;
  cursor: pointer;
  color: #fff;
}

.watch__controls {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 12px;
}

.watch__facts {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 8px 20px;
  font-size: 13px;
  color: var(--text-muted);
}

.watch__facts span {
  display: inline-block;
  min-width: 68px;
  color: var(--text-dim);
}

.watch__side {
  width: 320px;
  flex: 0 0 320px;
  overflow-y: auto;
  border-left: 1px solid var(--border);
  padding-left: 18px;
}

.watch__related {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.watch__related-item {
  display: flex;
  gap: 10px;
  padding: 6px;
  border-radius: var(--radius-sm);
  transition: background 0.14s ease;
}

.watch__related-item:hover {
  background: var(--surface);
}

.watch__related-thumb {
  position: relative;
  width: 66px;
  height: 66px;
  flex: 0 0 66px;
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--surface);
}

.watch__related-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.watch__related-info {
  min-width: 0;
  flex: 1;
}

@media (max-width: 980px) {
  .watch__body {
    flex-direction: column;
    padding: 14px;
  }

  .watch__side {
    width: auto;
    flex: 0 0 auto;
    border-left: none;
    border-top: 1px solid var(--border);
    padding-left: 0;
    padding-top: 14px;
  }
}
</style>
