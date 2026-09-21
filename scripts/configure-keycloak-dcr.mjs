import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const policyType = 'org.keycloak.services.clientregistration.policy.ClientRegistrationPolicy';
const template = new URL('../deploy/keycloak/mailmcp-realm.json', import.meta.url);

export async function adminApi(origin, credentials) {
  const url = new URL(origin);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Error('Use an identity origin without a path or credentials.');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === '127.0.0.1'))
    throw new Error('HTTPS is required except for a local test server.');
  let token;
  async function login() {
    const response = await fetch(`${url.origin}/realms/master/protocol/openid-connect/token`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'admin-cli',
        username: credentials.username,
        password: credentials.password,
      }),
    });
    if (!response.ok) throw new Error(`Operator authentication failed (${response.status}).`);
    token = (await response.json()).access_token;
  }
  await login();
  return async function request(path, method = 'GET', data) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(`${url.origin}/admin/${path}`, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      });
      if (response.status === 401 && attempt === 0) {
        await login();
        continue;
      }
      if (!response.ok) throw new Error(`${method} ${path} failed (${response.status}).`);
      const body = await response.text();
      return body ? JSON.parse(body) : undefined;
    }
  };
}

export async function configureDcr(api, realm, { apply = false, backup } = {}) {
  const desired = JSON.parse(await readFile(template, 'utf8'));
  const base = `realms/${encodeURIComponent(realm)}`;
  const state = {};
  for (const path of [
    'components',
    'client-policies/profiles',
    'client-policies/policies',
    'default-default-client-scopes',
    'default-optional-client-scopes',
    'client-scopes',
  ]) {
    state[path] = await api(`${base}/${path}`);
  }
  const components = state.components.filter(
    (c) => c.providerType === policyType && c.subType === 'anonymous',
  );
  for (const component of desired.components[policyType]) {
    if (components.filter((c) => c.providerId === component.providerId).length !== 1)
      throw new Error(
        `Expected exactly one anonymous ${component.providerId} policy; inspect this realm manually.`,
      );
  }
  for (const name of ['mailmcp', 'profile']) {
    if (!state['client-scopes'].some((s) => s.name === name))
      throw new Error(`Missing ${name} scope.`);
  }
  if (!apply)
    return {
      realm,
      action: 'dry-run',
      policies: desired.clientPolicies.policies.map((p) => p.name),
    };
  if (!backup) throw new Error('A private backup file is required before applying changes.');
  await writeFile(backup, JSON.stringify(state, null, 2), { mode: 0o600, flag: 'wx' });
  // Keycloak's OIDC registration converter requests its standard basic scope.
  // Older minimal realm imports did not create it.
  if (!state['client-scopes'].some((s) => s.name === 'basic')) {
    await api(
      `${base}/client-scopes`,
      'POST',
      desired.clientScopes.find((s) => s.name === 'basic'),
    );
    state['client-scopes'] = await api(`${base}/client-scopes`);
  }

  // Install constraints before removing the source-host restriction. Merge rather
  // than overwrite unrelated realm policies. Existing client assignments stay intact.
  const merge = (oldItems, newItems) => [
    ...oldItems.filter((old) => !newItems.some((next) => next.name === old.name)),
    ...newItems,
  ];
  await api(`${base}/client-policies/profiles`, 'PUT', {
    profiles: merge(state['client-policies/profiles'].profiles, desired.clientProfiles.profiles),
  });
  await api(`${base}/client-policies/policies`, 'PUT', {
    policies: merge(state['client-policies/policies'].policies, desired.clientPolicies.policies),
  });
  for (const [path, names] of [
    ['default-default-client-scopes', desired.defaultDefaultClientScopes],
    ['default-optional-client-scopes', desired.defaultOptionalClientScopes],
  ]) {
    for (const scope of state[path]) {
      if (!names.includes(scope.name)) await api(`${base}/${path}/${scope.id}`, 'DELETE');
    }
    for (const name of names) {
      if (state[path].some((scope) => scope.name === name)) continue;
      const scope = state['client-scopes'].find((s) => s.name === name);
      await api(`${base}/${path}/${scope.id}`, 'PUT');
    }
  }
  for (const next of desired.components[policyType]) {
    const old = components.find((c) => c.providerId === next.providerId);
    await api(`${base}/components/${old.id}`, 'PUT', { ...old, config: next.config });
  }
  for (const old of components.filter((c) => c.providerId === 'trusted-hosts')) {
    await api(`${base}/components/${old.id}`, 'DELETE');
  }
  return { realm, action: 'applied', backup };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { MAILMCP_KEYCLOAK_URL: origin, MAILMCP_KEYCLOAK_CREDENTIALS_FILE: file } = process.env;
  if (!origin || !file)
    throw new Error('Set MAILMCP_KEYCLOAK_URL and MAILMCP_KEYCLOAK_CREDENTIALS_FILE.');
  const credentials = JSON.parse(await readFile(file, 'utf8'));
  if (new URL(credentials.url).origin !== new URL(origin).origin)
    throw new Error('Credential destination does not match MAILMCP_KEYCLOAK_URL.');
  const api = await adminApi(origin, credentials);
  console.log(
    await configureDcr(api, process.env.MAILMCP_KEYCLOAK_REALM || 'mailmcp', {
      apply: process.argv.includes('--apply'),
      backup: process.env.MAILMCP_KEYCLOAK_BACKUP_FILE,
    }),
  );
}
