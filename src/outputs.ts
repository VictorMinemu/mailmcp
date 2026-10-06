import { z } from 'zod';
import { messageRefSchema } from './references.js';

const address = z.object({ name: z.string().optional(), address: z.string().optional() });
const connection = z.object({
  host: z.string(),
  port: z.number(),
  username: z.string(),
  security: z.enum(['tls', 'starttls']),
  hasPassword: z.boolean(),
  protocol: z.enum(['imap', 'pop3']).optional(),
});
const capabilities = z.object(
  Object.fromEntries(
    [
      'read',
      'search',
      'send',
      'reply',
      'attachments',
      'listFolders',
      'createFolders',
      'flag',
      'move',
      'uidPagination',
      'batchRead',
      'threadRead',
    ].map((key) => [key, z.boolean()]),
  ),
);
const operation = z.object({
  operationId: z.string(),
  accountId: z.string(),
  state: z.enum([
    'preparing',
    'submitting',
    'accepted',
    'partial',
    'rejected',
    'failed',
    'unknown',
  ]),
  createdAt: z.string(),
  updatedAt: z.string(),
  expiresAt: z.string(),
  messageId: z.string().optional(),
  accepted: z.array(z.unknown()).optional(),
  rejected: z.array(z.unknown()).optional(),
});
const upload = z.object({
  attachmentId: z.string(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number(),
  expiresAt: z.string(),
});
const account = z.object({
  id: z.string(),
  label: z.string(),
  email: z.string(),
  senderName: z.string(),
  replyTo: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  incoming: connection.optional(),
  smtp: connection.optional(),
  capabilities,
});
const attachment = z.object({
  index: z.number().int().nonnegative(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number().nonnegative(),
});
const summary = z.object({
  messageRef: messageRefSchema,
  messageId: z.string(),
  subject: z.string().optional(),
  from: z.array(address).optional(),
  date: z.string().optional(),
  flags: z.array(z.string()).optional(),
  size: z.number().optional(),
  number: z.number().optional(),
  hasAttachments: z.boolean().optional(),
});
const sent = z.object({
  operation: operation.optional(),
  messageId: z.string(),
  accepted: z.array(z.union([z.string(), address])),
  rejected: z.array(z.union([z.string(), address])),
});

// Array results get named containers in structuredContent; legacy text stays unchanged.
export const arrayResultKeys: Record<string, string> = {
  accounts_list: 'accounts',
  folders_list: 'folders',
  attachments_list: 'attachments',
};
export const outputSchemas: Record<string, z.ZodObject> = {
  accounts_list: z.object({ accounts: z.array(account) }),
  accounts_add: account,
  accounts_update: account,
  accounts_remove: z.object({ removed: z.boolean() }),
  accounts_verify: z.object({ verified: z.array(z.string()) }),
  folders_list: z.object({
    folders: z.array(
      z.object({ path: z.string(), name: z.string(), specialUse: z.string().optional() }),
    ),
  }),
  folders_create: z.object({ created: z.boolean() }),
  messages_list: z.object({
    messages: z.array(summary),
    uidValidity: z.string().optional(),
    nextBefore: z.number().nullable().optional(),
    nextBeforeUid: z.number().nullable().optional(),
    folder: z.string().optional(),
    protocol: z.literal('pop3').optional(),
  }),
  messages_search: z.object({
    folder: z.string(),
    uidValidity: z.string(),
    total: z.number().int().nonnegative(),
    nextBeforeUid: z.number().nullable(),
    messages: z.array(summary),
  }),
  messages_read: z.object({
    untrustedContent: z.literal(true),
    messageRef: messageRefSchema,
    messageId: z.string(),
    rfcMessageId: z.string().optional(),
    replyTo: z.string().optional(),
    subject: z.string().optional(),
    from: z.string().optional(),
    to: z.union([z.string(), z.array(z.string())]).optional(),
    date: z.string().optional(),
    text: z.string(),
    truncated: z.boolean(),
    offset: z.number().int().nonnegative(),
    totalChars: z.number().int().nonnegative(),
    nextOffset: z.number().int().nonnegative().nullable(),
    attachments: z.array(attachment),
  }),
  attachments_list: z.object({ attachments: z.array(attachment) }),
  attachments_download: z.object({
    filename: z.string(),
    contentType: z.string(),
    size: z.number().nonnegative(),
  }),
  messages_flag: z.object({ updated: z.boolean(), messageRef: messageRefSchema.optional() }),
  messages_move: z.object({
    moved: z.boolean(),
    messageRef: messageRefSchema.optional(),
    refreshRequired: z.boolean().optional(),
  }),
  messages_send: sent,
  messages_reply: sent.extend({
    subject: z.string(),
    inReplyTo: z.string(),
    references: z.array(z.string()),
    to: z.array(z.string()),
  }),
  messages_send_status: operation,
  attachments_upload: upload,
  attachments_reuse: upload,
  attachments_remove_upload: z.object({ removed: z.boolean() }),
  web_open: z.object({ url: z.string(), expiresIn: z.number() }),
  web_revoke_sessions: z.object({ revoked: z.boolean() }),
};

const batchResult = z.object({
  results: z.array(
    z.union([
      z.object({
        messageRef: messageRefSchema,
        status: z.literal('read'),
        message: outputSchemas.messages_read!,
      }),
      z.object({
        messageRef: messageRefSchema,
        status: z.literal('error'),
        error: z.object({
          code: z.string(),
          message: z.string(),
          messageKey: z.string(),
          retryable: z.boolean(),
          suggestedAction: z.string(),
          fieldErrors: z.array(
            z.object({ path: z.string(), code: z.string(), message: z.string() }),
          ),
        }),
      }),
      z.object({ messageRef: messageRefSchema, status: z.literal('budget_exhausted') }),
    ]),
  ),
  returnedChars: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
outputSchemas.messages_read_batch = batchResult;
outputSchemas.messages_thread = batchResult.extend({
  folder: z.string(),
  rootMessageId: z.string(),
  nextBeforeUid: z.number().nullable(),
  scope: z.literal('folder'),
});
