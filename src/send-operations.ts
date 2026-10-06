import { createHash, randomUUID } from 'node:crypto';
import { AppError, SendOperationError } from './errors.js';

export const SEND_OPERATION_TTL_MS = 24 * 60 * 60_000;
export type SendState =
  'preparing' | 'submitting' | 'accepted' | 'partial' | 'rejected' | 'failed' | 'unknown';
export type SendReceipt = {
  operationId: string;
  accountId: string;
  state: SendState;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  messageId?: string;
  accepted?: unknown[];
  rejected?: unknown[];
};
type Entry = {
  owner: string;
  fingerprint: string;
  receipt: SendReceipt;
  promise?: Promise<any>;
  result?: any;
  error?: unknown;
};
export class SendOperations {
  private entries = new Map<string, Entry>();
  constructor(private now: () => number = Date.now) {}
  private key(owner: string, id: string) {
    return JSON.stringify([owner, id]);
  }
  private purge() {
    for (const [key, entry] of this.entries)
      if (
        !['preparing', 'submitting'].includes(entry.receipt.state) &&
        Date.parse(entry.receipt.expiresAt) <= this.now()
      )
        this.entries.delete(key);
  }
  get(owner: string, id: string): SendReceipt {
    this.purge();
    const entry = this.entries.get(this.key(owner, id));
    if (!entry) throw new AppError('NOT_FOUND', 'Send operation not found or expired.', 404);
    return { ...entry.receipt };
  }
  async execute(
    owner: string,
    accountId: string,
    id: string | undefined,
    payload: unknown,
    action: (setState: (state: SendState) => void) => Promise<any>,
  ) {
    this.purge();
    const operationId = id ?? randomUUID();
    const key = this.key(owner, operationId);
    const fingerprint = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const previous = this.entries.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint || previous.receipt.accountId !== accountId)
        throw new AppError(
          'IDEMPOTENCY_CONFLICT',
          'Operation ID was already used for different content.',
        );
      if (previous.promise) return previous.promise;
      if (previous.error) throw previous.error;
      return previous.result;
    }
    if (
      this.entries.size >= 5000 ||
      [...this.entries.values()].filter((e) => e.owner === owner).length >= 500
    )
      throw new AppError('SEND_QUOTA', 'Send operation capacity reached.', 429);
    const timestamp = new Date(this.now()).toISOString();
    const entry: Entry = {
      owner,
      fingerprint,
      receipt: {
        operationId,
        accountId,
        state: 'preparing',
        createdAt: timestamp,
        updatedAt: timestamp,
        expiresAt: new Date(this.now() + SEND_OPERATION_TTL_MS).toISOString(),
      },
    };
    this.entries.set(key, entry);
    const setState = (state: SendState) => {
      entry.receipt.state = state;
      entry.receipt.updatedAt = new Date(this.now()).toISOString();
    };
    entry.promise = Promise.resolve().then(async () => {
      try {
        const result = await action(setState);
        Object.assign(entry.receipt, {
          messageId: result.messageId,
          accepted: result.accepted,
          rejected: result.rejected,
        });
        setState(
          result.accepted.length ? (result.rejected.length ? 'partial' : 'accepted') : 'rejected',
        );
        entry.result = { ...result, operation: { ...entry.receipt } };
        return entry.result;
      } catch (cause) {
        const details = cause as {
          code?: unknown;
          responseCode?: unknown;
          command?: unknown;
        } | null;
        const rejection =
          details &&
          (details.code === 'EENVELOPE' ||
            (typeof details.responseCode === 'number' &&
              details.responseCode >= 400 &&
              details.responseCode <= 599 &&
              ['MAIL FROM', 'RCPT TO', 'DATA'].includes(String(details.command))));
        setState(
          entry.receipt.state === 'submitting' ? (rejection ? 'rejected' : 'unknown') : 'failed',
        );
        entry.error = new SendOperationError(operationId, cause, entry.receipt.state);
        throw entry.error;
      } finally {
        entry.promise = undefined;
      }
    });
    return entry.promise;
  }
}
