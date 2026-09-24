import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createMcp } from '../src/mcp.js';
import { Vault } from '../src/vault.js';
import { Accounts } from '../src/accounts.js';
import { Mail } from '../src/mail.js';
import { Auth } from '../src/auth.js';
import { catalogs } from '../src/i18n.js';
import { readSchema } from '../src/schemas.js';
import { MAX_OUTGOING_TOTAL_BYTES } from '../src/uploads.js';

test('MCP discovery delivers localized routing guidance and documented inputs without weakening validation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mailmcp-metadata-'));
  const vault = new Vault(dir, randomBytes(32));
  const accounts = new Accounts(vault, new Set());
  const services = {
    accounts,
    mail: new Mail(accounts, new Set()),
    auth: new Auth(),
    origin: 'http://127.0.0.1:3210',
  };
  let sends = 0;
  services.mail.send = async () => {
    sends++;
    throw new Error('Metadata verification must never reach SMTP');
  };
  try {
    for (const locale of ['en', 'es'] as const) {
      const server = createMcp(services, 'metadata-test', locale);
      const client = new Client({ name: 'metadata-test', version: '1.0.0' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        assert.equal(client.getInstructions(), catalogs[locale].mcp.instructions);
        assert.match(client.getInstructions()!.slice(0, 512), /MailMCP/);
        assert.match(client.getInstructions()!.slice(0, 512), /accounts_list/);
        assert.equal(client.getServerVersion()?.title, catalogs[locale].mcp.server_title);
        const { tools } = await client.listTools();
        assert.equal(tools.length, 17);
        for (const tool of tools) {
          assert.ok(tool.title && !tool.title.startsWith('titles.'), tool.name);
          assert.equal(tool.description, catalogs[locale].mcp[`tools.${tool.name}`]);
          assert.equal(tool.inputSchema.type, 'object');
          assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
          for (const [name, schema] of Object.entries(tool.inputSchema.properties ?? {})) {
            const description = (schema as { description?: string }).description;
            assert.ok(
              description && !description.startsWith('parameters.'),
              `${locale}/${tool.name}/${name}`,
            );
          }
        }
        const find = (name: string) => tools.find((tool) => tool.name === name)!;
        const props = (name: string) => find(name).inputSchema.properties as Record<string, any>;
        assert.match(props('messages_read').messageId.description, /Message-ID/);
        assert.match(props('messages_list').before.description, /nextBefore/);
        assert.equal(props('messages_list').limit.maximum, 50);
        assert.equal(props('messages_list').folder.default, 'INBOX');
        assert.equal(props('attachments_download').index.minimum, 0);
        assert.equal(props('messages_send').confirm.const, true);
        assert.equal(props('messages_send').attachments.maxItems, 10);
        assert.ok(find('messages_send').inputSchema.required?.includes('confirm'));
        assert.deepEqual(find('messages_send').annotations, {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        });
        assert.deepEqual(find('messages_flag').annotations, {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: true,
        });
        assert.equal(find('web_open').annotations?.readOnlyHint, false);
        assert.equal(find('attachments_download').annotations?.idempotentHint, true);

        const invalid = await client.callTool({
          name: 'messages_send',
          arguments: {
            accountId: randomUUID(),
            to: ['test@example.com'],
            subject: 'Test',
            text: 'Test',
            confirm: false,
          },
        });
        assert.equal(invalid.isError, true);
        const unknownField = await client.callTool({
          name: 'accounts_list',
          arguments: { owner: 'other-user' },
        });
        assert.equal(unknownField.isError, true);
        const missingConnection = await client.callTool({
          name: 'accounts_add',
          arguments: { label: 'Test', email: 'test@example.com', senderName: 'Test' },
        });
        assert.equal(missingConnection.isError, true);
        assert.deepEqual(accounts.list('metadata-test'), []);
        const capabilities = await client.readResource({ uri: 'mailmcp://capabilities' });
        const limits = JSON.parse((capabilities.contents[0] as { text: string }).text);
        assert.equal(limits.outgoingAttachmentTotalLimitBytes, MAX_OUTGOING_TOTAL_BYTES);
        assert.equal(limits.serverSideSearch, false);
        assert.equal(limits.draftStorage, false);
        assert.equal(limits.replyThreadHeaders, true);
        assert.ok(find('messages_reply').inputSchema.required?.includes('to'));
        assert.ok(find('messages_reply').inputSchema.required?.includes('confirm'));
        assert.equal(props('messages_reply').subject, undefined);
        assert.equal(props('messages_reply').inReplyTo, undefined);
        assert.equal(props('messages_reply').attachments.maxItems, 10);
        assert.deepEqual(find('messages_reply').annotations, find('messages_send').annotations);
        assert.match(client.getInstructions()!, /messages_reply/);
      } finally {
        await client.close();
        await server.close();
      }
    }
    assert.equal(sends, 0);
    assert.equal(
      readSchema.shape.messageId.description,
      undefined,
      'Discovery must not mutate shared schemas',
    );
  } finally {
    vault.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
