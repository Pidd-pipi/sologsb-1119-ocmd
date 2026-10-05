import 'fake-indexeddb/auto';
// @ts-expect-error 最小 navigator
globalThis.navigator = {};
// 模拟从 v2 老库升级到 v3：先按 v2 schema 建库灌无版本数据
const Dexie = (await import('dexie')).default;
const oldDb = new Dexie('gbfossilprep');
oldDb.version(1).stores({
  specimens: 'id, specimenNo, taxon, locality, status, createdAt',
  procedures: 'id, specimenId, seq, stepType, state',
  supplies: 'id, kind, lotNo, name',
  photos: 'id, specimenId, procedureId, stage',
});
oldDb.version(2).stores({
  specimens: 'id, specimenNo, taxon, locality, status, createdAt',
  procedures: 'id, specimenId, seq, stepType, state, startedAt',
  supplies: 'id, kind, lotNo, name, openedAt',
  photos: 'id, specimenId, procedureId, stage, capturedAt',
});
await oldDb.open();
await oldDb.table('specimens').put({
  id: 'olds1', specimenNo: 'OLD-1', taxon: 't', horizon: 'h', locality: 'l', lithology: 'r',
  matrixHardness: 1, dimensions: '1', weight: 1, storageBox: 'A', status: '待清修', createdAt: 1,
});
await oldDb.table('procedures').put({
  id: 'oldp1', specimenId: 'olds1', stepType: '清修', nodeName: '老节点', seq: 1, tools: [],
  abrasive: '', adhesive: '', adhesiveConc: 0, durationMin: 10, tempC: 20, rh: 50,
  photoBeforeIds: [], photoAfterIds: [], operator: '甲', startedAt: 1, state: 'pending',
});
await oldDb.table('supplies').put({
  id: 'oldlot1', name: '老胶', kind: '胶种', spec: '', lotNo: 'X', qty: 3, unit: '瓶',
  openedAt: 1, shelfLifeMonths: 12, lowThreshold: 1, issues: [],
});
await oldDb.close();

// 重新以当前 v3 打开，应自动迁移补 version/materials
const { db, ensureSeedData, DB_VERSION } = await import('../src/utils/db.ts');
await db.open();
console.log('结构版本 =', DB_VERSION);
const s = await db.specimens.get('olds1');
const p = await db.procedures.get('oldp1');
const lot = await db.supplies.get('oldlot1');
let ok = true;
const check = (c: boolean, m: string) => { console.log(c ? `  ✅ ${m}` : `  ❌ ${m}`); if (!c) ok = false; };
check(s.version === 1, '老标本补 version=1');
check(p.version === 1 && Array.isArray(p.materials) && p.materials.length === 0, '老工序补 version=1、materials=[]');
check(lot.version === 1, '老批次补 version=1');

// ensureSeedData 在空库可灌入（当前库非空，应直接跳过不报错）
await ensureSeedData();
const count = await db.specimens.count();
check(count === 1, '非空库 ensureSeedData 跳过（仍 1 件）');
await db.close();

// 全新空库：删除数据库后重新打开（Dexie 单例需重新 open），ensureSeedData 灌 v3 示范数据
await db.delete();
await db.open();
await ensureSeedData();
const specimens = await db.specimens.toArray();
const procs = await db.procedures.toArray();
const lotsFresh = await db.supplies.toArray();
check(specimens.length === 2 && specimens.every((x) => x.version === 1), '示范标本 2 件且 version=1');
check(procs.length === 2 && procs.every((x) => x.version === 1), '示范工序 2 条且 version=1');
check(lotsFresh.every((x) => typeof x.version === 'number'), '示范批次均带 version');
const doneProc = procs.find((x) => x.state === 'done')!;
check(doneProc.materials.length === 1, '已完成示范工序含 1 条领用材料');
const linked = lotsFresh.find((l) => l.id === doneProc.materials[0].lotId);
check(!!linked && linked.issues[0].procedureId === doneProc.id, '领用记录与工序互相指向');
process.exit(ok ? 0 : 1);
