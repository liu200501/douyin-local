export type Compat = 'direct' | 'hevc' | 'remux' | 'remuxed' | 'broken' | 'unknown';

export interface Video {
  id: number;
  title: string;
  filename: string;
  collection: string;
  relPath: string;
  ext: string;
  size: number;
  mtime: number;
  duration: number;
  width: number;
  height: number;
  aspectRatio: number;
  videoCodec: string;
  audioCodec: string;
  container: string;
  compat: Compat;
  compatReason: string;
  hasPoster: boolean;
  missing: boolean;
  favorite: boolean;
  liked: boolean;
  tags: string[];
  position: number;
  playedAt: number | null;
  playCount: number;
}

export interface Paged<T> {
  total: number;
  items: T[];
  offset?: number;
  limit?: number;
}

export interface PlayInfo {
  status: 'ready' | 'preparing' | 'unsupported' | 'missing';
  url: string | null;
  compat: Compat;
  reason?: string;
  queue?: { active: number; pending: number };
}

export interface Collection {
  name: string;
  count: number;
  coverId: number | null;
  totalDuration: number;
}

export interface TagInfo {
  name: string;
  count: number;
}

export interface ScanState {
  running: boolean;
  phase: string;
  scanned: number;
  total: number;
  indexed: number;
  updated: number;
  removed: number;
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface SystemInfo {
  version: string;
  port: number;
  dataDir: string;
  cacheDir: string;
  videoDirs: string[];
  videoDirsReachable: { dir: string; exists: boolean; writable: boolean }[];
  nativeContainers: string[];
  nativeCodecs: string[];
  supportedExts: string[];
  hwaccel: { available: boolean; vendor: string; detail: string };
  jobs: { active: number; pending: number };
  scan: ScanState;
  stats: {
    total: number;
    bytes: number;
    seconds: number;
    pendingRemux: number;
    remuxed: number;
    hevc: number;
    broken: number;
    favorites: number;
    likes: number;
    history: number;
    collections: number;
    tags: number;
  };
  settings: Record<string, unknown>;
}

export interface VideoQuery {
  q?: string;
  collection?: string;
  tag?: string;
  compat?: string;
  ext?: string;
  favorite?: boolean;
  played?: boolean;
  sort?: string;
  limit?: number;
  offset?: number;
}
