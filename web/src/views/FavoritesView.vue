<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '@/api';
import VideoGrid from '@/components/VideoGrid.vue';
import type { Video } from '@/types';

const items = ref<Video[]>([]);
const total = ref(0);
const loading = ref(false);

async function load(append = false) {
  loading.value = true;
  try {
    const page = await api.favorites(append ? items.value.length : 0, 48);
    items.value = append ? [...items.value, ...page.items] : page.items;
    total.value = page.total;
  } finally {
    loading.value = false;
  }
}

onMounted(() => load());
</script>

<template>
  <div>
    <div class="input-row" style="margin-bottom: 14px">
      <span class="chip">共 {{ total }} 个收藏</span>
      <div style="flex: 1"></div>
      <router-link class="btn btn--sm" to="/grid">去浏览全部</router-link>
    </div>

    <VideoGrid
      :items="items"
      :loading="loading"
      empty-title="还没有收藏"
      empty-hint="在竖屏播放页点右侧的 ☆，或在网格里点卡片右下角的星星。"
      @load-more="load(true)"
    />
  </div>
</template>
