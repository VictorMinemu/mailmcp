import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { Accounts } from '../src/accounts.js';
import { Auth } from '../src/auth.js';
import { Mail } from '../src/mail.js';
import { Vault } from '../src/vault.js';
import { createMcp } from '../src/mcp.js';
import { AppError, publicError } from '../src/errors.js';
import { outputSchemas } from '../src/outputs.js';

const profile = {
  label: 'Synthetic',
  email: 'me@example.com',
  senderName: 'Test',
  incoming: {
    protocol: 'imap',
    host: 'imap.example.com',
    port: 993,
    security: 'tls',
    username: 'me',
    password: 'synthetic-secret',
  },
};
const text = (response: any) =>
  JSON.parse(response.content.find((c: any) => c.type === 'text').text);

async function fixture(
  run: (client: Client, mail: Mail, accountId: string, accounts: Accounts) => Promise<void>,
  locale: 'en' | 'es' = 'en',
) {
  const dir = mkdtempSync(join(tmpdir(), 'mailmcp-results-'));
  const vault = new Vault(dir, randomBytes(32));
  const accounts = new Accounts(vault, new Set(['imap.example.com']));
  const mail = new Mail(accounts, new Set());
  const server = createMcp(
    { accounts, mail, auth: new Auth(), origin: 'http://127.0.0.1:3210' },
    'alice',
    locale,
  );
  const client = new Client({ name: 'results-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    const account = accounts.add('alice', profile);
    await server.connect(b);
    await client.connect(a);
    await run(client, mail, account.id, accounts);
  } finally {
    await client.close();
    await server.close();
    vault.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('structured account and folder containers preserve legacy text and redact secrets', async () => {
  await fixture(async (client, mail) => {
    mail.folders = async () => [{ path: 'INBOX', name: 'Inbox' }];
    for (const [name, key, args] of [
      ['accounts_list', 'accounts', {}],
      [
        'folders_list',
        'folders',
        { accountId: text(await client.callTool({ name: 'accounts_list', arguments: {} }))[0].id },
      ],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true);
      assert.deepEqual((result.structuredContent as any)[key], text(result));
      assert.ok(outputSchemas[name]!.safeParse(result.structuredContent).success);
      assert.ok(!JSON.stringify(result).includes('synthetic-secret'));
    }
  });
});

test('MCP limits the initial body and paginates the full decoded message without loss', async () => {
  await fixture(async (client, mail, accountId) => {
    const body = 'a'.repeat(100_000) + ' tail: entrega confirmada 😀';
    const source = Buffer.from(
      'From: sender@example.com\r\nDate: Mon, 5 Oct 2026 12:00:00 +0000\r\nSubject: Long fixture\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n' +
        body,
    );
    (mail as any).imap = async (_account: unknown, callback: any) =>
      callback({
        mailbox: { uidValidity: 42n },
        getMailboxLock: async () => ({ release() {} }),
        fetchOne: async () => ({ source, size: source.length }),
      });
    const args = { accountId, messageId: '1', uidValidity: '42' };
    let response = await client.callTool({ name: 'messages_read', arguments: args });
    const initial = text(response);
    assert.equal(initial.text.length, 10_000);
    assert.equal(initial.totalChars, body.length);
    assert.equal(initial.nextOffset, 10_000);
    assert.equal(initial.truncated, true);
    assert.equal(initial.untrustedContent, true);
    assert.equal(typeof initial.date, 'string');
    assert.deepEqual(response.structuredContent, initial);
    let combined = initial.text;
    let next = initial.nextOffset;
    while (next !== null) {
      response = await client.callTool({
        name: 'messages_read',
        arguments: { ...args, maxChars: 30_000, offset: next },
      });
      assert.notEqual(response.isError, true, JSON.stringify(response));
      const page = text(response);
      assert.ok(page.text.length <= 30_000);
      assert.equal(page.offset, next);
      assert.equal(page.truncated, true);
      assert.deepEqual(response.structuredContent, page);
      combined += page.text;
      next = page.nextOffset;
    }
    assert.equal(combined, body);
    // Shared web/service default remains compatible with the previous 100k limit.
    assert.equal((await mail.read('alice', args)).text.length, 100_000);
    const outOfRange = await client.callTool({
      name: 'messages_read',
      arguments: { ...args, offset: body.length + 1 },
    });
    assert.equal(outOfRange.isError, true);
    assert.equal(text(outOfRange).code, 'INVALID_INPUT');
    await assert.rejects(mail.read('bob', args), { code: 'NOT_FOUND' });
    await assert.rejects(mail.read('alice', { ...args, uidValidity: '41' }), {
      code: 'STALE_MAILBOX',
    });
  });
});

test('MCP validation identifies nested fields in Spanish and never echoes credentials or unknown keys', async () => {
  await fixture(async (client, mail, accountId, accounts) => {
    const invalid = await client.callTool({
      name: 'accounts_add',
      arguments: {
        ...profile,
        incoming: { ...profile.incoming, password: 'private-password\r\n' },
        'private-unknown-key': 'private-value',
      },
    });
    assert.equal(invalid.isError, true);
    const error = text(invalid);
    assert.equal(error.code, 'INVALID_INPUT');
    assert.equal(error.retryable, false);
    assert.equal(error.suggestedAction, 'correct_input');
    assert.ok(
      error.fieldErrors.some(
        (f: any) => f.path === 'incoming.password' && f.message === 'Usa el formato requerido.',
      ),
    );
    for (const secret of ['private-password', 'private-unknown-key', 'private-value'])
      assert.ok(!JSON.stringify(invalid).includes(secret));
    assert.equal(accounts.list('alice').length, 1);
    for (const maxChars of [0, 100_001, 1.5]) {
      const invalidRead = await client.callTool({
        name: 'messages_read',
        arguments: { accountId, messageId: '1', maxChars },
      });
      assert.equal(text(invalidRead).fieldErrors[0].path, 'maxChars');
    }
    mail.send = async () => {
      throw new Error('provider secret and body');
    };
    const failed = await client.callTool({
      name: 'messages_send',
      arguments: {
        accountId,
        to: ['recipient@example.com'],
        subject: 'Test',
        text: 'Test',
        confirm: true,
      },
    });
    assert.equal(failed.isError, true);
    assert.equal(text(failed).retryable, false);
    assert.equal(text(failed).suggestedAction, 'verify_delivery_before_retry');
    assert.ok(!JSON.stringify(failed).includes('provider secret'));
  }, 'es');
});

test('recovery distinguishes transient reads, stale identities and ambiguous SMTP outcomes', () => {
  assert.equal(
    publicError(new AppError('BUSY', 'Too many concurrent mail operations.')).retryable,
    true,
  );
  assert.equal(
    publicError(
      new AppError('STALE_MAILBOX', 'Mailbox identity changed. Refresh the message list.'),
    ).suggestedAction,
    'refresh_message_list',
  );
  assert.equal(
    publicError(new AppError('MESSAGE_INCOMPLETE', 'Incomplete.')).suggestedAction,
    'read_message_again',
  );
  assert.equal(publicError(new Error('network'), 'en', true).retryable, false);
});

test('invalid service outputs cannot escape the MCP boundary as provider data or SDK error text', async () => {
  await fixture(async (client, mail, accountId) => {
    mail.verify = async () => ({ verified: ['imap'], extra: 'allowed extra field' });
    const valid = await client.callTool({ name: 'accounts_verify', arguments: { accountId } });
    assert.notEqual(valid.isError, true);
    (mail as any).verify = async () => ({ verified: 'private-provider-value' });
    const invalid = await client.callTool({ name: 'accounts_verify', arguments: { accountId } });
    assert.equal(invalid.isError, true);
    assert.equal(text(invalid).code, 'OPERATION_FAILED');
    assert.ok(!JSON.stringify(invalid).includes('private-provider-value'));
  });
});
