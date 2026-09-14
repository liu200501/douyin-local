<script setup lang="ts">
import { computed, ref } from 'vue';
import { api } from '@/api';
import { useLibraryStore } from '@/stores/library';
import VideoGrid from '@/components/VideoGrid.vue';
import type { Video } from '@/types';
import { debounce } from '@/utils';

const library = useLibraryStore();
const keyword = ref('');
const sort = ref(String(library.query.sort ?? 'newest'));
const activeTag = ref('');
const results = ref<Video[]>([]);
const total = ref(0);
const loading = ref(false);
const searched = ref(false);

const suggestions = computed(() => library.tags.slice(0, 16));

const run = debounce(async () => {
  const query = keyword.value.trim();
  if (!query && !activeTag.value) {
    results.value = [];
    total.value = 0;
    searched.value = false;
    return;
  }
  loading.value = true;
  searched.value = true;
  try {
    const page = await api.videos({
      q: query || undefined,
      tag: activeTag.value || undefined,
      sort: sort.value,
      limit: 60,
    });
    results.value = page.items;
    total.value = page.total;
  } finally {
    loading.value = false;
  }
}, 320);

function pickTag(tag: string) {
  activeTag.value = activeTag.value === tag ? '' : tag;
  run();
}
</script>

<template>
  <div>
    <div class="input-row" style="margin-bottom: 14px">
      <input
        v-model="keyword"
        type="search"
        placeholder="搜索文件名、路径或合集…"
        style="flex: 1; min-width: 220px"
        @input="run"
        autofocus
      />
      <select v-model="sort" style="min-width: 120px" @change="run">
        <option value="newest">最新添加</option>
        <option value="name">名称</option>
        <option value="duration">时长</option>
        <option value="size">体积</option>
      </select>
      <span v-if="searched" class="chip">{{ total }} 个结果</span>
    </div>

    <div v-if="suggestions.length" class="input-row" style="margin-bottom: 16px; gap: 6px">
      <button
        v-for="tag in suggestions"
        :key="tag.name"
        class="chip"
        :style="activeTag === tag.name ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}"
        @click="pickTag(tag.name)"
      >
        #{{ tag.name }} {{ tag.count }}
      </button>
    </div>

    <VideoGrid
      :items="results"
      :loading="loading"
      :infinite="false"
      empty-title="没有匹配的视频"
      empty-hint="换个关键词，或先给视频打上标签。"
    />
  </div>
</template>
