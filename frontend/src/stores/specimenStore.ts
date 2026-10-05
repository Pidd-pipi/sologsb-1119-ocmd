import { create } from 'zustand';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import { emitChange, subscribeRemoteChange } from '../utils/syncBus';
import { setSpecimenStatus } from '../services/prepService';
import type { Specimen, SpecimenDraft, SpecimenStatus } from '../types/specimen';

interface SpecimenState {
  items: Specimen[];
  loading: boolean;
  loaded: boolean;
  load: () => Promise<void>;
  add: (draft: SpecimenDraft) => Promise<Specimen>;
  /** 更新状态（服务层事务 + 标本版本校验），冲突时抛 ConflictError */
  setStatus: (base: Specimen, status: SpecimenStatus) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

export const useSpecimenStore = create<SpecimenState>((set, get) => ({
  items: [],
  loading: false,
  loaded: false,
  async load() {
    set({ loading: true });
    const items = await db.specimens.orderBy('createdAt').reverse().toArray();
    set({ items, loading: false, loaded: true });
  },
  async add(draft) {
    const record: Specimen = { ...draft, id: newId('spm'), createdAt: Date.now(), version: 1 };
    await db.specimens.put(record);
    set({ items: [record, ...get().items] });
    void emitChange(['specimens']);
    return record;
  },
  async setStatus(base, status) {
    const next = await setSpecimenStatus(base, status);
    set({ items: get().items.map((it) => (it.id === next.id ? next : it)) });
    void emitChange(['specimens']);
  },
  async remove(id) {
    await db.specimens.delete(id);
    set({ items: get().items.filter((it) => it.id !== id) });
    void emitChange(['specimens']);
  },
}));

/** 其它标签页改了标本状态后，本页状态分栏立即显示最后确认结果 */
subscribeRemoteChange((msg) => {
  if (msg.scopes.includes('all') || msg.scopes.includes('specimens')) {
    void useSpecimenStore.getState().load();
  }
});
