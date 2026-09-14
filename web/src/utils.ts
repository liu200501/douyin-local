export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '00:00';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 100 || index === 0 ? 0 : 1)} ${units[index]}`;
}

export function formatRelativeTime(timestamp: number | null): string {
  if (!timestamp) return '';
  const diff = Date.now() - timestamp;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
  return new Date(timestamp).toLocaleDateString('zh-CN');
}

const COMPAT_LABEL: Record<string, { text: string; tone: string }> = {
  direct: { text: '直接播放', tone: 'ok' },
  hevc: { text: 'HEVC 编码', tone: 'warn' },
  remux: { text: '待换封装', tone: 'warn' },
  remuxed: { text: '已换封装', tone: 'ok' },
  broken: { text: '无法解析', tone: 'bad' },
  unknown: { text: '未知', tone: 'muted' },
};

export function compatLabel(compat: string) {
  return COMPAT_LABEL[compat] || COMPAT_LABEL.unknown;
}

export function isMobileViewport(): boolean {
  return window.matchMedia('(max-width: 820px)').matches;
}

export function debounce<T extends (...args: any[]) => void>(fn: T, wait = 300) {
  let timer: number | undefined;
  return (...args: Parameters<T>) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), wait);
  };
}
