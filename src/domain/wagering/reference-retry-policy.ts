export class ReferenceRetryPolicy {
  constructor(
    readonly maxAttempts: number,
    private readonly baseDelayMs: number,
    private readonly maxDelayMs: number,
  ) {
    if (maxAttempts < 1) throw new Error('maxAttempts must be >= 1');
  }

  static default(): ReferenceRetryPolicy {
    return new ReferenceRetryPolicy(10, 2_000, 5 * 60_000);
  }

  nextCheckAt(attempt: number, now: Date): Date {
    const delay = Math.min(this.baseDelayMs * 2 ** (attempt - 1), this.maxDelayMs);
    return new Date(now.getTime() + delay);
  }
}
