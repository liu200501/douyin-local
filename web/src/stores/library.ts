import { defineStore } from 'pinia';
import { api } from '@/api';
import type { Collection, SystemInfo, TagInfo, Video, VideoQuery } from '@/types';

interface State {
  items: Video[];
  total: number;
  loading: boolean;
  error: string;
  offset: number;
  limit: number;
  query: VideoQuery;
  collections: Collection[];
  tags: TagInfo[];
  info: SystemInfo | null;
}

export const useLibraryStore = defineStore('library', {
  state: (): State => ({
    items: [],
    total: 0,
    loading: false,
    error: '',
    offset: 0,
    limit: 36,
    query: { sort: 'newest' },
    collections: [],
    tags: [],
    info: null,
  }),

  getters: {
    hasMore: (state) => state.items.length < state.total,
    /** Videos the user has already started watching, safest "continue" queue. */
    resumeList: (state) => state.items.filter((item) => item.position > 0),
  },

  actions: {
    async load(query: VideoQuery = {}, { append = false } = {}) {
      this.loading = true;
      this.error = '';
      this.query = { ...this.query, ...query };
      const offset = append ? this.items.length : 0;
      try {
        const page = await api.videos({ ...this.query, offset, limit: this.limit });
        this.items = append ? [...this.items, ...page.items] : page.items;
        this.total = page.total;
        this.offset = offset;
      } catch (error) {
        this.error = (error as Error).message;
      } finally {
        this.loading = false;
      }
    },

    async loadMore() {
      if (this.loading || !this.hasMore) return;
      await this.load({}, { append: true });
    },

    async refreshMetadata() {
      try {
        const [collections, tags] = await Promise.all([api.collections(), api.tags()]);
        this.collections = collections.items;
        this.tags = tags.items;
      } catch {
        /* non fatal */
      }
    },

    async loadSystem() {
      try {
        this.info = await api.systemInfo();
      } catch (error) {
        this.error = (error as Error).message;
      }
    },

    patch(id: number, changes: Partial<Video>) {
      this.items = this.items.map((item) => (item.id === id ? { ...item, ...changes } : item));
    },

    async toggleFavorite(video: Video) {
      const next = !video.favorite;
      this.patch(video.id, { favorite: next });
      try {
        await api.favorite(video.id, next);
        await this.refreshMetadata();
      } catch (error) {
        this.patch(video.id, { favorite: !next });
        this.error = (error as Error).message;
      }
      return next;
    },

    async toggleLike(video: Video) {
      const next = !video.liked;
      this.patch(video.id, { liked: next });
      try {
        await api.like(video.id, next);
      } catch (error) {
        this.patch(video.id, { liked: !next });
        this.error = (error as Error).message;
      }
      return next;
    },
  },
});
