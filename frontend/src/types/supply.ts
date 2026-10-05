/** 工具材料种类 */
export type SupplyKind = '工具' | '磨料' | '胶种' | '耗材';

export const SUPPLY_KINDS: SupplyKind[] = ['工具', '磨料', '胶种', '耗材'];

/** 领用记录来源：工序节点确认时扣减 / 材料台账手动领用 */
export type SupplyIssueKind = 'procedure' | 'manual';

/** 工具材料批次 */
export interface SupplyLot {
  id: string;
  name: string;
  kind: SupplyKind;
  /** 规格 */
  spec: string;
  /** 批号 */
  lotNo: string;
  /** 在库数量 */
  qty: number;
  unit: string;
  /** 开封时间 */
  openedAt: number;
  /** 保质期（月） */
  shelfLifeMonths: number;
  /** 低量阈值 */
  lowThreshold: number;
  /** 领用记录（最新在前） */
  issues: SupplyIssue[];
  /** 乐观锁版本：批次在库数量/领用记录每次变动 +1，旧版本提交立即失效 */
  version: number;
}

/** 领用登记 */
export interface SupplyIssue {
  id: string;
  qty: number;
  operator: string;
  specimenNo: string;
  issuedAt: number;
  /** 来源类型（v3 之前的老数据按手动领用兼容） */
  kind?: SupplyIssueKind;
  /** 关联工序节点：工序确认扣料时写入，回退工序时据此退料/冲销 */
  procedureId?: string;
  /** 关联标本 id，便于回退时定位 */
  specimenId?: string;
  /** 回退冲销标记：被回退的领用不再计入有效领用 */
  reversed?: boolean;
  /** 冲销时间 */
  reversedAt?: number;
}

export type SupplyLotDraft = Omit<SupplyLot, 'id' | 'issues' | 'version'>;

/** 是否低量 */
export function isLowStock(lot: SupplyLot): boolean {
  return lot.qty <= lot.lowThreshold;
}

/** 剩余保质期天数（负数表示已过期） */
export function shelfLifeLeftDays(lot: SupplyLot, now = Date.now()): number {
  const expireAt = lot.openedAt + lot.shelfLifeMonths * 30 * 24 * 3600 * 1000;
  return Math.floor((expireAt - now) / (24 * 3600 * 1000));
}

/** 有效领用（未被工序回退冲销）数量合计 */
export function effectiveIssuedQty(lot: SupplyLot): number {
  return lot.issues
    .filter((i) => !i.reversed)
    .reduce((sum, i) => sum + i.qty, 0);
}
