<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useLibraryStore } from '@/stores/library';
import VideoGrid from '@/components/VideoGrid.vue';

const props = defineProps<{ collection?: string }>();

const library = useLibraryStore();
const sort = ref(String(library.query.sort ?? 'newest'));
const compat = ref('');

const sortOptions = [
  { value: 'newest', label: '最新添加' },
  { value: 'oldest', label: '最早添加' },
  { value: 'name', label: '名称' },
  { value: 'duration', label: '时长' },
  { value: 'size', label: '体积' },
  { value: 'random', label: '随机' },
];

const compatOptions = [
  { value: '', label: '全部格式' },
  { value: 'direct', label: '直接播放' },
  { value: 'hevc', label: 'HEVC' },
  { value: 'remux', label: '待换封装' },
  { value: 'remuxed', label: '已换封装' },
  { value: 'broken', label: '无法解析' },
];

const heading = computed(() => props.collection ?? '');

async function reload() {
  await library.load({
    collection: props.collection,
    sort: sort.value,
    compat: compat.value || undefined,
  });
}

watch([sort, compat, () => props.collection], reload, { immediate: true });
</script>

<template>
  <div>
    <div class="input-row" style="margin-bottom: 16px">
      <span v-if="heading" class="chip">合集：{{ heading }}</span>
      <select v-model="sort" style="min-width: 120px">
        <option v-for="option in sortOptions" :key="option.value" :value="option.value">
          {{ option.label }}
        </option>
      </select>
      <select v-model="compat" style="min-width: 120px">
        <option v-for="option in compatOptions" :key="option.value" :value="option.value">
          {{ option.label }}
        </option>
      </select>
      <span class="chip">{{ library.total }} 个</span>
      <div style="flex: 1"></div>
      <router-link v-if="heading" class="btn btn--sm" to="/collections">返回合集</router-link>
      <router-link class="btn btn--sm" to="/feed">竖屏播放</router-link>
    </div>

    <VideoGrid
      :items="library.items"
      :loading="library.loading"
      :hide-collection="Boolean(heading)"
      @load-more="library.loadMore()"
    />

    <div v-if="library.error" class="alert alert--bad" style="margin-top: 16px">{{ library.error }}</div>
  </div>
</template>
