import { create } from 'zustand';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import { emitChange, subscribeRemoteChange } from '../utils/syncBus';
import { issueSupply } from '../services/prepService';
import type { SupplyIssue, SupplyLot, SupplyLotDraft } from '../types/supply';

interface SupplyState {
  items: SupplyLot[];
  loaded: boolean;
  load: () => Promise<void>;
  add: (draft: SupplyLotDraft) => Promise<SupplyLot>;
  /** 领用登记（服务层事务 + 批次版本/库存校验），冲突时抛 ConflictError */
  issue: (baseLot: SupplyLot, payload: Omit<SupplyIssue, 'id' | 'issuedAt'>) => Promise<void>;
  trace: (lotNo: string) => SupplyLot[];
}

function sortItems(items: SupplyLot[]): SupplyLot[] {
  return [...items].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}

export const useSupplyStore = create<SupplyState>((set, get) => ({
  items: [],
  loaded: false,
  async load() {
    const items = sortItems(await db.supplies.toArray());
    set({ items, loaded: true });
  },
  async add(draft) {
    const record: SupplyLot = { ...draft, id: newId('sup'), issues: [], version: 1 };
    await db.supplies.put(record);
    set({ items: sortItems([...get().items, record]) });
    void emitChange(['supplies']);
    return record;
  },
  async issue(baseLot, payload) {
    const next = await issueSupply(baseLot, payload);
    set({ items: sortItems(get().items.map((it) => (it.id === next.id ? next : it))) });
    void emitChange(['supplies']);
  },
  trace(lotNo) {
    if (!lotNo) return get().items;
    return get().items.filter((it) => it.lotNo.includes(lotNo) || it.name.includes(lotNo));
  },
}));

/** 其它标签页领用/退料后，本页批次库存与领用明细立即刷新 */
subscribeRemoteChange((msg) => {
  if (msg.scopes.includes('all') || msg.scopes.includes('supplies')) {
    void useSupplyStore.getState().load();
  }
});
