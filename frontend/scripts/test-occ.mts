/**
 * 临时验证：乐观锁事务的并发正确性。
 * 用法：node --import tsx scripts/test-occ.mts
 */
// 必须在导入 db 之前注入 fake-indexeddb（Dexie 在模块加载时就读全局 indexedDB）
import 'fake-indexeddb/auto';
if (typeof navigator === 'undefined') {
  // navigator.locks 缺失时 withCommitLock 直接执行（本脚本顺序 await 模拟）
  // @ts-expect-error 最小 navigator
  globalThis.navigator = {};
}

const { db } = await import('../src/utils/db.ts');
const { commitProcedure, finishProcedure, rollbackProcedure, setSpecimenStatus, issueSupply } = await import(
  '../src/services/prepService.ts'
);
const { ConflictError } = await import('../src/utils/occ.ts');

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`  ✅ ${msg}`);
  } else {
    failures += 1;
    console.error(`  ❌ ${msg}`);
  }
}

async function seed() {
  const now = Date.now();
  await db.specimens.bulkPut([
    // @ts-expect-error 最小测试记录
    {
      id: 'sp1',
      specimenNo: 'SP-1',
      taxon: 'T',
      horizon: 'h',
      locality: 'l',
      lithology: 'x',
      matrixHardness: 2,
      dimensions: '1',
      weight: 1,
      storageBox: 'A',
      status: '待清修',
      createdAt: now,
      version: 1,
    },
  ]);
  await db.supplies.bulkPut([
    // @ts-expect-error 最小测试记录
    { id: 'lot1', name: '磨料', kind: '磨料', spec: '', lotNo: 'L1', qty: 5, unit: '袋', openedAt: now, shelfLifeMonths: 12, lowThreshold: 1, issues: [], version: 3 },
    // @ts-expect-error 最小测试记录
    { id: 'lot2', name: '胶', kind: '胶种', spec: '', lotNo: 'L2', qty: 2, unit: '瓶', openedAt: now, shelfLifeMonths: 12, lowThreshold: 1, issues: [], version: 1 },
  ]);
}

const baseDraft = (seq: number) => ({
  specimenId: 'sp1',
  stepType: '清修' as const,
  nodeName: `节点${seq}`,
  seq,
  tools: [],
  abrasive: '',
  adhesive: '',
  adhesiveConc: 0,
  durationMin: 30,
  tempC: 20,
  rh: 50,
  photoBeforeIds: [],
  photoAfterIds: [],
  operator: '甲',
  startedAt: Date.now(),
  state: 'pending' as const,
});

const getSpecimen = async () => (await db.specimens.get('sp1'))!;
const getLot = async (id: string) => (await db.supplies.get(id))!;

// ---- 场景 1：两个标签页同版本提交（不同序号），后提交者因时间线/标本版本失效被拒 ----
console.log('\n[场景1] 同版本并发提交，后提交必须失败且不写入');
await seed();
const input1 = {
  specimenId: 'sp1',
  baseSpecimen: await getSpecimen(),
  baseProcedures: [],
  baseLots: [await getLot('lot1')],
  draft: baseDraft(1),
  materials: [{ lotId: 'lot1', qty: 2, expectedVersion: 3 }],
  nextStatus: '修复中' as const,
  withPhotos: false,
};
// 第二页同一时刻拿到完全相同的基线，也提交 #1（技师常开两页填同一件）
const input2 = JSON.parse(JSON.stringify(input1));
input2.draft.operator = '乙';
input2.materials = [{ lotId: 'lot1', qty: 2, expectedVersion: 3 }];

const r1 = await commitProcedure(input1);
assert(r1.procedure.seq === 1, '先提交者成功');
let blocked: unknown = null;
try {
  await commitProcedure(input2);
} catch (e) {
  blocked = e;
}
assert(blocked instanceof ConflictError, '后提交者抛 ConflictError');
const diffs = blocked instanceof ConflictError ? blocked.diffs : [];
assert(diffs.some((d) => d.objectLabel === '标本'), '差异含标本（状态已变）');
assert(diffs.some((d) => d.reason.includes('序号已被')), '差异含序号被占用');
assert(diffs.some((d) => d.objectLabel === '材料批次' && d.changes.some((c) => c[0] === '在库数量')), '差异含批次在库数量 5→3');
const lotAfter = await getLot('lot1');
assert(lotAfter.qty === 3, '后提交失败后批次仍只扣一次（qty=3），未被覆盖');
assert(lotAfter.version === 4, '批次版本只 +1 次（v4）');
assert(lotAfter.issues.length === 1, '只有 1 条领用记录');
const specimenAfter = await getSpecimen();
assert(specimenAfter.status === '修复中' && specimenAfter.version === 2, '标本状态为先提交者的结果');
const procCount = await db.procedures.count();
assert(procCount === 1, '工序只有 1 条，后提交未写入');

// ---- 场景 2：库存不足拒绝 ----
console.log('\n[场景2] 别处领用后最新库存不足，整笔不写入');
{
  const sp = await getSpecimen();
  const freshProcs = await db.procedures.where('specimenId').equals('sp1').toArray();
  const lot2 = await getLot('lot2');
  let e: unknown = null;
  try {
    await commitProcedure({
      specimenId: 'sp1',
      baseSpecimen: sp,
      baseProcedures: freshProcs,
      baseLots: [lot2],
      draft: { ...baseDraft(2), stepType: '加固' as const },
      materials: [{ lotId: 'lot2', qty: 2, expectedVersion: 1 }],
      nextStatus: null,
      withPhotos: false,
    });
  } catch (err) {
    e = err;
  }
  // 场景 2 中版本一致、库存也够（2==2）→ 应成功。再构造真正不足：
  assert(!(e instanceof ConflictError), '库存够（2/2）时提交成功');
  const lot2Again = await getLot('lot2');
  assert(lot2Again.qty === 0 && lot2Again.version === 2, 'lot2 扣到 0，版本 v2');

  const sp2 = await getSpecimen();
  const procs2 = await db.procedures.where('specimenId').equals('sp1').toArray();
  let e2: unknown = null;
  try {
    // 基线仍以为 lot2 有 2 个（v2 旧快照里 qty=0 也可构造版本冲突）；这里直接领超
    await commitProcedure({
      specimenId: 'sp1',
      baseSpecimen: sp2,
      baseProcedures: procs2,
      baseLots: [{ ...lot2 }], // 旧快照 qty=2 v1
      draft: { ...baseDraft(3), operator: '丙', startedAt: Date.now() },
      materials: [{ lotId: 'lot2', qty: 1, expectedVersion: 1 }],
      nextStatus: null,
      withPhotos: false,
    });
  } catch (err) {
    e2 = err;
  }
  assert(e2 instanceof ConflictError, '版本过期 + 库存不足时拒绝');
  const d2 = e2 instanceof ConflictError ? e2.diffs : [];
  assert(d2.some((d) => d.reason.includes('库存不足') || JSON.stringify(d).includes('库存不足')), '差异明确提示库存不足');
  assert((await db.procedures.count()) === 2, '工序未增加');
  assert((await getLot('lot2')).qty === 0, 'lot2 库存未变（仍 0）');
}

// ---- 场景 3：回退按领用记录退料 ----
console.log('\n[场景3] 回退工序按领用记录退回材料');
{
  const first = (await db.procedures.where('specimenId').equals('sp1').toArray()).find((p) => p.seq === 1)!;
  // 先完成
  const done = await finishProcedure(first);
  assert(done.state === 'done' && done.version === first.version + 1, '完成节点版本 +1');
  const beforeQty = (await getLot('lot1')).qty;
  const { procedure: rolled, lots } = await rollbackProcedure(done);
  assert(rolled.state === 'rolledback', '节点已回退');
  assert(rolled.materials.every((m) => typeof m.returnedAt === 'number'), '工序材料全部标记退回');
  const lot1 = lots.find((l) => l.id === 'lot1')!;
  assert(lot1.qty === beforeQty + 2, `批次库存加回 2（${beforeQty} → ${lot1.qty}）`);
  assert(lot1.issues[0].returnedAt !== undefined, '领用记录标记 returnedAt');
  assert(lot1.version === 5, '批次因退料再 +1（v5）');

  // 旧版本再回退必须失败
  let e: unknown = null;
  try {
    await rollbackProcedure(done);
  } catch (err) {
    e = err;
  }
  assert(e instanceof ConflictError, '拿旧版本重复回退被拒');
}

// ---- 场景 4：标本状态旧版本覆盖防护 ----
console.log('\n[场景4] 标本状态乐观锁');
{
  const sp = await getSpecimen();
  const next = await setSpecimenStatus(sp, '已加固');
  assert(next.status === '已加固' && next.version === sp.version + 1, '状态更新版本 +1');
  let e: unknown = null;
  try {
    await setSpecimenStatus(sp, '待交付'); // sp 是旧版本
  } catch (err) {
    e = err;
  }
  assert(e instanceof ConflictError, '旧版本改状态被拒，不覆盖别人结果');
  assert((await getSpecimen()).status === '已加固', '状态保持最新确认结果');
}

// ---- 场景 5：领用服务版本/库存校验 ----
console.log('\n[场景5] 材料台账领用乐观锁');
{
  const lot = await getLot('lot1');
  const next = await issueSupply(lot, { qty: 1, operator: '丁', specimenNo: 'SP-1' });
  assert(next.qty === lot.qty - 1, '领用扣减成功');
  let e: unknown = null;
  try {
    await issueSupply(lot, { qty: 1, operator: '丁', specimenNo: 'SP-1' });
  } catch (err) {
    e = err;
  }
  assert(e instanceof ConflictError, '旧批次版本领用被拒');
}

console.log(failures === 0 ? '\n全部断言通过 ✅' : `\n${failures} 个断言失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
