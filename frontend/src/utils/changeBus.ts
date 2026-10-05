/**
 * 数据变更广播：同一标签页内写入后，以及其它标签页写入后，
 * 统一发变更消息；各 store / 页面订阅自己关心的表并重载，
 * 使「打开页面时的版本」在别处改动后立即判旧。
 */

export type ChangedTable = 'specimens' | 'procedures' | 'supplies' | 'photos';

export interface ChangeMessage {
  /** 发起方标签页标识，避免回环处理自己发出的消息 */
  source: string;
  tables: ChangedTable[];
  at: number;
}

const CHANNEL_NAME = 'gbfossilprep:changes';
const LS_FALLBACK_KEY = 'gbfossilprep:change-tick';

function createTabId(): string {
  return `tab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export const TAB_ID = createTabId();

type Listener = (msg: ChangeMessage) => void;
const listeners = new Set<Listener>();

let channel: BroadcastChannel | null = null;
try {
  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (ev: MessageEvent<ChangeMessage>) => {
      const msg = ev.data;
      if (msg && msg.source !== TAB_ID) listeners.forEach((fn) => fn(msg));
    };
  }
} catch {
    /* 浏览器不支持 BroadcastChannel 时走 localStorage 兜底 */
}

/** localStorage storage 事件只在其它标签页触发，天然不会回环 */
if (typeof window !== 'undefined' && !channel) {
  window.addEventListener('storage', (ev) => {
    if (ev.key !== LS_FALLBACK_KEY || !ev.newValue) return;
    try {
      const msg = JSON.parse(ev.newValue) as ChangeMessage;
      if (msg.source !== TAB_ID) listeners.forEach((fn) => fn(msg));
    } catch {
      /* 兜底消息损坏时忽略 */
    }
  });
}

/** 广播一次写入涉及的表（本页监听者 + 其它标签页都会收到） */
export function announceChange(tables: ChangedTable[]): void {
  if (tables.length === 0) return;
  const msg: ChangeMessage = { source: TAB_ID, tables, at: Date.now() };
  // 先通知本页订阅者（同页 store 立即刷新）
  listeners.forEach((fn) => fn(msg));
  // 再通知其它标签页
  if (channel) {
    channel.postMessage(msg);
  } else if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(LS_FALLBACK_KEY, JSON.stringify(msg));
    } catch {
      /* localStorage 不可用时仅本页生效 */
    }
  }
}

export function subscribeChanges(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
