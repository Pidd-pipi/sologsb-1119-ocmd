/**
 * 跨标签页变更广播。
 *
 * 一个标签页提交成功后立即通知其它标签页：
 * - 其它标签页的 zustand 缓存整体重载（保证时间线/统计显示最后确认结果）；
 * - 录入页打开时拿到的旧版本立即判为失效，保存前即提示差异。
 *
 * 优先用 BroadcastChannel；不支持时退化到 localStorage storage 事件。
 */

export type SyncScope = 'specimens' | 'procedures' | 'supplies' | 'photos' | 'all';

export interface SyncMessage {
  /** 发送标签页标识，避免收到自己的广播后重复刷新 */
  source: string;
  scopes: SyncScope[];
  at: number;
}

export type SyncListener = (message: SyncMessage) => void;

const CHANNEL_NAME = 'gbfossilprep:sync';
const LS_PING_KEY = 'gbfossilprep:sync-ping';

const tabId =
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const listeners = new Set<SyncListener>();

let channel: BroadcastChannel | null = null;
try {
  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (event: MessageEvent<SyncMessage>) => {
      const msg = event.data;
      if (!msg || msg.source === tabId) return;
      listeners.forEach((fn) => fn(msg));
    };
  } else if (typeof window !== 'undefined') {
    window.addEventListener('storage', (event) => {
      if (event.key !== LS_PING_KEY || !event.newValue) return;
      try {
        const msg = JSON.parse(event.newValue) as SyncMessage;
        if (msg.source === tabId) return;
        listeners.forEach((fn) => fn(msg));
      } catch {
        /* 忽略无法解析的兜底载荷 */
      }
    });
  }
} catch {
  /* 个别环境禁止 BroadcastChannel：仅本标签页生效 */
  channel = null;
}

/** 订阅其它标签页的提交广播，返回取消订阅函数 */
export function subscribeRemoteChange(listener: SyncListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 本标签页提交成功后广播，让其它标签页旧版本立即失效 */
export async function emitChange(scopes: SyncScope[]): Promise<void> {
  const message: SyncMessage = { source: tabId, scopes, at: Date.now() };
  channel?.postMessage(message);
  if (!channel) {
    try {
      window.localStorage.setItem(LS_PING_KEY, JSON.stringify(message));
    } catch {
      /* localStorage 不可用时仅同标签页生效 */
    }
  }
}
