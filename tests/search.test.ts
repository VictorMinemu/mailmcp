import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createTcpServer, type Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ImapFlow } from 'imapflow';
import { Vault } from '../src/vault.js';
import { Accounts } from '../src/accounts.js';
import { Mail, IMAP_LIMITS } from '../src/mail.js';
import { searchSchema } from '../src/schemas.js';
import { buildSearchQuery, hasAttachmentParts } from '../src/search.js';

test('search schema requires at least one criterion and validates dates, sizes and cursors', () => {
  const base = { accountId: '9f0c4a2e-2c1d-4f3b-9a44-2b1e9c1d7a10' };
  assert.throws(() => searchSchema.parse(base), /criterion/i);
  assert.throws(() => searchSchema.parse({ ...base, limit: 20 }), /criterion/i);
  assert.throws(() => searchSchema.parse({ ...base, dateFrom: '2026/09/01' }));
  assert.throws(() => searchSchema.parse({ ...base, dateFrom: '2026-13-01' }));
  assert.throws(() =>
    searchSchema.parse({ ...base, dateFrom: '2026-09-02', dateTo: '2026-09-01' }),
  );
  assert.throws(() => searchSchema.parse({ ...base, minSize: 500, maxSize: 100 }));
  assert.throws(() => searchSchema.parse({ ...base, query: 'a\r\nb' }));
  assert.throws(() => searchSchema.parse({ ...base, query: 'x'.repeat(257) }));
  assert.throws(() => searchSchema.parse({ ...base, query: 'ok', beforeUid: 0 }));
  assert.throws(() => searchSchema.parse({ ...base, query: 'ok', limit: 51 }));
  assert.throws(() => searchSchema.parse({ ...base, query: 'ok', owner: 'other' }));
  const parsed = searchSchema.parse({ ...base, unread: true });
  assert.equal(parsed.folder, 'INBOX');
  assert.equal(parsed.limit, 20);
});

test('search criteria compile to provider-side IMAP SEARCH keys', () => {
  const query = buildSearchQuery(
    searchSchema.parse({
      accountId: '9f0c4a2e-2c1d-4f3b-9a44-2b1e9c1d7a10',
      query: 'invoice',
      sender: 'ana@example.com',
      recipient: 'team@example.com',
      subjectContains: 'Q3',
      bodyContains: 'due Friday',
      dateFrom: '2026-09-01',
      dateTo: '2026-09-14',
      unread: true,
      starred: false,
      answered: true,
      hasAttachments: true,
      minSize: 1024,
      maxSize: 5_000_000,
      beforeUid: 4821,
    }),
  );
  assert.equal(query.text, 'invoice');
  assert.equal(query.from, 'ana@example.com');
  assert.deepEqual(query.or, [{ to: 'team@example.com' }, { cc: 'team@example.com' }]);
  assert.equal(query.subject, 'Q3');
  assert.equal(query.body, 'due Friday');
  assert.equal((query.since as Date).toISOString(), '2026-09-01T00:00:00.000Z');
  // dateTo is inclusive: BEFORE is exclusive, so the cursor is the following midnight.
  assert.equal((query.before as Date).toISOString(), '2026-09-15T00:00:00.000Z');
  assert.equal(query.seen, false);
  assert.equal(query.flagged, false);
  assert.equal(query.answered, true);
  assert.deepEqual(query.header, { 'content-type': 'multipart/mixed' });
  assert.equal(query.larger, 1024);
  assert.equal(query.smaller, 5_000_000);
  assert.equal(query.uid, '1:4820');
  assert.equal(query.all, undefined);

  const negative = buildSearchQuery(
    searchSchema.parse({
      accountId: '9f0c4a2e-2c1d-4f3b-9a44-2b1e9c1d7a10',
      unread: false,
      hasAttachments: false,
      beforeUid: 1,
    }),
  );
  assert.equal(negative.seen, true);
  assert.deepEqual(negative.not, { header: { 'content-type': 'multipart/mixed' } });
  assert.equal(negative.uid, undefined, 'beforeUid 1 has nothing older; no impossible range');
  assert.equal(negative.header, undefined);
});

test('attachment detection reads the body structure without downloading parts', () => {
  const text = { type: 'text/plain' };
  assert.equal(
    hasAttachmentParts({ type: 'message/rfc822', disposition: 'attachment', childNodes: [text] }),
    true,
  );
  assert.equal(hasAttachmentParts(text), false);
  assert.equal(hasAttachmentParts(undefined), false);
  assert.equal(
    hasAttachmentParts({
      type: 'multipart/alternative',
      childNodes: [text, { type: 'text/html' }],
    }),
    false,
  );
  assert.equal(
    hasAttachmentParts({
      type: 'multipart/related',
      childNodes: [{ type: 'text/html' }, { type: 'image/png', disposition: 'inline' }],
    }),
    false,
    'inline images are not attachments',
  );
  assert.equal(
    hasAttachmentParts({
      type: 'multipart/mixed',
      childNodes: [text, { type: 'application/pdf', disposition: 'attachment' }],
    }),
    true,
  );
  assert.equal(
    hasAttachmentParts({
      type: 'multipart/mixed',
      childNodes: [text, { type: 'image/png', parameters: { name: 'photo.png' } }],
    }),
    true,
    'named non-text parts count as attachments',
  );
});

test(
  'messages_search runs on the provider and returns pages newest first',
  { timeout: 15000 },
  async () => {
    const commands: string[] = [];
    const sockets = new Set<Socket>();
    const envelope = (uid: number, subject: string) =>
      `ENVELOPE ("Mon, 1 Sep 2026 10:0${uid % 10}:00 +0000" "${subject}" (("Ana" NIL "ana" "example.com")) NIL NIL (("Alice" NIL "alice" "example.com")) NIL NIL NIL "<m${uid}@example.com>")`;
    const structure = (withFile: boolean) =>
      withFile
        ? 'BODYSTRUCTURE (("text" "plain" ("charset" "utf-8") NIL NIL "7bit" 12 1 NIL NIL NIL NIL)("application" "pdf" ("name" "invoice.pdf") NIL NIL "base64" 2048 NIL ("attachment" ("filename" "invoice.pdf")) NIL NIL) "mixed" ("boundary" "b1") NIL NIL NIL)'
        : 'BODYSTRUCTURE ("text" "plain" ("charset" "utf-8") NIL NIL "7bit" 12 1 NIL NIL NIL NIL)';
    const imap = createTcpServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => {});
      socket.write('* PREAUTH [CAPABILITY IMAP4rev1] Synthetic mailbox ready\r\n');
      let pending = '';
      socket.on('data', (chunk) => {
        pending += chunk.toString();
        while (pending.includes('\r\n')) {
          const at = pending.indexOf('\r\n'),
            line = pending.slice(0, at);
          pending = pending.slice(at + 2);
          commands.push(line);
          const [tag, ...parts] = line.split(' '),
            cmd = parts.join(' ');
          if (cmd === 'CAPABILITY')
            socket.write('* CAPABILITY IMAP4rev1\r\n' + tag + ' OK capability\r\n');
          else if (cmd.startsWith('LIST'))
            socket.write('* LIST (\\HasNoChildren) "/" "INBOX"\r\n' + tag + ' OK list\r\n');
          else if (cmd.startsWith('EXAMINE'))
            socket.write(
              '* FLAGS (\\Seen \\Flagged)\r\n* 40 EXISTS\r\n* OK [UIDVALIDITY 42] valid\r\n* OK [UIDNEXT 5000] next\r\n' +
                tag +
                ' OK [READ-ONLY] examined\r\n',
            );
          else if (cmd.startsWith('UID SEARCH')) {
            // The synthetic provider matches three messages regardless of criteria, unless the
            // UID range excludes the newest one, which exercises cursor pagination.
            const ceiling = Number(/UID 1:(\d+)/.exec(cmd)?.[1] ?? Infinity);
            const hits = [7, 4821, 4809].filter((uid) => uid <= ceiling);
            socket.write('* SEARCH ' + hits.join(' ') + '\r\n' + tag + ' OK search\r\n');
          } else if (cmd.startsWith('UID FETCH')) {
            const set = parts[2]!.split(',').map(Number);
            set
              .sort((a, b) => a - b)
              .forEach((uid, index) =>
                socket.write(
                  `* ${index + 1} FETCH (UID ${uid} FLAGS (${uid === 7 ? '\\Seen' : ''}) RFC822.SIZE ${uid * 3} ${envelope(uid, uid === 4821 ? 'Q3 filing' : 'Receipt')} ${structure(uid === 4821)})\r\n`,
                ),
              );
            socket.write(tag + ' OK fetched\r\n');
          } else if (cmd === 'LOGOUT') socket.end('* BYE\r\n' + tag + ' OK logout\r\n');
          else socket.write(tag + ' BAD unexpected test command\r\n');
        }
      });
    });
    const dir = mkdtempSync(join(tmpdir(), 'mailmcp-search-')),
      vault = new Vault(dir, randomBytes(32));
    const accounts = new Accounts(vault, new Set(['mail.example.com'])),
      mail = new Mail(accounts, new Set());
    try {
      await new Promise<void>((r) => imap.listen(0, '127.0.0.1', r));
      const port = (imap.address() as any).port;
      // Only the network adapter is replaced; the real IMAP client and response parsing run.
      (mail as any).imap = async (_account: unknown, callback: any) => {
        const c = new ImapFlow({
          ...IMAP_LIMITS,
          host: '127.0.0.1',
          port,
          secure: false,
          doSTARTTLS: false,
          auth: { user: 'test', pass: 'test' },
          logger: false,
          disableAutoIdle: true,
        });
        c.on('error', () => {});
        try {
          await c.connect();
          return await callback(c);
        } finally {
          c.close();
        }
      };
      const connection = {
        host: 'mail.example.com',
        port: 993,
        security: 'tls' as const,
        username: 'alice',
        password: 'synthetic',
      };
      const account = accounts.add('alice', {
        label: 'Fixture',
        email: 'alice@example.com',
        senderName: 'Alice',
        incoming: { ...connection, protocol: 'imap' },
      });
      const first = await mail.search('alice', {
        accountId: account.id,
        sender: 'ana',
        subjectContains: 'Q3',
        dateFrom: '2026-09-01',
        unread: true,
        limit: 2,
      });
      assert.equal(first.uidValidity, '42');
      assert.equal(first.total, 3);
      assert.equal(first.nextBeforeUid, 4809);
      assert.deepEqual(
        first.messages.map((m) => m.messageId),
        ['4821', '4809'],
        'newest UID first, bounded by limit',
      );
      assert.equal(first.messages[0]!.subject, 'Q3 filing');
      assert.equal(first.messages[0]!.hasAttachments, true);
      assert.equal(first.messages[1]!.hasAttachments, false);
      assert.deepEqual(first.messages[0]!.from, [{ name: 'Ana', address: 'ana@example.com' }]);
      assert.deepEqual(first.messages[0]!.flags, []);
      assert.equal(first.messages[0]!.size, 4821 * 3);
      const search = commands.find((c) => /UID SEARCH/.test(c))!;
      assert.match(search, /FROM "?ana"?/);
      assert.match(search, /SUBJECT "?Q3"?/);
      assert.match(search, /SINCE 0?1-Sep-2026/);
      assert.match(search, /UNSEEN/);
      assert.ok(
        commands.some((c) => /EXAMINE/.test(c)),
        'search opens the folder read-only',
      );
      assert.ok(
        !commands.some((c) => /BODY\[|BODY\.PEEK|STORE|SELECT/.test(c)),
        'search never downloads bodies or changes flags',
      );

      const second = await mail.search('alice', {
        accountId: account.id,
        sender: 'ana',
        beforeUid: first.nextBeforeUid!,
        limit: 2,
      });
      assert.deepEqual(
        second.messages.map((m) => m.messageId),
        ['7'],
      );
      assert.equal(second.total, 1);
      assert.equal(second.nextBeforeUid, null);
      assert.ok(commands.some((c) => /UID SEARCH .*UID 1:4808/.test(c)));

      const priorSearches = commands.filter((c) => /UID SEARCH/.test(c)).length;
      const end = await mail.search('alice', {
        accountId: account.id,
        sender: 'ana',
        beforeUid: 1,
      });
      assert.equal(end.total, 0);
      assert.deepEqual(end.messages, []);
      assert.equal(end.nextBeforeUid, null);
      assert.equal(commands.filter((c) => /UID SEARCH/.test(c)).length, priorSearches);
      assert.equal(first.folder, 'INBOX');

      const pop = accounts.add('alice', {
        label: 'POP',
        email: 'alice@example.com',
        senderName: 'Alice',
        incoming: { ...connection, protocol: 'pop3', port: 995 },
      });
      await assert.rejects(mail.search('alice', { accountId: pop.id, query: 'anything' }), /IMAP/);
      await assert.rejects(
        mail.search('bob', { accountId: account.id, query: 'anything' }),
        /not found/i,
      );
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((r) => imap.close(() => r()));
      vault.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
