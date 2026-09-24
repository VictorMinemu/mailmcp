// Live identity regression: uses only synthetic clients/user and removes them in finally.
// Run against a disposable Keycloak first. See docs/HOSTING.md.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { adminApi } from './configure-keycloak-dcr.mjs';

const origin = process.env.MAILMCP_KEYCLOAK_URL;
const realm = process.env.MAILMCP_KEYCLOAK_REALM || 'mailmcp';
const credentials = JSON.parse(
  await readFile(process.env.MAILMCP_KEYCLOAK_CREDENTIALS_FILE, 'utf8'),
);
assert.equal(new URL(credentials.url).origin, new URL(origin).origin);
const api = await adminApi(origin, credentials);
const base = `realms/${encodeURIComponent(realm)}`;
const issuer = `${origin}/${base}`;
const metadata = await (await fetch(`${issuer}/.well-known/openid-configuration`)).json();
const registered = [];
let userId;
const name = `dcr-test-${randomBytes(8).toString('hex')}`;
const password = randomBytes(24).toString('base64url');
const redirect = 'http://127.0.0.1:8765/callback';
const standard = {
  client_name: name,
  redirect_uris: [redirect],
  token_endpoint_auth_method: 'none',
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  scope: 'openid mailmcp',
};
async function register(overrides = {}, expected = 201) {
  const response = await fetch(metadata.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...standard, ...overrides }),
    redirect: 'error',
  });
  const body = await response.json();
  if (body.client_id) registered.push(body.client_id);
  if (expected === 201)
    assert.equal(
      response.status,
      201,
      JSON.stringify({ error: body.error, detail: body.error_description }),
    );
  else assert.ok(response.status >= 400 && response.status < 500, 'Unsafe metadata was accepted');
  return body;
}
const authUrl = (client, extras = {}) => {
  const url = new URL(metadata.authorization_endpoint);
  url.search = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirect,
    response_type: 'code',
    scope: 'openid mailmcp',
    state: name,
    ...extras,
  });
  return url;
};
const unescapeHtml = (s) =>
  s.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#39;', "'");
async function authorizationCode(client, verifier) {
  const cookies = new Map();
  async function page(url, body) {
    url = new URL(url, origin);
    assert.equal(new URL(url).origin, origin);
    const r = await fetch(url, {
      method: body ? 'POST' : 'GET',
      redirect: 'manual',
      headers: {
        cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
        ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      body,
    });
    for (const cookie of r.headers.getSetCookie()) {
      const pair = cookie.split(';')[0];
      const split = pair.indexOf('=');
      cookies.set(pair.slice(0, split), pair.slice(split + 1));
    }
    return { r, html: await r.text() };
  }
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  let { r, html } = await page(
    authUrl(client, { code_challenge: challenge, code_challenge_method: 'S256' }),
  );
  assert.equal(r.status, 200);
  const form = html.match(/<form[^>]*action="([^"]+)"/);
  assert.ok(form, 'Login form missing');
  ({ r, html } = await page(
    unescapeHtml(form[1]),
    new URLSearchParams({ username: name, password, credentialId: '' }),
  ));
  for (let hops = 0; hops < 5 && r.status === 302; hops++) {
    const next = new URL(r.headers.get('location'), origin);
    if (next.origin !== origin) break;
    ({ r, html } = await page(next));
  }
  const consent = html.match(/<form[^>]*action="([^"]+)"/);
  assert.ok(consent && html.includes('oauth'), 'Explicit consent screen missing');
  const fields = new URLSearchParams({ accept: 'Yes' });
  for (const input of html.matchAll(/<input[^>]*>/g)) {
    if (!/type="hidden"/.test(input[0])) continue;
    const fieldName = input[0].match(/name="([^"]+)"/)?.[1];
    if (fieldName)
      fields.set(fieldName, unescapeHtml(input[0].match(/value="([^"]*)"/)?.[1] ?? ''));
  }
  ({ r } = await page(unescapeHtml(consent[1]), fields));
  assert.equal(r.status, 302);
  const callback = new URL(r.headers.get('location'));
  assert.equal(callback.origin + callback.pathname, redirect);
  assert.equal(callback.searchParams.get('state'), name);
  assert.ok(callback.searchParams.get('code'), 'Authorization code missing');
  return callback.searchParams.get('code');
}

try {
  const client = await register();
  const [config] = await api(`${base}/clients?clientId=${encodeURIComponent(client.client_id)}`);
  assert.equal(config.attributes['pkce.code.challenge.method'], 'S256');
  assert.equal(config.consentRequired, true);
  assert.equal(config.fullScopeAllowed, false);
  assert.equal(config.directAccessGrantsEnabled, false);
  assert.equal(config.implicitFlowEnabled, false);
  assert.equal(config.serviceAccountsEnabled, false);
  console.log('PASS anonymous registration with constrained client settings');
  const noScope = await register({ scope: undefined });
  const [noScopeConfig] = await api(
    `${base}/clients?clientId=${encodeURIComponent(noScope.client_id)}`,
  );
  assert.ok(
    [...noScopeConfig.defaultClientScopes, ...noScopeConfig.optionalClientScopes].includes(
      'mailmcp',
    ),
  );
  await register({
    redirect_uris: ['https://example.com/callback'],
    token_endpoint_auth_method: 'client_secret_basic',
  });
  await register({ redirect_uris: ['http://localhost:8765/callback'] });
  await register({ redirect_uris: ['http://[::1]:8765/callback'] });
  console.log(
    'PASS HTTPS, localhost, IPv4/IPv6 loopback, confidential clients, and omitted registration scope',
  );
  for (const overrides of [
    { redirect_uris: ['https://example.com/*'] },
    { redirect_uris: ['http://example.com/callback'] },
    { redirect_uris: ['https://example.com/callback#fragment'] },
    { redirect_uris: ['https://user:pass@example.com/callback'] },
    { scope: 'openid realm-management' },
    { scope: 'offline_access' },
    { jwks_uri: 'http://127.0.0.1:8080/private' },
    { sector_identifier_uri: 'http://127.0.0.1:8080/private' },
    { request_uris: ['http://127.0.0.1:8080/private'] },
    { backchannel_logout_uri: 'http://127.0.0.1:8080/private' },
  ])
    await register(overrides, 400);
  console.log('PASS unsafe redirects, unauthorized scopes and server-fetch URLs rejected');
  const update = await fetch(client.registration_client_uri, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${client.registration_access_token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      ...standard,
      client_id: client.client_id,
      redirect_uris: ['https://example.com/*'],
    }),
  });
  assert.ok(update.status >= 400 && update.status < 500);
  for (const params of [{}, { code_challenge: 'a'.repeat(43), code_challenge_method: 'plain' }]) {
    const r = await fetch(authUrl(client, params), { redirect: 'manual' });
    assert.equal(r.status, 302);
    assert.equal(new URL(r.headers.get('location')).searchParams.get('error'), 'invalid_request');
  }
  console.log('PASS registration-token updates and missing/plain PKCE rejected');
  await api(`${base}/users`, 'POST', {
    username: name,
    enabled: true,
    emailVerified: true,
    email: `${name}@example.com`,
    firstName: 'DCR',
    lastName: 'Test',
    credentials: [{ type: 'password', value: password, temporary: false }],
  });
  [{ id: userId }] = await api(`${base}/users?username=${name}&exact=true`);
  const verifier = randomBytes(32).toString('base64url');
  const code = await authorizationCode(client, verifier);
  const response = await fetch(metadata.token_endpoint, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.client_id,
      redirect_uri: redirect,
      code,
      code_verifier: verifier,
    }),
  });
  assert.equal(response.status, 200);
  let tokens = await response.json();
  const audience = process.env.MAILMCP_TEST_RESOURCE || 'https://mailmcp.org/mcp';
  const { payload } = await jwtVerify(
    tokens.access_token,
    createRemoteJWKSet(new URL(metadata.jwks_uri)),
    { issuer, audience },
  );
  assert.equal(payload.sub, userId);
  assert.ok(payload.scope.split(' ').includes('mailmcp'));
  assert.ok(tokens.refresh_token);
  console.log(
    'PASS code + S256 + consent yields signed token with stable user subject, MCP audience and scope',
  );
  assert.ok(tokens.refresh_expires_in > 365 * 86400, 'Refresh lifetime must exceed one year');
  assert.ok(tokens.expires_in <= 300, 'Access tokens must remain short-lived');
  const originalRefresh = tokens.refresh_token;
  for (let renewal = 0; renewal < 2; renewal++) {
    // Keycloak compares token issue times at whole-second precision.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const refreshed = await fetch(metadata.token_endpoint, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: client.client_id,
        refresh_token: tokens.refresh_token,
      }),
    });
    assert.equal(refreshed.status, 200, 'Sequential refresh failed');
    const next = await refreshed.json();
    assert.ok(next.refresh_token && next.refresh_token !== tokens.refresh_token);
    assert.ok(next.refresh_expires_in > 365 * 86400);
    const verified = await jwtVerify(
      next.access_token,
      createRemoteJWKSet(new URL(metadata.jwks_uri)),
      { issuer, audience },
    );
    assert.equal(verified.payload.sub, userId);
    tokens = next; // Always replace both tokens together before the next refresh.
  }
  const replay = await fetch(metadata.token_endpoint, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: client.client_id,
      refresh_token: originalRefresh,
    }),
  });
  assert.equal(replay.status, 400, 'Used refresh token was accepted');
  assert.equal((await replay.json()).error, 'invalid_grant');
  console.log(
    'PASS refresh lifetime exceeds one year, two rotations preserve identity and old-token replay is rejected',
  );
  if (process.env.MAILMCP_TEST_MCP_URL) {
    assert.equal(process.env.MAILMCP_TEST_MCP_URL, audience);
    const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
    const mcp = new Client({ name: 'mailmcp-dcr-regression', version: '1.0.0' });
    try {
      await mcp.connect(
        new StreamableHTTPClientTransport(new URL(audience), {
          requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } },
        }),
      );
      for (const language of ['en', 'es']) {
        const localized = new Client({ name: 'mailmcp-metadata-regression', version: '1.0.0' });
        try {
          await localized.connect(
            new StreamableHTTPClientTransport(new URL(audience), {
              requestInit: {
                headers: {
                  authorization: `Bearer ${tokens.access_token}`,
                  'accept-language': language,
                },
              },
            }),
          );
          const expected = JSON.parse(
            await readFile(new URL(`../locales/${language}.json`, import.meta.url), 'utf8'),
          ).mcp;
          assert.equal(localized.getInstructions(), expected.instructions);
          assert.equal(localized.getServerVersion().title, expected.server_title);
          const tools = (await localized.listTools()).tools;
          assert.equal(tools.length, 18);
          for (const tool of tools) {
            assert.equal(tool.description, expected[`tools.${tool.name}`]);
            assert.equal(tool.title, expected[`titles.${tool.name}`]);
            for (const [name, schema] of Object.entries(tool.inputSchema.properties ?? {}))
              assert.equal(schema.description, expected[`parameters.${name}`]);
          }
          const capabilities = await localized.readResource({ uri: 'mailmcp://capabilities' });
          const data = JSON.parse(capabilities.contents[0].text);
          assert.equal(data.outgoingAttachmentTotalLimitBytes, 25_000_000);
          assert.equal(data.serverSideSearch, true);
        } finally {
          await localized.close();
        }
      }
      console.log(
        'PASS live EN/ES server instructions, 18 tool descriptions, parameter metadata and capabilities',
      );
      // Reauthorize the same user through a different client, as happens on reconnect.
      // The synthetic connected account must survive because ownership is issuer + sub.
      const fixtureResult = await mcp.callTool({
        name: 'accounts_add',
        arguments: {
          label: 'Reconnect fixture',
          email: `${name}@example.com`,
          senderName: 'Test',
          smtp: {
            host: 'smtp.example.com',
            port: 465,
            security: 'tls',
            username: 'fixture',
            password: 'synthetic-not-a-mail-password',
          },
        },
      });
      assert.ok(!fixtureResult.isError);
      const fixture = JSON.parse(fixtureResult.content.find((item) => item.type === 'text').text);
      const reconnected = new Client({ name: 'reconnect-regression', version: '1.0.0' });
      try {
        const secondClient = await register({ client_name: `${name}-reconnect` });
        const secondVerifier = randomBytes(32).toString('base64url');
        const secondCode = await authorizationCode(secondClient, secondVerifier);
        const exchange = await fetch(metadata.token_endpoint, {
          method: 'POST',
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: secondClient.client_id,
            redirect_uri: redirect,
            code: secondCode,
            code_verifier: secondVerifier,
          }),
        });
        assert.equal(exchange.status, 200);
        const secondTokens = await exchange.json();
        await reconnected.connect(
          new StreamableHTTPClientTransport(new URL(audience), {
            requestInit: { headers: { authorization: `Bearer ${secondTokens.access_token}` } },
          }),
        );
        const listed = await reconnected.callTool({ name: 'accounts_list', arguments: {} });
        assert.ok(!listed.isError);
        assert.ok(
          JSON.parse(listed.content.find((item) => item.type === 'text').text).some(
            (account) => account.id === fixture.id,
          ),
        );
        console.log(
          'PASS renewed access and a newly registered reconnect client preserve the connected account',
        );
      } finally {
        await reconnected.close();
        const removed = await mcp.callTool({
          name: 'accounts_remove',
          arguments: { accountId: fixture.id, confirm: true },
        });
        assert.ok(!removed.isError, 'Synthetic account cleanup failed');
      }
      if (process.env.MAILMCP_TEST_SEND_ATTACHMENTS === '1') {
        const tool = (await mcp.listTools()).tools.find((entry) => entry.name === 'messages_send');
        assert.ok(tool.inputSchema.properties.attachments);
        // Unknown account for the synthetic user: exercise the entire upload path without sending mail.
        const started = Date.now();
        const result = await mcp.callTool({
          name: 'messages_send',
          arguments: {
            accountId: randomUUID(),
            to: ['fixture@example.com'],
            subject: 'Upload regression',
            text: 'Synthetic data only',
            confirm: true,
            attachments: [
              { filename: '25MB.bin', contentBase64: Buffer.alloc(25_000_000).toString('base64') },
            ],
          },
        });
        assert.equal(result.isError, true);
        assert.equal(
          JSON.parse(result.content.find((item) => item.type === 'text').text).code,
          'NOT_FOUND',
        );
        console.log(
          `PASS production MCP accepts 25 MB attachment in ${Date.now() - started} ms through the proxy and enforces account ownership`,
        );
      }
      if (process.env.MAILMCP_TEST_PUBLIC_PROVIDERS === '1') {
        // Configuration-only checks: never authenticate to a real mailbox or send mail.
        const call = async (name, args) => {
          const result = await mcp.callTool({ name, arguments: args });
          assert.ok(!result.isError, `MCP ${name} failed: ${JSON.stringify(result.content)}`);
          return JSON.parse(result.content.find((item) => item.type === 'text').text);
        };
        for (const [incoming, outgoing] of [
          ['imappro.zoho.eu', 'smtppro.zoho.eu'],
          ['imap.zoho.eu', 'smtp.zoho.eu'],
          ['imap.custom-provider.example', 'smtp.custom-provider.example'],
        ]) {
          const connection = {
            username: `${name}@example.com`,
            password: 'synthetic-not-a-mail-password',
            security: 'tls',
          };
          const account = await call('accounts_add', {
            label: 'Provider regression',
            senderName: 'Test',
            email: connection.username,
            incoming: { ...connection, host: incoming, port: 993, protocol: 'imap' },
            smtp: { ...connection, host: outgoing, port: 465 },
          });
          try {
            assert.equal(account.incoming.host, incoming);
            assert.equal(account.smtp.host, outgoing);
            await call('accounts_update', {
              accountId: account.id,
              changes: {
                incoming: {
                  ...connection,
                  host: 'pop.custom-provider.example',
                  port: 995,
                  protocol: 'pop3',
                },
              },
            });
          } finally {
            await call('accounts_remove', { accountId: account.id, confirm: true });
          }
        }
        console.log(
          'PASS production account creation/update for Zoho EU and arbitrary public providers',
        );
      }
      console.log(
        'PASS production MCP initializes and lists 18 tools with dynamically registered client token',
      );
    } finally {
      await mcp.close();
    }
  }
} finally {
  for (const clientId of registered) {
    const clients = await api(`${base}/clients?clientId=${encodeURIComponent(clientId)}`);
    for (const client of clients) await api(`${base}/clients/${client.id}`, 'DELETE');
  }
  if (userId) await api(`${base}/users/${userId}`, 'DELETE');
  console.log('Synthetic clients and user removed.');
}
