export type AttemptRecord = { count: number; lastTs: number };

export default class UserLocks {
  // normalized by string user id to support numeric and string ids
  private queues: Map<string, Promise<void>> = new Map();
  private attempts: Map<string, Map<string, AttemptRecord>> = new Map();

  // Run function exclusively per user. Optional timeout in ms.
  async runExclusive<T>(userId: string | number, fn: () => Promise<T>, timeoutMs?: number): Promise<T> {
    const uid = String(userId);
    const prev = this.queues.get(uid) || Promise.resolve();

    let resolveNext: () => void = () => {};
    const next = new Promise<void>((res) => { resolveNext = res; });
    this.queues.set(uid, prev.then(() => next));

    try {
      // Ensure we start this task only after previous queue entry resolves
      await prev;
      const task = fn();
      if (timeoutMs && timeoutMs > 0) {
        const timeout = new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error('COMMAND_TIMEOUT')), timeoutMs)
        );
        const result = await Promise.race([task, timeout]);
        resolveNext();
        return result as T;
      }
      const result = await task;
      resolveNext();
      return result;
    } catch (err) {
      // ensure next in queue continues
      resolveNext();
      throw err;
    } finally {
      // cleanup queue head
      const head = this.queues.get(uid);
      if (head && head === next) {
        this.queues.delete(uid);
      }
    }
  }

  // Attempt limiter: returns true if attempt allowed and increments counter
  canAttempt(userId: string | number, command: string, maxAttempts: number, resetAfterMs: number): boolean {
    const uid = String(userId);
    let userMap = this.attempts.get(uid);
    const now = Date.now();
    if (!userMap) {
      userMap = new Map();
      this.attempts.set(uid, userMap);
    }

    const rec = userMap.get(command);
    if (!rec) {
      userMap.set(command, { count: 1, lastTs: now });
      return true;
    }

    // reset if older than resetAfterMs
    if (now - rec.lastTs > resetAfterMs) {
      userMap.set(command, { count: 1, lastTs: now });
      return true;
    }

    if (rec.count >= maxAttempts) return false;
    rec.count += 1;
    rec.lastTs = now;
    userMap.set(command, rec);
    return true;
  }

  // Clear attempts (call after successful command)
  clearAttempts(userId: string | number, command: string) {
    const uid = String(userId);
    const userMap = this.attempts.get(uid);
    if (!userMap) return;
    userMap.delete(command);
  }
}

// Shared singleton for cross-module locking
export const userLocks = new UserLocks();
