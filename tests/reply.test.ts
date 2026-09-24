import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { Accounts } from '../src/accounts.js';
import { Auth } from '../src/auth.js';
import { Mail } from '../src/mail.js';
import { Vault } from '../src/vault.js';
import { createMcp } from '../src/mcp.js';
import * as schemas from '../src/schemas.js';

const original = (extra = 'Message-ID: <parent@sender.example>', subject = 'Invoice review') =>
  Buffer.from(
    `From: Sender <sender@example.com>\r\nReply-To: Support <support@example.com>\r\nTo: Alice <alice@example.com>\r\nSubject: ${subject}\r\n${extra}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nPlease review the invoice.\r\n`,
  );
const content = (response: any) =>
  JSON.parse(response.content.find((c: any) => c.type === 'text').text);
async function fixture(run: (f: any) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'mailmcp-reply-'));
  const vault = new Vault(dir, randomBytes(32));
  const accounts = new Accounts(vault, new Set(['mail.example.com']));
  const account = accounts.add('alice', {
    label: 'Fixture',
    email: 'alice@example.com',
    senderName: 'Alice',
    incoming: {
      host: 'mail.example.com',
      port: 993,
      security: 'tls',
      protocol: 'imap',
      username: 'alice',
      password: 'synthetic',
    },
    smtp: {
      host: 'mail.example.com',
      port: 465,
      security: 'tls',
      username: 'alice',
      password: 'synthetic',
    },
  });
  const mail = new Mail(accounts, new Set());
  const encoder = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  const state = {
    source: original(),
    reads: 0,
    sends: 0,
    closes: 0,
    released: 0,
    missing: false,
    reject: false,
    emitted: undefined as Buffer | undefined,
  };
  (mail as any).imap = async (_account: unknown, callback: any) =>
    callback({
      mailbox: { uidValidity: 42n },
      getMailboxLock: async (_folder: string, options: unknown) => {
        assert.deepEqual(options, { readOnly: true });
        return {
          release() {
            state.released++;
          },
        };
      },
      fetchOne: async (_id: string, _query: unknown, options: unknown) => {
        assert.deepEqual(options, { uid: true });
        state.reads++;
        return state.missing ? false : { source: state.source, size: state.source.length };
      },
    });
  (mail as any).smtp = async () => ({
    sendMail: async (message: any) => {
      state.sends++;
      if (state.reject) throw Error('synthetic SMTP failure');
      const result = await encoder.sendMail(message);
      state.emitted = result.message as Buffer;
      return {
        messageId: result.messageId,
        accepted: message.to.map((a: any) => a.address),
        rejected: [],
      };
    },
    close: () => state.closes++,
  });
  const mcp = createMcp(
    { accounts, mail, auth: new Auth(), origin: 'http://127.0.0.1:3210' },
    'alice',
  );
  const client = new Client({ name: 'reply-fixture', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await mcp.connect(serverTransport);
    await client.connect(clientTransport);
    const args = {
      accountId: account.id,
      folder: 'INBOX',
      messageId: '7',
      uidValidity: '42',
      to: ['support@example.com'],
      text: 'Thanks, we confirm the details.',
      confirm: true,
    };
    await run({ mail, accounts, account, state, client, args });
  } finally {
    await client.close();
    await mcp.close();
    encoder.close();
    vault.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('messages_reply sends server-derived threading headers, subject and exact attachments', async () => {
  await fixture(async ({ state, client, args }) => {
    state.source = original(
      'Message-ID: <parent@sender.example>\r\nReferences: <root@sender.example>\r\n <previous@sender.example>',
    );
    const bytes = Buffer.from([0, 128, 255, 13, 10]);
    const result = await client.callTool({
      name: 'messages_reply',
      arguments: {
        ...args,
        attachments: [{ filename: 'proof.bin', contentBase64: bytes.toString('base64') }],
      },
    });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const parsed = await simpleParser(state.emitted);
    assert.equal(parsed.inReplyTo, '<parent@sender.example>');
    assert.deepEqual(parsed.references, [
      '<root@sender.example>',
      '<previous@sender.example>',
      '<parent@sender.example>',
    ]);
    assert.equal(parsed.subject, 'Re: Invoice review');
    assert.equal(parsed.text?.trim(), args.text);
    assert.equal(parsed.to.value[0].address, 'support@example.com');
    assert.notEqual(parsed.messageId, '<parent@sender.example>');
    assert.deepEqual(parsed.attachments[0]?.content, bytes);
    assert.deepEqual(content(result).accepted, ['support@example.com']);
    assert.equal(content(result).inReplyTo, '<parent@sender.example>');
    assert.equal(state.closes, 1);
    assert.equal(state.released, 1);
  });
});

for (const [headers, references] of [
  ['Message-ID: <parent@sender.example>', ['<parent@sender.example>']],
  [
    'Message-ID: <parent@sender.example>\r\nIn-Reply-To: <root@sender.example>',
    ['<root@sender.example>', '<parent@sender.example>'],
  ],
  [
    'Message-ID: <parent@sender.example>\r\nIn-Reply-To: <a@example.com> <b@example.com>',
    ['<parent@sender.example>'],
  ],
  [
    'Message-ID: <parent@sender.example>\r\nReferences: <root@sender.example> <root@sender.example> <parent@sender.example>',
    ['<root@sender.example>', '<parent@sender.example>'],
  ],
] as const) {
  test(`reply preserves RFC references ancestry: ${headers}`, async () =>
    fixture(async ({ state, mail, args }) => {
      state.source = original(headers, 'RE: Invoice review');
      await mail.reply('alice', args);
      const parsed = await simpleParser(state.emitted);
      assert.equal(parsed.subject, 'RE: Invoice review');
      assert.deepEqual([parsed.references].flat(), references);
    }));
}

test('read exposes RFC message identity and reply recipients separately from the mailbox UID', async () =>
  fixture(async ({ mail, args }) => {
    const { to, text, confirm, ...read } = args;
    const result = await mail.read('alice', read);
    assert.equal(result.messageId, '7');
    assert.equal(result.rfcMessageId, '<parent@sender.example>');
    assert.match(result.replyTo, /support@example.com/);
  }));

for (const headers of [
  '',
  'Message-ID: broken',
  'Message-ID: <a@example.com> <b@example.com>',
  'Message-ID: <a@example.com>\r\nMessage-ID: <b@example.com>',
]) {
  test(`reply rejects missing or ambiguous original Message-ID: ${headers}`, async () =>
    fixture(async ({ state, mail, args }) => {
      state.source = original(headers);
      await assert.rejects(mail.reply('alice', args), { code: 'REPLY_MESSAGE_ID' });
      assert.equal(state.sends, 0);
    }));
}

test('reply rejects invalid references instead of silently dropping thread ancestry', async () =>
  fixture(async ({ state, mail, args }) => {
    state.source = original(
      'Message-ID: <parent@sender.example>\r\nReferences: <bad id@example.com>',
    );
    await assert.rejects(mail.reply('alice', args), { code: 'REPLY_REFERENCES' });
    assert.equal(state.sends, 0);
  }));

test('reply rejects forged headers, unconfirmed sends and unreviewed recipients before reading or sending', async () =>
  fixture(async ({ state, client, args }) => {
    for (const change of [
      { confirm: false },
      { confirm: undefined },
      { to: undefined },
      { to: [] },
      { to: ['victim@example.com\r\nBcc: another@example.com'] },
      { subject: 'Forged' },
      { inReplyTo: '<forged@example.com>' },
      { references: ['<forged@example.com>'] },
      { headers: { Bcc: 'hidden@example.com' } },
      { text: '   ' },
    ]) {
      const result = await client.callTool({
        name: 'messages_reply',
        arguments: { ...args, ...change },
      });
      assert.equal(result.isError, true);
    }
    assert.equal(state.reads, 0);
    assert.equal(state.sends, 0);
  }));

test('reply enforces ownership, UIDVALIDITY and message existence before SMTP', async () =>
  fixture(async ({ state, mail, args }) => {
    await assert.rejects(mail.reply('bob', args), { code: 'NOT_FOUND' });
    assert.equal(state.reads, 0);
    await assert.rejects(mail.reply('alice', { ...args, uidValidity: '41' }), {
      code: 'STALE_MAILBOX',
    });
    await assert.rejects(mail.reply('alice', { ...args, uidValidity: undefined }), {
      code: 'INVALID_INPUT',
    });
    state.missing = true;
    await assert.rejects(mail.reply('alice', args), { code: 'NOT_FOUND' });
    assert.equal(state.sends, 0);
  }));

test('reply supports POP3 UIDL using the same threading logic', async () =>
  fixture(async ({ state, mail, accounts, account, args }) => {
    accounts.update('alice', account.id, {
      incoming: {
        protocol: 'pop3',
        host: 'mail.example.com',
        port: 995,
        security: 'tls',
        username: 'alice',
        password: 'synthetic',
      },
    });
    (mail as any).pop = async (_account: unknown, callback: any) =>
      callback({
        read: async (id: string) => {
          assert.equal(id, 'opaque-uidl');
          return state.source;
        },
      });
    await mail.reply('alice', { ...args, messageId: 'opaque-uidl', uidValidity: undefined });
    assert.equal((await simpleParser(state.emitted)).inReplyTo, '<parent@sender.example>');
  }));

test('reply failures close SMTP and never retry delivery automatically', async () =>
  fixture(async ({ state, client, args }) => {
    state.reject = true;
    const result = await client.callTool({ name: 'messages_reply', arguments: args });
    assert.equal(result.isError, true);
    assert.equal(content(result).code, 'OPERATION_FAILED');
    assert.equal(state.sends, 1);
    assert.equal(state.closes, 1);
  }));

test('reply and new-message sends share the same per-owner send limit', async () =>
  fixture(async ({ state, mail, args }) => {
    for (let i = 0; i < 10; i++) {
      await mail.reply('alice', args);
      await mail.send('alice', {
        accountId: args.accountId,
        to: args.to,
        subject: 'New message',
        text: args.text,
        confirm: true,
      });
    }
    await assert.rejects(mail.reply('alice', args), { code: 'RATE_LIMIT' });
    assert.equal(state.sends, 20);
  }));

test('reply retains total attachment and attachment count limits', () => {
  assert.ok(schemas.replySchema, 'reply schema must be exposed');
  const base = {
    accountId: 'd8cdff46-53a4-4ec7-bb3c-e39293085eb6',
    messageId: '1',
    to: ['support@example.com'],
    text: 'Reply',
    confirm: true,
  };
  const attachment = {
    filename: 'data.bin',
    contentBase64: Buffer.alloc(12_500_001).toString('base64'),
  };
  assert.equal(
    schemas.replySchema.safeParse({ ...base, attachments: [attachment, attachment] }).success,
    false,
  );
  assert.equal(
    schemas.replySchema.safeParse({
      ...base,
      attachments: Array(11).fill({ filename: 'empty.txt', contentBase64: '' }),
    }).success,
    false,
  );
});

for (const [headers, expected] of [
  [
    'Message-ID: (outer (nested)) <parent@sender.example> (end)\r\nReferences: (root) <root@sender.example>\r\n (ancestor) <previous@sender.example>',
    ['<root@sender.example>', '<previous@sender.example>', '<parent@sender.example>'],
  ],
  ['Message-ID: <parent@[IPv6:2001:db8::1]>', ['<parent@[IPv6:2001:db8::1]>']],
  ['Message-ID: <parent@[literal>domain]>', ['<parent@[literal>domain]>']],
] as const) {
  test(`reply supports comments, folding and domain literals: ${headers}`, async () =>
    fixture(async ({ state, mail, args }) => {
      state.source = original(headers);
      const result = await mail.reply('alice', args);
      assert.deepEqual(result.references, expected);
      const parsed = await simpleParser(state.emitted);
      assert.equal(
        parsed.headerLines.find((h) => h.key === 'in-reply-to')?.line,
        'In-Reply-To: ' + expected.at(-1),
      );
    }));
}

test('reply rejects excessive reference chains and subjects before SMTP', async () =>
  fixture(async ({ state, mail, args }) => {
    state.source = original(
      'Message-ID: <parent@sender.example>\r\nReferences: ' +
        Array.from({ length: 101 }, (_, i) => `<id${i}@example.com>`).join(' '),
    );
    await assert.rejects(mail.reply('alice', args), { code: 'REPLY_REFERENCES' });
    state.source = original('Message-ID: <parent@sender.example>', 'a'.repeat(1001));
    await assert.rejects(mail.reply('alice', args), { code: 'REPLY_SUBJECT' });
    assert.equal(state.sends, 0);
  }));

test('reply does not turn encoded subject controls into injected SMTP headers', async () =>
  fixture(async ({ state, mail, args }) => {
    state.source = original(
      'Message-ID: <parent@sender.example>',
      '=?UTF-8?Q?Invoice=0D=0ABcc:_hidden@example.com?=',
    );
    await mail.reply('alice', args);
    const parsed = await simpleParser(state.emitted);
    assert.equal(parsed.bcc, undefined);
    assert.match(parsed.subject!, /^Re: Invoice/);
    assert.equal(parsed.headerLines.filter((h) => h.key === 'subject').length, 1);
  }));

test('reply rejects an account without SMTP before fetching the original', async () =>
  fixture(async ({ state, mail, args, accounts, account }) => {
    accounts.update('alice', account.id, { smtp: null });
    await assert.rejects(mail.reply('alice', args), { code: 'UNSUPPORTED' });
    assert.equal(state.reads, 0);
    assert.equal(state.sends, 0);
  }));
