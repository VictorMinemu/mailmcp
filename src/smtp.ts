import { Socket } from 'node:net';
import nodemailer, { type SendMailOptions } from 'nodemailer';
import type { Account } from './schemas.js';

// The caller supplies an address already checked by mailEndpoint. Keeping the
// underlying socket lets us close even a peer that continuously trickles data;
// Nodemailer's non-pooled transport.close() does not close active connections.
export function smtpTransport(
  connection: NonNullable<Account['smtp']>,
  target: { address: string; servername: string },
  timeoutMs = 45_000,
) {
  const socket = new Socket();
  socket.on('error', () => {});
  const deadline = setTimeout(() => socket.destroy(new Error('SMTP deadline exceeded')), timeoutMs);
  const transport = nodemailer.createTransport({
    socket,
    host: target.address,
    port: connection.port,
    secure: connection.security === 'tls',
    requireTLS: true,
    auth: { user: connection.username, pass: connection.password },
    tls: { servername: target.servername, rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
    disableFileAccess: true,
    disableUrlAccess: true,
    logger: false,
    debug: false,
  });
  return {
    verify: () => transport.verify(),
    sendMail: (message: SendMailOptions) => transport.sendMail(message),
    close() {
      clearTimeout(deadline);
      socket.destroy();
      transport.close();
    },
  };
}
