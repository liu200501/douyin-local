import type {
  Collection,
  Paged,
  PlayInfo,
  SystemInfo,
  TagInfo,
  Video,
  VideoQuery,
} from './types';

const jsonHeaders = { 'Content-Type': 'application/json' };

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      if (body?.error) detail = body.error;
    } catch {
      /* keep the status text */
    }
    throw new Error(detail);
  }
  const type = response.headers.get('content-type') || '';
  if (type.includes('application/json')) return (await response.json()) as T;
  return (await response.text()) as unknown as T;
}

function toQuery(params: Record<string, unknown>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '' || value === false) continue;
    search.set(key, String(value === true ? 1 : value));
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

export const api = {
  systemInfo: () => request<SystemInfo>('/api/system/info'),
  scan: (full = true) =>
    request<{ started?: boolean; scan: SystemInfo['scan'] }>('/api/system/scan', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ full }),
    }),
  scanStatus: () =>
    request<{ scan: SystemInfo['scan']; jobs: { active: number; pending: number } }>(
      '/api/system/scan'
    ),
  setDirs: (dirs: string[]) =>
    request<{ dirs: string[]; warning?: string }>('/api/system/dirs', {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify({ dirs }),
    }),
  detectDirs: () =>
    request<{ candidates: { dir: string; exists: boolean }[]; mountHint: string }>(
      '/api/system/detect-dirs'
    ),
  saveSettings: (payload: Record<string, unknown>) =>
    request<{ settings: Record<string, unknown> }>('/api/system/settings', {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify(payload),
    }),

  videos: (query: VideoQuery = {}) => request<Paged<Video>>(`/api/videos${toQuery(query)}`),
  video: (id: number) => request<Video>(`/api/videos/${id}`),
  play: (id: number) => request<PlayInfo>(`/api/videos/${id}/play`),
  related: (id: number) => request<{ items: Video[] }>(`/api/videos/${id}/related`),
  collections: () => request<{ items: Collection[] }>('/api/collections'),
  tags: () => request<{ items: TagInfo[] }>('/api/tags'),

  favorite: (id: number, on: boolean) =>
    request<{ favorite: boolean }>(`/api/videos/${id}/favorite`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ on }),
    }),
  like: (id: number, on: boolean) =>
    request<{ liked: boolean; likes: number }>(`/api/videos/${id}/like`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ on }),
    }),
  progress: (id: number, payload: { position: number; duration: number; finished?: boolean; countPlay?: boolean }) =>
    request<{ ok: boolean }>(`/api/videos/${id}/progress`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify(payload),
    }),
  setTags: (id: number, tags: string[]) =>
    request<{ tags: string[] }>(`/api/videos/${id}/tags`, {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify({ tags }),
    }),

  favorites: (offset = 0, limit = 60) =>
    request<Paged<Video>>(`/api/favorites?offset=${offset}&limit=${limit}`),
  history: (offset = 0, limit = 60) => request<Paged<Video>>(`/api/history?offset=${offset}&limit=${limit}`),
  clearHistory: () => request<{ ok: boolean }>('/api/history', { method: 'DELETE' }),
  removeHistory: (id: number) => request<{ ok: boolean }>(`/api/history/${id}`, { method: 'DELETE' }),

  remux: (id: number) => request<Video>(`/api/videos/${id}/remux`, { method: 'POST' }),
  remove: (id: number) => request<{ ok: boolean; trash: string | null }>(`/api/videos/${id}?confirm=1`, {
    method: 'DELETE',
  }),
  trash: () => request<{ items: { name: string; size: number; mtime: number }[]; dir: string }>(
    '/api/system/trash'
  ),

  upload: (files: File[], onProgress?: (percent: number) => void) =>
    new Promise<{ saved: { name: string }[]; skipped: { name: string; reason: string }[]; indexed: number[] }>(
      (resolve, reject) => {
        const form = new FormData();
        files.forEach((file) => form.append('files', file, file.name));
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/upload');
        xhr.upload.onprogress = (event) => {
          if (onProgress && event.lengthComputable) {
            onProgress(Math.round((event.loaded / event.total) * 100));
          }
        };
        xhr.onload = () => {
          try {
            const body = JSON.parse(xhr.responseText || '{}');
            if (xhr.status >= 200 && xhr.status < 300) resolve(body);
            else reject(new Error(body.error || `上传失败 (${xhr.status})`));
          } catch {
            reject(new Error(`上传失败 (${xhr.status})`));
          }
        };
        xhr.onerror = () => reject(new Error('网络错误，上传中断'));
        xhr.send(form);
      }
    ),
};

export const posterUrl = (id: number) => `/api/poster/${id}`;
export const streamUrl = (id: number) => `/api/stream/${id}`;
export const downloadUrl = (id: number) => `/api/download/${id}`;
