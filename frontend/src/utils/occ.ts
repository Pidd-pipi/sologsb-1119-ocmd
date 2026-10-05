import type { Specimen } from '../types/specimen';
import type { PrepProcedure } from '../types/procedure';
import type { SupplyLot } from '../types/supply';

/**
 * 乐观并发控制（OCC）。
 *
 * 每个对象带单调递增的 version：页面打开时记下版本，保存时带回。
 * 事务内重读最新数据比对版本：
 * - 版本一致才允许写入，写入后 version +1；
 * - 版本不一致（含对象被删除）立即抛 ConflictError，整笔事务回滚、不写入任何表，
 *   同时给出逐项差异供页面展示。
 */

/** 一行字段级差异 */
export interface VersionDiff {
  /** 对象中文名：标本 / 工序 / 材料批次 */
  objectLabel: string;
  /** 对象定位，如 FP-2024-0031 / 批号 B72-20240312 / 工序 #2 */
  objectKey: string;
  /** 打开页面时的版本 */
  expectedVersion: number | null;
  /** 保存时库里的实际版本；null 表示已被删除 */
  actualVersion: number | null;
  /** 差异字段明细：[字段中文名, 打开时的值, 现在的值] */
  changes: [string, string, string][];
  /** 冲突原因（已删除 / 序号被占用 / 库存不足等） */
  reason: string;
}

export class ConflictError extends Error {
  diffs: VersionDiff[];

  constructor(diffs: VersionDiff[]) {
    super(diffs.map((d) => `${d.objectLabel} ${d.objectKey}：${d.reason}`).join('；'));
    this.name = 'ConflictError';
    this.diffs = diffs;
  }
}

/** 打开页面时持有的版本基线 */
export interface VersionBase {
  specimenId: string;
  specimenVersion: number;
  /** 该标本全部工序的 id → version（序号冲突检测用） */
  procedureVersions: Record<string, number>;
  /** 领用批次 id → version 与打开时在库量 */
  lots: Record<string, { version: number; qty: number }>;
}

function fmtVal(v: unknown): string {
  if (v === undefined || v === null || v === '') return '空';
  if (typeof v === 'number') return String(v);
  return String(v);
}

/** 标本字段差异（状态是重点） */
export function diffSpecimen(base: Specimen | undefined, current: Specimen | undefined, key: string): VersionDiff | null {
  if (!current) {
    return {
      objectLabel: '标本',
      objectKey: key,
      expectedVersion: base?.version ?? null,
      actualVersion: null,
      changes: [],
      reason: '标本已被其它标签页删除',
    };
  }
  if (base && base.version === current.version) return null;
  const changes: [string, string, string][] = [];
  if (base) {
    if (base.status !== current.status) changes.push(['标本状态', fmtVal(base.status), fmtVal(current.status)]);
    if (base.storageBox !== current.storageBox) changes.push(['匣位', fmtVal(base.storageBox), fmtVal(current.storageBox)]);
  }
  return {
    objectLabel: '标本',
    objectKey: key,
    expectedVersion: base?.version ?? null,
    actualVersion: current.version,
    changes,
    reason: base
      ? `打开页面后已被改动（v${base.version} → v${current.version}）`
      : '基线缺失，请刷新后重试',
  };
}

/** 批次字段差异（在库数量是重点） */
export function diffLot(base: SupplyLot | undefined, current: SupplyLot | undefined, expectedVersion?: number): VersionDiff | null {
  const key = current?.lotNo ?? base?.lotNo ?? '';
  if (!current) {
    return {
      objectLabel: '材料批次',
      objectKey: key,
      expectedVersion: expectedVersion ?? base?.version ?? null,
      actualVersion: null,
      changes: [],
      reason: '批次已被其它标签页删除',
    };
  }
  const baseVersion = expectedVersion ?? base?.version;
  // 无任何版本基线时不判冲突（仅用于展示性比对）
  if (baseVersion === undefined) return null;
  if (baseVersion === current.version) return null;
  const changes: [string, string, string][] = [];
  if (base) {
    if (base.qty !== current.qty) changes.push(['在库数量', `${base.qty} ${base.unit}`, `${current.qty} ${current.unit}`]);
    if (base.lowThreshold !== current.lowThreshold) changes.push(['低量阈值', fmtVal(base.lowThreshold), fmtVal(current.lowThreshold)]);
  } else {
    changes.push(['批次版本', `v${baseVersion}`, `v${current.version}`]);
  }
  return {
    objectLabel: '材料批次',
    objectKey: current.lotNo ? `${current.name}（${current.lotNo}）` : current.name,
    expectedVersion: baseVersion,
    actualVersion: current.version,
    changes,
    reason: `选择/打开页面后已被领用或改动（v${baseVersion} → v${current.version}）`,
  };
}

/** 工序字段差异（完成/回退时用） */
export function diffProcedure(base: PrepProcedure | undefined, current: PrepProcedure | undefined, seq: number): VersionDiff | null {
  const key = `#${seq}`;
  if (!current) {
    return {
      objectLabel: '工序',
      objectKey: key,
      expectedVersion: base?.version ?? null,
      actualVersion: null,
      changes: [],
      reason: '工序已被其它标签页删除',
    };
  }
  if (base && base.version === current.version) return null;
  const stateLabel = (s?: PrepProcedure['state']) => (s === 'done' ? '已完成' : s === 'rolledback' ? '已回退' : '待办');
  const changes: [string, string, string][] = [];
  if (base) {
    if (base.state !== current.state) changes.push(['工序状态', stateLabel(base.state), stateLabel(current.state)]);
    if (base.nodeName !== current.nodeName) changes.push(['节点名称', fmtVal(base.nodeName), fmtVal(current.nodeName)]);
  }
  return {
    objectLabel: '工序',
    objectKey: key,
    expectedVersion: base?.version ?? null,
    actualVersion: current.version,
    changes,
    reason: base ? `打开页面后已被改动（v${base.version} → v${current.version}）` : '基线缺失，请刷新后重试',
  };
}

const procedureStateLabel = (s: PrepProcedure['state']): string =>
  s === 'done' ? '已完成' : s === 'rolledback' ? '已回退' : '待办';

/**
 * 比对打开页面时与现在的该标本工序时间线：
 * 别处新登记 / 删除 / 完成 / 回退都列为差异，旧版本整体失效。
 */
export function diffProcedureTimeline(baseList: PrepProcedure[], currentList: PrepProcedure[]): VersionDiff[] {
  const diffs: VersionDiff[] = [];
  const currentById = new Map(currentList.map((p) => [p.id, p]));
  const baseById = new Map(baseList.map((p) => [p.id, p]));

  for (const base of baseList) {
    const current = currentById.get(base.id);
    if (!current) {
      diffs.push({
        objectLabel: '工序',
        objectKey: `#${base.seq}`,
        expectedVersion: base.version,
        actualVersion: null,
        changes: [['工序状态', procedureStateLabel(base.state), '已删除']],
        reason: '工序已被其它标签页删除',
      });
    } else if (current.version !== base.version) {
      const changes: [string, string, string][] = [];
      if (base.state !== current.state) {
        changes.push(['工序状态', procedureStateLabel(base.state), procedureStateLabel(current.state)]);
      }
      if (base.seq !== current.seq) changes.push(['序号', `#${base.seq}`, `#${current.seq}`]);
      diffs.push({
        objectLabel: '工序',
        objectKey: `#${current.seq}`,
        expectedVersion: base.version,
        actualVersion: current.version,
        changes,
        reason: `打开页面后已被改动（v${base.version} → v${current.version}）`,
      });
    }
  }

  for (const current of currentList) {
    if (!baseById.has(current.id)) {
      diffs.push({
        objectLabel: '工序',
        objectKey: `#${current.seq}`,
        expectedVersion: null,
        actualVersion: current.version,
        changes: [
          ['工序状态', '—', procedureStateLabel(current.state)],
          ['节点名称', '—', current.nodeName],
        ],
        reason: '打开页面后其它标签页已新登记该工序',
      });
    }
  }

  return diffs;
}

/** 序号冲突：占用或跳号（基于事务内最新序列） */
export function checkSeqConflict(seq: number, currentList: PrepProcedure[]): VersionDiff | null {
  const occupied = currentList.find((p) => p.seq === seq);
  if (occupied) {
    return {
      objectLabel: '工序',
      objectKey: `#${seq}`,
      expectedVersion: null,
      actualVersion: occupied.version,
      changes: [['序号', `#${seq}（待保存）`, `已被「${occupied.nodeName}」占用`]],
      reason: '序号已被其它标签页占用',
    };
  }
  const maxSeq = currentList.reduce((m, p) => Math.max(m, p.seq), 0);
  if (seq > maxSeq + 1) {
    return {
      objectLabel: '工序',
      objectKey: `#${seq}`,
      expectedVersion: null,
      actualVersion: null,
      changes: [['当前最大序号', `#${maxSeq}`, `#${maxSeq}`]],
      reason: `序号跳号：最新最大序号为 ${maxSeq}，本节点必须用 ${maxSeq + 1}`,
    };
  }
  return null;
}

/** 一条领用行的版本 / 库存差异 */
export function checkMaterialLine(
  baseLot: SupplyLot | undefined,
  currentLot: SupplyLot | undefined,
  qty: number,
  expectedVersionOverride?: number,
): VersionDiff | null {
  // 基线之后新选的批次以「选中时版本」为准
  const expectedVersion = expectedVersionOverride ?? baseLot?.version;
  const versionDiff = diffLot(baseLot, currentLot, expectedVersion);
  if (!currentLot) return versionDiff;
  const changes = versionDiff?.changes ?? [];
  let reason = versionDiff?.reason ?? '';
  if (qty <= 0) {
    return {
      objectLabel: '材料批次',
      objectKey: currentLot.lotNo ? `${currentLot.name}（${currentLot.lotNo}）` : currentLot.name,
      expectedVersion: baseLot?.version ?? currentLot.version,
      actualVersion: currentLot.version,
      changes,
      reason: '领用数量必须大于 0',
    };
  }
  if (qty > currentLot.qty) {
    changes.push(['在库数量', `${currentLot.qty} ${currentLot.unit}（最新）`, `本次需领 ${qty} ${currentLot.unit}`]);
    reason = reason ? `${reason}；最新库存不足` : '最新在库数量不足，无法按打开页面时的数量领用';
  }
  if (!versionDiff && changes.length === 0) return null;
  return {
    objectLabel: '材料批次',
    objectKey: currentLot.lotNo ? `${currentLot.name}（${currentLot.lotNo}）` : currentLot.name,
    expectedVersion: expectedVersion ?? currentLot.version,
    actualVersion: currentLot.version,
    changes,
    reason: reason || '批次已被改动',
  };
}
