import { ImapFlow } from 'imapflow';
import { createHash } from 'node:crypto';
import { smtpTransport } from './smtp.js';
import { simpleParser, type ParsedMail } from 'mailparser';
import { convert } from 'html-to-text';
import type { z } from 'zod';
import type { FetchMessageObject } from 'imapflow';
import { buildSearchQuery, hasAttachmentParts } from './search.js';
import { replyHeaders } from './reply.js';
import { Accounts } from './accounts.js';
import { AppError, publicError } from './errors.js';
import type { Locale } from './i18n.js';
import { resolveMessageReference, type MessageRef } from './references.js';
import { TemporaryAttachments } from './temporary-attachments.js';
import { SendOperations, type SendState } from './send-operations.js';
import { MAX_OUTGOING_TOTAL_BYTES } from './uploads.js';
import {
  batchReadSchema,
  threadReadSchema,
  attachmentUploadSchema,
  attachmentRemoveSchema,
  sendStatusSchema,
} from './workflow-schemas.js';
import { RateLimit } from './auth.js';
import { Pop3, MAX_MESSAGE } from './pop3.js';
import { mailEndpoint } from './network.js';
import {
  listSchema,
  searchSchema,
  readSchema,
  messageReadSchema,
  sendSchema,
  replySchema,
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
  private uploads = new TemporaryAttachments();
  private operations = new SendOperations();
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
        if (p.folder !== 'INBOX' || p.before !== undefined || p.beforeUid !== undefined)
          throw new AppError('UNSUPPORTED', 'POP3 supports INBOX without IMAP pagination.');
        return this.pop(a, async (c) => ({
          messages: (await c.list())
            .slice(-p.limit)
            .reverse()
            .map((m) => ({
              ...m,
              messageRef: { accountId: p.accountId, folder: p.folder, messageId: m.messageId },
            })),
          folder: p.folder,
          protocol: 'pop3' as const,
        }));
      }
      return this.imap(a, async (c) => {
        const lock = await c.getMailboxLock(p.folder, { readOnly: true });
        try {
          const uidValidity = this.validity(c, p.uidValidity),
            box = c.mailbox;
          const empty = {
            folder: p.folder,
            messages: [],
            uidValidity,
            nextBefore: null,
            nextBeforeUid: null,
          };
          if (!box || !box.exists || p.beforeUid === 1) return empty;
          if (p.before !== undefined) {
            // Compatibility for existing browser clients using sequence positions.
            const end = Math.min(box.exists, p.before - 1);
            if (end < 1) return empty;
            const start = Math.max(1, end - p.limit + 1);
            const messages = await c.fetchAll(`${start}:${end}`, {
              uid: true,
              envelope: true,
              flags: true,
              size: true,
            });
            return {
              folder: p.folder,
              uidValidity,
              nextBefore: start > 1 ? start : null,
              nextBeforeUid: null,
              messages: messages
                .reverse()
                .map((m) => this.summary(m, p.accountId, p.folder, uidValidity)),
            };
          }
          const found = await c.search(
            p.beforeUid === undefined ? { all: true } : { uid: `1:${p.beforeUid - 1}` },
            { uid: true },
          );
          const uids = (Array.isArray(found) ? found : []).sort((a, b) => b - a);
          const page = uids.slice(0, p.limit);
          const messages = page.length
            ? await c.fetchAll(
                page,
                { uid: true, envelope: true, flags: true, size: true },
                { uid: true },
              )
            : [];
          messages.sort((a, b) => b.uid - a.uid);
          return {
            folder: p.folder,
            uidValidity,
            nextBeforeUid: uids.length > page.length ? page[page.length - 1]! : null,
            nextBefore:
              uids.length > page.length && messages.length
                ? messages[messages.length - 1]!.seq
                : null,
            messages: messages.map((m) => this.summary(m, p.accountId, p.folder, uidValidity)),
          };
        } finally {
          lock.release();
        }
      });
    });
  }
  private summary(m: FetchMessageObject, accountId: string, folder: string, uidValidity: string) {
    return {
      messageId: String(m.uid),
      messageRef: { accountId, folder, messageId: String(m.uid), uidValidity },
      subject: m.envelope?.subject?.slice(0, 1000),
      from: m.envelope?.from?.slice(0, 20),
      date: m.envelope?.date,
      flags: [...(m.flags ?? [])],
      size: m.size,
    };
  }
  search(owner: string, input: unknown) {
    return this.run(owner, async () => {
      const p = searchSchema.parse(input),
        a = this.accounts.get(owner, p.accountId);
      if (a.incoming?.protocol !== 'imap')
        throw new AppError('UNSUPPORTED', 'Search requires an IMAP account. POP3 has no search.');
      return this.imap(a, async (c) => {
        const lock = await c.getMailboxLock(p.folder, { readOnly: true });
        try {
          const uidValidity = this.validity(c, p.uidValidity);
          if (p.beforeUid === 1)
            return { folder: p.folder, uidValidity, total: 0, nextBeforeUid: null, messages: [] };
          // The provider evaluates every criterion and returns only matching UIDs.
          const found = await c.search(buildSearchQuery(p), { uid: true });
          const uids = (Array.isArray(found) ? found : []).sort((x, y) => y - x);
          const page = uids.slice(0, p.limit);
          const messages = page.length
            ? await c.fetchAll(
                page,
                { uid: true, envelope: true, flags: true, size: true, bodyStructure: true },
                { uid: true },
              )
            : [];
          return {
            folder: p.folder,
            uidValidity,
            total: uids.length,
            nextBeforeUid: uids.length > page.length ? page[page.length - 1]! : null,
            messages: messages
              .sort((x, y) => y.uid - x.uid)
              .map((m) => ({
                ...this.summary(m, p.accountId, p.folder, uidValidity),
                hasAttachments: hasAttachmentParts(m.bodyStructure),
              })),
          };
        } finally {
          lock.release();
        }
      });
    });
  }
  private async parsedMessage(owner: string, input: unknown) {
    const p = readSchema.parse(resolveMessageReference(input)),
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
          if (message.size !== undefined && message.source.length < message.size)
            throw new AppError(
              'MESSAGE_INCOMPLETE',
              'The mail server returned an incomplete message. Retry reading it before drafting a reply.',
              502,
            );
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
  private render(parsed: ParsedMail, p: z.output<typeof readSchema>, maxChars: number, offset = 0) {
    let text = parsed.text ?? '';
    if (!text.trim() && typeof parsed.html === 'string') text = convert(parsed.html);
    if (!text.trim())
      throw new AppError(
        'MESSAGE_BODY_UNAVAILABLE',
        'No readable message body could be extracted. The message may be empty or contain only attachments or unsupported content. Inspect it in your mail client or use attachments_list. Do not draft a reply assuming the message was read.',
        422,
      );
    if (offset > text.length)
      throw new AppError('INVALID_INPUT', 'Body offset exceeds the message length.');
    return {
      untrustedContent: true as const,
      messageId: p.messageId,
      messageRef: { ...p },
      rfcMessageId: parsed.messageId,
      replyTo: parsed.replyTo?.text,
      subject: parsed.subject,
      from: parsed.from?.text,
      to: Array.isArray(parsed.to) ? parsed.to.map((a) => a.text) : parsed.to?.text,
      date: parsed.date,
      text: text.slice(offset, offset + maxChars),
      truncated: offset > 0 || offset + maxChars < text.length,
      offset,
      totalChars: text.length,
      nextOffset: offset + maxChars < text.length ? offset + maxChars : null,
      attachments: parsed.attachments.map((a, index) => ({
        index,
        filename: safeFilename(a.filename, index),
        contentType: a.contentType,
        size: a.size,
      })),
    };
  }
  read(owner: string, input: unknown) {
    return this.run(owner, async () => {
      const { maxChars, offset, ...message } = messageReadSchema.parse(
        resolveMessageReference(input),
      );
      const { parsed, p } = await this.parsedMessage(owner, message);
      return this.render(parsed, p, maxChars, offset);
    });
  }
  private async readMany(
    owner: string,
    messages: MessageRef[],
    maxTotalChars: number,
    maxCharsPerMessage: number,
    locale: Locale,
    filter?: (parsed: ParsedMail) => boolean,
  ) {
    const results: (
      | { messageRef: MessageRef; status: 'read'; message: ReturnType<Mail['render']> }
      | { messageRef: MessageRef; status: 'error'; error: ReturnType<typeof publicError> }
      | { messageRef: MessageRef; status: 'budget_exhausted' }
    )[] = [];
    let remaining = maxTotalChars;
    for (const messageRef of messages) {
      if (!remaining) {
        results.push({ messageRef, status: 'budget_exhausted' });
        continue;
      }
      try {
        const { parsed, p } = await this.parsedMessage(owner, messageRef);
        if (filter && !filter(parsed)) continue;
        const message = this.render(parsed, p, Math.min(remaining, maxCharsPerMessage));
        remaining -= message.text.length;
        results.push({ messageRef, status: 'read', message });
      } catch (error) {
        results.push({ messageRef, status: 'error', error: publicError(error, locale) });
      }
    }
    return {
      results,
      returnedChars: maxTotalChars - remaining,
      truncated: results.some((r) => r.status !== 'read' || r.message.truncated),
    };
  }
  readBatch(owner: string, input: unknown, locale: Locale = 'en') {
    return this.run(owner, async () => {
      const p = batchReadSchema.parse(input);
      return this.readMany(owner, p.messages, p.maxTotalChars, p.maxCharsPerMessage, locale);
    });
  }
  thread(owner: string, input: unknown, locale: Locale = 'en') {
    return this.run(owner, async () => {
      const p = threadReadSchema.parse(input),
        a = this.accounts.get(owner, p.messageRef.accountId);
      if (a.incoming?.protocol !== 'imap')
        throw new AppError('UNSUPPORTED', 'Thread discovery requires IMAP.');
      const { parsed } = await this.parsedMessage(owner, p.messageRef);
      const headers = replyHeaders(parsed),
        root = headers.references[0]!,
        anchor = headers.inReplyTo;
      const ids = [...new Set([root, anchor])];
      const candidates = await this.imap(a, async (c) => {
        const lock = await c.getMailboxLock(p.messageRef.folder, { readOnly: true });
        try {
          this.validity(c, p.messageRef.uidValidity);
          if (p.beforeUid === 1) return [] as number[];
          const found = await c.search(
            {
              or: ids.flatMap((id) =>
                ['message-id', 'in-reply-to', 'references'].map((name) => ({
                  header: { [name]: id },
                })),
              ),
              ...(p.beforeUid === undefined ? {} : { uid: `1:${p.beforeUid - 1}` }),
            },
            { uid: true },
          );
          return (Array.isArray(found) ? found : []).sort((a, b) => b - a);
        } finally {
          lock.release();
        }
      });
      const page = candidates.slice(0, p.limit);
      const result = await this.readMany(
        owner,
        page
          .slice()
          .reverse()
          .map((uid) => ({ ...p.messageRef, messageId: String(uid) })),
        p.maxTotalChars,
        p.maxCharsPerMessage,
        locale,
        (mail) => {
          const references = Array.isArray(mail.references)
            ? mail.references
            : [mail.references ?? ''];
          const actual = [mail.messageId ?? '', mail.inReplyTo ?? '', ...references].flatMap(
            (value) => value.match(/<[^<>\s]+@[^<>\s]+>/g) ?? [],
          );
          return actual.some((id) => ids.includes(id));
        },
      );
      return {
        ...result,
        folder: p.messageRef.folder,
        rootMessageId: root,
        nextBeforeUid: candidates.length > page.length ? page[page.length - 1]! : null,
        truncated: result.truncated || candidates.length > page.length,
        scope: 'folder' as const,
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
      const { index, ...message } = attachmentSchema.parse(resolveMessageReference(input));
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
  uploadAttachment(owner: string, input: unknown) {
    const p = attachmentUploadSchema.parse(input);
    this.accounts.get(owner, p.accountId);
    return this.uploads.put(owner, p.accountId, p.file);
  }
  reuseAttachment(owner: string, input: unknown) {
    return this.run(owner, async () => {
      const p = attachmentSchema.parse(resolveMessageReference(input));
      const { parsed } = await this.parsedMessage(owner, {
        accountId: p.accountId,
        folder: p.folder,
        messageId: p.messageId,
        uidValidity: p.uidValidity,
      });
      const attachment = parsed.attachments[p.index];
      if (!attachment) throw new AppError('NOT_FOUND', 'Attachment not found.', 404);
      if (attachment.size > 5_000_000)
        throw new AppError('ATTACHMENT_SIZE', 'Attachment exceeds the 5 MB download limit.');
      const filename = safeFilename(attachment.filename, p.index);
      const sourceKey = createHash('sha256')
        .update(JSON.stringify({ ...p, filename, contentType: attachment.contentType }))
        .update(attachment.content)
        .digest('hex');
      return this.uploads.put(
        owner,
        p.accountId,
        {
          filename,
          contentType: attachment.contentType,
          contentBase64: attachment.content.toString('base64'),
        },
        sourceKey,
      );
    });
  }
  removeUpload(owner: string, input: unknown) {
    const p = attachmentRemoveSchema.parse(resolveMessageReference(input, true));
    this.accounts.get(owner, p.accountId);
    return this.uploads.remove(owner, p.accountId, p.attachmentId);
  }
  sendStatus(owner: string, input: unknown) {
    const p = sendStatusSchema.parse(input),
      result = this.operations.get(owner, p.operationId);
    this.accounts.get(owner, result.accountId);
    return result;
  }
  send(owner: string, input: unknown) {
    return this.run(owner, async () => {
      const p = sendSchema.parse(input),
        a = this.accounts.get(owner, p.accountId);
      const { operationId, ...payload } = p;
      return this.operations.execute(
        owner,
        p.accountId,
        operationId,
        { kind: 'send', ...payload },
        (setState) => this.deliver(owner, a, p, undefined, setState),
      );
    });
  }
  reply(owner: string, input: unknown) {
    return this.run(owner, async () => {
      const p = replySchema.parse(resolveMessageReference(input)),
        a = this.accounts.get(owner, p.accountId);
      if (!a.smtp) throw new AppError('UNSUPPORTED', 'Configure SMTP to send mail.');
      const { operationId, ...payload } = p;
      return this.operations.execute(
        owner,
        p.accountId,
        operationId,
        { kind: 'reply', ...payload },
        async (setState) => {
          const { parsed } = await this.parsedMessage(owner, {
            accountId: p.accountId,
            folder: p.folder,
            messageId: p.messageId,
            uidValidity: p.uidValidity,
          });
          const thread = replyHeaders(parsed);
          const sent = await this.deliver(
            owner,
            a,
            { ...p, subject: thread.subject },
            thread,
            setState,
          );
          return { ...sent, ...thread, to: p.to };
        },
      );
    });
  }
  private async deliver(
    owner: string,
    a: Account,
    p: z.output<typeof sendSchema>,
    thread?: ReturnType<typeof replyHeaders>,
    setState?: (state: SendState) => void,
  ) {
    this.sends.check(owner);
    const attachments = (p.attachments ?? []).map((attachment) =>
      'attachmentId' in attachment
        ? this.uploads.get(owner, a.id, attachment.attachmentId)
        : {
            filename: attachment.filename,
            contentType: attachment.contentType,
            content: Buffer.from(attachment.contentBase64, 'base64'),
          },
    );
    if (attachments.reduce((sum, file) => sum + file.content.length, 0) > MAX_OUTGOING_TOTAL_BYTES)
      throw new AppError('ATTACHMENT_TOTAL', 'Attachments exceed the 25 MB total limit.');
    const c = await this.smtp(a);
    try {
      setState?.('submitting');
      const sent = await c.sendMail({
        from: { name: a.senderName, address: a.email },
        replyTo: a.replyTo,
        to: p.to.map((address) => ({ address, name: '' })),
        subject: p.subject,
        inReplyTo: thread?.inReplyTo,
        references: thread?.references,
        text: p.text,
        attachments: attachments.map((file) => ({
          ...file,
          contentDisposition: 'attachment',
          contentTransferEncoding: 'base64',
        })),
      });
      return { messageId: sent.messageId, accepted: sent.accepted, rejected: sent.rejected };
    } finally {
      c.close();
    }
  }
  flag(owner: string, input: unknown) {
    return this.run(owner, async () => {
      const p = flagSchema.parse(resolveMessageReference(input, true));
      return this.imap(this.accounts.get(owner, p.accountId), async (c) => {
        const lock = await c.getMailboxLock(p.folder);
        try {
          this.validity(c, p.uidValidity);
          const flags = [p.flag === 'seen' ? '\\Seen' : '\\Flagged'];
          const result = p.value
            ? await c.messageFlagsAdd(String(p.uid), flags, { uid: true })
            : await c.messageFlagsRemove(String(p.uid), flags, { uid: true });
          return {
            updated: result,
            messageRef: {
              accountId: p.accountId,
              folder: p.folder,
              messageId: String(p.uid),
              uidValidity: p.uidValidity,
            },
          };
        } finally {
          lock.release();
        }
      });
    });
  }
  move(owner: string, input: unknown) {
    return this.run(owner, async () => {
      const p = moveSchema.parse(resolveMessageReference(input, true));
      return this.imap(this.accounts.get(owner, p.accountId), async (c) => {
        const lock = await c.getMailboxLock(p.folder);
        try {
          this.validity(c, p.uidValidity);
          const result = await c.messageMove(String(p.uid), p.destination, { uid: true });
          const destinationUid = result && result.uidMap?.get(p.uid);
          return {
            moved: !!result,
            messageRef:
              destinationUid && result.uidValidity
                ? {
                    accountId: p.accountId,
                    folder: p.destination,
                    messageId: String(destinationUid),
                    uidValidity: String(result.uidValidity),
                  }
                : undefined,
            refreshRequired: !destinationUid,
          };
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
