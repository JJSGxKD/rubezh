/**
 * Ожидание с потолком для вызовов, у которых своего таймаута нет (CLAUDE.md,
 * «каждый await внешнего вызова — с таймаутом»). Сам вызов не отменяется —
 * отпускается только тот, кто его ждёт.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: нет ответа за ${ms} мс`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
