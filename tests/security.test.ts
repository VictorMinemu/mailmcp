import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Socket } from 'node:net';
import { ImapStream } from 'imapflow/lib/handler/imap-stream.js';
import { IMAP_LIMITS } from '../src/mail.js';
import { Pop3 } from '../src/pop3.js';
import { smtpTransport } from '../src/smtp.js';

test('IMAP rejects oversized literals and unterminated lines before buffering mail', async () => {
  for (const [payload, code] of [
    [`* 1 FETCH (BODY[] {${IMAP_LIMITS.maxLiteralSize + 1}}\r\n`, 'LiteralTooLarge'],
    ['x'.repeat(IMAP_LIMITS.maxLineLength + 1), 'LineTooLarge'],
  ]) {
    const parser = new ImapStream({ ...IMAP_LIMITS, logger: false });
    const error = once(parser, 'error');
    parser.write(Buffer.from(payload!));
    const [failure] = await error;
    assert.equal(failure.code, code);
    assert.equal(parser.destroyed, true);
  }
});

test(
  'SMTP deadline closes a trickling peer before sending credentials',
  { timeout: 5000 },
  async () => {
    const sockets = new Set<Socket>();
    let received = '';
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('data', (chunk) => {
        received += chunk.toString();
      });
      const trickle = setInterval(() => socket.write('2'), 10);
      socket.on('close', () => {
        clearInterval(trickle);
        sockets.delete(socket);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const client = smtpTransport(
      {
        host: 'localhost',
        port: (server.address() as { port: number }).port,
        security: 'starttls',
        username: 'fixture-user',
        password: 'fixture-secret',
      },
      { address: '127.0.0.1', servername: 'localhost' },
      150,
    );
    try {
      await assert.rejects(client.verify());
      assert.equal(received.includes('fixture-secret'), false);
    } finally {
      client.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

test(
  'POP3 login rejects a peer close during TLS and an explicit close',
  { timeout: 5000 },
  async () => {
    for (const peerCloses of [true, false]) {
      const sockets = new Set<Socket>();
      const server = createServer((socket) => {
        sockets.add(socket);
        socket.on('error', () => {});
        socket.on('close', () => sockets.delete(socket));
        if (peerCloses) socket.destroy();
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const client = new Pop3(
        '127.0.0.1',
        'localhost',
        (server.address() as { port: number }).port,
      );
      try {
        const rejected = assert.rejects(
          client.login('fixture', 'fixture'),
          /POP3 connection failed/,
        );
        if (!peerCloses) client.close();
        await rejected;
      } finally {
        client.close();
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  },
);
