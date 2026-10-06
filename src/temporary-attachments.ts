import { randomUUID } from 'node:crypto';
import { AppError } from './errors.js';
import { base64Bytes, MAX_OUTGOING_ATTACHMENT_BYTES } from './uploads.js';

export const ATTACHMENT_TTL_MS = 15 * 60_000;
export const ATTACHMENT_OWNER_BYTES = 50_000_000;
export const ATTACHMENT_GLOBAL_BYTES = 100_000_000;
type File = { filename: string; contentType: string; contentBase64: string };
type Entry = {
  owner: string;
  accountId: string;
  bytes: Buffer;
  filename: string;
  contentType: string;
  expiresAt: number;
  sourceKey?: string;
  timer?: ReturnType<typeof setTimeout>;
};

export class TemporaryAttachments {
  private entries = new Map<string, Entry>();
  constructor(private now: () => number = Date.now) {}
  private drop(id: string) {
    const entry = this.entries.get(id);
    if (entry?.timer) clearTimeout(entry.timer);
    this.entries.delete(id);
  }
  private purge() {
    for (const [id, entry] of this.entries) if (entry.expiresAt <= this.now()) this.drop(id);
  }
  put(owner: string, accountId: string, file: File, sourceKey?: string) {
    this.purge();
    if (sourceKey) {
      const existing = [...this.entries.entries()].find(
        ([, entry]) =>
          entry.owner === owner && entry.accountId === accountId && entry.sourceKey === sourceKey,
      );
      if (existing) {
        const [attachmentId, entry] = existing;
        return {
          attachmentId,
          filename: entry.filename,
          contentType: entry.contentType,
          size: entry.bytes.length,
          expiresAt: new Date(entry.expiresAt).toISOString(),
        };
      }
    }
    const size = base64Bytes(file.contentBase64);
    let ownerBytes = 0,
      totalBytes = 0,
      count = 0;
    for (const entry of this.entries.values()) {
      totalBytes += entry.bytes.length;
      if (entry.owner === owner) {
        ownerBytes += entry.bytes.length;
        count++;
      }
    }
    if (
      size > MAX_OUTGOING_ATTACHMENT_BYTES ||
      ownerBytes + size > ATTACHMENT_OWNER_BYTES ||
      totalBytes + size > ATTACHMENT_GLOBAL_BYTES ||
      count >= 20 ||
      this.entries.size >= 200
    )
      throw new AppError('UPLOAD_QUOTA', 'Temporary attachment capacity reached.', 429);
    const attachmentId = randomUUID(),
      expiresAt = this.now() + ATTACHMENT_TTL_MS;
    const entry: Entry = {
      owner,
      accountId,
      bytes: Buffer.from(file.contentBase64, 'base64'),
      filename: file.filename,
      contentType: file.contentType,
      expiresAt,
      sourceKey,
    };
    this.entries.set(attachmentId, entry);
    entry.timer = setTimeout(() => {
      this.drop(attachmentId);
    }, ATTACHMENT_TTL_MS);
    entry.timer.unref();
    return {
      attachmentId,
      filename: entry.filename,
      contentType: entry.contentType,
      size,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }
  get(owner: string, accountId: string, id: string) {
    this.purge();
    const entry = this.entries.get(id);
    if (!entry || entry.owner !== owner || entry.accountId !== accountId)
      throw new AppError('NOT_FOUND', 'Temporary attachment not found or expired.', 404);
    return { filename: entry.filename, contentType: entry.contentType, content: entry.bytes };
  }
  remove(owner: string, accountId: string, id: string) {
    this.get(owner, accountId, id);
    this.drop(id);
    return { removed: true };
  }
}
