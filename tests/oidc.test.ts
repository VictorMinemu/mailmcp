import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { Oidc, subjectOwner } from '../src/oidc.js';
import { readConfig } from '../src/config.js';

const issuer = 'https://identity.example.com',
  audience = 'https://mail.example.com/mcp';
const config = () =>
  readConfig({
    MAILMCP_MODE: 'hosted',
    MAILMCP_MASTER_KEY: randomBytes(32).toString('hex'),
    MAILMCP_PUBLIC_URL: 'https://mail.example.com',
    MAILMCP_OIDC_ISSUER: issuer,
    MAILMCP_OIDC_CLIENT_ID: 'web-client',
  });

test('OAuth verifies signature, issuer, resource audience, expiry, subject and scope', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256'),
    { privateKey: wrongKey } = await generateKeyPair('RS256');
  const identity = new Oidc(config()),
    keys = createLocalJWKSet({ keys: [await exportJWK(publicKey)] });
  (identity as any).discovery = async () => ({ keys });
  const sign = (overrides = {}, key = privateKey) =>
    new SignJWT({
      scope: 'mailmcp',
      sub: 'alice',
      iss: issuer,
      aud: audience,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 60,
      ...overrides,
    })
      .setProtectedHeader({ alg: 'RS256' })
      .sign(key);
  assert.equal(await identity.bearer(await sign()), subjectOwner(issuer, 'alice'));
  for (const token of [
    await sign({ aud: 'web-client' }),
    await sign({ iss: 'https://evil.example.com' }),
    await sign({ exp: 0 }),
    await sign({ sub: undefined }),
    await sign({ scope: 'other' }),
    await sign({}, wrongKey),
  ])
    await assert.rejects(identity.bearer(token), /valid OAuth/);
  assert.notEqual(subjectOwner(issuer, 'alice'), subjectOwner(issuer, 'bob'));
  assert.notEqual(
    subjectOwner(issuer, 'alice'),
    subjectOwner('https://another.example.com', 'alice'),
  );
});

test('OIDC login binds state to the browser, uses PKCE and verifies nonce before creating an owner', async (t) => {
  const { privateKey, publicKey } = await generateKeyPair('RS256'),
    identity = new Oidc(config());
  const data = {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`,
  };
  (identity as any).discovery = async () => ({
    data,
    keys: createLocalJWKSet({ keys: [await exportJWK(publicKey)] }),
  });
  const login = await identity.begin(),
    url = new URL(login.url);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://mail.example.com/auth/callback');
  const idToken = await new SignJWT({ nonce: url.searchParams.get('nonce') })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(issuer)
    .setAudience('web-client')
    .setSubject('alice')
    .setIssuedAt()
    .setExpirationTime('1m')
    .sign(privateKey);
  t.mock.method(globalThis, 'fetch', async (input: unknown, options: any) => {
    assert.equal(String(input), data.token_endpoint);
    const posted = new URLSearchParams(options.body);
    assert.equal(
      createHash('sha256').update(posted.get('code_verifier')!).digest('base64url'),
      url.searchParams.get('code_challenge'),
    );
    return new Response(JSON.stringify({ id_token: idToken }), { status: 200 });
  });
  const callback = new URLSearchParams({
    state: url.searchParams.get('state')!,
    code: 'one-time-code',
  });
  assert.equal(await identity.finish(callback, login.binding), subjectOwner(issuer, 'alice'));
  await assert.rejects(identity.finish(callback, login.binding), /expired/);
  const stolen = await identity.begin();
  await assert.rejects(
    identity.finish(
      new URLSearchParams({ state: new URL(stolen.url).searchParams.get('state')!, code: 'code' }),
      'wrong-browser',
    ),
    /expired/,
  );
});

test('OIDC rejects mismatched nonce, audience and authorized party', async (t) => {
  const { privateKey, publicKey } = await generateKeyPair('RS256'),
    identity = new Oidc(config());
  (identity as any).discovery = async () => ({
    data: { authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token` },
    keys: createLocalJWKSet({ keys: [await exportJWK(publicKey)] }),
  });
  for (const claims of [{ nonce: 'wrong' }, { aud: 'another-client' }, { azp: 'attacker' }]) {
    const login = await identity.begin(),
      url = new URL(login.url);
    const idToken = await new SignJWT({
      iss: issuer,
      aud: 'web-client',
      sub: 'alice',
      nonce: url.searchParams.get('nonce'),
      ...claims,
    })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuedAt()
      .setExpirationTime('1m')
      .sign(privateKey);
    const mock = t.mock.method(
      globalThis,
      'fetch',
      async () => new Response(JSON.stringify({ id_token: idToken })),
    );
    await assert.rejects(
      identity.finish(
        new URLSearchParams({ state: url.searchParams.get('state')!, code: 'code' }),
        login.binding,
      ),
    );
    mock.mock.restore();
  }
});
