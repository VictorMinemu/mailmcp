import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { Accounts } from '../src/accounts.js';
import { Auth } from '../src/auth.js';
import { Mail } from '../src/mail.js';
import { Vault } from '../src/vault.js';
import { createMcp } from '../src/mcp.js';
import { TemporaryAttachments, ATTACHMENT_TTL_MS } from '../src/temporary-attachments.js';
import { SendOperations, SEND_OPERATION_TTL_MS } from '../src/send-operations.js';

const connection = {
  host: 'mail.example.com',
  port: 993,
  security: 'tls',
  username: 'test',
  password: 'synthetic-only',
};
const json = (r: any) => JSON.parse(r.content.find((c: any) => c.type === 'text').text);
async function fixture(run: (f: any) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'mailmcp-workflows-'));
  const vault = new Vault(dir, randomBytes(32));
  const accounts = new Accounts(vault, new Set(['mail.example.com']));
  const mail = new Mail(accounts, new Set());
  const account = accounts.add('alice', {
    label: 'Work',
    email: 'me@example.com',
    senderName: 'Test',
    incoming: { ...connection, protocol: 'imap' },
    smtp: connection,
  });
  const ref = { accountId: account.id, folder: 'Archive', messageId: '9', uidValidity: '42' };
  const sources = new Map([
    [
      9,
      Buffer.from(
        'Message-ID: <reply@example.com>\r\nReferences: <root@example.com>\r\nFrom: sender@example.com\r\nSubject: Re: Fixture\r\nContent-Type: text/plain\r\n\r\nReply body',
      ),
    ],
    [
      7,
      Buffer.from(
        'Message-ID: <root@example.com>\r\nFrom: sender@example.com\r\nSubject: Fixture\r\nContent-Type: text/plain\r\n\r\nRoot body',
      ),
    ],
    [
      5,
      Buffer.from(
        'Message-ID: <unrelated@example.com>\r\nSubject: Re: Fixture\r\nContent-Type: text/plain\r\n\r\nUnrelated same subject',
      ),
    ],
  ]);
  const commands: any[] = [];
  let uids = [9, 7, 5];
  let validity = '42';
  (mail as any).imap = async (_a: any, action: any) =>
    action({
      get mailbox() {
        return { uidValidity: BigInt(validity), exists: uids.length };
      },
      getMailboxLock: async (folder: string, options: any) => {
        commands.push({ folder, options });
        return { release() {} };
      },
      search: async (query: any, options: any) => {
        commands.push({ search: query, options });
        return uids.filter(
          (uid) => query.uid === undefined || uid <= Number(query.uid.split(':')[1]),
        );
      },
      fetchAll: async (set: any, query: any, options: any) => {
        commands.push({ fetch: set, query, options });
        return (Array.isArray(set) ? set : uids).map((uid: number) => ({
          uid,
          seq:
            uids
              .slice()
              .sort((a, b) => a - b)
              .indexOf(uid) + 1,
          flags: new Set(),
          envelope: { subject: 'Fixture' },
          size: sources.get(uid)?.length,
        }));
      },
      fetchOne: async (uid: string) =>
        sources.has(Number(uid))
          ? { source: sources.get(Number(uid)), size: sources.get(Number(uid))!.length }
          : false,
      messageFlagsAdd: async (uid: string) => {
        commands.push({ flag: uid });
        return true;
      },
      messageMove: async (uid: string, destination: string) => {
        commands.push({ move: uid, destination });
        return { uidMap: new Map([[Number(uid), 20]]), uidValidity: 99n };
      },
    });
  const smtp: any[] = [];
  (mail as any).smtp = async () => ({
    sendMail: async (p: any) => {
      smtp.push(p);
      return {
        messageId: '<sent@example.com>',
        accepted: p.to.map((a: any) => a.address),
        rejected: [],
      };
    },
    close() {},
  });
  const server = createMcp(
    { accounts, mail, auth: new Auth(), origin: 'http://127.0.0.1:3210' },
    'alice',
  );
  const client = new Client({ name: 'workflow-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b);
    await client.connect(a);
    await run({
      accounts,
      account,
      ref,
      sources,
      commands,
      smtp,
      mail,
      client,
      setUids: (value: number[]) => {
        uids = value;
      },
      setValidity: (value: string) => {
        validity = value;
      },
    });
  } finally {
    await client.close();
    await server.close();
    vault.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('account capabilities distinguish IMAP, POP3, SMTP-only and receive-only accounts', async () => {
  await fixture(async ({ accounts, account }: any) => {
    assert.equal(account.capabilities.threadRead, true);
    const pop = accounts.add('alice', {
      label: 'POP',
      email: 'pop@example.com',
      senderName: 'POP',
      incoming: { ...connection, protocol: 'pop3' },
    });
    assert.equal(pop.capabilities.read, true);
    assert.equal(pop.capabilities.search, false);
    assert.equal(pop.capabilities.move, false);
    assert.equal(pop.capabilities.reply, false);
    const smtp = accounts.add('alice', {
      label: 'Outgoing',
      email: 'out@example.com',
      senderName: 'SMTP',
      smtp: connection,
    });
    assert.equal(smtp.capabilities.send, true);
    assert.equal(smtp.capabilities.read, false);
    assert.equal(smtp.capabilities.listFolders, false);
    assert.equal(accounts.list('bob').length, 0);
  });
});

test('messageRef works for reads, flags, moves and replies, rejecting mixed identity and other owners', async () => {
  await fixture(async ({ client, mail, ref, account, commands }: any) => {
    for (const [name, extra] of [
      ['messages_read', {}],
      ['messages_flag', { flag: 'seen', value: true }],
      ['messages_move', { destination: 'Sent', confirm: true }],
      ['messages_reply', { to: ['sender@example.com'], text: 'Approved', confirm: true }],
    ] as const) {
      const result = await client.callTool({ name, arguments: { messageRef: ref, ...extra } });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      if (name === 'messages_read') assert.deepEqual(json(result).messageRef, ref);
      if (name === 'messages_move')
        assert.deepEqual(json(result).messageRef, {
          ...ref,
          folder: 'Sent',
          messageId: '20',
          uidValidity: '99',
        });
    }
    assert.ok(commands.some((c: any) => c.flag === '9'));
    const mixed = await client.callTool({
      name: 'messages_read',
      arguments: { messageRef: ref, accountId: account.id },
    });
    assert.equal(mixed.isError, true);
    await assert.rejects(mail.read('bob', { messageRef: ref }), { code: 'NOT_FOUND' });
    await assert.rejects(
      mail.flag('alice', { messageRef: { ...ref, uidValidity: '41' }, flag: 'seen', value: true }),
      { code: 'STALE_MAILBOX' },
    );
  });
});

test('UID listing survives expunges and new arrivals and fails on mailbox generation changes', async () => {
  await fixture(async ({ mail, account, setUids, setValidity, commands }: any) => {
    const first = await mail.list('alice', { accountId: account.id, limit: 2 });
    assert.deepEqual(
      first.messages.map((m: any) => m.messageId),
      ['9', '7'],
    );
    assert.equal(first.nextBeforeUid, 7);
    setUids([12, 9, 5]); // New arrival and deletion shift sequence positions.
    const second = await mail.list('alice', {
      accountId: account.id,
      limit: 2,
      beforeUid: first.nextBeforeUid,
      uidValidity: first.uidValidity,
    });
    assert.deepEqual(
      second.messages.map((m: any) => m.messageId),
      ['5'],
    );
    assert.ok(commands.some((c: any) => c.fetch && c.options?.uid === true));
    setValidity('43');
    await assert.rejects(
      mail.list('alice', { accountId: account.id, beforeUid: 7, uidValidity: '42' }),
      { code: 'STALE_MAILBOX' },
    );
    await assert.rejects(mail.list('alice', { accountId: account.id, beforeUid: 7 }));
    await assert.rejects(mail.list('bob', { accountId: account.id }));
  });
});

test('batch body budget is shared, failures are per item and unread items remain explicit', async () => {
  await fixture(async ({ mail, ref }: any) => {
    const otherOwner = { ...ref, accountId: randomUUID() };
    const result = await mail.readBatch('alice', {
      messages: [otherOwner, ref, { ...ref, messageId: '7' }],
      maxTotalChars: 5,
    });
    assert.equal(result.results[0].status, 'error');
    assert.equal(result.results[0].error.code, 'NOT_FOUND');
    assert.equal(result.results[1].message.text, 'Reply');
    assert.equal(result.results[2].status, 'budget_exhausted');
    assert.equal(result.returnedChars, 5);
    assert.equal(result.truncated, true);
  });
});

test('conversation discovery verifies RFC ancestry instead of grouping by subject', async () => {
  await fixture(async ({ client, ref, commands }: any) => {
    const response = await client.callTool({
      name: 'messages_thread',
      arguments: { messageRef: ref },
    });
    assert.notEqual(response.isError, true, JSON.stringify(response));
    const result = json(response);
    assert.deepEqual(
      result.results.map((r: any) => r.messageRef.messageId),
      ['7', '9'],
    );
    assert.equal(result.rootMessageId, '<root@example.com>');
    assert.equal(result.scope, 'folder');
    assert.ok(
      commands.some((c: any) => c.search?.or?.some((term: any) => term.header?.references)),
    );
  });
});

test('temporary uploads enforce expiry, account/user binding, count quotas and release memory', () => {
  let now = 1_000_000;
  const store = new TemporaryAttachments(() => now);
  const file = {
    filename: 'file.bin',
    contentType: 'application/octet-stream',
    contentBase64: 'AP+A',
  };
  const upload = store.put('alice', 'account-a', file);
  assert.deepEqual(
    store.get('alice', 'account-a', upload.attachmentId).content,
    Buffer.from([0, 255, 128]),
  );
  assert.throws(() => store.get('bob', 'account-a', upload.attachmentId), { code: 'NOT_FOUND' });
  assert.throws(() => store.get('alice', 'account-b', upload.attachmentId), { code: 'NOT_FOUND' });
  now += ATTACHMENT_TTL_MS;
  assert.throws(() => store.get('alice', 'account-a', upload.attachmentId), { code: 'NOT_FOUND' });
  const ids = Array.from({ length: 20 }, () => store.put('alice', 'account-a', file).attachmentId);
  assert.throws(() => store.put('alice', 'account-a', file), { code: 'UPLOAD_QUOTA' });
  store.remove('alice', 'account-a', ids[0]!);
  store.put('alice', 'account-a', file);
});

test('staged and reused attachment IDs send exact bytes and cannot bypass the aggregate limit', async () => {
  await fixture(async ({ client, mail, account, ref, sources, smtp, accounts }: any) => {
    const file = {
      filename: 'bytes.bin',
      contentType: 'application/octet-stream',
      contentBase64: 'AP+A',
    };
    const staged = json(
      await client.callTool({
        name: 'attachments_upload',
        arguments: { accountId: account.id, file },
      }),
    );
    assert.ok(staged.attachmentId);
    assert.equal(staged.contentBase64, undefined);
    const send = {
      accountId: account.id,
      to: ['recipient@example.com'],
      subject: 'Fixture',
      text: 'Approved',
      confirm: true,
      attachments: [{ attachmentId: staged.attachmentId }],
    };
    const result = await client.callTool({ name: 'messages_send', arguments: send });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.deepEqual(smtp[0].attachments[0].content, Buffer.from([0, 255, 128]));
    await assert.rejects(mail.send('bob', send), { code: 'NOT_FOUND' });
    const other = accounts.add('alice', {
      label: 'Other',
      email: 'other@example.com',
      senderName: 'Other',
      smtp: connection,
    });
    await assert.rejects(mail.send('alice', { ...send, accountId: other.id }), {
      code: 'NOT_FOUND',
    });
    sources.set(
      9,
      Buffer.from(
        'Message-ID: <file@example.com>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\nBody\r\n--x\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=original.bin\r\nContent-Transfer-Encoding: base64\r\n\r\nAP+A\r\n--x--\r\n',
      ),
    );
    const reused = await client.callTool({
      name: 'attachments_reuse',
      arguments: { messageRef: ref, index: 0 },
    });
    assert.notEqual(reused.isError, true, JSON.stringify(reused));
    assert.ok(json(reused).attachmentId);
    const repeatedReuse = await client.callTool({
      name: 'attachments_reuse',
      arguments: { messageRef: ref, index: 0 },
    });
    assert.equal(json(repeatedReuse).attachmentId, json(reused).attachmentId);
    assert.equal(json(repeatedReuse).expiresAt, json(reused).expiresAt);
    assert.ok(!JSON.stringify(reused).includes('AP+A'));
    const large = mail.uploadAttachment('alice', {
      accountId: account.id,
      file: { filename: 'large.bin', contentBase64: Buffer.alloc(13_000_000).toString('base64') },
    });
    await assert.rejects(
      mail.send('alice', {
        ...send,
        attachments: [{ attachmentId: large.attachmentId }, { attachmentId: large.attachmentId }],
      }),
      { code: 'ATTACHMENT_TOTAL' },
    );
    assert.equal(smtp.length, 1);
    await client.callTool({
      name: 'attachments_remove_upload',
      arguments: { accountId: account.id, attachmentId: staged.attachmentId },
    });
    await assert.rejects(mail.send('alice', send), { code: 'NOT_FOUND' });
  });
});

test('send IDs deduplicate concurrent requests and reject changed content without another SMTP submission', async () => {
  await fixture(async ({ mail, account, smtp }: any) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    (mail as any).smtp = async () => ({
      sendMail: async (p: any) => {
        smtp.push(p);
        await gate;
        return { messageId: '<accepted@example.com>', accepted: ['to@example.com'], rejected: [] };
      },
      close() {},
    });
    const operationId = randomUUID();
    const args = {
      accountId: account.id,
      operationId,
      to: ['to@example.com'],
      subject: 'Fixture',
      text: 'Approved',
      confirm: true,
    };
    const first = mail.send('alice', args),
      duplicate = mail.send('alice', args);
    await new Promise((r) => setImmediate(r));
    assert.equal(mail.sendStatus('alice', { operationId }).state, 'submitting');
    release();
    assert.deepEqual(await first, await duplicate);
    assert.equal(smtp.length, 1);
    assert.equal((await mail.send('alice', args)).operation.state, 'accepted');
    await assert.rejects(mail.send('alice', { ...args, text: 'Changed' }), {
      code: 'IDEMPOTENCY_CONFLICT',
    });
    assert.throws(() => mail.sendStatus('bob', { operationId }), { code: 'NOT_FOUND' });
  });
});

test('ambiguous SMTP failures retain an unknown receipt and repeat calls do not resend', async () => {
  await fixture(async ({ mail, client, account }: any) => {
    let count = 0;
    (mail as any).smtp = async () => ({
      sendMail: async () => {
        count++;
        throw new Error('private-provider-data');
      },
      close() {},
    });
    const args = {
      accountId: account.id,
      operationId: randomUUID(),
      to: ['to@example.com'],
      subject: 'Fixture',
      text: 'Approved',
      confirm: true,
    };
    for (let i = 0; i < 2; i++) {
      const response = await client.callTool({ name: 'messages_send', arguments: args });
      assert.equal(response.isError, true);
      assert.equal(json(response).operationId, args.operationId);
      assert.equal(json(response).suggestedAction, 'verify_delivery_before_retry');
      assert.ok(!JSON.stringify(response).includes('private-provider-data'));
    }
    assert.equal(count, 1);
    const status = await client.callTool({
      name: 'messages_send_status',
      arguments: { operationId: args.operationId },
    });
    assert.equal(json(status).state, 'unknown');
  });
});

test('operation receipts report partial/rejected acceptance and expire without leaking other users', async () => {
  let now = 1_000_000;
  const operations = new SendOperations(() => now);
  const id = randomUUID();
  const result = await operations.execute('alice', 'a', id, { text: 'fixture' }, async () => ({
    messageId: '<m>',
    accepted: ['one@example.com'],
    rejected: ['two@example.com'],
  }));
  assert.equal(result.operation.state, 'partial');
  const rejected = await operations.execute('alice', 'a', undefined, {}, async () => ({
    messageId: '<m>',
    accepted: [],
    rejected: ['two@example.com'],
  }));
  assert.equal(rejected.operation.state, 'rejected');
  assert.throws(() => operations.get('bob', id), { code: 'NOT_FOUND' });
  now += SEND_OPERATION_TTL_MS;
  assert.throws(() => operations.get('alice', id), { code: 'NOT_FOUND' });
});

test('explicit SMTP rejection is distinguished from an ambiguous disconnect', async () => {
  await fixture(async ({ mail, account }: any) => {
    const operationId = randomUUID();
    (mail as any).smtp = async () => ({
      sendMail: async () => {
        throw Object.assign(new Error('Private SMTP rejection'), {
          responseCode: 550,
          command: 'DATA',
        });
      },
      close() {},
    });
    await assert.rejects(
      mail.send('alice', {
        accountId: account.id,
        operationId,
        to: ['to@example.com'],
        subject: 'Fixture',
        text: 'Approved',
        confirm: true,
      }),
    );
    assert.equal(mail.sendStatus('alice', { operationId }).state, 'rejected');
  });
});

test('per-item errors remain localized and mark a batch incomplete', async () => {
  await fixture(async ({ mail, ref }: any) => {
    const result = await mail.readBatch('bob', { messages: [ref] }, 'es');
    assert.equal(result.results[0].error.message, 'Cuenta no encontrada.');
    assert.equal(result.truncated, true);
  });
});
