// Read-only probe. No mailbox access and no refresh-token collection/storage.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { adminApi } from './configure-keycloak-dcr.mjs';

export function sessionPolicyWarnings(realm, clients = []) {
  const warnings = [];
  const year = 365 * 86400;
  for (const field of ['ssoSessionIdleTimeout', 'ssoSessionMaxLifespan'])
    if (!(realm[field] > year)) warnings.push(`${field}_too_short`);
  for (const field of ['clientSessionIdleTimeout', 'clientSessionMaxLifespan'])
    if (realm[field] > 0 && realm[field] <= year) warnings.push(`${field}_too_short`);
  if (!(realm.accessTokenLifespan > 0 && realm.accessTokenLifespan <= 300))
    warnings.push('access_token_lifetime');
  if (!realm.revokeRefreshToken || realm.refreshTokenMaxReuse !== 0)
    warnings.push('refresh_rotation_policy');
  if (!realm.eventsEnabled || !realm.enabledEventTypes?.includes('REFRESH_TOKEN_ERROR'))
    warnings.push('refresh_errors_not_recorded');
  if (
    clients.some((c) =>
      ['client.session.idle.timeout', 'client.session.max.lifespan'].some(
        (key) => Number(c.attributes?.[key]) > 0 && Number(c.attributes[key]) <= year,
      ),
    )
  )
    warnings.push('mcp_client_session_override_too_short');
  return warnings;
}

export function expiringSessionCount(sessions, realm, now = Date.now()) {
  const milliseconds = (value) => (Number(value) > 1e12 ? Number(value) : Number(value) * 1000);
  return new Set(
    sessions
      .filter((session) => {
        const deadlines = [
          milliseconds(session.start) + realm.ssoSessionMaxLifespan * 1000,
          milliseconds(session.lastAccess) + realm.ssoSessionIdleTimeout * 1000,
        ];
        return deadlines.some(
          (deadline) => Number.isFinite(deadline) && deadline <= now + 7 * 86400_000,
        );
      })
      .map((session) => session.id),
  ).size;
}

export async function checkAuthHealth(origin, { api, realm = 'mailmcp' } = {}) {
  const publicUrl = new URL(origin);
  if (publicUrl.protocol !== 'https:' || publicUrl.origin !== origin)
    throw new Error('Use the HTTPS application origin.');
  const get = async (url) => {
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Health dependency returned ${response.status}`);
    return response.json();
  };
  const health = await get(`${origin}/healthz`);
  if (health.status !== 'ok') throw new Error('Application health failed');
  const resource = await get(`${origin}/.well-known/oauth-protected-resource/mcp`);
  if (resource.resource !== `${origin}/mcp` || resource.authorization_servers?.length !== 1)
    throw new Error('Invalid OAuth resource metadata');
  const issuer = new URL(resource.authorization_servers[0]);
  if (
    issuer.protocol !== 'https:' ||
    issuer.username ||
    issuer.password ||
    issuer.search ||
    issuer.hash
  )
    throw new Error('Invalid issuer');
  const oidc = await get(`${issuer.href}/.well-known/openid-configuration`);
  if (oidc.issuer !== issuer.href || !oidc.grant_types_supported?.includes('refresh_token'))
    throw new Error('Refresh grant unavailable');
  const jwks = new URL(oidc.jwks_uri);
  if (jwks.origin !== issuer.origin || jwks.username || jwks.password)
    throw new Error('Unexpected key endpoint');
  if (!(await get(jwks.href)).keys?.length) throw new Error('No identity signing keys');
  const unauthenticated = await fetch(`${origin}/mcp`, {
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  if (unauthenticated.status !== 401 || !unauthenticated.headers.get('www-authenticate'))
    throw new Error('MCP authentication challenge failed');
  await unauthenticated.body?.cancel();
  const report = {
    status: 'ok',
    checkedAt: new Date().toISOString(),
    application: true,
    identity: true,
    refreshGrant: true,
    operatorChecks: Boolean(api),
    warnings: [],
  };
  if (api) {
    const base = `realms/${encodeURIComponent(realm)}`;
    const settings = await api(base);
    const clients = (await api(`${base}/clients`)).filter(
      (c) =>
        c.clientId !== 'mailmcp-web' &&
        [...(c.defaultClientScopes ?? []), ...(c.optionalClientScopes ?? [])].includes('mailmcp') &&
        !c.name?.startsWith('dcr-test-'),
    );
    report.warnings.push(...sessionPolicyWarnings(settings, clients));
    const activeClients = new Set(clients.map((c) => c.clientId));
    const errors = await api(`${base}/events?type=REFRESH_TOKEN_ERROR&max=1000`);
    report.refreshFailuresLastHour = errors.filter(
      (e) => activeClients.has(e.clientId) && e.time >= Date.now() - 3600_000,
    ).length;
    if (report.refreshFailuresLastHour) report.warnings.push('recent_refresh_failures');
    if (errors.length === 1000) report.warnings.push('event_sample_capped');
    const sessions = [];
    for (const client of clients) {
      const page = await api(`${base}/clients/${client.id}/user-sessions?first=0&max=100`);
      sessions.push(...page);
      if (page.length === 100) report.warnings.push('session_sample_capped');
    }
    report.sessionsExpiringWithinSevenDays = expiringSessionCount(sessions, settings);
    if (report.sessionsExpiringWithinSevenDays) report.warnings.push('sessions_expiring_soon');
  }
  report.warnings = [...new Set(report.warnings)];
  if (report.warnings.length) report.status = 'warning';
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let api;
    if (process.env.MAILMCP_KEYCLOAK_CREDENTIALS_FILE) {
      const credentials = JSON.parse(
        await readFile(process.env.MAILMCP_KEYCLOAK_CREDENTIALS_FILE, 'utf8'),
      );
      if (new URL(credentials.url).origin !== process.env.MAILMCP_KEYCLOAK_URL)
        throw new Error('Credential destination mismatch');
      api = await adminApi(process.env.MAILMCP_KEYCLOAK_URL, credentials);
    }
    const result = await checkAuthHealth(process.env.MAILMCP_PUBLIC_URL || 'https://mailmcp.org', {
      api,
      realm: process.env.MAILMCP_KEYCLOAK_REALM || 'mailmcp',
    });
    console.log(JSON.stringify(result));
    if (result.status !== 'ok') process.exitCode = 1;
  } catch {
    console.error(
      JSON.stringify({
        status: 'error',
        message: 'Identity health check failed; inspect connectivity and configuration.',
      }),
    );
    process.exitCode = 1;
  }
}
