import { create } from 'zustand';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import { announceChange, subscribeChanges } from '../utils/changeBus';
import { ConcurrencyError, buildSpecimenConflict } from '../utils/concurrency';
import type { Specimen, SpecimenDraft, SpecimenStatus } from '../types/specimen';

interface SpecimenState {
  items: Specimen[];
  loading: boolean;
  loaded: boolean;
  load: () => Promise<void>;
  add: (draft: SpecimenDraft) => Promise<Specimen>;
  update: (id: string, patch: Partial<Specimen>) => Promise<void>;
  /** 带版本确认的状态修改：expectedVersion 落后即整笔失败、不写入 */
  setStatus: (id: string, status: SpecimenStatus, expectedVersion: number) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

/** 标本 store：一律以 IndexedDB 为准，写入后经 changeBus 广播并重载 */
export const useSpecimenStore = create<SpecimenState>((set) => ({
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
    announceChange(['specimens']);
    return record;
  },
  async update(id, patch) {
    await db.transaction('rw', db.specimens, async () => {
      const target = await db.specimens.get(id);
      if (!target) return;
      const next: Specimen = { ...target, ...patch, id, version: target.version + 1 };
      await db.specimens.put(next);
    });
    announceChange(['specimens']);
  },
  async setStatus(id, status, expectedVersion) {
    await db.transaction('rw', db.specimens, async () => {
      // 事务内重读：版本不一致立即中止整笔事务，不写入
      const current = await db.specimens.get(id);
      if (!current) {
        throw new ConcurrencyError([
          {
            kind: 'specimen',
            id,
            title: '标本（已被删除）',
            expectedVersion,
            actualVersion: 0,
            fields: [{ label: '存在性', expected: '存在', actual: '已删除' }],
          },
        ]);
      }
      if (current.version !== expectedVersion) {
        throw new ConcurrencyError([buildSpecimenConflict(current, expectedVersion, status)]);
      }
      if (current.status === status) return;
      const next: Specimen = { ...current, status, version: current.version + 1 };
      await db.specimens.put(next);
    });
    announceChange(['specimens']);
  },
  async remove(id) {
    await db.specimens.delete(id);
    announceChange(['specimens']);
  },
}));

// 任一标签页（含本页写入后）改动标本即从数据库重载，保证看到最后确认结果
subscribeChanges((msg) => {
  if (msg.tables.includes('specimens')) {
    void useSpecimenStore.getState().load();
  }
});
