/** 工具材料种类 */
export type SupplyKind = '工具' | '磨料' | '胶种' | '耗材';

export const SUPPLY_KINDS: SupplyKind[] = ['工具', '磨料', '胶种', '耗材'];

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
  /**
   * 乐观锁版本：领用 / 退料时必须带回打开页面时的版本，
   * 被其他标签页改动后旧版本立即失效。
   */
  version: number;
}

/** 领用登记（工序提交时随事务生成；回退工序时按此记录退回材料） */
export interface SupplyIssue {
  id: string;
  qty: number;
  operator: string;
  specimenNo: string;
  issuedAt: number;
  /** 关联工序：有该字段的领用可随工序回退而退料 */
  procedureId?: string;
  /** 退料时间；已退料的记录不再重复退回 */
  returnedAt?: number;
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
