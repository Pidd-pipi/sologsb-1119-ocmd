import type { Specimen, SpecimenStatus } from '../types/specimen';
import type { SupplyLot } from '../types/supply';
import type { PrepProcedure } from '../types/procedure';

/** 参与并发确认的对象类型 */
export type EntityKind = 'specimen' | 'supply' | 'procedure';

/** 冲突时给出的逐项差异（用于页面列出差异且不写入） */
export interface FieldDiff {
  /** 页面上的字段中文名 */
  label: string;
  /** 打开页面时基线值（提交所依据的值） */
  expected: string;
  /** 数据库当前值（别处刚确认的结果） */
  actual: string;
}

/** 单个对象的版本冲突描述 */
export interface EntityConflict {
  kind: EntityKind;
  id: string;
  /** 对象展示名：标本号 / 批号+名称 / 工序 #序号 */
  title: string;
  /** 打开页面时的版本 */
  expectedVersion: number;
  /** 数据库当前版本 */
  actualVersion: number;
  /** 字段级差异 */
  fields: FieldDiff[];
}

/**
 * 乐观锁冲突：保存时带上的任一对象版本落后于数据库当前版本，
 * 或数量/状态等业务前置条件不再满足（如库存不足）。
 * 抛出后整笔事务中止、绝不写入。
 */
export class ConcurrencyError extends Error {
  conflicts: EntityConflict[];

  constructor(conflicts: EntityConflict[]) {
    super(
      conflicts.length > 0
        ? `数据已被别处改动：${conflicts.map((c) => c.title).join('、')}`
        : '并发确认失败',
    );
    this.name = 'ConcurrencyError';
    this.conflicts = conflicts;
  }
}

function fmtText(value: unknown): string {
  if (value === undefined || value === null || value === '') return '—';
  return String(value);
}

/** 构造标本字段差异 */
export function buildSpecimenConflict(
  current: Specimen,
  expectedVersion: number,
  expectedStatus?: SpecimenStatus,
): EntityConflict {
  const fields: FieldDiff[] = [
    { label: '标本状态', expected: fmtText(expectedStatus), actual: current.status },
  ];
  return {
    kind: 'specimen',
    id: current.id,
    title: `标本 ${current.specimenNo}`,
    expectedVersion,
    actualVersion: current.version,
    fields,
  };
}

/** 构造材料批次字段差异 */
export function buildSupplyConflict(
  current: SupplyLot,
  expectedVersion: number,
  wantedQty?: number,
): EntityConflict {
  const fields: FieldDiff[] = [
    { label: '在库数量', expected: `版本 v${expectedVersion} 时的快照`, actual: `${current.qty} ${current.unit}` },
  ];
  if (wantedQty !== undefined && wantedQty > current.qty) {
    fields.push({
      label: '库存不足',
      expected: `本次需领用 ${wantedQty} ${current.unit}`,
      actual: `现存仅 ${current.qty} ${current.unit}`,
    });
  }
  return {
    kind: 'supply',
    id: current.id,
    title: `批次 ${current.lotNo} · ${current.name}`,
    expectedVersion,
    actualVersion: current.version,
    fields,
  };
}

/** 构造工序字段差异 */
export function buildProcedureConflict(
  current: PrepProcedure,
  expectedVersion: number,
): EntityConflict {
  const stateLabel = (s: PrepProcedure['state']) =>
    s === 'done' ? '已完成' : s === 'rolledback' ? '已回退' : '待办';
  const fields: FieldDiff[] = [
    { label: '工序状态', expected: `版本 v${expectedVersion} 时的快照`, actual: stateLabel(current.state) },
  ];
  return {
    kind: 'procedure',
    id: current.id,
    title: `工序 #${current.seq} ${current.nodeName}`,
    expectedVersion,
    actualVersion: current.version,
    fields,
  };
}
