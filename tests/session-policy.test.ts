import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const realm = JSON.parse(
  readFileSync(new URL('../deploy/keycloak/mailmcp-realm.json', import.meta.url), 'utf8'),
);
test('MCP identity sessions survive nights and weekends while access tokens stay short and rotate', () => {
  assert.equal(realm.ssoSessionIdleTimeout, 400 * 86400);
  assert.equal(realm.ssoSessionMaxLifespan, 730 * 86400);
  assert.equal(realm.clientSessionIdleTimeout, 0);
  assert.equal(realm.clientSessionMaxLifespan, 0);
  assert.equal(realm.accessTokenLifespan, 300);
  assert.equal(realm.revokeRefreshToken, true);
  assert.equal(realm.refreshTokenMaxReuse, 0);
  const web = realm.clients.find((c: any) => c.clientId === 'mailmcp-web');
  assert.equal(web.attributes['client.session.idle.timeout'], '1800');
  assert.equal(web.attributes['client.session.max.lifespan'], '28800');
  assert.ok(realm.enabledEventTypes.includes('REFRESH_TOKEN_ERROR'));
});

test('operator health detects short client overrides, disabled rotation and session deadlines without identities', async () => {
  const { sessionPolicyWarnings, expiringSessionCount } =
    await import('../scripts/check-auth-health.mjs');
  assert.deepEqual(sessionPolicyWarnings(realm), []);
  assert.ok(
    sessionPolicyWarnings({ ...realm, ssoSessionIdleTimeout: 1800 }).includes(
      'ssoSessionIdleTimeout_too_short',
    ),
  );
  assert.ok(
    sessionPolicyWarnings({ ...realm, revokeRefreshToken: false }).includes(
      'refresh_rotation_policy',
    ),
  );
  assert.ok(
    sessionPolicyWarnings(realm, [
      { attributes: { 'client.session.max.lifespan': '28800' } },
    ]).includes('mcp_client_session_override_too_short'),
  );
  const now = 1800000000000;
  const expiring = { id: 'private-session-id', start: now - 729 * 86400_000, lastAccess: now };
  assert.equal(expiringSessionCount([expiring, expiring], realm, now), 1);
  assert.equal(expiringSessionCount([{ ...expiring, start: now, lastAccess: now }], realm, now), 0);
  assert.equal(
    expiringSessionCount(
      [{ ...expiring, start: expiring.start / 1000, lastAccess: now / 1000 }],
      realm,
      now,
    ),
    1,
  );
});
