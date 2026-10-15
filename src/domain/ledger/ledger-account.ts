import { WagerTransactionKind } from '../wagering/wager-transaction';

export enum LedgerAccountKind {
  PlayerWallet = 'PLAYER_WALLET',
  House = 'HOUSE',
  Funding = 'FUNDING',
}

export interface LedgerAccountState {
  code: string;
  kind: LedgerAccountKind;
  currency: string;
  walletId?: string;
  providerId?: string;
}

export class LedgerAccount {
  readonly code: string;
  readonly kind: LedgerAccountKind;
  readonly currency: string;
  readonly walletId: string | undefined;
  readonly providerId: string | undefined;

  private constructor(state: LedgerAccountState) {
    this.code = state.code;
    this.kind = state.kind;
    this.currency = state.currency;
    this.walletId = state.walletId;
    this.providerId = state.providerId;
  }

  static playerWallet(walletId: string, currency: string): LedgerAccount {
    return new LedgerAccount({
      code: `PLAYER:${walletId}`,
      kind: LedgerAccountKind.PlayerWallet,
      currency,
      walletId,
    });
  }

  static house(providerId: string, currency: string): LedgerAccount {
    return new LedgerAccount({
      code: `HOUSE:${providerId}:${currency}`,
      kind: LedgerAccountKind.House,
      currency,
      providerId,
    });
  }

  static funding(currency: string): LedgerAccount {
    return new LedgerAccount({
      code: `FUNDING:${currency}`,
      kind: LedgerAccountKind.Funding,
      currency,
    });
  }

  static counterpartyFor(
    kind: WagerTransactionKind,
    providerId: string,
    currency: string,
  ): LedgerAccount {
    return kind === WagerTransactionKind.Opening
      ? LedgerAccount.funding(currency)
      : LedgerAccount.house(providerId, currency);
  }

  static rehydrate(state: LedgerAccountState): LedgerAccount {
    return new LedgerAccount(state);
  }
}
