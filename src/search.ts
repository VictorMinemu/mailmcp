import type { SearchObject, MessageStructureObject } from 'imapflow';
import type { z } from 'zod';
import type { searchSchema } from './schemas.js';

export type SearchInput = z.output<typeof searchSchema>;

// IMAP SEARCH dates are day-granular and imapflow formats them in UTC, so calendar days
// from the user map to UTC midnights. BEFORE is exclusive; dateTo is inclusive.
const day = (value: string, offsetDays = 0) =>
  new Date(Date.parse(`${value}T00:00:00.000Z`) + offsetDays * 86_400_000);

// Standard IMAP has no attachment key. Content-Type multipart/mixed is the conventional
// container for attached files, so it serves as the provider-side filter.
const ATTACHMENT_HEADER = { 'content-type': 'multipart/mixed' };

// Translate validated criteria into keys the mail provider evaluates itself.
// Nothing is indexed or filtered in MailMCP; the provider returns matching UIDs only.
export function buildSearchQuery(p: SearchInput): SearchObject {
  const query: SearchObject = {};
  if (p.query) query.text = p.query;
  if (p.sender) query.from = p.sender;
  if (p.recipient) query.or = [{ to: p.recipient }, { cc: p.recipient }];
  if (p.subjectContains) query.subject = p.subjectContains;
  if (p.bodyContains) query.body = p.bodyContains;
  if (p.dateFrom) query.since = day(p.dateFrom);
  if (p.dateTo) query.before = day(p.dateTo, 1);
  if (p.unread !== undefined) query.seen = !p.unread;
  if (p.starred !== undefined) query.flagged = p.starred;
  if (p.answered !== undefined) query.answered = p.answered;
  if (p.hasAttachments === true) query.header = ATTACHMENT_HEADER;
  if (p.hasAttachments === false) query.not = { header: ATTACHMENT_HEADER };
  if (p.minSize !== undefined) query.larger = p.minSize;
  if (p.maxSize !== undefined) query.smaller = p.maxSize;
  if (p.beforeUid !== undefined && p.beforeUid > 1) query.uid = `1:${p.beforeUid - 1}`;
  return query;
}

// Attachment presence from BODYSTRUCTURE, without fetching any part.
export function hasAttachmentParts(node: MessageStructureObject | undefined): boolean {
  if (!node) return false;
  const type = node.type.toLowerCase(),
    disposition = node.disposition?.toLowerCase();
  if (disposition === 'attachment') return true;
  if (node.childNodes?.length) return node.childNodes.some(hasAttachmentParts);
  if (disposition === 'inline') return false;
  if (type.startsWith('text/') || type.startsWith('multipart/')) return false;
  return Boolean(node.dispositionParameters?.filename || node.parameters?.name);
}
