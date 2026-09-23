import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { catalogs, translate } from '../src/i18n.js';
import { matchLanguage, negotiateLanguage, interpolate } from '../web/language.js';
import { AppError, publicError } from '../src/errors.js';
import { Vault } from '../src/vault.js';
import { Accounts } from '../src/accounts.js';
import { Auth } from '../src/auth.js';
import { Mail } from '../src/mail.js';
import { createMcp } from '../src/mcp.js';

test('language negotiation supports regional tags, quality weights and safe fallback', () => {
  assert.equal(matchLanguage('es-CO'), 'es');
  assert.equal(matchLanguage('EN_us'), 'en');
  assert.equal(matchLanguage('../../.env'), undefined);
  assert.equal(negotiateLanguage('de-DE, es-MX;q=0.8, en;q=0.5'), 'es');
  assert.equal(negotiateLanguage('es;q=0, en;q=0.2'), 'en');
  assert.equal(negotiateLanguage('es;q=garbage, en;q=1'), 'en');
  assert.equal(negotiateLanguage('fr', 'es'), 'es');
  assert.equal(negotiateLanguage('*'), 'en');
  assert.equal(negotiateLanguage(''), 'en');
});

test('catalogs have matching keys/placeholders and cover application-owned text', () => {
  for (const section of ['web', 'mcp', 'errors'] as const) {
    assert.deepEqual(
      Object.keys(catalogs.en[section]).sort(),
      Object.keys(catalogs.es[section]).sort(),
    );
    for (const [key, value] of Object.entries(catalogs.en[section])) {
      const spanish = catalogs.es[section][key]!;
      assert.ok(value.trim() && spanish.trim(), `${section}.${key} cannot be empty`);
      const placeholders = (text: string) =>
        [...text.matchAll(/\{([a-zA-Z_]+)\}/g)].map((m) => m[1]).sort();
      assert.deepEqual(placeholders(value), placeholders(spanish), `${section}.${key}`);
    }
  }
  const html = readFileSync('web/index.html', 'utf8');
  for (const match of html.matchAll(/data-i18n(?:-aria-label|-placeholder)?="([^"]+)"/g))
    assert.ok(Object.hasOwn(catalogs.en.web, match[1]!), match[1]);
  const ui = ['web/app.js', 'web/landing.js'].map((file) => readFileSync(file, 'utf8')).join('\n');
  for (const match of ui.matchAll(/\b(?:msg|message|t|new UiError)\('([^']+)'/g))
    assert.ok(Object.hasOwn(catalogs.en.web, match[1]!), match[1]);
  for (const file of readdirSync('src').filter((name) => name.endsWith('.ts'))) {
    for (const match of readFileSync(join('src', file), 'utf8').matchAll(
      /new AppError\(\s*'[^']+',\s*'([^']+)'/g,
    ))
      assert.ok(Object.hasOwn(catalogs.es.errors, match[1]!), `${file}: ${match[1]}`);
  }
});

test('interpolation does not reinterpret message content and errors retain machine-readable codes', () => {
  assert.equal(
    interpolate('{filename}', { filename: '<script>{filename}</script>' }),
    '<script>{filename}</script>',
  );
  const spanish = publicError(new AppError('NOT_FOUND', 'Account not found.', 404), 'es');
  assert.equal(spanish.code, 'NOT_FOUND');
  assert.equal(spanish.message, 'Cuenta no encontrada.');
  assert.equal(spanish.messageKey, 'Account not found.');
  assert.equal(
    publicError(new AppError('NOT_FOUND', 'Account not found.')).message,
    'Account not found.',
  );
  assert.ok(
    !JSON.stringify(publicError(new Error('password=do-not-leak'), 'es')).includes('do-not-leak'),
  );
  assert.equal(translate('es', 'web', 'unknown-key'), 'unknown-key');
});

test('Spanish MCP descriptions, errors, prompts and web links preserve identifiers and user data', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mailmcp-i18n-'));
  const vault = new Vault(dir, randomBytes(32));
  const accounts = new Accounts(vault, new Set(['smtp.example.com']));
  const auth = new Auth();
  const client = new Client({ name: 'locale-test', version: '1.0.0' });
  const server = createMcp(
    { accounts, auth, mail: new Mail(accounts, new Set()), origin: 'https://mail.example.com' },
    'alice',
    'es',
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    const account = accounts.add('alice', {
      label: 'Work',
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
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 16);
    assert.equal(
      tools.tools.find((t) => t.name === 'accounts_list')?.description,
      catalogs.es.mcp['tools.accounts_list'],
    );
    const parse = (result: any) =>
      JSON.parse(result.content.find((item: any) => item.type === 'text').text);
    assert.equal(
      parse(await client.callTool({ name: 'accounts_list', arguments: {} }))[0].label,
      'Work',
    );
    const error = await client.callTool({
      name: 'accounts_remove',
      arguments: { accountId: randomUUID(), confirm: true },
    });
    assert.equal(error.isError, true);
    assert.equal(parse(error).message, 'Cuenta no encontrada.');
    for (const explicit of [undefined, 'en'] as const) {
      const link = new URL(
        parse(
          await client.callTool({
            name: 'web_open',
            arguments: explicit ? { language: explicit } : {},
          }),
        ).url,
      );
      assert.equal(link.searchParams.get('lang'), explicit ?? 'es');
      assert.equal(
        auth.owner(auth.redeem(new URLSearchParams(link.hash.slice(1)).get('token')!)),
        'alice',
      );
    }
    const prompt = await client.getPrompt({
      name: 'draft_reply',
      arguments: { context: 'Keep this original English text {goal}', goal: 'Dar las gracias' },
    });
    assert.match(JSON.stringify(prompt), /No la envíes/);
    assert.match(JSON.stringify(prompt), /Keep this original English text \{goal\}/);
    assert.equal(accounts.get('alice', account.id).senderName, 'Alice');
  } finally {
    await client.close();
    await server.close();
    vault.close();
    rmSync(dir, { recursive: true });
  }
});
