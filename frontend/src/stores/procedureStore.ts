import { create } from 'zustand';
import { db } from '../utils/db';
import { emitChange, subscribeRemoteChange } from '../utils/syncBus';
import { finishProcedure, rollbackProcedure } from '../services/prepService';
import { useSupplyStore } from './supplyStore';
import type { PrepProcedure } from '../types/procedure';

interface ProcedureState {
  items: PrepProcedure[];
  loaded: boolean;
  load: () => Promise<void>;
  /** 完成节点（服务层事务 + 版本校验），冲突时抛 ConflictError */
  finish: (base: PrepProcedure) => Promise<PrepProcedure>;
  /** 回退节点并按领用记录退料，冲突时抛 ConflictError */
  rollback: (base: PrepProcedure) => Promise<PrepProcedure>;
  bySpecimen: (specimenId: string) => PrepProcedure[];
}

function sortItems(items: PrepProcedure[]): PrepProcedure[] {
  return [...items].sort((a, b) => a.seq - b.seq || a.startedAt - b.startedAt);
}

export const useProcedureStore = create<ProcedureState>((set, get) => ({
  items: [],
  loaded: false,
  async load() {
    const items = sortItems(await db.procedures.toArray());
    set({ items, loaded: true });
  },
  async finish(base) {
    const next = await finishProcedure(base);
    set({ items: sortItems(get().items.map((it) => (it.id === next.id ? next : it))) });
    void emitChange(['procedures']);
    return next;
  },
  async rollback(base) {
    const { procedure, lots } = await rollbackProcedure(base);
    // 工序状态 + 批次库存一起更新；跨页由广播触发整体 reload
    set({ items: sortItems(get().items.map((it) => (it.id === procedure.id ? procedure : it))) });
    useSupplyStore.setState((state) => ({
      items: state.items.map((lot) => lots.find((next) => next.id === lot.id) ?? lot),
    }));
    void emitChange(['procedures', 'supplies']);
    return procedure;
  },
  bySpecimen(specimenId) {
    return get()
      .items.filter((it) => it.specimenId === specimenId)
      .sort((a, b) => a.seq - b.seq);
  },
}));

/**
 * 其它标签页确认后，本页缓存立即重载，
 * 时间线与完成度统计始终显示最后确认结果。
 */
subscribeRemoteChange((msg) => {
  if (msg.scopes.includes('all') || msg.scopes.includes('procedures')) {
    void useProcedureStore.getState().load();
  }
});
