import { z } from 'zod';

export class RequestValidationError extends Error {
  readonly code = 'INVALID_PAYLOAD';

  constructor(readonly issues: { path: string; message: string }[]) {
    super('Request payload is invalid');
    this.name = 'RequestValidationError';
  }
}

const moneySchema = z.object({
  amount: z.string(),
  currency: z.string(),
});

const requiredText = z.string().trim().min(1);

export const openWalletSchema = z.object({
  playerId: requiredText,
  initialBalance: moneySchema,
});

export const wagerTransactionSchema = z.object({
  providerId: requiredText,
  externalTransactionId: requiredText,
  playerId: requiredText,
  walletId: z.uuid(),
  roundId: requiredText,
  gameId: requiredText,
  kind: z.enum(['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK']),
  money: moneySchema,
  referenceExternalTransactionId: requiredText.optional(),
});

export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new RequestValidationError(
      result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    );
  }
  return result.data;
}
