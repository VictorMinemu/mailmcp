import { ImapFlow } from 'imapflow';
import { smtpTransport } from './smtp.js';
import { simpleParser } from 'mailparser';
import { Accounts } from './accounts.js';
import { AppError } from './errors.js';
import { RateLimit } from './auth.js';
import { Pop3, MAX_MESSAGE } from './pop3.js';
import { mailEndpoint } from './network.js';
import {
  listSchema,
  readSchema,
  sendSchema,
  flagSchema,
  moveSchema,
  attachmentSchema,
  type Account,
} from './schemas.js';

// Enforce limits in the protocol parser, before an untrusted server can allocate
// an oversized response. A FETCH size request alone is not a memory boundary.
export const IMAP_LIMITS = {
  maxLineLength: 64_000,
  maxLiteralSize: MAX_MESSAGE + 1,
  maxResponseSize: MAX_MESSAGE + 128_000,
};

export class Mail {
  private active = new Map<string, number>();
  private sends = new RateLimit(20, 3_600_000);
  constructor(
    private accounts: Accounts,
    private allowed: Set<string>,
  ) {}
  private async run<T>(owner: string, task: () => Promise<T>) {
    const total = [...this.active.values()].reduce((a, b) => a + b, 0);
    if ((this.active.get(owner) ?? 0) >= 3 || total >= 30)
      throw new AppError('BUSY', 'Too many concurrent mail operations.', 429);
    this.active.set(owner, (this.active.get(owner) ?? 0) + 1);
    try {
      return await task();
    } finally {
      const left = this.active.get(owner)! - 1;
      if (left) this.active.set(owner, left);
      else this.active.delete(owner);
    }
  }
  private async imap<T>(account: Account, callback: (client: ImapFlow) => Promise<T>) {
    const incoming = account.incoming;
    if (incoming?.protocol !== 'imap')
      throw new AppError('UNSUPPORTED', 'This operation requires IMAP.');
    const target = await mailEndpoint(incoming.host, this.allowed);
    const client = new ImapFlow({
      ...IMAP_LIMITS,
      host: target.address,
      port: incoming.port,
      secure: incoming.security === 'tls',
      doSTARTTLS: incoming.security === 'starttls' ? true : undefined,
      auth: { user: incoming.username, pass: incoming.password },
      logger: false,
      tls: { servername: target.servername, rejectUnauthorized: true, minVersion: 'TLSv1.2' },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    });
    client.on('error', () => {});
    const deadline = setTimeout(() => client.close(), 45_000);
    try {
      await client.connect();
      return await callback(client);
    } finally {
      clearTimeout(deadline);
      client.close();
    }
  }
  private async pop<T>(account: Account, callback: (client: Pop3) => Promise<T>) {
    const incoming = account.incoming;
    if (incoming?.protocol !== 'pop3')
      throw new AppError('UNSUPPORTED', 'This operation requires POP3.');
    const target = await mailEndpoint(incoming.host, this.allowed),
      client = new Pop3(target.address, target.servername, incoming.port);
    try {
      await client.login(incoming.username, incoming.password);
      return await callback(client);
    } finally {
      client.close();
    }
  }
  private async smtp(account: Account) {
    if (!account.smtp) throw new AppError('UNSUPPORTED', 'Configure SMTP to send mail.');
    const c = account.smtp,
      target = await mailEndpoint(c.host, this.allowed);
    return smtpTransport(c, target);
  }
  private validity(client: ImapFlow, expected?: string) {
    const current = client.mailbox && String(client.mailbox.uidValidity);
    if (!current || (expected && expected !== current))
      throw new AppError('STALE_MAILBOX', 'Mailbox identity changed. Refresh the message list.');
    return current;
  }
  verify(owner: string, id: string) {
    return this.run(owner, async () => {
      const a = this.accounts.get(owner, id);
      const result: string[] = [];
      if (a.incoming?.protocol === 'imap') {
        await this.imap(a, async () => true);
        result.push('imap');
      }
      if (a.incoming?.protocol === 'pop3') {
        await this.pop(a, (c) => c.list());
        result.push('pop3');
      }
      if (a.smtp) {
        const c = await this.smtp(a);
        try {
          await c.verify();
          result.push('smtp');
        } finally {
          c.close();
        }
      }
      return { verified: result };
    });
  }
  folders(owner: string, id: string) {
    return this.run(owner, async () => {
      const a = this.accounts.get(owner, id);
      if (a.incoming?.protocol === 'pop3') return [{ path: 'INBOX', name: 'INBOX' }];
      return this.imap(a, async (c) =>
        (await c.list())
          .slice(0, 500)
          .map((f) => ({ path: f.path, name: f.name, specialUse: f.specialUse })),
      );
    });
  }
  list(owner: string, input: unknown) {
    return this.run(owner, async () => {
      const p = listSchema.parse(input),
        a = this.accounts.get(owner, p.accountId);
      if (a.incoming?.protocol === 'pop3') {
        if (p.folder !== 'INBOX' || p.before)
          throw new AppError('UNSUPPORTED', 'POP3 supports INBOX without IMAP pagination.');
        return this.pop(a, async (c) => ({
          messages: (await c.list()).slice(-p.limit).reverse(),
          protocol: 'pop3',
        }));
      }
      return this.imap(a, async (c) => {
        const lock = await c.getMailboxLock(p.folder, { readOnly: true });
        try {
          const uidValidity = this.validity(c),
            box = c.mailbox;
          if (!box || !box.exists) return { messages: [], uidValidity };
          // Sequence-based pagination is bounded; UIDs returned identify subsequent operations.
          const end = Math.min(box.exists, (p.before ?? box.exists + 1) - 1);
          if (end < 1) return { messages: [], uidValidity };
          const start = Math.max(1, end - p.limit + 1);
          const messages = await c.fetchAll(`${start}:${end}`, {
            uid: true,
            envelope: true,
            flags: true,
            size: true,
          });
          return {
            uidValidity,
            nextBefore: start > 1 ? start : null,
            messages: messages.reverse().map((m) => ({
              messageId: String(m.uid),
              subject: m.envelope?.subject?.slice(0, 1000),
              from: m.envelope?.from?.slice(0, 20),
              date: m.envelope?.date,
              flags: [...(m.flags ?? [])],
              size: m.size,
            })),
          };
        } finally {
          lock.release();
        }
      });
    });
  }
  private async parsedMessage(owner: string, input: unknown) {
    const p = readSchema.parse(input),
      a = this.accounts.get(owner, p.accountId);
    let source: Buffer;
    if (a.incoming?.protocol === 'pop3') {
      if (p.folder !== 'INBOX') throw new AppError('UNSUPPORTED', 'POP3 supports INBOX only.');
      source = await this.pop(a, (c) => c.read(p.messageId));
    } else
      source = await this.imap(a, async (c) => {
        if (!/^[1-9]\d*$/.test(p.messageId) || !p.uidValidity)
          throw new AppError(
            'INVALID_INPUT',
            'IMAP reads require a numeric UID and UIDVALIDITY from the message list.',
          );
        const lock = await c.getMailboxLock(p.folder, { readOnly: true });
        try {
          this.validity(c, p.uidValidity);
          const message = await c.fetchOne(
            p.messageId,
            { source: { start: 0, maxLength: MAX_MESSAGE + 1 }, size: true },
            { uid: true },
          );
          if (!message || !message.source)
            throw new AppError('NOT_FOUND', 'Message not found.', 404);
          if (
            (message.size ?? message.source.length) > MAX_MESSAGE ||
            message.source.length > MAX_MESSAGE
          )
            throw new AppError('MESSAGE_SIZE', 'Message exceeds the 10 MB read limit.');
          return message.source;
        } finally {
          lock.release();
        }
      });
    const parsed = await simpleParser(source, {
      skipHtmlToText: false,
      skipTextToHtml: true,
      skipImageLinks: true,
    });
    return { parsed, p };
  }
  read(owner: string, input: unknown) {
    return this.run(owner, async () => {
      const { parsed, p } = await this.parsedMessage(owner, input);
      return {
        untrustedContent: true,
        messageId: p.messageId,
        subject: parsed.subject,
        from: parsed.from?.text,
        to: Array.isArray(parsed.to) ? parsed.to.map((a) => a.text) : parsed.to?.text,
        date: parsed.date,
        text: (parsed.text ?? '').slice(0, 100_000),
        truncated: (parsed.text?.length ?? 0) > 100_000,
        attachments: parsed.attachments.map((a, index) => ({
          index,
          filename: safeFilename(a.filename, index),
          contentType: a.contentType,
          size: a.size,
        })),
      };
    });
  }
  attachments(owner: string, input: unknown) {
    return this.run(owner, async () => {
      const { parsed } = await this.parsedMessage(owner, input);
      return parsed.attachments.map((a, index) => ({
        index,
        filename: safeFilename(a.filename, index),
        contentType: a.contentType,
        size: a.size,
      }));
    });
  }
  attachment(owner: string, input: unknown) {
    return this.run(owner, async () => {
      const { index, ...message } = attachmentSchema.parse(input);
      const { parsed } = await this.parsedMessage(owner, message);
      const a = parsed.attachments[index];
      if (!a) throw new AppError('NOT_FOUND', 'Attachment not found.', 404);
      if (a.size > 5_000_000)
        throw new AppError('ATTACHMENT_SIZE', 'Attachment exceeds the 5 MB download limit.');
      return {
        filename: safeFilename(a.filename, index),
        contentType: a.contentType,
        size: a.size,
        contentBase64: a.content.toString('base64'),
      };
    });
  }
  send(owner: string, input: unknown) {
    return this.run(owner, async () => {
      const p = sendSchema.parse(input),
        a = this.accounts.get(owner, p.accountId);
      this.sends.check(owner);
      const c = await this.smtp(a);
      try {
        const sent = await c.sendMail({
          from: { name: a.senderName, address: a.email },
          replyTo: a.replyTo,
          to: p.to.map((address) => ({ address, name: '' })),
          subject: p.subject,
          text: p.text,
        });
        return { messageId: sent.messageId, accepted: sent.accepted, rejected: sent.rejected };
      } finally {
        c.close();
      }
    });
  }
  flag(owner: string, input: unknown) {
    return this.run(owner, async () => {
      const p = flagSchema.parse(input);
      return this.imap(this.accounts.get(owner, p.accountId), async (c) => {
        const lock = await c.getMailboxLock(p.folder);
        try {
          this.validity(c, p.uidValidity);
          const flags = [p.flag === 'seen' ? '\\Seen' : '\\Flagged'];
          const result = p.value
            ? await c.messageFlagsAdd(String(p.uid), flags, { uid: true })
            : await c.messageFlagsRemove(String(p.uid), flags, { uid: true });
          return { updated: result };
        } finally {
          lock.release();
        }
      });
    });
  }
  move(owner: string, input: unknown) {
    return this.run(owner, async () => {
      const p = moveSchema.parse(input);
      return this.imap(this.accounts.get(owner, p.accountId), async (c) => {
        const lock = await c.getMailboxLock(p.folder);
        try {
          this.validity(c, p.uidValidity);
          const result = await c.messageMove(String(p.uid), p.destination, { uid: true });
          return { moved: !!result };
        } finally {
          lock.release();
        }
      });
    });
  }
  createFolder(owner: string, id: string, path: string) {
    return this.run(owner, () =>
      this.imap(this.accounts.get(owner, id), async (c) => ({
        created: !!(await c.mailboxCreate(path)),
      })),
    );
  }
}

export function safeFilename(name: string | undefined, index: number) {
  const basename = name
    ?.split(/[\\/]/)
    .pop()
    ?.replace(/[\x00-\x1f\x7f]/g, '')
    .trim()
    .slice(0, 200);
  return basename && basename !== '.' && basename !== '..'
    ? basename
    : `attachment-${index + 1}.bin`;
}
