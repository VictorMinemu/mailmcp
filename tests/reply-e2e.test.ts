import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createTcpServer, type Socket } from 'node:net';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { SMTPServer } from 'smtp-server';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Vault } from '../src/vault.js';
import { Accounts } from '../src/accounts.js';
import { Auth } from '../src/auth.js';
import { Mail, IMAP_LIMITS } from '../src/mail.js';
import { createWeb } from '../src/web.js';
import { readConfig } from '../src/config.js';
import { AppError } from '../src/errors.js';

// Test-only HTTP bridge preserves the public Host while connecting to loopback.
const rawFetch: typeof fetch = async (input, init = {}) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      url,
      {
        method: init.method ?? 'GET',
        headers: {
          ...Object.fromEntries(new Headers(init.headers)),
          ...(init.body ? { 'content-length': Buffer.byteLength(String(init.body)) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const headers = new Headers();
          for (const [k, v] of Object.entries(res.headers))
            if (v) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
          resolve(
            new Response([204, 205, 304].includes(res.statusCode!) ? null : Buffer.concat(chunks), {
              status: res.statusCode,
              headers,
            }),
          );
        });
      },
    );
    req.on('error', reject);
    if (init.body) req.write(String(init.body));
    req.end();
  });
};
const content = (r: any) => JSON.parse(r.content.find((c: any) => c.type === 'text').text);

test(
  'HTTP MCP -> IMAP MIME -> SMTP delivery preserves two successive replies and attachment bytes',
  { timeout: 20000 },
  async () => {
    const source = Buffer.from(
      [
        'From: Sender <sender@example.com>',
        'Reply-To: support@example.com',
        'To: alice@example.com',
        'Message-ID: <parent@sender.example>',
        'References: <root@sender.example>',
        'Subject: =?UTF-8?Q?Re:_Revisi=C3=B3n_de_factura?=',
        'MIME-Version: 1.0',
        'Content-Type: multipart/alternative; boundary="alt"',
        '',
        '--alt',
        'Content-Type: multipart/related; boundary="related"',
        '',
        '--related',
        'Content-Type: text/html; charset=utf-8',
        '',
        '<p>Please review the invoice.</p>',
        '--related--',
        '--alt--',
        '',
      ].join('\r\n'),
    );
    const messages = new Map([[7, source]]);
    const commands: string[] = [];
    const sockets = new Set<Socket>();
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
              '* FLAGS (\\Seen)\r\n* ' +
                messages.size +
                ' EXISTS\r\n* OK [UIDVALIDITY 42] valid\r\n* OK [UIDNEXT 10] next\r\n' +
                tag +
                ' OK [READ-ONLY] examined\r\n',
            );
          else if (cmd.startsWith('UID FETCH')) {
            const uid = Number(parts[2]),
              bytes = messages.get(uid);
            if (bytes) {
              socket.write(
                `* 1 FETCH (UID ${uid} RFC822.SIZE ${bytes.length} BODY[]<0> {${bytes.length}}\r\n`,
              );
              socket.write(bytes);
              socket.write(')\r\n');
            }
            socket.write(tag + ' OK fetched\r\n');
          } else if (cmd === 'LOGOUT') socket.end('* BYE\r\n' + tag + ' OK logout\r\n');
          else socket.write(tag + ' BAD unexpected test command\r\n');
        }
      });
    });
    const delivered: { source: Buffer; to: string[] }[] = [];
    const smtp = new SMTPServer({
      authOptional: true,
      disabledCommands: ['AUTH', 'STARTTLS'],
      logger: false,
      onRcptTo(address, _session, done) {
        if (address.address === 'rejected@example.com')
          return done(
            Object.assign(new Error('Synthetic recipient rejection'), { responseCode: 550 }),
          );
        done();
      },
      onData(stream, session, done) {
        const chunks: Buffer[] = [];
        stream.on('data', (c) => chunks.push(c));
        stream.on('end', () => {
          delivered.push({
            source: Buffer.concat(chunks),
            to: session.envelope.rcptTo.map((r) => r.address),
          });
          done();
        });
      },
    });
    const dir = mkdtempSync(join(tmpdir(), 'mailmcp-reply-e2e-')),
      vault = new Vault(dir, randomBytes(32));
    const accounts = new Accounts(vault, new Set(['mail.example.com'])),
      auth = new Auth(),
      mail = new Mail(accounts, new Set());
    const config = readConfig({
      MAILMCP_MODE: 'hosted',
      MAILMCP_MASTER_KEY: randomBytes(32).toString('hex'),
      MAILMCP_PUBLIC_URL: 'https://mail.example.com',
      MAILMCP_OIDC_ISSUER: 'https://identity.example.com',
      MAILMCP_OIDC_CLIENT_ID: 'web',
    });
    const web = createWeb(
      config,
      { accounts, auth, mail, origin: config.origin },
      {
        begin: async () => ({ url: 'https://identity.example.com', binding: 'fixture' }),
        finish: async () => 'alice',
        bearer: async (token) => {
          if (token === 'alice-test') return 'alice';
          if (token === 'bob-test') return 'bob';
          throw new AppError('UNAUTHORIZED', 'Invalid token.', 401);
        },
      },
    );
    const client = new Client({ name: 'reply-e2e', version: '1.0.0' });
    const bob = new Client({ name: 'other-owner', version: '1.0.0' });
    try {
      await new Promise<void>((r) => imap.listen(0, '127.0.0.1', r));
      await new Promise<void>((r) => smtp.listen(0, '127.0.0.1', r));
      await new Promise<void>((r) => web.listen(0, '127.0.0.1', r));
      const imapPort = (imap.address() as any).port,
        smtpPort = (smtp.server.address() as any).port;
      // Replace network destination adapters only. The real IMAP client, MIME parser,
      // SMTP client/composer, HTTP routing, schemas, ownership and MCP are exercised.
      // Production TLS/DNS policy is unchanged; fixtures are isolated loopback services.
      (mail as any).imap = async (_account: unknown, callback: any) => {
        const c = new ImapFlow({
          ...IMAP_LIMITS,
          host: '127.0.0.1',
          port: imapPort,
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
      (mail as any).smtp = async () =>
        nodemailer.createTransport({
          host: '127.0.0.1',
          port: smtpPort,
          secure: false,
          ignoreTLS: true,
          disableFileAccess: true,
          disableUrlAccess: true,
        });
      const base = `http://127.0.0.1:${(web.address() as any).port}`;
      for (const [connection, token] of [
        [client, 'alice-test'],
        [bob, 'bob-test'],
      ] as const)
        await connection.connect(
          new StreamableHTTPClientTransport(new URL(base + '/mcp'), {
            fetch: rawFetch,
            requestInit: {
              headers: { host: 'mail.example.com', authorization: `Bearer ${token}` },
            },
          }),
        );
      const account = content(
        await client.callTool({
          name: 'accounts_add',
          arguments: {
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
          },
        }),
      );
      const originalArgs = {
        accountId: account.id,
        folder: 'INBOX',
        messageId: '7',
        uidValidity: '42',
      };
      const read = await client.callTool({ name: 'messages_read', arguments: originalArgs });
      assert.notEqual(read.isError, true, JSON.stringify(read));
      assert.match(content(read).text, /Please review the invoice/);
      const bytes = randomBytes(300_000),
        args = {
          ...originalArgs,
          to: ['support@example.com'],
          text: 'Confirmamos la revisión.',
          confirm: true,
          attachments: [{ filename: 'proof.bin', contentBase64: bytes.toString('base64') }],
        };
      const denied = await bob.callTool({ name: 'messages_reply', arguments: args });
      assert.equal(denied.isError, true);
      assert.equal(content(denied).code, 'NOT_FOUND');
      assert.equal(delivered.length, 0);
      const response = await client.callTool({ name: 'messages_reply', arguments: args });
      assert.notEqual(response.isError, true, JSON.stringify(response));
      assert.equal(delivered.length, 1);
      assert.deepEqual(delivered[0]!.to, ['support@example.com']);
      const first = await simpleParser(delivered[0]!.source);
      assert.equal(first.inReplyTo, '<parent@sender.example>');
      assert.deepEqual(first.references, ['<root@sender.example>', '<parent@sender.example>']);
      assert.equal(first.subject, 'Re: Revisión de factura');
      assert.equal(first.text?.trim(), args.text);
      assert.deepEqual(first.attachments[0]!.content, bytes);
      assert.equal(content(response).messageId, first.messageId);
      messages.set(8, delivered[0]!.source);
      const secondReply = await client.callTool({
        name: 'messages_reply',
        arguments: { ...args, messageId: '8', text: 'Second reply', attachments: undefined },
      });
      assert.notEqual(secondReply.isError, true, JSON.stringify(secondReply));
      const second = await simpleParser(delivered[1]!.source);
      assert.equal(second.inReplyTo, first.messageId);
      assert.deepEqual(second.references, [
        '<root@sender.example>',
        '<parent@sender.example>',
        first.messageId,
      ]);
      assert.equal(second.subject, first.subject);
      assert.equal(second.attachments.length, 0);
      const partial = await client.callTool({
        name: 'messages_reply',
        arguments: {
          ...args,
          attachments: undefined,
          to: ['support@example.com', 'rejected@example.com'],
        },
      });
      assert.notEqual(partial.isError, true);
      assert.deepEqual(content(partial).accepted, ['support@example.com']);
      assert.deepEqual(content(partial).rejected, ['rejected@example.com']);
      const rejected = await client.callTool({
        name: 'messages_reply',
        arguments: { ...args, attachments: undefined, to: ['rejected@example.com'] },
      });
      assert.equal(rejected.isError, true);
      assert.equal(content(rejected).code, 'OPERATION_FAILED');
      assert.equal(delivered.length, 3, 'Rejected delivery must not be retried');
      const cookie = `__Host-mailmcp=${auth.session('alice')}`;
      const csrf = await rawFetch(base + '/api/mail/reply', {
        method: 'POST',
        headers: { host: 'mail.example.com', cookie, 'content-type': 'application/json' },
        body: JSON.stringify(args),
      });
      assert.equal(csrf.status, 403);
      const webReply = await rawFetch(base + '/api/mail/reply', {
        method: 'POST',
        headers: {
          host: 'mail.example.com',
          origin: config.origin,
          cookie,
          'content-type': 'application/json',
        },
        body: JSON.stringify(args),
      });
      assert.equal(webReply.status, 200, JSON.stringify(await webReply.json()));
      assert.equal(delivered.length, 4);
      const webMessage = await simpleParser(delivered[3]!.source);
      assert.equal(webMessage.inReplyTo, '<parent@sender.example>');
      assert.deepEqual(webMessage.attachments[0]!.content, bytes);
      assert.ok(commands.some((c) => /EXAMINE/.test(c)));
      assert.ok(commands.some((c) => /BODY\.PEEK\[\]/.test(c)));
      assert.ok(
        !commands.some((c) => /\bSTORE\b|\bSELECT\b/.test(c)),
        'Replies must not modify mailbox flags',
      );
    } finally {
      await client.close();
      await bob.close();
      web.closeAllConnections();
      await new Promise<void>((r) => web.close(() => r()));
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((r) => imap.close(() => r()));
      await new Promise<void>((r) => smtp.close(r));
      vault.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
