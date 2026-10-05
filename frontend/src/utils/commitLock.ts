/**
 * 跨标签页提交互斥锁。
 *
 * IndexedDB 事务的快照隔离不跨标签页串行化：两个标签页同时提交时，
 * 可能都读到 v3、都通过校验、先后整对象覆盖。用 Web Locks
 * （同源跨标签页互斥）把「重读校验 + 写入」包成临界区，
 * 保证后提交者一定能看到先提交者的版本 +1。
 */

interface LockManagerLike {
  request: (name: string, callback: () => Promise<void> | void) => Promise<void>;
}

function getLockManager(): LockManagerLike | undefined {
  const nav = typeof navigator !== 'undefined' ? (navigator as Navigator & { locks?: LockManagerLike }) : undefined;
  return nav?.locks;
}

export async function withCommitLock<T>(task: () => Promise<T>): Promise<T> {
  const locks = getLockManager();
  if (!locks) {
    // 极少数环境无 Web Locks（http 非 localhost 旧浏览器）：退化为本标签页串行
    return task();
  }
  let result: T | undefined;
  await locks.request('gbfossilprep:commit', async () => {
    result = await task();
  });
  return result as T;
}
