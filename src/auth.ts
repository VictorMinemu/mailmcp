import { createHash, randomBytes } from 'node:crypto';
import { AppError } from './errors.js';
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
type Grant = { owner: string; expires: number };
export class Auth {
  private links = new Map<string, Grant>();
  private sessions = new Map<string, Grant>();
  constructor(private now = () => Date.now()) {}
  private clean(map: Map<string, Grant>) {
    for (const [id, value] of map) if (value.expires <= this.now()) map.delete(id);
  }
  private issue(map: Map<string, Grant>, owner: string, duration: number) {
    this.clean(map);
    if (map.size >= 10_000) throw new AppError('CAPACITY', 'Authentication capacity reached.', 429);
    const token = randomBytes(32).toString('base64url');
    map.set(hash(token), { owner, expires: this.now() + duration });
    return token;
  }
  link(owner: string) {
    return this.issue(this.links, owner, 60_000);
  }
  session(owner: string) {
    return this.issue(this.sessions, owner, 3_600_000);
  }
  redeem(token: string) {
    const entry = this.links.get(hash(token));
    this.links.delete(hash(token));
    if (!entry || entry.expires <= this.now())
      throw new AppError('INVALID_TOKEN', 'Login link is invalid or expired.', 401);
    return this.session(entry.owner);
  }
  owner(token: string | undefined) {
    const entry = token && this.sessions.get(hash(token));
    if (!entry || entry.expires <= this.now())
      throw new AppError('UNAUTHORIZED', 'Sign in to continue.', 401);
    return entry.owner;
  }
  logout(token: string) {
    this.sessions.delete(hash(token));
  }
  revoke(owner: string) {
    for (const map of [this.links, this.sessions])
      for (const [key, value] of map) if (value.owner === owner) map.delete(key);
  }
}

export class RateLimit {
  private entries = new Map<string, { count: number; until: number }>();
  constructor(
    private limit: number,
    private windowMs: number,
    private now = () => Date.now(),
  ) {}
  check(key: string) {
    for (const [id, value] of this.entries) if (value.until <= this.now()) this.entries.delete(id);
    const entry = this.entries.get(key) ?? { count: 0, until: this.now() + this.windowMs };
    if (this.entries.size >= 10_000 && !this.entries.has(key))
      throw new AppError('RATE_LIMIT', 'Try again later.', 429);
    this.entries.set(key, entry);
    if (++entry.count > this.limit)
      throw new AppError('RATE_LIMIT', 'Too many requests. Try again later.', 429);
  }
}
