<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useLibraryStore } from '@/stores/library';
import { usePlayerStore } from '@/stores/player';
import { isMobileViewport } from '@/utils';

const route = useRoute();
const router = useRouter();
const library = useLibraryStore();
const player = usePlayerStore();

const drawerOpen = ref(false);

const isFullscreen = computed(() => Boolean(route.meta.fullscreen));
const onFeed = computed(() => route.name === 'feed');

const navItems = [
  { to: '/feed', icon: '▶', label: '竖屏播放' },
  { to: '/grid', icon: '▦', label: '全部视频' },
  { to: '/collections', icon: '❐', label: '合集' },
  { to: '/search', icon: '⌕', label: '搜索' },
  { to: '/favorites', icon: '★', label: '收藏' },
  { to: '/history', icon: '◷', label: '观看历史' },
];

const toolItems = [
  { to: '/admin', icon: '⇪', label: '媒体管理' },
  { to: '/settings', icon: '⚙', label: '设置' },
];

const title = computed(() => {
  const map: Record<string, string> = {
    feed: '竖屏播放',
    grid: '全部视频',
    collections: '合集',
    collection: `合集 · ${route.params.name ?? ''}`,
    search: '搜索',
    favorites: '收藏',
    history: '观看历史',
    admin: '媒体管理',
    settings: '设置',
    watch: '播放',
  };
  return map[String(route.name)] ?? 'douyin-local';
});

function closeDrawer() {
  drawerOpen.value = false;
}

function toggleMode() {
  const next = onFeed.value ? 'grid' : 'feed';
  player.setMode(next);
  router.push(next === 'feed' ? '/feed' : '/grid');
}

watch(
  () => route.fullPath,
  () => {
    closeDrawer();
  }
);

onMounted(async () => {
  await Promise.all([library.loadSystem(), library.refreshMetadata()]);
  if (player.mode === 'auto' && isMobileViewport() && route.name === 'grid') {
    router.replace('/feed');
  }
  setInterval(() => {
    if (!library.info?.scan.running) return;
    library.loadSystem();
  }, 4000);
});
</script>

<template>
  <div v-if="isFullscreen" class="fullscreen">
    <router-view />
  </div>

  <div v-else class="app-shell">
    <aside class="sidebar" :class="{ 'is-open': drawerOpen }">
      <div class="brand">
        <div class="brand__mark">抖</div>
        <div>
          <div class="brand__name">douyin-local</div>
          <div class="brand__meta">本地短视频库 v{{ library.info?.version ?? '—' }}</div>
        </div>
      </div>

      <router-link v-for="item in navItems" :key="item.to" :to="item.to" class="nav-link"
        :class="{ 'is-active': route.path.startsWith(item.to) }" custom v-slot="{ navigate, isActive }">
        <a class="nav-link" :class="{ 'is-active': isActive }" @click="navigate">
          <span class="nav-link__icon">{{ item.icon }}</span>
          <span>{{ item.label }}</span>
          <span v-if="item.to === '/favorites' && library.info" class="nav-link__badge">
            {{ library.info.stats.favorites }}
          </span>
          <span v-if="item.to === '/history' && library.info" class="nav-link__badge">
            {{ library.info.stats.history }}
          </span>
        </a>
      </router-link>

      <div class="nav-section">管理</div>
      <router-link v-for="item in toolItems" :key="item.to" :to="item.to" custom
        v-slot="{ navigate, isActive }">
        <a class="nav-link" :class="{ 'is-active': isActive }" @click="navigate">
          <span class="nav-link__icon">{{ item.icon }}</span>
          <span>{{ item.label }}</span>
        </a>
      </router-link>

      <div style="flex: 1"></div>

      <div v-if="library.info" class="panel" style="padding: 12px">
        <div class="stat__label">库内视频</div>
        <div class="stat__value">{{ library.info.stats.total }}</div>
        <div class="stat__label" style="margin-top: 6px">
          {{ library.info.videoDirs.length }} 个目录 · {{ library.info.hwaccel.vendor }}
        </div>
      </div>
    </aside>

    <div v-if="drawerOpen" style="position: fixed; inset: 0; z-index: 30" @click="closeDrawer"></div>

    <div class="main-area">
      <header class="topbar">
        <button class="icon-btn mobile-drawer-toggle" @click="drawerOpen = true">☰</button>
        <div class="topbar__title">{{ title }}</div>
        <div class="topbar__spacer"></div>

        <span v-if="library.info?.scan.running" class="chip chip--warn">
          <span class="spinner" style="width: 12px; height: 12px"></span>
          扫描中 {{ library.info.scan.scanned }}/{{ library.info.scan.total }}
        </span>
        <span v-else-if="library.info" class="chip">
          共 {{ library.info.stats.total }} 个视频
        </span>

        <button class="btn btn--sm" @click="toggleMode">
          {{ onFeed ? '桌面网格' : '竖屏播放' }}
        </button>
      </header>

      <div class="content">
        <router-view />
      </div>
    </div>
  </div>
</template>
