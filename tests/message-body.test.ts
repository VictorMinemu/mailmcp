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

const headers = 'From: sender@example.com\r\nSubject: Synthetic reply\r\nMIME-Version: 1.0\r\n';
const message = (body: string) => Buffer.from(headers + body);
const alternative = (plain: string, html: string) =>
  'Content-Type: multipart/alternative; boundary="alt"\r\n\r\n' +
  '--alt\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n' +
  plain +
  '\r\n--alt\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n' +
  Buffer.from(html).toString('base64') +
  '\r\n--alt--\r\n';

async function fixture(
  protocol: 'imap' | 'pop3',
  source: Buffer,
  run: (mail: Mail, args: any, accounts: Accounts) => Promise<void>,
  size = source.length,
) {
  const dir = mkdtempSync(join(tmpdir(), 'mailmcp-body-'));
  const vault = new Vault(dir, randomBytes(32));
  const accounts = new Accounts(vault, new Set(['mail.example.com']));
  const mail = new Mail(accounts, new Set());
  let releases = 0;
  (mail as any).imap = async (_account: unknown, callback: any) =>
    callback({
      mailbox: { uidValidity: 42n },
      getMailboxLock: async (_folder: string, options: unknown) => {
        assert.deepEqual(options, { readOnly: true });
        return {
          release() {
            releases++;
          },
        };
      },
      fetchOne: async (_uid: string, _query: unknown, options: unknown) => {
        assert.deepEqual(options, { uid: true });
        return { source, size };
      },
    });
  (mail as any).pop = async (_account: unknown, callback: any) =>
    callback({ read: async () => source });
  try {
    const account = accounts.add('alice', {
      label: 'Test',
      email: 'me@example.com',
      senderName: 'Test',
      incoming: {
        protocol,
        host: 'mail.example.com',
        port: protocol === 'imap' ? 993 : 995,
        security: 'tls',
        username: 'me@example.com',
        password: 'synthetic-password',
      },
    });
    await run(
      mail,
      { accountId: account.id, messageId: '1', folder: 'INBOX', uidValidity: '42' },
      accounts,
    );
    if (protocol === 'imap') assert.ok(releases > 0);
  } finally {
    vault.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const protocol of ['imap', 'pop3'] as const) {
  for (const plain of ['', ' \t\r\n', '\u00a0']) {
    test(`${protocol}: empty plain alternative falls back to decoded HTML (${JSON.stringify(plain)})`, async () => {
      await fixture(
        protocol,
        message(alternative(plain, '<p>Confirmación: entrega el viernes &amp; revisión.</p>')),
        async (mail, args) => {
          const result = await mail.read('alice', args);
          assert.match(result.text, /Confirmación: entrega el viernes & revisión\./);
          assert.equal(result.truncated, false);
          assert.equal(result.untrustedContent, true);
        },
      );
    });
  }
}

test('nested MIME falls back to HTML while preserving attachment bytes and indices', async () => {
  const bytes = Buffer.from([0, 255, 128, 13, 10]);
  const source = message(
    'Content-Type: multipart/mixed; boundary="mixed"\r\n\r\n--mixed\r\n' +
      'Content-Type: multipart/related; boundary="related"\r\n\r\n--related\r\n' +
      alternative('', '<p>Delivery confirmed.</p>') +
      '\r\n--related--\r\n' +
      '--mixed\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="proof.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\n' +
      bytes.toString('base64') +
      '\r\n--mixed--\r\n',
  );
  await fixture('imap', source, async (mail, args) => {
    const result = await mail.read('alice', args);
    assert.match(result.text, /Delivery confirmed\./);
    assert.equal(result.attachments[0]?.filename, 'proof.bin');
    assert.deepEqual(
      Buffer.from((await mail.attachment('alice', { ...args, index: 0 })).contentBase64, 'base64'),
      bytes,
    );
  });
});

test('useful plain text retains precedence and formatting', async () => {
  await fixture(
    'imap',
    message(alternative('Plain reply\r\n  with indentation', '<p>Different HTML</p>')),
    async (mail, args) => {
      assert.equal((await mail.read('alice', args)).text, 'Plain reply\n  with indentation');
    },
  );
});

test('HTML-only alternative containing related images exposes the reply body', async () => {
  // Synthetic structure of the production failure: alternative -> related ->
  // base64 HTML + three PNGs, with no text/plain part anywhere in the message.
  const source = message(
    'Content-Type: multipart/alternative; boundary="outer"\r\n\r\n--outer\r\n' +
      'Content-Type: multipart/related; boundary="inner"; type="text/html"\r\n\r\n--inner\r\n' +
      'Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n' +
      Buffer.from('<p>We have received your request and will review it.</p>').toString('base64') +
      '\r\n' +
      [1, 2, 3]
        .map(
          (index) =>
            '--inner\r\nContent-Type: image/png; name="image' +
            index +
            '.png"\r\n' +
            'Content-ID: <image' +
            index +
            '>\r\nContent-Transfer-Encoding: base64\r\n\r\nAAEC\r\n',
        )
        .join('') +
      '--inner--\r\n--outer--\r\n',
  );
  await fixture('imap', source, async (mail, args, accounts) => {
    const server = createMcp(
      { accounts, mail, auth: new Auth(), origin: 'http://127.0.0.1:3210' },
      'alice',
    );
    const client = new Client({ name: 'html-reply-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const response = await client.callTool({ name: 'messages_read', arguments: args });
      assert.notEqual(response.isError, true);
      const result = JSON.parse((response.content as any[])[0].text);
      assert.equal(result.text, 'We have received your request and will review it.');
      assert.equal(result.attachments.length, 3);
      assert.equal(result.truncated, false);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

test('HTML-only quoted-printable messages decode charset and entities without executing markup', async () => {
  await fixture(
    'imap',
    message(
      'Content-Type: text/html; charset=iso-8859-1\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n<style>hidden style</style><script>danger()</script><p>Confirmaci=F3n &amp; entrega</p>',
    ),
    async (mail, args) => {
      const result = await mail.read('alice', args);
      assert.equal(result.text, 'Confirmación & entrega');
    },
  );
});

test('HTML fallback keeps the 100,000 character limit and reports truncation', async () => {
  await fixture(
    'imap',
    message(alternative('', '<p>' + 'a'.repeat(100_001) + '</p>')),
    async (mail, args) => {
      const result = await mail.read('alice', args);
      assert.equal(result.text.length, 100_000);
      assert.equal(result.truncated, true);
    },
  );
});

for (const body of [
  'Content-Type: text/plain\r\n\r\n',
  'Content-Type: text/html\r\n\r\n<html><body><br></body></html>',
  'Content-Type: application/pkcs7-mime\r\nContent-Transfer-Encoding: base64\r\n\r\nAAEC',
  'Content-Type: text/plain\r\nContent-Disposition: attachment; filename="notes.txt"\r\n\r\nAttachment only',
]) {
  test(`MCP explicitly reports unavailable body: ${body.split('\r\n')[0]}`, async () => {
    await fixture('imap', message(body), async (mail, args, accounts) => {
      const server = createMcp(
        { accounts, mail, auth: new Auth(), origin: 'http://127.0.0.1:3210' },
        'alice',
      );
      const client = new Client({ name: 'body-test', version: '1.0.0' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        const response = await client.callTool({ name: 'messages_read', arguments: args });
        assert.equal(response.isError, true);
        const error = JSON.parse((response.content as any[])[0].text);
        assert.equal(error.code, 'MESSAGE_BODY_UNAVAILABLE');
        assert.match(error.message, /Do not draft/);
        // Body extraction must not prevent listing/downloading attachments.
        await mail.attachments('alice', args);
      } finally {
        await client.close();
        await server.close();
      }
    });
  });
}

test('incomplete IMAP source cannot be mistaken for a complete message', async () => {
  const source = message('Content-Type: text/plain\r\n\r\nOnly the start');
  await fixture(
    'imap',
    source,
    async (mail, args) => {
      await assert.rejects(mail.read('alice', args), { code: 'MESSAGE_INCOMPLETE' });
    },
    source.length + 100,
  );
});
