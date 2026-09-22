// Fresh-install and existing-realm migration checks. Local disposable server only.
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { adminApi, configureDcr } from './configure-keycloak-dcr.mjs';
import { configureSessions } from './configure-keycloak-sessions.mjs';

const origin = process.env.MAILMCP_KEYCLOAK_URL;
assert.equal(
  new URL(origin).hostname,
  '127.0.0.1',
  'Only a local disposable Keycloak is supported',
);
const credentials = JSON.parse(
  await readFile(process.env.MAILMCP_KEYCLOAK_CREDENTIALS_FILE, 'utf8'),
);
assert.equal(new URL(credentials.url).origin, new URL(origin).origin);
const api = await adminApi(origin, credentials);
const folder = await mkdtemp(join(tmpdir(), 'mailmcp-dcr-'));
try {
  for (const mode of ['fresh', 'migration']) {
    const realm = JSON.parse(
      (
        await readFile(new URL('../deploy/keycloak/mailmcp-realm.json', import.meta.url), 'utf8')
      ).replaceAll('${MAILMCP_PUBLIC_URL}', 'https://mailmcp.org'),
    );
    realm.realm = `dcr-${mode}-${randomBytes(6).toString('hex')}`;
    realm.sslRequired = 'none'; // HTTP is confined to the local fixture.
    if (mode === 'migration') {
      realm.ssoSessionIdleTimeout = 1800;
      realm.ssoSessionMaxLifespan = 28800;
      realm.enabledEventTypes = [];
      const web = realm.clients.find((c) => c.clientId === 'mailmcp-web');
      delete web.attributes['client.session.idle.timeout'];
      delete web.attributes['client.session.max.lifespan'];
      delete realm.components;
      delete realm.clientPolicies;
      delete realm.clientProfiles;
      realm.clientScopes = realm.clientScopes.filter((s) => s.name !== 'basic');
      realm.defaultDefaultClientScopes = [];
      realm.defaultOptionalClientScopes = [];
    }
    await api('realms', 'POST', realm);
    try {
      if (mode === 'migration') {
        const base = `realms/${realm.realm}`;
        const before = await api(`${base}/clients?clientId=mailmcp-web`);
        const components = await api(`${base}/components`);
        const registration = await fetch(`${origin}/${base}/clients-registrations/openid-connect`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            redirect_uris: ['http://127.0.0.1:8765/callback'],
            token_endpoint_auth_method: 'none',
          }),
        });
        assert.equal(
          registration.status,
          403,
          'Legacy fixture should reproduce Trusted Hosts rejection',
        );
        assert.match((await registration.json()).error_description, /Trusted Hosts/);
        await configureDcr(api, realm.realm);
        assert.deepEqual(
          await api(`${base}/components`),
          components,
          'Dry run mutated configuration',
        );
        await configureDcr(api, realm.realm, { apply: true, backup: join(folder, 'before.json') });
        await configureDcr(api, realm.realm, { apply: true, backup: join(folder, 'repeat.json') });
        assert.deepEqual(
          await api(`${base}/clients?clientId=mailmcp-web`),
          before,
          'Existing web client changed',
        );
        const legacy = await api(base);
        await configureSessions(api, realm.realm);
        assert.equal((await api(base)).ssoSessionIdleTimeout, legacy.ssoSessionIdleTimeout);
        await configureSessions(api, realm.realm, {
          apply: true,
          backup: join(folder, 'sessions.json'),
        });
        await configureSessions(api, realm.realm, {
          apply: true,
          backup: join(folder, 'sessions-repeat.json'),
        });
        const [after] = await api(`${base}/clients?clientId=mailmcp-web`);
        assert.equal(after.id, before[0].id);
        assert.deepEqual(after.redirectUris, before[0].redirectUris);
        assert.equal(after.attributes['client.session.idle.timeout'], '1800');
      }
      execFileSync(process.execPath, ['scripts/test-keycloak-dcr.mjs'], {
        env: { ...process.env, MAILMCP_KEYCLOAK_REALM: realm.realm, MAILMCP_TEST_MCP_URL: '' },
        stdio: 'inherit',
      });
      console.log(`PASS ${mode} identity configuration`);
    } finally {
      await api(`realms/${realm.realm}`, 'DELETE');
    }
  }
} finally {
  await rm(folder, { recursive: true, force: true });
}
