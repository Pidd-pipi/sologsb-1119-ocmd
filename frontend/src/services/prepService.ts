import { db } from '../utils/db';
import { newId } from '../utils/id';
import { withCommitLock } from '../utils/commitLock';
import { ConflictError, checkMaterialLine, checkSeqConflict, diffLot, diffProcedure, diffSpecimen, diffProcedureTimeline } from '../utils/occ';
import { makeSketchDataUrl } from '../types/photo';
import type { PrepProcedure, ProcedureMaterial } from '../types/procedure';
import type { SupplyIssue, SupplyLot } from '../types/supply';
import type { Specimen, SpecimenStatus } from '../types/specimen';

/**
 * 修复档案的全部「确认写入」入口。
 *
 * 每个方法都：
 * 1. 经 withCommitLock 跨标签页互斥；
 * 2. 在单个 IndexedDB 事务内重读最新记录、比对打开页面时的版本；
 * 3. 任一对象被别处改动（版本不一致 / 删除 / 序号被占 / 库存不足）即抛
 *    ConflictError 列出差异，事务回滚、不写入任何表；
 * 4. 通过则写入并把相关对象 version +1。
 */

/** 录入页一条领用行：选实际批次、填实际数量；expectedVersion 为选中时看到的版本 */
export interface MaterialLineInput {
  lotId: string;
  qty: number;
  expectedVersion?: number;
}

/** 保存节点的表单内容（不含 id/version/materials，这些在事务内定） */
export type ProcedureDraftCore = Omit<PrepProcedure, 'id' | 'version' | 'materials'>;

export interface CommitProcedureInput {
  specimenId: string;
  /** 打开页面时的标本基线（含 version） */
  baseSpecimen: Specimen;
  /** 打开页面时该标本的工序时间线基线 */
  baseProcedures: PrepProcedure[];
  /** 打开页面时材料批次基线（用于展示旧值；至少含所选批次） */
  baseLots: SupplyLot[];
  draft: ProcedureDraftCore;
  materials: MaterialLineInput[];
  /** 保存时一并确认的标本状态；null 表示本节点不改状态 */
  nextStatus: SpecimenStatus | null;
  /** 是否同时挂接修复前/后留痕影像（事务内生成） */
  withPhotos: boolean;
}

export interface CommitProcedureResult {
  procedure: PrepProcedure;
  specimen: Specimen;
  lots: SupplyLot[];
}

/** 一次确认：工序 + 材料批次扣减 + 标本状态，全成全败 */
export async function commitProcedure(input: CommitProcedureInput): Promise<CommitProcedureResult> {
  return withCommitLock(() =>
    db.transaction('rw', db.specimens, db.procedures, db.supplies, db.photos, async () => {
      const diffs = [];
      const { baseSpecimen, baseProcedures, baseLots, draft, materials, nextStatus } = input;

      // 1. 标本：重读、比对版本
      const specimen = await db.specimens.get(input.specimenId);
      const specimenKey = specimen?.specimenNo ?? baseSpecimen.specimenNo;
      const specimenDiff = diffSpecimen(baseSpecimen, specimen, specimenKey);
      if (specimenDiff) diffs.push(specimenDiff);
      if (!specimen) throw new ConflictError(diffs);

      // 2. 工序时间线：别处新增/删除/完成/回退均使旧版本失效；序号占用/跳号按最新序列判
      const freshProcedures = await db.procedures.where('specimenId').equals(input.specimenId).toArray();
      diffs.push(...diffProcedureTimeline(baseProcedures, freshProcedures));
      const seqDiff = checkSeqConflict(draft.seq, freshProcedures);
      if (seqDiff) diffs.push(seqDiff);

      // 3. 每个领用批次：版本 + 最新库存双重校验
      const baseLotById = new Map(baseLots.map((lot) => [lot.id, lot]));
      const seenLot = new Set<string>();
      for (const line of materials) {
        if (seenLot.has(line.lotId)) continue;
        seenLot.add(line.lotId);
        const freshLot = await db.supplies.get(line.lotId);
        // 该行「选中批次时看到的版本」优先；老行则回落到打开页面时的批次版本
        const expectedVersion =
          line.expectedVersion ?? baseLotById.get(line.lotId)?.version;
        const lineDiff = checkMaterialLine(baseLotById.get(line.lotId), freshLot, line.qty, expectedVersion);
        if (lineDiff) diffs.push(lineDiff);
      }

      if (diffs.length > 0) throw new ConflictError(diffs);

      // 4. 校验通过：扣料、生成领用记录
      const now = Date.now();
      const procedureId = newId('prc');
      const confirmedMaterials: ProcedureMaterial[] = [];
      const touchedLots: SupplyLot[] = [];

      for (const line of materials) {
        const lot = (await db.supplies.get(line.lotId))!;
        const issue: SupplyIssue = {
          id: newId('iss'),
          qty: line.qty,
          operator: draft.operator,
          specimenNo: specimen.specimenNo,
          issuedAt: now,
          procedureId,
        };
        const nextLot: SupplyLot = {
          ...lot,
          qty: lot.qty - line.qty,
          issues: [issue, ...lot.issues],
          version: lot.version + 1,
        };
        await db.supplies.put(nextLot);
        touchedLots.push(nextLot);
        confirmedMaterials.push({
          lotId: lot.id,
          lotNo: lot.lotNo,
          name: lot.name,
          unit: lot.unit,
          qty: line.qty,
          issueId: issue.id,
        });
      }

      // 5. 写工序（version 从 1 起）
      const procedure: PrepProcedure = {
        ...draft,
        id: procedureId,
        materials: confirmedMaterials,
        version: 1,
      };
      await db.procedures.put(procedure);

      // 6. 留痕影像（同事务，失败则整笔回滚）
      if (input.withPhotos) {
        const captionBase = `${draft.nodeName.trim()}（${specimen.specimenNo}）`;
        await db.photos.bulkPut([
          {
            id: newId('pho'),
            specimenId: specimen.id,
            procedureId,
            stage: 'before',
            caption: `${draft.nodeName.trim()} · 修复前（${specimen.specimenNo}）`,
            dataUrl: makeSketchDataUrl(`修复前 · ${specimen.specimenNo}`, '#6b5844'),
            capturedAt: now,
          },
          {
            id: newId('pho'),
            specimenId: specimen.id,
            procedureId,
            stage: 'after',
            caption: `${captionBase} · 修复后`,
            dataUrl: makeSketchDataUrl(`修复后 · ${specimen.specimenNo}`, '#3f5a4a'),
            capturedAt: now + 1,
          },
        ]);
      }

      // 7. 标本状态确认（有变化才 bump 版本）
      let nextSpecimen = specimen;
      if (nextStatus && nextStatus !== specimen.status) {
        nextSpecimen = { ...specimen, status: nextStatus, version: specimen.version + 1 };
        await db.specimens.put(nextSpecimen);
      }

      return { procedure, specimen: nextSpecimen, lots: touchedLots };
    }),
  );
}

/** 完成节点：带回打开页面时的工序版本 */
export async function finishProcedure(baseProcedure: PrepProcedure): Promise<PrepProcedure> {
  return withCommitLock(() =>
    db.transaction('rw', db.procedures, async () => {
      const fresh = await db.procedures.get(baseProcedure.id);
      const diff = diffProcedure(baseProcedure, fresh, baseProcedure.seq);
      if (diff) throw new ConflictError([diff]);
      const current = fresh!;
      if (current.state === 'done') {
        throw new ConflictError([
          {
            objectLabel: '工序',
            objectKey: `#${current.seq}`,
            expectedVersion: current.version,
            actualVersion: current.version,
            changes: [],
            reason: '该节点已被别处确认为完成，无需重复操作',
          },
        ]);
      }
      const next: PrepProcedure = { ...current, state: 'done', finishedAt: Date.now(), version: current.version + 1 };
      await db.procedures.put(next);
      return next;
    }),
  );
}

/**
 * 回退工序：状态回退，并按当时的领用记录逐条把材料退回批次
 * （同一批次已退过的不重复退；批次已删则整笔失败、不回退）。
 */
export async function rollbackProcedure(baseProcedure: PrepProcedure): Promise<{ procedure: PrepProcedure; lots: SupplyLot[] }> {
  return withCommitLock(() =>
    db.transaction('rw', db.procedures, db.supplies, async () => {
      const fresh = await db.procedures.get(baseProcedure.id);
      const diff = diffProcedure(baseProcedure, fresh, baseProcedure.seq);
      if (diff) throw new ConflictError([diff]);
      const current = fresh!;
      if (current.state !== 'done') {
        throw new ConflictError([
          {
            objectLabel: '工序',
            objectKey: `#${current.seq}`,
            expectedVersion: current.version,
            actualVersion: current.version,
            changes: [],
            reason: '仅已完成节点可以回退',
          },
        ]);
      }

      const now = Date.now();
      const touchedLots: SupplyLot[] = [];
      const nextMaterials = [...current.materials];
      const blockingDiffs = [];

      for (let i = 0; i < nextMaterials.length; i += 1) {
        const material = nextMaterials[i];
        if (material.returnedAt) continue;
        const lot = await db.supplies.get(material.lotId);
        if (!lot) {
          blockingDiffs.push({
            objectLabel: '材料批次',
            objectKey: material.lotNo ? `${material.name}（${material.lotNo}）` : material.name,
            expectedVersion: null,
            actualVersion: null,
            changes: [],
            reason: '批次已被删除，无法退回该批材料，回退已中止',
          });
          continue;
        }
        const issue = lot.issues.find((it) => it.id === material.issueId);
        if (!issue) {
          // 领用记录缺失也视为无法对账，阻止回退
          blockingDiffs.push({
            objectLabel: '材料批次',
            objectKey: material.lotNo ? `${material.name}（${material.lotNo}）` : material.name,
            expectedVersion: lot.version,
            actualVersion: lot.version,
            changes: [],
            reason: '找不到对应领用记录，无法退料，回退已中止',
          });
          continue;
        }
        if (issue.returnedAt) {
          nextMaterials[i] = { ...material, returnedAt: issue.returnedAt };
          continue;
        }
        const nextLot: SupplyLot = {
          ...lot,
          qty: lot.qty + material.qty,
          issues: lot.issues.map((it) => (it.id === issue.id ? { ...it, returnedAt: now } : it)),
          version: lot.version + 1,
        };
        await db.supplies.put(nextLot);
        touchedLots.push(nextLot);
        nextMaterials[i] = { ...material, returnedAt: now };
      }

      if (blockingDiffs.length > 0) throw new ConflictError(blockingDiffs);

      const next: PrepProcedure = {
        ...current,
        state: 'rolledback',
        finishedAt: undefined,
        materials: nextMaterials,
        version: current.version + 1,
      };
      await db.procedures.put(next);
      return { procedure: next, lots: touchedLots };
    }),
  );
}

/** 材料台账直接领用：带回打开页面时的批次版本与在库量 */
export async function issueSupply(
  baseLot: SupplyLot,
  payload: Omit<SupplyIssue, 'id' | 'issuedAt'>,
): Promise<SupplyLot> {
  return withCommitLock(() =>
    db.transaction('rw', db.supplies, async () => {
      const fresh = await db.supplies.get(baseLot.id);
      const diff = diffLot(baseLot, fresh);
      const diffs = diff ? [diff] : [];
      if (!fresh) throw new ConflictError(diffs);
      if (payload.qty <= 0 || payload.qty > fresh.qty) {
        diffs.push({
          objectLabel: '材料批次',
          objectKey: fresh.lotNo ? `${fresh.name}（${fresh.lotNo}）` : fresh.name,
          expectedVersion: baseLot.version,
          actualVersion: fresh.version,
          changes: [['在库数量', `${fresh.qty} ${fresh.unit}`, `需领 ${payload.qty} ${fresh.unit}`]],
          reason: `领用数量需在 1 ~ ${fresh.qty} ${fresh.unit} 之间`,
        });
      }
      if (diffs.length > 0) throw new ConflictError(diffs);

      const issue: SupplyIssue = { ...payload, id: newId('iss'), issuedAt: Date.now() };
      const next: SupplyLot = {
        ...fresh,
        qty: fresh.qty - payload.qty,
        issues: [issue, ...fresh.issues],
        version: fresh.version + 1,
      };
      await db.supplies.put(next);
      return next;
    }),
  );
}

/** 标本详情页改状态：带回打开页面时的标本版本 */
export async function setSpecimenStatus(
  baseSpecimen: Specimen,
  status: SpecimenStatus,
): Promise<Specimen> {
  return withCommitLock(() =>
    db.transaction('rw', db.specimens, async () => {
      const fresh = await db.specimens.get(baseSpecimen.id);
      const diff = diffSpecimen(baseSpecimen, fresh, baseSpecimen.specimenNo);
      if (diff) throw new ConflictError([diff]);
      const current = fresh!;
      if (current.status === status) return current;
      const next = { ...current, status, version: current.version + 1 };
      await db.specimens.put(next);
      return next;
    }),
  );
}
