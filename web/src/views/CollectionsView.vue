<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { posterUrl } from '@/api';
import { useLibraryStore } from '@/stores/library';
import { formatDuration } from '@/utils';

const library = useLibraryStore();
const loading = ref(false);

onMounted(async () => {
  loading.value = true;
  await library.refreshMetadata();
  loading.value = false;
});
</script>

<template>
  <div>
    <div v-if="loading" class="empty"><span class="spinner" style="margin: 0 auto"></span></div>

    <div v-else-if="library.collections.length === 0" class="empty">
      <div class="empty__title">还没有合集</div>
      <div>合集按视频目录下的一级子文件夹自动生成，例如 <code>videos/旅行/xxx.mp4</code>。</div>
    </div>

    <div v-else class="grid" style="grid-template-columns: repeat(auto-fill, minmax(220px, 1fr))">
      <router-link
        v-for="item in library.collections"
        :key="item.name"
        class="card"
        :to="`/collections/${encodeURIComponent(item.name)}`"
      >
        <div class="card__thumb" style="aspect-ratio: 16 / 10">
          <img v-if="item.coverId" :src="posterUrl(item.coverId)" alt="" loading="lazy" />
          <div v-else class="card__placeholder">无封面</div>
          <span class="card__duration">{{ formatDuration(item.totalDuration) }}</span>
        </div>
        <div class="card__body">
          <div class="card__title">{{ item.name }}</div>
          <div class="card__meta">
            <span>{{ item.count }} 个视频</span>
            <span>›</span>
          </div>
        </div>
      </router-link>
    </div>
  </div>
</template>
