// Update identity lifetimes without changing users, subjects, connected accounts or client IDs.
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { adminApi } from './configure-keycloak-dcr.mjs';

export async function configureSessions(api, realm, { apply = false, backup } = {}) {
  const desired = JSON.parse(
    await readFile(new URL('../deploy/keycloak/mailmcp-realm.json', import.meta.url), 'utf8'),
  );
  const base = `realms/${encodeURIComponent(realm)}`;
  const current = await api(base);
  const [web] = await api(`${base}/clients?clientId=mailmcp-web`);
  if (!web) throw new Error('Expected the existing mailmcp-web client.');
  const fields = [
    'ssoSessionIdleTimeout',
    'ssoSessionMaxLifespan',
    'clientSessionIdleTimeout',
    'clientSessionMaxLifespan',
    'accessTokenLifespan',
    'revokeRefreshToken',
    'refreshTokenMaxReuse',
    'eventsEnabled',
    'eventsExpiration',
  ];
  const changes = Object.fromEntries(fields.map((key) => [key, desired[key]]));
  changes.enabledEventTypes = [
    ...new Set([...(current.enabledEventTypes ?? []), ...desired.enabledEventTypes]),
  ];
  const webChanges = Object.fromEntries(
    Object.entries(desired.clients.find((c) => c.clientId === 'mailmcp-web').attributes).filter(
      ([key]) => key.startsWith('client.session.'),
    ),
  );
  if (!apply) return { action: 'dry-run', realm, changes, webSessionLimits: webChanges };
  if (!backup) throw new Error('A private backup file is required.');
  await writeFile(
    backup,
    JSON.stringify(
      {
        realm: Object.fromEntries(
          [...fields, 'enabledEventTypes'].map((key) => [key, current[key]]),
        ),
        web: { id: web.id, attributes: web.attributes },
      },
      null,
      2,
    ),
    { mode: 0o600, flag: 'wx' },
  );
  // Bound the browser client before extending the shared SSO ceiling used by MCP clients.
  await api(`${base}/clients/${web.id}`, 'PUT', {
    attributes: { ...web.attributes, ...webChanges },
  });
  await api(base, 'PUT', changes);
  const actual = await api(base);
  for (const field of fields)
    if (actual[field] !== changes[field])
      throw new Error(`Session migration verification failed: ${field}`);
  return { action: 'applied', realm, idleDays: 400, maxDays: 730, accessTokenSeconds: 300 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const origin = process.env.MAILMCP_KEYCLOAK_URL;
  const credentials = JSON.parse(
    await readFile(process.env.MAILMCP_KEYCLOAK_CREDENTIALS_FILE, 'utf8'),
  );
  if (new URL(credentials.url).origin !== new URL(origin).origin)
    throw new Error('Credential destination mismatch.');
  const api = await adminApi(origin, credentials);
  console.log(
    await configureSessions(api, process.env.MAILMCP_KEYCLOAK_REALM || 'mailmcp', {
      apply: process.argv.includes('--apply'),
      backup: process.env.MAILMCP_KEYCLOAK_BACKUP_FILE,
    }),
  );
}
