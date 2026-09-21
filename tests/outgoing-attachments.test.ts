import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { outgoingAttachmentSchema, sendSchema } from '../src/schemas.js';
import {
  MAX_OUTGOING_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_BASE64_LENGTH,
  validAttachmentBase64,
} from '../src/uploads.js';
import { Vault } from '../src/vault.js';
import { Accounts } from '../src/accounts.js';
import { Auth } from '../src/auth.js';
import { Mail } from '../src/mail.js';
import { createMcp } from '../src/mcp.js';

const attachment = { filename: 'file.bin', contentBase64: 'AAEC/4A=' };
const send = {
  accountId: randomUUID(),
  to: ['recipient@example.com'],
  subject: 'Files',
  text: 'Please review.',
  confirm: true,
};

test('outgoing files reject invalid base64, paths, MIME/header injection and file/URL loading', () => {
  for (const contentBase64 of [
    'A',
    'AAA',
    'A===',
    '====',
    'AB==',
    'AAB=',
    'AA==\n',
    'data:text/plain;base64,AA==',
    '__8=',
  ])
    assert.equal(
      outgoingAttachmentSchema.safeParse({ ...attachment, contentBase64 }).success,
      false,
      contentBase64,
    );
  for (const filename of [
    '../file',
    '/etc/passwd',
    'C:\\secret',
    '.',
    '..',
    'bad\r\nBcc: x',
    'a\0b',
  ])
    assert.equal(outgoingAttachmentSchema.safeParse({ ...attachment, filename }).success, false);
  for (const contentType of [
    'text/plain\r\nX-Injected: yes',
    'text/plain; name=evil',
    'text',
    '*/mixed',
  ])
    assert.equal(outgoingAttachmentSchema.safeParse({ ...attachment, contentType }).success, false);
  for (const property of ['path', 'href', 'raw', 'headers', 'cid'])
    assert.equal(
      outgoingAttachmentSchema.safeParse({
        ...attachment,
        [property]: 'https://internal.example/secret',
      }).success,
      false,
    );
  assert.equal(
    outgoingAttachmentSchema.parse({ filename: 'vacío.txt', contentBase64: '' }).contentBase64,
    '',
  );
  assert.equal(
    sendSchema.safeParse({ ...send, confirm: false, attachments: [attachment] }).success,
    false,
  );
  assert.equal(
    sendSchema.safeParse({ ...send, attachments: Array(11).fill(attachment) }).success,
    false,
  );
  assert.equal(sendSchema.safeParse(send).success, true);
});

test('outgoing attachment sizes use decoded bytes and enforce 25 MB per file and total', () => {
  const maximum = Buffer.alloc(MAX_OUTGOING_ATTACHMENT_BYTES).toString('base64');
  assert.equal(maximum.length, MAX_ATTACHMENT_BASE64_LENGTH);
  assert.equal(validAttachmentBase64(maximum), true);
  assert.equal(
    sendSchema.safeParse({ ...send, attachments: [{ ...attachment, contentBase64: maximum }] })
      .success,
    true,
  );
  assert.equal(
    sendSchema.safeParse({
      ...send,
      attachments: [{ ...attachment, contentBase64: maximum }, attachment],
    }).success,
    false,
  );
  // One extra byte has the same encoded length; an encoded-length-only check would miss it.
  assert.equal(
    validAttachmentBase64(Buffer.alloc(MAX_OUTGOING_ATTACHMENT_BYTES + 1).toString('base64')),
    false,
  );
});

test('MCP messages_send produces exact multipart attachment bytes and enforces ownership before SMTP', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mailmcp-send-'));
  const vault = new Vault(dir, randomBytes(32));
  const accounts = new Accounts(vault, new Set(['smtp.example.com']));
  const mail = new Mail(accounts, new Set());
  const encoder = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  let emitted: Buffer | undefined;
  let connections = 0;
  let closed = 0;
  // Exercise real MIME composition, capturing locally instead of sending external email.
  (mail as any).smtp = async () => {
    connections++;
    return {
      sendMail: async (message: any) => {
        const result = await encoder.sendMail(message);
        emitted = result.message as Buffer;
        return { messageId: result.messageId, accepted: message.to, rejected: [] };
      },
      close: () => {
        closed++;
      },
    };
  };
  const mcp = createMcp(
    { accounts, mail, auth: new Auth(), origin: 'http://127.0.0.1:3210' },
    'alice',
  );
  const client = new Client({ name: 'send-fixture', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    const account = accounts.add('alice', {
      label: 'SMTP fixture',
      email: 'alice@example.com',
      senderName: 'Alice',
      smtp: {
        host: 'smtp.example.com',
        port: 465,
        security: 'tls',
        username: 'alice',
        password: 'synthetic-secret',
      },
    });
    await mcp.connect(serverTransport);
    await client.connect(clientTransport);
    const schema = (await client.listTools()).tools.find(
      (t) => t.name === 'messages_send',
    )!.inputSchema;
    assert.ok(schema.properties?.attachments);
    const binary = randomBytes(300_000);
    const args = {
      ...send,
      accountId: account.id,
      attachments: [
        {
          filename: 'datos.bin',
          contentType: 'application/octet-stream',
          contentBase64: binary.toString('base64'),
        },
        {
          filename: 'notas.txt',
          contentType: 'text/plain',
          contentBase64: Buffer.from('Hola, adjunto.').toString('base64'),
        },
      ],
    };
    const result = await client.callTool({ name: 'messages_send', arguments: args });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    const parsed = await simpleParser(emitted!);
    assert.equal(parsed.attachments.length, 2);
    assert.equal(parsed.attachments[0]!.filename, 'datos.bin');
    assert.deepEqual(parsed.attachments[0]!.content, binary);
    assert.equal(parsed.attachments[1]!.content.toString(), 'Hola, adjunto.');
    assert.equal(parsed.attachments[0]!.contentDisposition, 'attachment');
    assert.equal(closed, 1);
    assert.equal(JSON.stringify(result).includes(args.attachments[0]!.contentBase64), false);
    await assert.rejects(mail.send('bob', args), /not found/);
    assert.equal(connections, 1);
    const rejected = await client.callTool({
      name: 'messages_send',
      arguments: { ...args, confirm: false },
    });
    assert.equal(rejected.isError, true);
    assert.equal(connections, 1);
    await mail.send('alice', { ...send, accountId: account.id });
    assert.equal((await simpleParser(emitted!)).attachments.length, 0);
    assert.equal(closed, 2);
  } finally {
    await client.close();
    await mcp.close();
    encoder.close();
    vault.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
