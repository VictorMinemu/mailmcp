import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  chmodSync,
  fsyncSync,
  lstatSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Account } from './schemas.js';
import { AppError } from './errors.js';

type State = { version: 1; accounts: Account[] };
const aad = Buffer.from('mailmcp:vault:v1');
export class Vault {
  private state: State = { version: 1, accounts: [] };
  private file: string;
  private lock: string;
  private closed = false;
  constructor(
    private dir: string,
    private key: Buffer,
  ) {
    if (key.length !== 32) throw new AppError('KEY', 'Encryption key must be 32 bytes.');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (lstatSync(dir).isSymbolicLink())
      throw new AppError('VAULT_PATH', 'Vault directory cannot be a symlink.');
    chmodSync(dir, 0o700);
    this.file = join(dir, 'vault.enc');
    this.lock = join(dir, 'vault.lock');
    let fd: number;
    try {
      fd = openSync(this.lock, 'wx', 0o600);
    } catch {
      throw new AppError(
        'VAULT_LOCKED',
        'Vault is locked. Stop the other process. After an unclean shutdown, remove vault.lock only after verifying no instance is running.',
      );
    }
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
    try {
      let encrypted: Buffer;
      try {
        encrypted = readFileSync(this.file);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
          this.persist(this.state);
          return;
        }
        throw e;
      }
      const decipher = createDecipheriv('aes-256-gcm', key, encrypted.subarray(0, 12));
      decipher.setAAD(aad);
      decipher.setAuthTag(encrypted.subarray(12, 28));
      this.state = JSON.parse(
        Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]).toString(),
      );
      if (this.state.version !== 1 || !Array.isArray(this.state.accounts))
        throw new Error('schema');
    } catch {
      this.close();
      throw new AppError(
        'VAULT_INVALID',
        'Cannot decrypt vault. Check the key or restore a valid backup.',
      );
    }
  }
  all() {
    return structuredClone(this.state.accounts);
  }
  replace(accounts: Account[]) {
    if (this.closed) throw new AppError('VAULT_CLOSED', 'Vault is closed.');
    const next: State = { version: 1, accounts: structuredClone(accounts) };
    this.persist(next);
    this.state = next;
  }
  private persist(state: State) {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(state), 'utf8'),
      cipher.final(),
    ]);
    const temp = join(this.dir, `.vault-${randomBytes(8).toString('hex')}.tmp`);
    const fd = openSync(temp, 'wx', 0o600);
    try {
      writeFileSync(fd, Buffer.concat([iv, cipher.getAuthTag(), ciphertext]));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, this.file);
    const directory = openSync(this.dir, 'r');
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  }
  close() {
    if (!this.closed) {
      this.closed = true;
      unlinkSync(this.lock);
    }
  }
}
