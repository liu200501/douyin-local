<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { posterUrl } from '@/api';
import { useLibraryStore } from '@/stores/library';
import type { Video } from '@/types';
import { compatLabel, formatDuration } from '@/utils';

const props = withDefaults(
  defineProps<{
    items: Video[];
    loading?: boolean;
    emptyTitle?: string;
    emptyHint?: string;
    infinite?: boolean;
    hideCollection?: boolean;
  }>(),
  {
    loading: false,
    emptyTitle: '这里还没有视频',
    emptyHint: '去「设置」里添加视频目录，然后在「媒体管理」里触发扫描。',
    infinite: true,
    hideCollection: false,
  }
);

const emit = defineEmits<{ (event: 'load-more'): void }>();

const router = useRouter();
const library = useLibraryStore();
const sentinel = ref<HTMLElement | null>(null);
let observer: IntersectionObserver | null = null;

const ready = computed(() => props.items.length > 0);

function open(video: Video) {
  if (video.compat === 'broken') return;
  router.push({ name: 'watch', params: { id: video.id } });
}

function onPosterError(event: Event) {
  const target = event.target as HTMLImageElement;
  target.style.display = 'none';
}

onMounted(() => {
  if (!props.infinite) return;
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) emit('load-more');
    },
    { rootMargin: '600px 0px' }
  );
  if (sentinel.value) observer.observe(sentinel.value);
});

onBeforeUnmount(() => {
  observer?.disconnect();
  observer = null;
});
</script>

<template>
  <div>
    <div v-if="ready" class="grid">
      <article v-for="video in items" :key="video.id" class="card" @click="open(video)">
        <div class="card__thumb">
          <img
            v-if="video.hasPoster"
            :src="posterUrl(video.id)"
            :alt="video.title"
            loading="lazy"
            decoding="async"
            @error="onPosterError"
          />
          <div v-else class="card__placeholder">封面生成中…</div>

          <span v-if="video.compat === 'hevc'" class="card__badge">HEVC</span>
          <span v-else-if="video.compat === 'remux'" class="card__badge">转封装中</span>
          <span v-else-if="video.compat === 'broken'" class="card__badge">无法解析</span>

          <span class="card__duration">{{ formatDuration(video.duration) }}</span>

          <div v-if="video.position > 0 && video.duration > 0" class="card__progress">
            <span :style="{ width: `${Math.min((video.position / video.duration) * 100, 100)}%` }"></span>
          </div>
        </div>

        <div class="card__body">
          <div class="card__title">{{ video.title }}</div>
          <div class="card__meta">
            <span v-if="!hideCollection" class="card__collection">{{ video.collection }}</span>
            <span style="display: flex; gap: 4px; align-items: center">
              <button
                class="icon-btn"
                style="width: 22px; height: 22px; font-size: 13px"
                :class="{ 'is-on': video.favorite }"
                :title="video.favorite ? '取消收藏' : '收藏'"
                @click.stop="library.toggleFavorite(video)"
              >
                {{ video.favorite ? '★' : '☆' }}
              </button>
              <span>{{ compatLabel(video.compat).text }}</span>
            </span>
          </div>
        </div>
      </article>
    </div>

    <div v-else-if="!loading" class="empty">
      <div class="empty__title">{{ emptyTitle }}</div>
      <div>{{ emptyHint }}</div>
    </div>

    <div v-if="loading" class="empty" style="padding: 28px">
      <span class="spinner" style="margin: 0 auto"></span>
    </div>

    <div ref="sentinel" style="height: 1px"></div>
  </div>
</template>
