import { translate, type Locale } from './i18n.js';
import { McpServer, type StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Accounts } from './accounts.js';
import type { Mail } from './mail.js';
import type { Auth } from './auth.js';
import { publicError } from './errors.js';
import { arrayResultKeys, outputSchemas } from './outputs.js';
import { withMessageRef, resolveMessageReference } from './references.js';
import {
  batchReadSchema,
  threadReadSchema,
  attachmentUploadSchema,
  attachmentRemoveSchema,
  sendStatusSchema,
} from './workflow-schemas.js';
import {
  ATTACHMENT_TTL_MS,
  ATTACHMENT_OWNER_BYTES,
  ATTACHMENT_GLOBAL_BYTES,
} from './temporary-attachments.js';
import { SEND_OPERATION_TTL_MS } from './send-operations.js';
import {
  MAX_OUTGOING_ATTACHMENTS,
  MAX_OUTGOING_ATTACHMENT_BYTES,
  MAX_OUTGOING_TOTAL_BYTES,
} from './uploads.js';
import {
  accountSchema,
  accountPatch,
  idSchema,
  listSchema,
  searchSchema,
  readSchema,
  messageReadSchema,
  sendSchema,
  replySchema,
  flagSchema,
  moveSchema,
  line,
  attachmentSchema,
} from './schemas.js';

export type Services = { accounts: Accounts; mail: Mail; auth: Auth; origin: string };
export function createMcp(services: Services, owner: string, locale: Locale = 'en') {
  const m = (key: string, values: Record<string, string> = {}) =>
    translate(locale, 'mcp', key, values);
  const server = new McpServer(
    {
      name: 'mailmcp',
      title: m('server_title'),
      description: m('server_description'),
      version: '0.1.0',
    },
    {
      instructions: m('instructions'),
    },
  );
  // Describe the wire schema without mutating shared validators used by the web API.
  // safeExtend retains object refinements (including the total attachment limit).
  function describedInput(schema: z.ZodObject) {
    const shape = Object.fromEntries(
      Object.entries(schema.shape).map(([name, field]) => [
        name,
        (field as z.ZodType).describe(m(`parameters.${name}`)),
      ]),
    );
    return schema.safeExtend(shape);
  }
  // Keep SDK input validation while exposing safe, localized errors through its
  // error boundary instead of the SDK's free-form validation text.
  function wireInput(schema: z.ZodObject, sending = false): StandardSchemaWithJSON {
    const described = describedInput(schema);
    return {
      '~standard': {
        ...described['~standard'],
        validate(value: unknown) {
          const result = described.safeParse(value);
          if (!result.success)
            throw new Error(JSON.stringify(publicError(result.error, locale, sending)));
          return { value: result.data };
        },
      },
    };
  }
  function tool<T extends z.ZodObject>(
    name: string,
    description: string,
    schema: T,
    action: (input: z.output<T>) => unknown | Promise<unknown>,
    readOnly = true,
    destructive = false,
    external = false,
    idempotent = readOnly,
  ) {
    server.registerTool<StandardSchemaWithJSON, StandardSchemaWithJSON>(
      name,
      {
        title: m(`titles.${name}`),
        description,
        inputSchema: wireInput(schema, name === 'messages_send' || name === 'messages_reply'),
        outputSchema: outputSchemas[name],
        annotations: {
          readOnlyHint: readOnly,
          destructiveHint: destructive,
          idempotentHint: idempotent,
          openWorldHint: external,
        },
      },
      async (input) => {
        try {
          const result = await action(schema.parse(input) as z.output<T>);
          const normalized = JSON.parse(JSON.stringify(result));
          const key = arrayResultKeys[name];
          const structured = key ? { [key]: normalized } : normalized;
          if (!outputSchemas[name]!.safeParse(structured).success)
            throw new Error('Invalid service output');
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(normalized) }],
            structuredContent: structured,
          };
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  publicError(error, locale, name === 'messages_send' || name === 'messages_reply'),
                ),
              },
            ],
          };
        }
      },
    );
  }
  const { accounts, mail, auth, origin } = services;
  tool('accounts_list', m('tools.accounts_list'), z.object({}).strict(), () =>
    accounts.list(owner),
  );
  tool(
    'accounts_add',
    m('tools.accounts_add'),
    accountSchema,
    (p) => accounts.add(owner, p),
    false,
  );
  tool(
    'accounts_update',
    m('tools.accounts_update'),
    idSchema.extend({ changes: accountPatch }),
    (p) => accounts.update(owner, p.accountId, p.changes),
    false,
    true,
  );
  tool(
    'accounts_remove',
    m('tools.accounts_remove'),
    idSchema.extend({ confirm: z.literal(true) }),
    (p) => accounts.remove(owner, p.accountId),
    false,
    true,
  );
  tool(
    'accounts_verify',
    m('tools.accounts_verify'),
    idSchema,
    (p) => mail.verify(owner, p.accountId),
    true,
    false,
    true,
  );
  tool(
    'folders_list',
    m('tools.folders_list'),
    idSchema,
    (p) => mail.folders(owner, p.accountId),
    true,
    false,
    true,
  );
  tool(
    'folders_create',
    m('tools.folders_create'),
    idSchema.extend({ path: line }),
    (p) => mail.createFolder(owner, p.accountId, p.path),
    false,
    false,
    true,
  );
  tool(
    'messages_list',
    m('tools.messages_list'),
    listSchema,
    (p) => mail.list(owner, p),
    true,
    false,
    true,
  );
  tool(
    'messages_search',
    m('tools.messages_search'),
    searchSchema,
    (p) => mail.search(owner, p),
    true,
    false,
    true,
  );
  tool(
    'messages_read',
    m('tools.messages_read'),
    withMessageRef(
      messageReadSchema.extend({ maxChars: messageReadSchema.shape.maxChars.default(10_000) }),
    ),
    (p) => mail.read(owner, p),
    true,
    false,
    true,
  );
  tool(
    'attachments_list',
    m('tools.attachments_list'),
    withMessageRef(readSchema),
    (p) => mail.attachments(owner, p),
    true,
    false,
    true,
  );
  server.registerTool(
    'attachments_download',
    {
      title: m('titles.attachments_download'),
      description: m('tools.attachments_download'),
      inputSchema: wireInput(withMessageRef(attachmentSchema)),
      outputSchema: outputSchemas.attachments_download,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input) => {
      try {
        const p = attachmentSchema.parse(resolveMessageReference(input));
        const { contentBase64, ...metadata } = await mail.attachment(owner, p);
        if (!outputSchemas.attachments_download!.safeParse(metadata).success)
          throw new Error('Invalid attachment metadata');
        return {
          structuredContent: metadata,
          content: [
            { type: 'text' as const, text: JSON.stringify(metadata) },
            {
              type: 'resource' as const,
              resource: {
                uri: `mailmcp://attachment/${p.accountId}/${encodeURIComponent(p.folder)}/${encodeURIComponent(p.messageId)}/${p.uidValidity ?? 'pop3'}/${p.index}`,
                mimeType: metadata.contentType,
                blob: contentBase64,
              },
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: JSON.stringify(publicError(error, locale)) }],
        };
      }
    },
  );
  tool(
    'messages_flag',
    m('tools.messages_flag'),
    withMessageRef(flagSchema, true),
    (p) => mail.flag(owner, p),
    false,
    true,
    true,
    true,
  );
  tool(
    'messages_move',
    m('tools.messages_move'),
    withMessageRef(moveSchema, true),
    (p) => mail.move(owner, p),
    false,
    true,
    true,
  );
  tool(
    'messages_send',
    m('tools.messages_send'),
    sendSchema,
    (p) => mail.send(owner, p),
    false,
    true,
    true,
  );
  tool(
    'messages_reply',
    m('tools.messages_reply'),
    withMessageRef(replySchema),
    (p) => mail.reply(owner, p),
    false,
    true,
    true,
  );
  tool(
    'messages_read_batch',
    m('tools.messages_read_batch'),
    batchReadSchema,
    (p) => mail.readBatch(owner, p, locale),
    true,
    false,
    true,
  );
  tool(
    'messages_thread',
    m('tools.messages_thread'),
    threadReadSchema,
    (p) => mail.thread(owner, p, locale),
    true,
    false,
    true,
  );
  tool('messages_send_status', m('tools.messages_send_status'), sendStatusSchema, (p) =>
    mail.sendStatus(owner, p),
  );
  tool(
    'attachments_upload',
    m('tools.attachments_upload'),
    attachmentUploadSchema,
    (p) => mail.uploadAttachment(owner, p),
    false,
  );
  tool(
    'attachments_reuse',
    m('tools.attachments_reuse'),
    withMessageRef(attachmentSchema),
    (p) => mail.reuseAttachment(owner, p),
    true,
    false,
    true,
  );
  tool(
    'attachments_remove_upload',
    m('tools.attachments_remove_upload'),
    attachmentRemoveSchema,
    (p) => mail.removeUpload(owner, p),
    false,
    true,
  );
  tool(
    'web_open',
    m('tools.web_open'),
    z.object({ language: z.enum(['en', 'es']).optional() }).strict(),
    (p) => ({
      url: `${origin}/?lang=${p.language ?? locale}#token=${auth.link(owner)}`,
      expiresIn: 60,
    }),
    false,
  );
  tool(
    'web_revoke_sessions',
    m('tools.web_revoke_sessions'),
    z.object({ confirm: z.literal(true) }).strict(),
    () => {
      auth.revoke(owner);
      return { revoked: true };
    },
    false,
    true,
  );
  server.registerResource(
    'accounts',
    'mailmcp://accounts',
    {
      mimeType: 'application/json',
      description: m('accounts_resource'),
    },
    async (uri) => ({
      contents: [
        { uri: uri.href, mimeType: 'application/json', text: JSON.stringify(accounts.list(owner)) },
      ],
    }),
  );
  server.registerResource(
    'capabilities',
    'mailmcp://capabilities',
    { mimeType: 'application/json', description: m('capabilities_resource') },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify({
            protocols: ['imap', 'pop3s', 'smtp'],
            languages: ['en', 'es'],
            language: locale,
            mailboxProvisioning: false,
            invitations: false,
            messageLimitBytes: 10_000_000,
            attachmentLimitBytes: 5_000_000,
            attachmentDownloads: true,
            structuredToolResults: true,
            accountCapabilities: true,
            uniformMessageReferences: true,
            uidListPagination: true,
            batchReads: true,
            batchReadCountLimit: 10,
            batchReadTotalCharsLimit: 100_000,
            threadDiscovery: true,
            threadScope: 'folder',
            temporaryAttachments: true,
            temporaryAttachmentTtlSeconds: ATTACHMENT_TTL_MS / 1000,
            temporaryAttachmentOwnerBytes: ATTACHMENT_OWNER_BYTES,
            temporaryAttachmentGlobalBytes: ATTACHMENT_GLOBAL_BYTES,
            sendTracking: true,
            sendOperationTtlSeconds: SEND_OPERATION_TTL_MS / 1000,
            sendTrackingPersistent: false,
            messageBodyPagination: true,
            messageReadDefaultChars: 10_000,
            messageReadMaxChars: 100_000,
            outgoingAttachments: true,
            outgoingAttachmentLimitBytes: MAX_OUTGOING_ATTACHMENT_BYTES,
            outgoingAttachmentTotalLimitBytes: MAX_OUTGOING_TOTAL_BYTES,
            outgoingAttachmentCountLimit: MAX_OUTGOING_ATTACHMENTS,
            serverSideSearch: true,
            searchProtocols: ['imap'],
            searchCriteria: [
              'query',
              'sender',
              'recipient',
              'subjectContains',
              'bodyContains',
              'dateFrom',
              'dateTo',
              'unread',
              'starred',
              'answered',
              'hasAttachments',
              'minSize',
              'maxSize',
            ],
            draftStorage: false,
            replyThreadHeaders: true,
            permanentDeletion: false,
            imapFlags: ['seen', 'starred'],
            accountLimit: 20,
            plainTextOnly: true,
          }),
        },
      ],
    }),
  );
  server.registerPrompt(
    'draft_reply',
    {
      description: m('draft_description'),
      argsSchema: z.object({
        context: z.string().max(100_000).describe(m('parameters.context')),
        goal: z.string().max(2000).describe(m('parameters.goal')),
      }),
    },
    ({ context, goal }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: m('draft_text', { goal, context: JSON.stringify(context) }),
          },
        },
      ],
    }),
  );
  return server;
}
