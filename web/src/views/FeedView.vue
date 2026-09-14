<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { api, downloadUrl, posterUrl } from '@/api';
import { useLibraryStore } from '@/stores/library';
import { usePlayerStore } from '@/stores/player';
import type { Video } from '@/types';
import { compatLabel, formatDuration } from '@/utils';

interface PlayState {
  status: 'idle' | 'loading' | 'ready' | 'preparing' | 'unsupported' | 'missing' | 'error';
  url: string | null;
  reason: string;
  attempts: number;
}

const router = useRouter();
const library = useLibraryStore();
const player = usePlayerStore();

const items = ref<Video[]>([]);
const index = ref(0);
const loading = ref(false);
const finished = ref(false);
const errorText = ref('');

const dragOffset = ref(0);
const animating = ref(false);
const paused = ref(false);
const currentTime = ref(0);
const duration = ref(0);
const showHint = ref(true);
const heartVisible = ref(false);

const playStates = reactive<Record<number, PlayState>>({});
const videoRefs = new Map<number, HTMLVideoElement>();
const pollTimers = new Map<number, number>();
const wheelLock = { until: 0 };

const track = ref<HTMLElement | null>(null);
const activeVideo = computed(() => items.value[index.value] ?? null);

const trackStyle = computed(() => ({
  transform: `translate3d(0, calc(${-index.value * 100}% + ${dragOffset.value}px), 0)`,
}));

function stateOf(video: Video): PlayState {
  if (!playStates[video.id]) {
    playStates[video.id] = { status: 'idle', url: null, reason: '', attempts: 0 };
  }
  return playStates[video.id];
}

async function ensurePlayable(video: Video, { retry = true } = {}) {
  const state = stateOf(video);
  if (state.status === 'ready' || state.status === 'loading' || state.status === 'unsupported') return;

  state.status = 'loading';
  try {
    const info = await api.play(video.id);
    state.url = info.url;
    state.reason = info.reason ?? '';

    if (info.status === 'ready') {
      state.status = 'ready';
      if (pollTimers.has(video.id)) {
        window.clearTimeout(pollTimers.get(video.id));
        pollTimers.delete(video.id);
      }
      return;
    }

    if (info.status === 'preparing') {
      state.status = 'preparing';
      if (retry && state.attempts < 200) {
        state.attempts += 1;
        pollTimers.set(
          video.id,
          window.setTimeout(() => {
            state.status = 'idle';
            if (items.value[index.value]?.id === video.id) ensurePlayable(video);
          }, 2500)
        );
      }
      return;
    }

    state.status = info.status === 'missing' ? 'missing' : 'unsupported';
  } catch (error) {
    state.status = 'error';
    state.reason = (error as Error).message;
  }
}

function setVideoRef(id: number, el: unknown) {
  if (el instanceof HTMLVideoElement) videoRefs.set(id, el);
  else videoRefs.delete(id);
}

async function syncPlayback() {
  const active = activeVideo.value;
  for (const [id, el] of videoRefs.entries()) {
    if (!active || id !== active.id) {
      el.pause();
    }
  }
  if (!active) return;

  await ensurePlayable(active);
  const state = stateOf(active);
  if (state.status !== 'ready' || !state.url) {
    paused.value = true;
    currentTime.value = 0;
    duration.value = active.duration || 0;
    return;
  }

  await nextTick();
  const el = videoRefs.get(active.id);
  if (!el) return;
  el.muted = player.effectiveMuted;
  el.volume = player.volume;

  if (!paused.value) {
    try {
      await el.play();
    } catch {
      // Autoplay refused (unmuted before interaction) — retry muted.
      el.muted = true;
      await el.play().catch(() => {
        paused.value = true;
      });
    }
  }

  // Warm up the next slide so swiping feels instant.
  const next = items.value[index.value + 1];
  if (next) ensurePlayable(next);
  const half = items.value[index.value + 2];
  if (half) ensurePlayable(half);
}

function go(target: number, { animate = true } = {}) {
  const clamped = Math.min(Math.max(target, 0), items.value.length - 1);
  if (clamped === index.value) return;
  index.value = clamped;
  dragOffset.value = 0;
  if (animate) {
    animating.value = true;
    window.setTimeout(() => {
      animating.value = false;
    }, 360);
  }
  paused.value = false;
  currentTime.value = 0;
  duration.value = 0;
  maybeLoadMore();
}

function maybeLoadMore() {
  if (loading.value || finished.value) return;
  if (index.value >= items.value.length - 3) loadMore();
}

async function loadMore() {
  if (loading.value || finished.value) return;
  loading.value = true;
  try {
    const page = await api.videos({ sort: library.query.sort || 'newest', offset: items.value.length, limit: 24 });
    const known = new Set(items.value.map((item) => item.id));
    const fresh = page.items.filter((item) => !known.has(item.id) && item.compat !== 'broken');
    items.value = [...items.value, ...fresh];
    if (items.value.length >= page.total || fresh.length === 0) finished.value = true;
    if (items.value.length === 0) {
      errorText.value = '视频库是空的，先去「设置」添加目录并扫描。';
    }
  } catch (error) {
    errorText.value = (error as Error).message;
  } finally {
    loading.value = false;
  }
}

/* ---------------- progress reporting ---------------- */

let lastReport = 0;

function report(force = false, finishedFlag = false) {
  const video = activeVideo.value;
  if (!video) return;
  const now = Date.now();
  if (!force && now - lastReport < 5000) return;
  lastReport = now;
  api
    .progress(video.id, {
      position: finishedFlag ? 0 : currentTime.value,
      duration: duration.value || video.duration,
      finished: finishedFlag,
      countPlay: force && !finishedFlag,
    })
    .catch(() => {});
}

function onTimeUpdate(event: Event) {
  const el = event.target as HTMLVideoElement;
  currentTime.value = el.currentTime;
  duration.value = el.duration || 0;
  report();
}

function onEnded() {
  report(true, true);
  paused.value = true;
  if (index.value < items.value.length - 1) go(index.value + 1);
  else maybeLoadMore();
}

function onLoadedMetadata(event: Event) {
  const el = event.target as HTMLVideoElement;
  duration.value = el.duration || 0;
  const video = activeVideo.value;
  if (!video) return;
  const resume = video.position || 0;
  if (resume > 3 && (!el.duration || resume < el.duration - 5)) {
    el.currentTime = resume;
    currentTime.value = resume;
  }
}

function togglePlay() {
  const video = activeVideo.value;
  if (!video) return;
  const el = videoRefs.get(video.id);
  if (player.effectiveMuted) {
    player.unlock();
    if (el) el.muted = false;
    player.setMuted(false);
    el?.play().catch(() => {});
    return;
  }
  paused.value = !paused.value;
  if (!el) return;
  if (paused.value) el.pause();
  else el.play().catch(() => {});
}

function toggleMute() {
  player.unlock();
  player.setMuted(!player.muted);
  const video = activeVideo.value;
  if (video) {
    const el = videoRefs.get(video.id);
    if (el) el.muted = player.muted;
  }
}

async function like(withAnimation = false) {
  const video = activeVideo.value;
  if (!video) return;
  if (!video.liked) {
    await library.toggleLike(video);
    if (withAnimation) {
      heartVisible.value = true;
      window.setTimeout(() => {
        heartVisible.value = false;
      }, 880);
    }
  } else if (withAnimation) {
    heartVisible.value = true;
    window.setTimeout(() => {
      heartVisible.value = false;
    }, 880);
  }
}

async function favorite() {
  const video = activeVideo.value;
  if (video) await library.toggleFavorite(video);
}

/* ---------------- gestures ---------------- */

let touchStartY = 0;
let touchStartTime = 0;
let dragging = false;
let lastTap = 0;
let suppressClick = false;

function onTouchStart(event: TouchEvent) {
  touchStartY = event.touches[0].clientY;
  touchStartTime = Date.now();
  dragging = false;
  animating.value = false;
}

function onTouchMove(event: TouchEvent) {
  const delta = event.touches[0].clientY - touchStartY;
  if (Math.abs(delta) < 6 && !dragging) return;
  dragging = true;
  const atEdge =
    (index.value === 0 && delta > 0) || (index.value === items.value.length - 1 && delta < 0);
  dragOffset.value = atEdge ? delta * 0.28 : delta;
}

function onTouchEnd() {
  if (!dragging) {
    // A plain tap: let the browser's synthetic click drive handleTap().
    dragOffset.value = 0;
    return;
  }

  const threshold = (track.value?.clientHeight ?? 600) * 0.16;
  const elapsed = Date.now() - touchStartTime;
  const offset = dragOffset.value;
  const fast = elapsed < 220 && Math.abs(offset) > 40;

  dragOffset.value = 0;
  if (offset < -threshold || (fast && offset < 0)) go(index.value + 1);
  else if (offset > threshold || (fast && offset > 0)) go(index.value - 1);

  // A swipe still produces a click on some browsers; swallow the next one.
  suppressClick = true;
  window.setTimeout(() => {
    suppressClick = false;
  }, 420);
}

function onClick(event: MouseEvent) {
  if (suppressClick) return;
  if (nowUnder(event.target)) return;
  handleTap();
}

function handleTap() {
  const now = Date.now();
  if (now - lastTap < 280) {
    like(true);
    lastTap = 0;
    return;
  }
  lastTap = now;
  window.setTimeout(() => {
    if (lastTap === now) togglePlay();
  }, 290);
}

function onWheel(event: WheelEvent) {
  if (nowUnder(event.target)) return;
  const now = Date.now();
  if (now < wheelLock.until) return;
  const delta = event.deltaY;
  if (Math.abs(delta) < 12) return;
  wheelLock.until = now + 420;
  go(index.value + (delta > 0 ? 1 : -1));
}

function nowUnder(target: EventTarget | null) {
  return target instanceof HTMLElement && Boolean(target.closest('.feed__progress, .feed__actions'));
}

/* ---------------- keyboard ---------------- */

function onKey(event: KeyboardEvent) {
  const tag = (event.target as HTMLElement)?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  switch (event.key) {
    case 'ArrowDown':
    case 'j':
      event.preventDefault();
      go(index.value + 1);
      break;
    case 'ArrowUp':
    case 'k':
      event.preventDefault();
      go(index.value - 1);
      break;
    case ' ':
      event.preventDefault();
      togglePlay();
      break;
    case 'm':
      toggleMute();
      break;
    case 'f':
      favorite();
      break;
    case 'l':
      like(true);
      break;
    case 'Escape':
      router.push('/grid');
      break;
    default:
      break;
  }
}

/* ---------------- progress bar ---------------- */

const progressPercent = computed(() => (duration.value > 0 ? (currentTime.value / duration.value) * 100 : 0));

function onScrub(event: MouseEvent) {
  const video = activeVideo.value;
  if (!video) return;
  const el = videoRefs.get(video.id);
  if (!el || !duration.value) return;
  const rail = event.currentTarget as HTMLElement;
  const ratio = Math.min(Math.max((event.clientX - rail.getBoundingClientRect().left) / rail.clientWidth, 0), 1);
  el.currentTime = ratio * duration.value;
  currentTime.value = el.currentTime;
  report(true);
}

let scrubbing = false;

function startScrub(event: MouseEvent) {
  scrubbing = true;
  onScrub(event);
  const move = (moveEvent: MouseEvent) => {
    if (scrubbing) onScrub(moveEvent);
  };
  const up = () => {
    scrubbing = false;
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

/* ---------------- lifecycle ---------------- */

watch(index, () => {
  if (showHint.value) showHint.value = false;
  syncPlayback();
});

watch(
  () => player.muted,
  (muted) => {
    const video = activeVideo.value;
    if (!video) return;
    const el = videoRefs.get(video.id);
    if (el) el.muted = muted || !player.unlocked;
  }
);

onMounted(async () => {
  await loadMore();
  if (items.value.length > 0) syncPlayback();
  window.addEventListener('keydown', onKey);
  window.addEventListener('beforeunload', () => report(true));
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
  report(true);
  pollTimers.forEach((timer) => window.clearTimeout(timer));
  pollTimers.clear();
  videoRefs.forEach((el) => el.pause());
  videoRefs.clear();
});
</script>

<template>
  <div class="feed" @touchstart.passive="onTouchStart" @touchmove.passive="onTouchMove"
    @touchend="onTouchEnd" @wheel="onWheel" @click="onClick">
    <div ref="track" class="feed__track" :class="{ 'is-animated': animating }" :style="trackStyle">
      <section v-for="(video, i) in items" :key="video.id" class="feed__slide">
        <template v-if="Math.abs(i - index) <= 1">
          <img
            v-if="video.hasPoster && (i !== index || playStates[video.id]?.status !== 'ready')"
            class="feed__poster"
            :src="posterUrl(video.id)"
            alt=""
          />
          <video
            v-if="Math.abs(i - index) <= 1"
            :ref="(el) => setVideoRef(video.id, el)"
            class="feed__video"
            :src="playStates[video.id]?.status === 'ready' ? playStates[video.id].url ?? undefined : undefined"
            :poster="video.hasPoster ? posterUrl(video.id) : undefined"
            :preload="i === index ? 'auto' : 'metadata'"
            playsinline
            webkit-playsinline
            @timeupdate="i === index && onTimeUpdate($event)"
            @loadedmetadata="onLoadedMetadata"
            @ended="i === index && onEnded()"
          ></video>
        </template>

        <div v-if="i === index" class="feed__center">
          <div class="feed__play-icon" :class="{ 'is-visible': paused }">▶</div>
        </div>

        <div v-if="i === index && playStates[video.id] && playStates[video.id].status !== 'ready'" class="feed__center">
          <div class="alert alert--warn" style="max-width: 320px; text-align: center; pointer-events: none">
            <template v-if="playStates[video.id].status === 'preparing'">
              正在换封装（{{ video.ext }} → mp4）…完成后自动播放
            </template>
            <template v-else-if="playStates[video.id].status === 'loading'">加载中…</template>
            <template v-else-if="playStates[video.id].status === 'missing'">
              文件不存在或未正确挂载
            </template>
            <template v-else-if="playStates[video.id].status === 'unsupported'">
              无法播放：{{ playStates[video.id].reason || '不支持的编码' }}
            </template>
            <template v-else>{{ playStates[video.id].reason || '播放失败' }}</template>
          </div>
        </div>

        <div v-if="i === index && video.compat === 'hevc'" class="feed__hint" style="bottom: 152px">
          HEVC 编码：iOS/Safari 与部分 Windows 浏览器可播放，安卓可能黑屏
        </div>

        <div v-if="i === index && showHint" class="feed__hint">
          上下滑动切换 · 单击暂停 · 双击点赞 · 桌面滚轮/方向键同样有效
        </div>

        <div v-if="i === index" class="feed__overlay">
          <div class="heart-burst" :class="{ 'is-bursting': heartVisible }">❤️</div>
        </div>

        <div v-if="i === index" class="feed__topbar">
          <button class="feed__glass" title="返回网格" @click="router.push('/grid')">←</button>
          <div class="feed__topbar-title">{{ video.title }}</div>
          <button class="feed__glass" :title="player.muted ? '取消静音' : '静音'" @click="toggleMute">
            {{ player.muted ? '🔇' : '🔊' }}
          </button>
        </div>

        <div v-if="i === index" class="feed__meta">
          <div class="feed__author">{{ video.collection || '未分类' }}</div>
          <div class="feed__caption">{{ video.title }}</div>
          <div class="feed__tags">
            <span class="feed__tag">#{{ video.ext }}</span>
            <span class="feed__tag">#{{ compatLabel(video.compat).text }}</span>
            <span class="feed__tag">#{{ Math.round(video.height) }}p</span>
            <span v-for="tag in video.tags" :key="tag" class="feed__tag">#{{ tag }}</span>
          </div>
        </div>

        <div v-if="i === index" class="feed__actions">
          <button class="feed__action" @click="like(true)">
            <span class="feed__action-icon" :class="{ 'is-on': video.liked }">{{ video.liked ? '❤️' : '🤍' }}</span>
            <span>喜欢</span>
          </button>
          <button class="feed__action" @click="favorite">
            <span class="feed__action-icon" :class="{ 'is-on': video.favorite }">{{ video.favorite ? '★' : '☆' }}</span>
            <span>收藏</span>
          </button>
          <a class="feed__action" :href="downloadUrl(video.id)">
            <span class="feed__action-icon">⇩</span>
            <span>下载</span>
          </a>
          <button class="feed__action" @click="router.push({ name: 'watch', params: { id: video.id } })">
            <span class="feed__action-icon">⤢</span>
            <span>详情</span>
          </button>
        </div>

        <div v-if="i === index" class="feed__progress">
          <div class="feed__progress-rail" @mousedown.prevent="startScrub($event)">
            <div class="feed__progress-fill" :style="{ width: `${progressPercent}%` }"></div>
            <div class="feed__progress-knob" :style="{ left: `${progressPercent}%` }"></div>
          </div>
        </div>
      </section>
    </div>

    <div v-if="items.length === 0 && !loading && errorText" class="feed__center">
      <div class="alert" style="max-width: 340px; text-align: center">
        <div style="margin-bottom: 12px">{{ errorText }}</div>
        <button class="btn btn--primary btn--sm" @click="router.push('/settings')">去设置目录</button>
      </div>
    </div>

    <div v-if="loading && items.length === 0" class="feed__center">
      <span class="spinner" style="width: 26px; height: 26px"></span>
    </div>

    <div v-if="items.length > 0" class="feed__hint" style="bottom: 74px; font-size: 11px">
      {{ index + 1 }} / {{ items.length }}{{ finished ? '' : '+' }} · 已看 {{ formatDuration(currentTime) }} /
      {{ formatDuration(duration) }}
    </div>
  </div>
</template>
