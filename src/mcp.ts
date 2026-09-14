import { translate, type Locale } from './i18n.js';
import { McpServer, type StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Accounts } from './accounts.js';
import type { Mail } from './mail.js';
import type { Auth } from './auth.js';
import { publicError } from './errors.js';
import {
  accountSchema,
  accountPatch,
  idSchema,
  listSchema,
  readSchema,
  sendSchema,
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
    { name: 'mailmcp', version: '0.1.0' },
    {
      instructions: m('instructions'),
    },
  );
  function tool<T extends z.ZodObject>(
    name: string,
    description: string,
    schema: T,
    action: (input: z.output<T>) => unknown | Promise<unknown>,
    readOnly = true,
    destructive = false,
    external = false,
  ) {
    server.registerTool<StandardSchemaWithJSON, StandardSchemaWithJSON>(
      name,
      {
        description,
        inputSchema: schema,
        annotations: {
          readOnlyHint: readOnly,
          destructiveHint: destructive,
          idempotentHint: readOnly,
          openWorldHint: external,
        },
      },
      async (input) => {
        try {
          const result = await action(schema.parse(input) as z.output<T>);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        } catch (error) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: JSON.stringify(publicError(error, locale)) }],
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
    'messages_read',
    m('tools.messages_read'),
    readSchema,
    (p) => mail.read(owner, p),
    true,
    false,
    true,
  );
  tool(
    'attachments_list',
    m('tools.attachments_list'),
    readSchema,
    (p) => mail.attachments(owner, p),
    true,
    false,
    true,
  );
  server.registerTool(
    'attachments_download',
    {
      description: m('tools.attachments_download'),
      inputSchema: attachmentSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async (p) => {
      try {
        const { contentBase64, ...metadata } = await mail.attachment(owner, p);
        return {
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
    flagSchema,
    (p) => mail.flag(owner, p),
    false,
    false,
    true,
  );
  tool(
    'messages_move',
    m('tools.messages_move'),
    moveSchema,
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
    { mimeType: 'application/json' },
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
      argsSchema: z.object({ context: z.string().max(100_000), goal: z.string().max(2000) }),
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
