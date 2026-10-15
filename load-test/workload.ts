export interface LoadWallet {
  id: string;
  playerId: string;
  hot: boolean;
  openBets: { externalTransactionId: string; amount: string; roundId: string }[];
}

export interface WagerRequest {
  kind: string;
  idempotencyKey: string;
  body: Record<string, unknown>;
  replay: boolean;
  wallet: LoadWallet;
}

const HISTORY_SIZE = 500;

function randomAmount(min: number, max: number): string {
  const cents = Math.floor(min * 100 + Math.random() * (max - min) * 100);
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

function pick<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)]!;
}

export class Workload {
  private readonly history: WagerRequest[] = [];
  private sequence = 0;

  constructor(
    private readonly normal: LoadWallet[],
    private readonly hot: LoadWallet[],
    private readonly hotShare: number,
  ) {}

  next(): WagerRequest {
    const roll = Math.random();
    if (roll < 0.05 && this.history.length > 0) {
      return { ...pick(this.history), replay: true };
    }

    const wallet =
      this.hot.length > 0 && Math.random() < this.hotShare ? pick(this.hot) : pick(this.normal);
    const request =
      roll < 0.1 && wallet.openBets.length > 0
        ? this.refund(wallet)
        : roll < 0.2
          ? this.build(wallet, 'LOSS', '0.00')
          : roll < 0.35
            ? this.build(wallet, 'WIN', randomAmount(1, 20))
            : this.build(wallet, 'BET', randomAmount(1, 20));

    this.history.push(request);
    if (this.history.length > HISTORY_SIZE) {
      this.history.shift();
    }
    return request;
  }

  onResult(request: WagerRequest, status: string | undefined): void {
    if (request.replay || request.kind !== 'BET' || status !== 'PROCESSED') {
      return;
    }
    request.wallet.openBets.push({
      externalTransactionId: request.body.externalTransactionId as string,
      amount: (request.body.money as { amount: string }).amount,
      roundId: request.body.roundId as string,
    });
  }

  private refund(wallet: LoadWallet): WagerRequest {
    const bet = wallet.openBets.shift()!;
    return this.build(wallet, 'REFUND', bet.amount, bet);
  }

  private build(
    wallet: LoadWallet,
    kind: string,
    amount: string,
    reference?: { externalTransactionId: string; roundId: string },
  ): WagerRequest {
    this.sequence += 1;
    const externalTransactionId = `load-${process.pid}-${this.sequence}-${crypto.randomUUID().slice(0, 8)}`;
    return {
      kind,
      replay: false,
      wallet,
      idempotencyKey: `provider-load:${externalTransactionId}`,
      body: {
        providerId: 'provider-load',
        externalTransactionId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: reference?.roundId ?? `round-${this.sequence % 1000}`,
        gameId: 'fortune-chimp',
        kind,
        money: { amount, currency: 'BRL' },
        ...(reference ? { referenceExternalTransactionId: reference.externalTransactionId } : {}),
      },
    };
  }
}
