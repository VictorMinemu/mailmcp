import { resolve } from 'node:path';
import { AppError } from './errors.js';

export type Config = ReturnType<typeof readConfig>;
export function readConfig(env = process.env) {
  const mode = env.MAILMCP_MODE ?? 'local';
  if (!['local', 'hosted'].includes(mode))
    throw new AppError('CONFIG', 'MAILMCP_MODE must be local or hosted.');
  const port = Number(env.MAILMCP_WEB_PORT ?? '3210');
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new AppError('CONFIG', 'Invalid web port.');
  const origin = new URL(env.MAILMCP_PUBLIC_URL ?? `http://127.0.0.1:${port}`);
  if (origin.origin !== origin.href.replace(/\/$/, '') || origin.username || origin.password)
    throw new AppError('CONFIG', 'PUBLIC_URL must be an origin without a path.');
  if (mode === 'hosted' && origin.protocol !== 'https:')
    throw new AppError('CONFIG', 'Hosted mode requires an HTTPS public URL.');
  if (mode === 'local' && origin.origin !== `http://127.0.0.1:${port}`)
    throw new AppError(
      'CONFIG',
      'Local mode requires the loopback origin. Use hosted mode for a domain.',
    );
  const key = env.MAILMCP_MASTER_KEY ?? '';
  if (!/^[a-fA-F0-9]{64}$/.test(key))
    throw new AppError('CONFIG', 'Set a random 32-byte hex MASTER_KEY; run npm run setup.');
  const issuer = env.MAILMCP_OIDC_ISSUER;
  const clientId = env.MAILMCP_OIDC_CLIENT_ID;
  const audience = env.MAILMCP_OAUTH_AUDIENCE ?? `${origin.origin}/mcp`;
  if (audience !== `${origin.origin}/mcp`)
    throw new AppError('CONFIG', 'OAuth audience must equal PUBLIC_URL/mcp.');
  if (mode === 'hosted' && clientId === audience)
    throw new AppError('CONFIG', 'Browser client ID must differ from the MCP resource audience.');
  if (
    issuer &&
    (new URL(issuer).username ||
      new URL(issuer).password ||
      new URL(issuer).search ||
      new URL(issuer).hash)
  )
    throw new AppError('CONFIG', 'Invalid OIDC issuer URL.');
  if (!/^[A-Za-z0-9:._-]{1,100}$/.test(env.MAILMCP_OAUTH_SCOPE ?? 'mailmcp'))
    throw new AppError('CONFIG', 'Invalid OAuth scope.');
  if (mode === 'hosted' && (!issuer || !clientId || !issuer.startsWith('https://')))
    throw new AppError('CONFIG', 'Hosted mode requires HTTPS OIDC_ISSUER and OIDC_CLIENT_ID.');
  return {
    mode,
    port,
    origin: origin.origin,
    hostname: origin.host,
    bind: mode === 'local' ? '127.0.0.1' : (env.MAILMCP_BIND ?? '0.0.0.0'),
    dataDir: resolve(env.MAILMCP_DATA_DIR ?? './data'),
    key: Buffer.from(key, 'hex'),
    allowedHosts: new Set(
      (env.MAILMCP_ALLOWED_HOSTS ?? '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
    issuer,
    clientId,
    audience,
    clientSecret: env.MAILMCP_OIDC_CLIENT_SECRET,
    scope: env.MAILMCP_OAUTH_SCOPE ?? 'mailmcp',
    oidcScopes: env.MAILMCP_OIDC_SCOPES ?? 'openid profile',
  };
}
