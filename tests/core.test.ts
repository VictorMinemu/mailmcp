import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { Vault } from '../src/vault.js';
import { Accounts } from '../src/accounts.js';
import { Auth, RateLimit } from '../src/auth.js';
import { PopLines } from '../src/pop3.js';
import { accountSchema, sendSchema, attachmentSchema } from '../src/schemas.js';
import { readConfig } from '../src/config.js';
import { mailEndpoint } from '../src/network.js';
import { safeFilename } from '../src/mail.js';
import { publicError } from '../src/errors.js';

export const sample = {
  label: 'Work',
  email: 'me@example.com',
  senderName: 'My Name',
  incoming: {
    protocol: 'imap' as const,
    host: 'imap.example.com',
    port: 993,
    security: 'tls' as const,
    username: 'me@example.com',
    password: 'unique-test-password',
  },
};

test('encrypted vault survives restart, uses restricted permissions and rejects simultaneous writers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mailmcp-')),
    key = randomBytes(32);
  let vault = new Vault(dir, key);
  try {
    const accounts = new Accounts(vault, new Set(['imap.example.com']));
    const created = accounts.add('alice', sample);
    assert.equal(created.incoming?.hasPassword, true);
    assert.ok(!JSON.stringify(created).includes(sample.incoming.password));
    const disk = readFileSync(join(dir, 'vault.enc'));
    assert.ok(!disk.includes(Buffer.from(sample.incoming.password)));
    assert.ok(!disk.includes(Buffer.from(sample.email)));
    assert.equal(statSync(join(dir, 'vault.enc')).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.throws(() => new Vault(dir, key), /locked/);
    vault.close();
    vault = new Vault(dir, key);
    assert.equal(
      new Accounts(vault, new Set()).get('alice', created.id).incoming?.password,
      sample.incoming.password,
    );
  } finally {
    vault.close();
    rmSync(dir, { recursive: true });
  }
});

test('tampering and wrong encryption keys fail closed without overwriting data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mailmcp-')),
    key = randomBytes(32),
    vault = new Vault(dir, key);
  vault.close();
  try {
    const original = readFileSync(join(dir, 'vault.enc'));
    assert.throws(() => new Vault(dir, randomBytes(32)), /decrypt/);
    assert.deepEqual(readFileSync(join(dir, 'vault.enc')), original);
    original[original.length - 1] ^= 1;
    writeFileSync(join(dir, 'vault.enc'), original);
    assert.throws(() => new Vault(dir, key), /decrypt/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('all account operations enforce ownership and never permit owner injection', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mailmcp-')),
    vault = new Vault(dir, randomBytes(32));
  try {
    const accounts = new Accounts(vault, new Set(['imap.example.com'])),
      created = accounts.add('alice', sample);
    assert.deepEqual(accounts.list('bob'), []);
    assert.throws(() => accounts.get('bob', created.id), /not found/);
    assert.throws(() => accounts.update('bob', created.id, { label: 'Hijack' }), /not found/);
    assert.throws(() => accounts.remove('bob', created.id), /not found/);
    assert.throws(() => accounts.add('bob', { ...sample, owner: 'alice' }));
    assert.throws(
      () =>
        accounts.update('alice', created.id, {
          incoming: { ...sample.incoming, host: 'evil.example.com' },
        }),
      /not enabled/,
    );
    accounts.update('alice', created.id, { label: 'Renamed', senderName: 'New Sender' });
    assert.equal(accounts.get('alice', created.id).incoming?.password, sample.incoming.password);
    assert.equal(accounts.list('alice')[0]?.senderName, 'New Sender');
    assert.throws(() => accounts.update('alice', created.id, { incoming: null }));
    accounts.remove('alice', created.id);
    assert.deepEqual(accounts.list('alice'), []);
  } finally {
    vault.close();
    rmSync(dir, { recursive: true });
  }
});

test('login links are one-use, expire, retain owner and support revocation', () => {
  let now = 0;
  const auth = new Auth(() => now);
  const link = auth.link('alice'),
    session = auth.redeem(link);
  assert.equal(auth.owner(session), 'alice');
  assert.throws(() => auth.redeem(link), /invalid/);
  const expired = auth.link('bob');
  now += 60_001;
  assert.throws(() => auth.redeem(expired), /expired/);
  const pending = auth.link('alice');
  auth.revoke('alice');
  assert.throws(() => auth.owner(session));
  assert.throws(() => auth.redeem(pending));
  const fresh = auth.session('bob');
  now += 3_600_000;
  assert.throws(() => auth.owner(fresh));
  const logout = auth.session('bob');
  auth.logout(logout);
  assert.throws(() => auth.owner(logout));
});

test('rate limits expire and are isolated by identity', () => {
  let now = 0;
  const limiter = new RateLimit(1, 100, () => now);
  limiter.check('alice');
  assert.throws(() => limiter.check('alice'));
  limiter.check('bob');
  now = 100;
  limiter.check('alice');
});

test('schema rejects insecure POP3, injection, arbitrary keys, unchecked sending and invalid indices', () => {
  assert.throws(() =>
    accountSchema.parse({
      ...sample,
      incoming: { ...sample.incoming, protocol: 'pop3', security: 'starttls' },
    }),
  );
  assert.throws(() =>
    accountSchema.parse({
      ...sample,
      incoming: { ...sample.incoming, password: 'secret\r\nDELE 1' },
    }),
  );
  assert.throws(() =>
    accountSchema.parse({ ...sample, incoming: { ...sample.incoming, host: 'http://localhost' } }),
  );
  assert.throws(() =>
    accountSchema.parse({ ...sample, incoming: { ...sample.incoming, rejectUnauthorized: false } }),
  );
  assert.throws(() =>
    sendSchema.parse({
      accountId: randomBytes(16).toString('hex'),
      to: ['a@example.com'],
      subject: 'hello',
      text: 'hello',
    }),
  );
  assert.throws(() =>
    attachmentSchema.parse({
      accountId: '2bcbf567-ef16-4a1c-80b1-45f512bb4bfd',
      messageId: '1',
      index: -1,
    }),
  );
  assert.equal(safeFilename('../../private.txt', 0), 'private.txt');
  assert.equal(safeFilename('..', 2), 'attachment-3.bin');
  assert.ok(!JSON.stringify(publicError(new Error('password=secret'))).includes('secret'));
});

test('hosted configuration requires HTTPS and an identity provider; local cannot bind publicly', () => {
  const base = { MAILMCP_MASTER_KEY: randomBytes(32).toString('hex') };
  assert.equal(readConfig({ ...base, MAILMCP_BIND: '0.0.0.0' }).bind, '127.0.0.1');
  assert.throws(() => readConfig({ ...base, MAILMCP_MODE: 'hosted' }), /HTTPS/);
  assert.throws(
    () =>
      readConfig({
        ...base,
        MAILMCP_MODE: 'hosted',
        MAILMCP_PUBLIC_URL: 'https://mail.example.com',
      }),
    /OIDC/,
  );
});

test('network policy rejects unlisted hosts and private or metadata IPs even if listed', async () => {
  await assert.rejects(mailEndpoint('example.com', new Set()), /not enabled/);
  for (const host of ['127.0.0.1', '169.254.169.254', '10.0.0.1'])
    await assert.rejects(mailEndpoint(host, new Set([host])), /private or reserved/);
});

test('all-provider mode permits account creation and updates without maintaining provider lists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mailmcp-providers-'));
  const vault = new Vault(dir, randomBytes(32));
  try {
    const all = new Accounts(vault, new Set(['*']));
    for (const [incoming, outgoing] of [
      ['imappro.zoho.eu', 'smtppro.zoho.eu'],
      ['imap.zoho.eu', 'smtp.zoho.eu'],
      ['imap.custom-provider.example', 'smtp.custom-provider.example'],
    ]) {
      const created = all.add('alice', {
        ...sample,
        incoming: { ...sample.incoming, host: incoming },
        smtp: {
          host: outgoing,
          port: 465,
          security: 'tls',
          username: sample.email,
          password: 'synthetic-password',
        },
      });
      assert.equal(created.incoming?.host, incoming);
      assert.equal(created.smtp?.host, outgoing);
      assert.equal(
        all.update('alice', created.id, {
          incoming: {
            ...sample.incoming,
            host: 'pop.custom-provider.example',
            protocol: 'pop3',
            port: 995,
          },
        }).incoming?.protocol,
        'pop3',
      );
      assert.throws(
        () =>
          new Accounts(vault, new Set(['imap.example.com'])).update('alice', created.id, {
            label: 'Restricted',
          }),
        /not enabled/,
      );
    }
    assert.throws(() => new Accounts(vault, new Set()).add('alice', sample), /not enabled/);
  } finally {
    vault.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('all-provider DNS policy checks every answer, pins one public address and rechecks each connection', async () => {
  const allowed = readConfig({
    MAILMCP_MASTER_KEY: randomBytes(32).toString('hex'),
    MAILMCP_ALLOWED_HOSTS: '*',
  }).allowedHosts;
  let lookups = 0;
  const resolver = async (name: string) => {
    assert.equal(name, 'imappro.zoho.eu');
    lookups++;
    return [{ address: lookups === 1 ? '8.8.8.8' : '127.0.0.1' }];
  };
  assert.deepEqual(await mailEndpoint('imappro.zoho.eu', allowed, resolver), {
    address: '8.8.8.8',
    servername: 'imappro.zoho.eu',
  });
  assert.equal(lookups, 1);
  await assert.rejects(mailEndpoint('imappro.zoho.eu', allowed, resolver), /private or reserved/);
  for (const address of [
    '127.0.0.1',
    '0.0.0.0',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '224.0.0.1',
    '192.0.2.1',
    '::1',
    '::',
    'fc00::1',
    'fe80::1',
    'ff02::1',
    '2001:db8::1',
    '::ffff:127.0.0.1',
  ]) {
    await assert.rejects(
      mailEndpoint('mail.example', allowed, async () => [{ address }]),
      /private or reserved/,
    );
    await assert.rejects(
      mailEndpoint('mail.example', allowed, async () => [{ address: '8.8.8.8' }, { address }]),
      /private or reserved/,
    );
  }
  await assert.rejects(
    mailEndpoint('mail.example', allowed, async () => []),
    /private or reserved/,
  );
  assert.deepEqual(
    await mailEndpoint('mail.example', allowed, async () => [{ address: '2606:4700:4700::1111' }]),
    { address: '2606:4700:4700::1111', servername: 'mail.example' },
  );
  await assert.rejects(
    mailEndpoint('unlisted.example', new Set(['listed.example']), async () => {
      throw new Error('DNS must not run for rejected hosts');
    }),
    /not enabled/,
  );
});

test('POP3 parser handles fragmented framing, dot unstuffing and binary bytes', async () => {
  const stream = new PassThrough(),
    parser = new PopLines(stream),
    response = parser.response(true);
  stream.write('+O');
  stream.write('K\r\nSubject: test\r');
  stream.write('\n\r\n..escaped\r\n');
  stream.write(Buffer.from([0xe9, 13, 10]));
  stream.write('.\r\n');
  assert.deepEqual(
    await response,
    Buffer.concat([Buffer.from('Subject: test\r\n\r\n.escaped\r\n'), Buffer.from([0xe9, 13, 10])]),
  );
  stream.destroy();
});

test('POP3 parser rejects provider errors without leaking raw response and rejects disconnect', async () => {
  const stream = new PassThrough(),
    parser = new PopLines(stream),
    response = parser.response();
  stream.write('-ERR secret detail\r\n');
  await assert.rejects(
    response,
    (error) => error instanceof Error && !error.message.includes('secret detail'),
  );
  const pending = parser.response();
  stream.destroy();
  await assert.rejects(pending, /closed/);
});
