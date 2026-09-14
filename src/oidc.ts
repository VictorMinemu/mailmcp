import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Config } from './config.js';
import { AppError } from './errors.js';

const random = () => randomBytes(32).toString('base64url');
const digest = (s: string) => createHash('sha256').update(s).digest('base64url');
export function subjectOwner(issuer: string, subject: string) {
  return digest(JSON.stringify([issuer, subject]));
}
type Discovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
};
export interface IdentityProvider {
  begin(): Promise<{ url: string; binding: string }>;
  finish(params: URLSearchParams, binding: string | undefined): Promise<string>;
  bearer(token: string): Promise<string>;
}

export class Oidc implements IdentityProvider {
  private pending = new Map<
    string,
    { binding: string; verifier: string; nonce: string; expires: number }
  >();
  private metadata?: Promise<{ data: Discovery; keys: ReturnType<typeof createRemoteJWKSet> }>;
  constructor(private config: Config) {}
  private discovery() {
    this.metadata ??= (async () => {
      const response = await fetch(
        `${this.config.issuer!.replace(/\/$/, '')}/.well-known/openid-configuration`,
        { signal: AbortSignal.timeout(10_000), redirect: 'error' },
      );
      if (!response.ok)
        throw new AppError('IDENTITY_PROVIDER', 'Identity provider is unavailable.', 503);
      const data = (await response.json()) as Discovery;
      if (data.issuer !== this.config.issuer)
        throw new AppError('IDENTITY_PROVIDER', 'Identity provider issuer mismatch.', 503);
      for (const url of [data.authorization_endpoint, data.token_endpoint, data.jwks_uri]) {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password)
          throw new AppError('IDENTITY_PROVIDER', 'Identity endpoints must use HTTPS.', 503);
      }
      return {
        data,
        keys: createRemoteJWKSet(new URL(data.jwks_uri), { timeoutDuration: 10_000 }),
      };
    })().catch((error) => {
      this.metadata = undefined;
      throw error;
    });
    return this.metadata;
  }
  async begin() {
    const { data } = await this.discovery();
    for (const [key, item] of this.pending) if (item.expires < Date.now()) this.pending.delete(key);
    if (this.pending.size >= 1000)
      throw new AppError('RATE_LIMIT', 'Too many pending logins.', 429);
    const state = random(),
      binding = random(),
      verifier = random(),
      nonce = random();
    this.pending.set(digest(state), {
      binding: digest(binding),
      verifier,
      nonce,
      expires: Date.now() + 300_000,
    });
    const url = new URL(data.authorization_endpoint);
    for (const [key, value] of Object.entries({
      response_type: 'code',
      client_id: this.config.clientId!,
      redirect_uri: `${this.config.origin}/auth/callback`,
      scope: this.config.oidcScopes,
      state,
      nonce,
      code_challenge: digest(verifier),
      code_challenge_method: 'S256',
    }))
      url.searchParams.set(key, value);
    return { url: url.href, binding };
  }
  async finish(params: URLSearchParams, binding: string | undefined) {
    const key = digest(params.get('state') ?? ''),
      grant = this.pending.get(key);
    this.pending.delete(key);
    if (
      !grant ||
      !binding ||
      grant.binding !== digest(binding) ||
      grant.expires <= Date.now() ||
      !params.get('code') ||
      params.get('error')
    )
      throw new AppError(
        'LOGIN_FAILED',
        'Login expired or could not be verified. Start again.',
        401,
      );
    const { data, keys } = await this.discovery();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: params.get('code')!,
      redirect_uri: `${this.config.origin}/auth/callback`,
      client_id: this.config.clientId!,
      code_verifier: grant.verifier,
    });
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
    if (this.config.clientSecret)
      headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(this.config.clientId!)}:${encodeURIComponent(this.config.clientSecret)}`).toString('base64')}`;
    const response = await fetch(data.token_endpoint, {
      method: 'POST',
      body,
      headers,
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    });
    if (!response.ok) throw new AppError('LOGIN_FAILED', 'Identity provider rejected login.', 401);
    const tokens = (await response.json()) as { id_token?: string };
    if (!tokens.id_token)
      throw new AppError('LOGIN_FAILED', 'Identity provider returned no ID token.', 401);
    const { payload } = await jwtVerify(tokens.id_token, keys, {
      issuer: this.config.issuer,
      audience: this.config.clientId,
      algorithms: ['RS256', 'ES256'],
      requiredClaims: ['sub', 'exp', 'iat', 'nonce'],
    });
    if (
      payload.nonce !== grant.nonce ||
      (payload.azp && payload.azp !== this.config.clientId) ||
      (Array.isArray(payload.aud) && payload.aud.length > 1 && !payload.azp)
    )
      throw new AppError('LOGIN_FAILED', 'ID token could not be verified.', 401);
    return subjectOwner(this.config.issuer!, payload.sub!);
  }
  async bearer(token: string) {
    try {
      const { keys } = await this.discovery();
      const { payload } = await jwtVerify(token, keys, {
        issuer: this.config.issuer,
        audience: this.config.audience,
        algorithms: ['RS256', 'ES256'],
        requiredClaims: ['sub', 'exp', 'iat'],
      });
      return this.accessOwner(payload);
    } catch {
      throw new AppError(
        'UNAUTHORIZED',
        'A valid OAuth access token for this MCP resource is required.',
        401,
      );
    }
  }
  private accessOwner(payload: JWTPayload) {
    if (typeof payload.scope !== 'string' || !payload.scope.split(' ').includes(this.config.scope))
      throw new AppError('SCOPE', 'Required OAuth scope is missing.', 403);
    return subjectOwner(this.config.issuer!, payload.sub!);
  }
}
