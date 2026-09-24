import type { ParsedMail } from 'mailparser';
import { AppError } from './errors.js';

// RFC 5322 modern msg-id syntax: dot-atom left and dot-atom/domain-literal right.
// Bound each token so the SMTP composer can keep physical header lines under 998 bytes.
const messageId =
  /^<[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*|\[[\x21-\x5a\x5e-\x7e]+\])>/;

function ids(value: string): string[] | undefined {
  if (value.length > 16_384) return;
  const result: string[] = [];
  let i = 0;
  while (i < value.length) {
    if (/[ \t\r\n]/.test(value[i]!)) {
      i++;
      continue;
    }
    // CFWS comments can surround identifiers but are not part of their identity.
    if (value[i] === '(') {
      let depth = 1;
      while (++i < value.length && depth) {
        if (value[i] === '\\') i++;
        else if (value[i] === '(') depth++;
        else if (value[i] === ')') depth--;
      }
      if (depth) return;
      continue;
    }
    if (value[i] !== '<') return;
    const token = value.slice(i).match(messageId)?.[0];
    if (!token || token.length > 900) return;
    result.push(token);
    if (result.length > 100) return;
    i += token.length;
  }
  return result;
}

function header(parsed: ParsedMail, name: string): string | undefined {
  const lines = parsed.headerLines.filter((h) => h.key.toLowerCase() === name);
  if (!lines.length) return '';
  if (lines.length !== 1) return;
  // Use the actual RFC header: MailParser otherwise repairs missing angle brackets.
  return lines[0]!.line.slice(lines[0]!.line.indexOf(':') + 1);
}

export function replyHeaders(parsed: ParsedMail) {
  const rawId = header(parsed, 'message-id');
  const parent = rawId === undefined ? undefined : ids(rawId);
  if (parent?.length !== 1)
    throw new AppError(
      'REPLY_MESSAGE_ID',
      'The original message has no single supported Message-ID. Cannot send a threaded reply.',
    );
  const inReplyTo = parent[0]!;
  const rawReferences = header(parsed, 'references');
  let ancestry = rawReferences === undefined ? undefined : ids(rawReferences);
  if (!ancestry)
    throw new AppError(
      'REPLY_REFERENCES',
      'The original thread references are invalid or too large. Cannot safely preserve the thread.',
    );
  if (!ancestry.length) {
    const rawReply = header(parsed, 'in-reply-to');
    const previous = rawReply === undefined ? undefined : ids(rawReply);
    if (previous?.length === 1) ancestry = previous;
  }
  const references = [...new Set(ancestry.filter((id) => id !== inReplyTo)), inReplyTo];
  const originalSubject = (parsed.subject ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim();
  if (originalSubject.length > 1000)
    throw new AppError('REPLY_SUBJECT', 'The original subject is too long to reply safely.');
  const subject = /^re:/i.test(originalSubject) ? originalSubject : `Re: ${originalSubject}`.trim();
  return { inReplyTo, references, subject };
}
