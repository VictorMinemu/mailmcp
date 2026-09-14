import { connect, type TLSSocket } from 'node:tls';
import { once } from 'node:events';
import type { Duplex } from 'node:stream';
import { AppError } from './errors.js';

export const MAX_MESSAGE = 10_000_000;
// A bounded byte parser preserves MIME encodings across TCP chunk boundaries.
export class PopLines {
  private buffer = Buffer.alloc(0);
  private waiting?: { resolve: (line: Buffer) => void; reject: (e: Error) => void };
  private failure?: Error;
  constructor(private stream: Duplex) {
    stream.on('data', (chunk: Buffer) => {
      if (this.buffer.length + chunk.length > MAX_MESSAGE + 64_000) {
        this.fail(new AppError('MESSAGE_SIZE', 'POP3 response exceeds size limit.'));
        stream.destroy();
        return;
      }
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.deliver();
    });
    stream.on('error', () => this.fail(new AppError('POP3_CONNECTION', 'POP3 connection failed.')));
    stream.on('close', () => this.fail(new AppError('POP3_CLOSED', 'POP3 connection closed.')));
  }
  private fail(error: Error) {
    this.failure = error;
    this.waiting?.reject(error);
    this.waiting = undefined;
  }
  private deliver() {
    const end = this.buffer.indexOf('\r\n');
    if (this.waiting && end >= 0) {
      const line = this.buffer.subarray(0, end);
      this.buffer = this.buffer.subarray(end + 2);
      const waiting = this.waiting;
      this.waiting = undefined;
      waiting.resolve(line);
    }
  }
  line(): Promise<Buffer> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.waiting) return Promise.reject(new Error('Concurrent POP3 command'));
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject };
      this.deliver();
    });
  }
  async response(multiline = false) {
    const status = await this.line();
    if (!status.toString('ascii').startsWith('+OK'))
      throw new AppError(
        'POP3_REJECTED',
        'POP3 server rejected the operation. UIDL support is required.',
      );
    if (!multiline) return status;
    const chunks: Buffer[] = [];
    let size = 0;
    while (true) {
      let line = await this.line();
      if (line.equals(Buffer.from('.'))) break;
      if (line[0] === 46 && line[1] === 46) line = line.subarray(1);
      size += line.length + 2;
      if (size > MAX_MESSAGE)
        throw new AppError('MESSAGE_SIZE', 'POP3 response exceeds size limit.');
      chunks.push(line, Buffer.from('\r\n'));
    }
    return Buffer.concat(chunks);
  }
}

export class Pop3 {
  private socket: TLSSocket;
  private lines: PopLines;
  private deadline: NodeJS.Timeout;
  constructor(address: string, servername: string, port: number) {
    this.socket = connect({
      host: address,
      servername,
      port,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
    });
    this.lines = new PopLines(this.socket);
    this.socket.setTimeout(15_000, () => this.socket.destroy());
    this.deadline = setTimeout(() => this.socket.destroy(), 45_000);
  }
  async login(username: string, password: string) {
    if (/[\r\n\x00]/.test(username + password))
      throw new AppError('INVALID_INPUT', 'Invalid POP3 credentials.');
    await once(this.socket, 'secureConnect');
    await this.lines.response();
    await this.command(`USER ${username}`);
    await this.command(`PASS ${password}`);
  }
  private command(command: string, multi = false) {
    this.socket.write(`${command}\r\n`);
    return this.lines.response(multi);
  }
  async list() {
    const source = (await this.command('UIDL', true)).toString('ascii').trim();
    if (!source) return [];
    return source.split('\r\n').map((line) => {
      const match = /^([1-9]\d*) ([!-~]{1,70})$/.exec(line);
      if (!match) throw new AppError('POP3_RESPONSE', 'Invalid POP3 UIDL response.');
      return { number: Number(match[1]), messageId: match[2]! };
    });
  }
  async read(uidl: string) {
    const message = (await this.list()).find((m) => m.messageId === uidl);
    if (!message) throw new AppError('NOT_FOUND', 'Message not found.', 404);
    return this.command(`RETR ${message.number}`, true);
  }
  close() {
    clearTimeout(this.deadline);
    this.socket.destroy();
  }
}
