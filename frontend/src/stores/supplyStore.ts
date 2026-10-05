import { create } from 'zustand';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import { announceChange, subscribeChanges } from '../utils/changeBus';
import { ConcurrencyError, buildSupplyConflict } from '../utils/concurrency';
import type { SupplyIssue, SupplyLot, SupplyLotDraft } from '../types/supply';

interface ManualIssuePayload {
  qty: number;
  operator: string;
  specimenNo: string;
}

interface SupplyState {
  items: SupplyLot[];
  loaded: boolean;
  load: () => Promise<void>;
  add: (draft: SupplyLotDraft) => Promise<SupplyLot>;
  /** 台账手动领用：带批次版本确认，别处刚动过该批次则旧版本失效 */
  issue: (id: string, payload: ManualIssuePayload, expectedVersion: number) => Promise<void>;
  trace: (lotNo: string) => SupplyLot[];
}

export const useSupplyStore = create<SupplyState>((set, get) => ({
  items: [],
  loaded: false,
  async load() {
    const items = await db.supplies.toArray();
    items.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
    set({ items, loaded: true });
  },
  async add(draft) {
    const record: SupplyLot = { ...draft, id: newId('sup'), issues: [], version: 1 };
    await db.supplies.put(record);
    announceChange(['supplies']);
    return record;
  },
  async issue(id, payload, expectedVersion) {
    await db.transaction('rw', db.supplies, async () => {
      // 事务内重读批次：版本落后或库存已不够都拒绝整笔领用
      const target = await db.supplies.get(id);
      if (!target) {
        throw new ConcurrencyError([
          {
            kind: 'supply',
            id,
            title: '材料批次（已被删除）',
            expectedVersion,
            actualVersion: 0,
            fields: [{ label: '存在性', expected: '存在', actual: '已删除' }],
          },
        ]);
      }
      if (target.version !== expectedVersion) {
        throw new ConcurrencyError([buildSupplyConflict(target, expectedVersion, payload.qty)]);
      }
      if (payload.qty > target.qty) {
        throw new ConcurrencyError([buildSupplyConflict(target, expectedVersion, payload.qty)]);
      }
      const issue: SupplyIssue = {
        ...payload,
        id: newId('iss'),
        issuedAt: Date.now(),
        kind: 'manual',
      };
      const next: SupplyLot = {
        ...target,
        qty: target.qty - payload.qty,
        issues: [issue, ...target.issues],
        version: target.version + 1,
      };
      await db.supplies.put(next);
    });
    announceChange(['supplies']);
  },
  trace(lotNo) {
    if (!lotNo) return get().items;
    return get().items.filter((it) => it.lotNo.includes(lotNo) || it.name.includes(lotNo));
  },
}));

subscribeChanges((msg) => {
  if (msg.tables.includes('supplies')) {
    void useSupplyStore.getState().load();
  }
});
