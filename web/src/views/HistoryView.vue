<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '@/api';
import { useLibraryStore } from '@/stores/library';
import VideoGrid from '@/components/VideoGrid.vue';
import type { Video } from '@/types';

const library = useLibraryStore();
const items = ref<Video[]>([]);
const total = ref(0);
const loading = ref(false);

async function load(append = false) {
  loading.value = true;
  try {
    const page = await api.history(append ? items.value.length : 0, 48);
    items.value = append ? [...items.value, ...page.items] : page.items;
    total.value = page.total;
  } finally {
    loading.value = false;
  }
}

async function clearAll() {
  if (!window.confirm('清空所有观看历史？视频文件不会被删除。')) return;
  await api.clearHistory();
  items.value = [];
  total.value = 0;
  await library.loadSystem();
}

onMounted(() => load());
</script>

<template>
  <div>
    <div class="input-row" style="margin-bottom: 14px">
      <span class="chip">共 {{ total }} 条记录</span>
      <div style="flex: 1"></div>
      <button class="btn btn--sm btn--danger" :disabled="total === 0" @click="clearAll">清空历史</button>
    </div>

    <VideoGrid
      :items="items"
      :loading="loading"
      empty-title="还没有观看记录"
      empty-hint="在竖屏播放页看过的视频会自动出现在这里，并记住播放进度。"
      @load-more="load(true)"
    />
  </div>
</template>
