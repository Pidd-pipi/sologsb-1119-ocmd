import { create } from 'zustand';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import { announceChange, subscribeChanges } from '../utils/changeBus';
import {
  ConcurrencyError,
  type EntityConflict,
  buildProcedureConflict,
  buildSpecimenConflict,
  buildSupplyConflict,
} from '../utils/concurrency';
import type {
  MaterialUsage,
  PrepProcedure,
  PrepProcedureDraft,
  ProcedureState as ProcedureStateEnum,
} from '../types/procedure';
import type { SpecimenStatus } from '../types/specimen';
import type { SupplyIssue, SupplyLot } from '../types/supply';

/** 录入工序时选择的一条实际领用（批次 + 数量） */
export interface DraftMaterial {
  lotId: string;
  qty: number;
}

/** 一次工序确认携带的全部基线版本（打开页面时取得） */
export interface SubmitBaseline {
  /** 标本在打开页面时的版本 */
  specimenVersion: number;
  /** 各领用批次在打开页面时的版本，key 为 lotId */
  lotVersions: Record<string, number>;
}

export interface SubmitProcedureInput {
  draft: PrepProcedureDraft;
  /** 保存时一并确认的标本状态；与当前一致则不动标本 */
  targetStatus?: SpecimenStatus;
  photos?: Array<{
    id: string;
    specimenId: string;
    stage: 'before' | 'after' | 'process';
    caption: string;
    dataUrl: string;
    capturedAt: number;
  }>;
  baseline: SubmitBaseline;
}

interface ProcedureState {
  items: PrepProcedure[];
  loaded: boolean;
  load: () => Promise<void>;
  /**
   * 原子确认一笔工序：同一 IndexedDB 事务内
   * 校验序号、扣减所选批次库存并写领用记录、更新标本状态、写工序与影像。
   * 任一对象版本与 baseline 不符即整笔中止，抛出 ConcurrencyError 列出差异。
   */
  submitProcedure: (input: SubmitProcedureInput) => Promise<PrepProcedure>;
  /** 完成节点：工序版本确认 */
  finish: (id: string, expectedVersion: number) => Promise<void>;
  /** 回退节点：按该工序的领用记录逐条退回材料、冲销领用 */
  rollback: (id: string, expectedVersion: number, reason?: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  bySpecimen: (specimenId: string) => PrepProcedure[];
}

export const useProcedureStore = create<ProcedureState>((set, get) => ({
  items: [],
  loaded: false,
  async load() {
    const items = await db.procedures.toArray();
    items.sort((a, b) => a.seq - b.seq || a.startedAt - b.startedAt);
    set({ items, loaded: true });
  },

  async submitProcedure({ draft, targetStatus, photos, baseline }) {
    const wantedLots = draft.materials.filter((m) => m.lotId && m.qty > 0);
    const lotIds = wantedLots.map((m) => m.lotId);
    if (new Set(lotIds).size !== lotIds.length) {
      throw new ConcurrencyError([
        {
          kind: 'procedure',
          id: '',
          title: '领用批次重复',
          expectedVersion: 0,
          actualVersion: 0,
          fields: [{ label: '领用明细', expected: '每个批次至多一条', actual: '存在重复批次' }],
        },
      ]);
    }

    const created = await db.transaction(
      'rw',
      db.procedures,
      db.supplies,
      db.specimens,
      db.photos,
      async () => {
        // ===== 校验阶段：只读，把全部对象的差异一次收集齐 =====
        const conflicts: EntityConflict[] = [];

        // 1) 标本：版本确认
        const specimen = await db.specimens.get(draft.specimenId);
        if (!specimen) {
          conflicts.push({
            kind: 'specimen',
            id: draft.specimenId,
            title: '标本（已被删除）',
            expectedVersion: baseline.specimenVersion,
            actualVersion: 0,
            fields: [{ label: '存在性', expected: '存在', actual: '已删除' }],
          });
        } else if (specimen.version !== baseline.specimenVersion) {
          conflicts.push(
            buildSpecimenConflict(specimen, baseline.specimenVersion, targetStatus ?? specimen.status),
          );
        }

        // 2) 序号：事务内复查占用与跳号，防止两页同时占用同一序号
        const siblings = specimen
          ? await db.procedures.where('specimenId').equals(draft.specimenId).toArray()
          : [];
        const seqs = siblings.map((p) => p.seq);
        const nextSeq = seqs.length === 0 ? 1 : Math.max(...seqs) + 1;
        if (seqs.includes(draft.seq)) {
          conflicts.push({
            kind: 'procedure',
            id: '',
            title: `工序序号 #${draft.seq}`,
            expectedVersion: 0,
            actualVersion: 0,
            fields: [{ label: '序号占用', expected: `#${draft.seq} 可用`, actual: `已被占用，建议 #${nextSeq}` }],
          });
        } else if (draft.seq > nextSeq) {
          conflicts.push({
            kind: 'procedure',
            id: '',
            title: `工序序号 #${draft.seq}`,
            expectedVersion: 0,
            actualVersion: 0,
            fields: [{ label: '序号跳号', expected: `#${nextSeq}`, actual: `#${draft.seq}` }],
          });
        }

        // 3) 材料批次：逐个版本确认、库存确认（全部读完再统一报错）
        const lotPlans: Array<{ lot: SupplyLot; qty: number; issueId: string }> = [];
        for (const wanted of wantedLots) {
          const lot = await db.supplies.get(wanted.lotId);
          const expectedLotVersion = baseline.lotVersions[wanted.lotId] ?? 0;
          if (!lot) {
            conflicts.push({
              kind: 'supply',
              id: wanted.lotId,
              title: '材料批次（已被删除）',
              expectedVersion: expectedLotVersion,
              actualVersion: 0,
              fields: [{ label: '存在性', expected: '存在', actual: '已删除' }],
            });
            continue;
          }
          // 版本落后（别处刚扣/补过库存）或现存不够，都记入差异
          if (lot.version !== expectedLotVersion || wanted.qty > lot.qty) {
            conflicts.push(buildSupplyConflict(lot, expectedLotVersion, wanted.qty));
            continue;
          }
          lotPlans.push({ lot, qty: wanted.qty, issueId: newId('iss') });
        }

        // 任一对象版本失效或前置条件不满足：列出全部差异，整笔不写入
        if (conflicts.length > 0 || !specimen) {
          throw new ConcurrencyError(conflicts);
        }

        // ===== 写入阶段：全部对象已通过确认，在同一事务内落库 =====
        const procedureId = newId('prc');
        const materials: MaterialUsage[] = [];
        for (const plan of lotPlans) {
          const { lot, qty, issueId } = plan;
          const issue: SupplyIssue = {
            id: issueId,
            qty,
            operator: draft.operator,
            specimenNo: specimen.specimenNo,
            specimenId: specimen.id,
            procedureId,
            kind: 'procedure',
            issuedAt: draft.startedAt,
          };
          await db.supplies.put({
            ...lot,
            qty: lot.qty - qty,
            issues: [issue, ...lot.issues],
            version: lot.version + 1,
          });
          materials.push({
            lotId: lot.id,
            lotNo: lot.lotNo,
            name: lot.name,
            unit: lot.unit,
            qty,
            issueId,
          });
        }

        const record: PrepProcedure = {
          ...draft,
          materials,
          id: procedureId,
          version: 1,
        };
        await db.procedures.put(record);

        // 标本状态：与目标不一致才推进（标本版本已在上方确认）
        if (targetStatus && targetStatus !== specimen.status) {
          await db.specimens.put({
            ...specimen,
            status: targetStatus,
            version: specimen.version + 1,
          });
        }

        // 留痕影像
        if (photos && photos.length > 0) {
          await db.photos.bulkPut(photos.map((p) => ({ ...p, procedureId })));
        }

        return record;
      },
    );

    announceChange(['procedures', 'supplies', 'specimens', 'photos']);
    return created;
  },

  async finish(id, expectedVersion) {
    await db.transaction('rw', db.procedures, async () => {
      const current = await db.procedures.get(id);
      if (!current) {
        throw new ConcurrencyError([
          {
            kind: 'procedure',
            id,
            title: '工序（已被删除）',
            expectedVersion,
            actualVersion: 0,
            fields: [{ label: '存在性', expected: '存在', actual: '已删除' }],
          },
        ]);
      }
      // 别处刚完成/回退过该节点：旧版本立即失效，不覆盖
      if (current.version !== expectedVersion) {
        throw new ConcurrencyError([buildProcedureConflict(current, expectedVersion)]);
      }
      if (current.state === 'done') return;
      const next: PrepProcedure = {
        ...current,
        state: 'done' as ProcedureStateEnum,
        finishedAt: Date.now(),
        rollbackReason: undefined,
        version: current.version + 1,
      };
      await db.procedures.put(next);
    });
    announceChange(['procedures']);
  },

  async rollback(id, expectedVersion, reason) {
    await db.transaction('rw', db.procedures, db.supplies, async () => {
      const current = await db.procedures.get(id);
      if (!current) {
        throw new ConcurrencyError([
          {
            kind: 'procedure',
            id,
            title: '工序（已被删除）',
            expectedVersion,
            actualVersion: 0,
            fields: [{ label: '存在性', expected: '存在', actual: '已删除' }],
          },
        ]);
      }
      if (current.version !== expectedVersion) {
        throw new ConcurrencyError([buildProcedureConflict(current, expectedVersion)]);
      }

      // 仅已完成节点可回退；待办节点录错请删除后重录
      if (current.state === 'rolledback') {
        throw new Error('该节点已回退，不能重复回退');
      }
      if (current.state !== 'done') {
        throw new Error('仅已完成节点可回退；待办节点录错请删除后重录');
      }

      // 按该工序的领用记录逐条退回材料（同事务，与工序状态一次确认）
      const activeMaterials = current.materials.filter((m) => !m.returned);
      for (const m of activeMaterials) {
        const lot = await db.supplies.get(m.lotId);
        if (!lot) continue; // 批次已删除则无法退料，跳过该条但不破坏回退
        const issue = lot.issues.find((iss) => iss.id === m.issueId);
        // 领用记录未冲销过才退回，避免重复回退重复加库存
        if (!issue || issue.reversed) continue;
        const issues = lot.issues.map((iss) =>
          iss.id === m.issueId ? { ...iss, reversed: true, reversedAt: Date.now() } : iss,
        );
        await db.supplies.put({
          ...lot,
          qty: lot.qty + m.qty,
          issues,
          version: lot.version + 1,
        });
      }

      const materials = current.materials.map((m) =>
        activeMaterials.some((x) => x.lotId === m.lotId) ? { ...m, returned: true } : m,
      );
      const next: PrepProcedure = {
        ...current,
        state: 'rolledback',
        finishedAt: undefined,
        rollbackReason: reason,
        materials,
        version: current.version + 1,
      };
      await db.procedures.put(next);
    });
    announceChange(['procedures', 'supplies']);
  },

  async remove(id) {
    await db.procedures.delete(id);
    announceChange(['procedures']);
  },

  bySpecimen(specimenId) {
    return get()
      .items.filter((it) => it.specimenId === specimenId)
      .sort((a, b) => a.seq - b.seq);
  },
}));

subscribeChanges((msg) => {
  if (msg.tables.includes('procedures')) {
    void useProcedureStore.getState().load();
  }
});
