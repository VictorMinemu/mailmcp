import { randomUUID } from 'node:crypto';
import { accountSchema, accountPatch, type Account } from './schemas.js';
import type { Vault } from './vault.js';
import { AppError } from './errors.js';
import { assertMailHostAllowed } from './network.js';

export function redact(account: Account) {
  const { owner: _owner, incoming, smtp, ...profile } = account;
  const safe = (v: typeof incoming | typeof smtp) => {
    if (!v) return undefined;
    const { password: _secret, ...fields } = v;
    return { ...fields, hasPassword: true };
  };
  return { ...profile, incoming: safe(incoming), smtp: safe(smtp) };
}
export class Accounts {
  constructor(
    private vault: Vault,
    private allowedHosts: Set<string>,
  ) {}
  list(owner: string) {
    return this.vault
      .all()
      .filter((a) => a.owner === owner)
      .map(redact);
  }
  get(owner: string, id: string) {
    const result = this.vault.all().find((a) => a.owner === owner && a.id === id);
    if (!result) throw new AppError('NOT_FOUND', 'Account not found.', 404);
    return result;
  }
  private validateHosts(account: ReturnType<typeof accountSchema.parse>) {
    for (const connection of [account.incoming, account.smtp])
      if (connection) assertMailHostAllowed(connection.host, this.allowedHosts);
  }
  add(owner: string, input: unknown) {
    const parsed = accountSchema.parse(input);
    this.validateHosts(parsed);
    const accounts = this.vault.all();
    if (accounts.filter((a) => a.owner === owner).length >= 20 || accounts.length >= 10_000)
      throw new AppError('QUOTA', 'Account limit reached.', 429);
    const account: Account = {
      ...parsed,
      id: randomUUID(),
      owner,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    accounts.push(account);
    this.vault.replace(accounts);
    return redact(account);
  }
  update(owner: string, id: string, input: unknown) {
    const current = this.get(owner, id),
      patch = accountPatch.parse(input);
    const {
      id: _id,
      owner: _owner,
      createdAt: _created,
      updatedAt: _updated,
      ...profile
    } = current;
    const merged = { ...profile, ...patch };
    const parsed = accountSchema.parse({
      ...merged,
      incoming: merged.incoming ?? undefined,
      smtp: merged.smtp ?? undefined,
      replyTo: merged.replyTo ?? undefined,
    });
    this.validateHosts(parsed);
    const updated = {
      ...parsed,
      id,
      owner,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
    };
    this.vault.replace(
      this.vault.all().map((a) => (a.id === id && a.owner === owner ? updated : a)),
    );
    return redact(updated);
  }
  remove(owner: string, id: string) {
    this.get(owner, id);
    this.vault.replace(this.vault.all().filter((a) => !(a.owner === owner && a.id === id)));
    return { removed: true };
  }
}
