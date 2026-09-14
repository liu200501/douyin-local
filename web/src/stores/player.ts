import { defineStore } from 'pinia';

const STORAGE_KEY = 'douyin-local:prefs';

interface Prefs {
  muted: boolean;
  volume: number;
  mode: 'auto' | 'feed' | 'grid';
}

function readPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { muted: true, volume: 1, mode: 'auto', ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return { muted: true, volume: 1, mode: 'auto' };
}

export const usePlayerStore = defineStore('player', {
  state: () => ({
    ...readPrefs(),
    /** Whether the user has already interacted, so audio is allowed. */
    unlocked: false,
  }),

  getters: {
    /** Browsers block unmuted autoplay until the page has been interacted with. */
    effectiveMuted: (state) => state.muted || !state.unlocked,
  },

  actions: {
    persist() {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ muted: this.muted, volume: this.volume, mode: this.mode })
      );
    },
    setMuted(value: boolean) {
      this.muted = value;
      this.persist();
    },
    setVolume(value: number) {
      this.volume = Math.min(Math.max(value, 0), 1);
      this.muted = this.volume === 0;
      this.persist();
    },
    unlock() {
      this.unlocked = true;
    },
    setMode(mode: Prefs['mode']) {
      this.mode = mode;
      this.persist();
    },
  },
});
