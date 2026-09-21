import { negotiateLanguage } from './i18n.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { z, ZodError } from 'zod';
import type { Config } from './config.js';
import { createMcp, type Services } from './mcp.js';
import { RateLimit } from './auth.js';
import { AppError, publicError } from './errors.js';
import type { IdentityProvider } from './oidc.js';
import { idSchema, line } from './schemas.js';
import { MAX_SEND_REQUEST_BYTES } from './uploads.js';

const json = (res: ServerResponse, value: unknown, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
};
const cookieValue = (req: IncomingMessage, name: string) =>
  req.headers.cookie
    ?.split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${name}=`))
    ?.slice(name.length + 1);
async function body(req: IncomingMessage, maxBytes = 262_144) {
  if (!(req.headers['content-type'] ?? '').startsWith('application/json'))
    throw new AppError('CONTENT_TYPE', 'Use application/json.', 415);
  const chunks: Buffer[] = [];
  let length = 0;
  const trace = Number(req.headers['content-length'] ?? 0) > 1_000_000;
  const progress = (stage: string) => {
    if (trace)
      console.error(
        JSON.stringify({
          event: 'upload',
          stage,
          received: length,
          expected: req.headers['content-length'],
          http: req.httpVersion,
        }),
      );
  };
  let nextProgress = 8_000_000;
  progress('start');
  req.once('aborted', () => progress('aborted'));
  const tooLarge = () =>
    new AppError(
      'BODY_TOO_LARGE',
      maxBytes === MAX_SEND_REQUEST_BYTES
        ? 'Request body exceeds 40 MB.'
        : 'Request body exceeds 256 KB.',
      413,
    );
  if (Number(req.headers['content-length'] ?? 0) > maxBytes) throw tooLarge();
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > maxBytes) throw tooLarge();
    chunks.push(chunk);
    if (length >= nextProgress) {
      progress('receiving');
      nextProgress += 8_000_000;
    }
  }
  progress('complete');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new AppError('INVALID_JSON', 'Invalid JSON.');
  }
}

export function createWeb(config: Config, services: Services, identity?: IdentityProvider) {
  const hosted = config.mode === 'hosted',
    sessionName = hosted ? '__Host-mailmcp' : 'mailmcp';
  const bindingName = '__Host-mailmcp-login';
  const sessionCookie = (token: string, maxAge = 3600) =>
    `${sessionName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${hosted ? '; Secure' : ''}`;
  const loginCookie = (binding: string, maxAge = 300) =>
    `${bindingName}=${binding}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${maxAge}`;
  const authLimit = new RateLimit(300, 60_000),
    publicLimit = new RateLimit(60, 60_000),
    apiLimit = new RateLimit(120, 60_000);
  // Reserve before buffering authenticated MCP/send bodies. Keep the lease through
  // SMTP completion, since decoded attachments stay in memory until then.
  const largeRequests = new Set<string>();
  function reserveRequest(owner: string) {
    if (largeRequests.size >= 2 || largeRequests.has(owner))
      throw new AppError('BUSY', 'Too many concurrent mail operations.', 429);
    largeRequests.add(owner);
    return () => {
      largeRequests.delete(owner);
    };
  }
  const assets: Record<string, [string, string]> = {
    '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
    '/': ['index.html', 'text/html'],
    '/app.js': ['app.js', 'text/javascript'],
    '/i18n.js': ['i18n.js', 'text/javascript'],
    '/language.js': ['language.js', 'text/javascript'],
    '/landing.js': ['landing.js', 'text/javascript'],
    '/style.css': ['style.css', 'text/css'],
    '/landing.css': ['landing.css', 'text/css'],
    '/robots.txt': ['robots.txt', 'text/plain'],
    '/sitemap.xml': ['sitemap.xml', 'application/xml'],
    '/llms.txt': ['llms.txt', 'text/plain'],
  };
  const handler = createMcpHandler(
    (ctx) => {
      const owner = ctx.authInfo?.extra?.owner;
      if (typeof owner !== 'string')
        throw new AppError('UNAUTHORIZED', 'Authentication required.', 401);
      return createMcp(
        services,
        owner,
        negotiateLanguage(
          ctx.requestInfo?.headers.get('accept-language') ?? undefined,
          config.locale,
        ),
      );
    },
    { maxSubscriptions: 0 },
  );
  const server = createServer(async (req, res) => {
    let releaseRequest: (() => void) | undefined;
    const locale = negotiateLanguage(req.headers['accept-language'], config.locale);
    res.setHeader('content-language', locale);
    res.setHeader('vary', 'Accept-Language');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader(
      'content-security-policy',
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
    if (hosted) res.setHeader('strict-transport-security', 'max-age=31536000');
    try {
      if (req.headers.host !== config.hostname)
        throw new AppError('INVALID_HOST', 'Unexpected request host.', 403);
      const origin = req.headers.origin;
      if (origin && origin !== config.origin)
        throw new AppError('INVALID_ORIGIN', 'Cross-origin access is not allowed.', 403);
      const url = new URL(req.url ?? '/', config.origin),
        path = url.pathname;
      if (url.origin !== config.origin)
        throw new AppError('INVALID_HOST', 'Unexpected request URL.', 403);
      if (req.method === 'GET' && path === '/healthz') return json(res, { status: 'ok' });
      if (
        req.method === 'GET' &&
        (path === '/.well-known/oauth-protected-resource' ||
          path === '/.well-known/oauth-protected-resource/mcp') &&
        hosted
      )
        return json(res, {
          resource: `${config.origin}/mcp`,
          authorization_servers: [config.issuer],
          scopes_supported: [config.scope],
          bearer_methods_supported: ['header'],
        });
      if (path === '/mcp') {
        if (!hosted || !identity) throw new AppError('NOT_FOUND', 'Use stdio in local mode.', 404);
        authLimit.check('mcp');
        const authorization = req.headers.authorization;
        if (!authorization?.startsWith('Bearer ') || authorization.length > 16_000)
          throw new AppError('UNAUTHORIZED', 'OAuth bearer token required.', 401);
        const token = authorization.slice(7),
          owner = await identity.bearer(token);
        apiLimit.check(owner);
        if (req.method === 'POST') releaseRequest = reserveRequest(owner);
        const parsedBody =
          req.method === 'POST' ? await body(req, MAX_SEND_REQUEST_BYTES) : undefined;
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers))
          if (typeof value === 'string') headers.set(key, value);
        const request = new Request(url, {
          method: req.method,
          headers,
        });
        const response = await handler.fetch(request, {
          authInfo: { token, clientId: 'oauth-user', scopes: [config.scope], extra: { owner } },
          parsedBody,
        });
        for (const [key, value] of response.headers) res.setHeader(key, value);
        res.writeHead(response.status);
        res.end(Buffer.from(await response.arrayBuffer()));
        return;
      }
      if (req.method === 'GET' && path === '/auth/login' && hosted && identity) {
        // The reverse proxy enforces client-IP limits; forwarded headers are never trusted here.
        publicLimit.check('oidc');
        const login = await identity.begin();
        res.setHeader('set-cookie', loginCookie(login.binding));
        res.writeHead(302, { location: login.url });
        res.end();
        return;
      }
      if (req.method === 'GET' && path === '/auth/callback' && hosted && identity) {
        publicLimit.check('callback');
        const owner = await identity.finish(url.searchParams, cookieValue(req, bindingName));
        res.setHeader('set-cookie', [
          sessionCookie(services.auth.session(owner)),
          loginCookie('', 0),
        ]);
        res.writeHead(303, { location: '/' });
        res.end();
        return;
      }
      if (req.method === 'GET' && path === '/api/config')
        return json(res, { hosted, loginUrl: hosted ? '/auth/login' : null });
      if (req.method === 'POST' && path === '/api/redeem') {
        if (origin !== config.origin)
          throw new AppError('CSRF', 'Same-origin request required.', 403);
        publicLimit.check('redeem');
        const p = z
          .object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
          .strict()
          .parse(await body(req));
        res.setHeader('set-cookie', sessionCookie(services.auth.redeem(p.token)));
        return json(res, { authenticated: true });
      }
      if (path.startsWith('/api/')) {
        const token = cookieValue(req, sessionName),
          owner = services.auth.owner(token);
        apiLimit.check(owner);
        if (!['GET', 'HEAD'].includes(req.method ?? '') && origin !== config.origin)
          throw new AppError('CSRF', 'Same-origin request required.', 403);
        if (req.method === 'POST' && path === '/api/logout') {
          services.auth.logout(token!);
          res.setHeader('set-cookie', sessionCookie('', 0));
          return json(res, { loggedOut: true });
        }
        if (req.method === 'GET' && path === '/api/accounts')
          return json(res, services.accounts.list(owner));
        if (req.method === 'POST' && path === '/api/accounts')
          return json(res, services.accounts.add(owner, await body(req)), 201);
        const accountPath = /^\/api\/accounts\/([^/]+)$/.exec(path);
        if (accountPath) {
          const id = z.uuid().parse(accountPath[1]);
          if (req.method === 'PATCH')
            return json(res, services.accounts.update(owner, id, await body(req)));
          if (req.method === 'DELETE') {
            z.object({ confirm: z.literal(true) })
              .strict()
              .parse(await body(req));
            return json(res, services.accounts.remove(owner, id));
          }
        }
        if (req.method === 'POST' && path.startsWith('/api/mail/')) {
          if (path === '/api/mail/send') releaseRequest = reserveRequest(owner);
          const input = await body(
            req,
            path === '/api/mail/send' ? MAX_SEND_REQUEST_BYTES : 262_144,
          );
          let result: unknown;
          switch (path.slice('/api/mail/'.length)) {
            case 'verify':
              result = await services.mail.verify(owner, idSchema.parse(input).accountId);
              break;
            case 'folders':
              result = await services.mail.folders(owner, idSchema.parse(input).accountId);
              break;
            case 'list':
              result = await services.mail.list(owner, input);
              break;
            case 'attachments':
              result = await services.mail.attachments(owner, input);
              break;
            case 'attachment':
              result = await services.mail.attachment(owner, input);
              break;
            case 'read':
              result = await services.mail.read(owner, input);
              break;
            case 'send':
              result = await services.mail.send(owner, input);
              break;
            case 'flag':
              result = await services.mail.flag(owner, input);
              break;
            case 'move':
              result = await services.mail.move(owner, input);
              break;
            case 'create-folder': {
              const p = idSchema.extend({ path: line }).parse(input);
              result = await services.mail.createFolder(owner, p.accountId, p.path);
              break;
            }
            default:
              throw new AppError('NOT_FOUND', 'Endpoint not found.', 404);
          }
          return json(res, result);
        }
        throw new AppError('NOT_FOUND', 'Endpoint not found.', 404);
      }
      if (req.method === 'GET' && /^\/locales\/(en|es)\.json$/.test(path)) {
        const file = await readFile(new URL(`..${path}`, import.meta.url));
        res.setHeader('content-language', path.includes('/es.') ? 'es' : 'en');
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(file);
        return;
      }
      const asset = Object.hasOwn(assets, path) ? assets[path] : undefined;
      if (req.method === 'GET' && asset) {
        // Public metadata (canonical URL, sitemap, robots) is bound to the configured origin.
        const file = (
          await readFile(new URL(`../web/${asset[0]}`, import.meta.url), 'utf8')
        ).replaceAll('__ORIGIN__', config.origin);
        if (path === '/') res.setHeader('content-language', 'en');
        res.writeHead(200, { 'content-type': `${asset[1]}; charset=utf-8` });
        res.end(file);
        return;
      }
      throw new AppError('NOT_FOUND', 'Not found.', 404);
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      const status =
        error instanceof AppError ? error.status : error instanceof ZodError ? 400 : 500;
      if (!req.complete || status === 413 || status === 429) res.setHeader('connection', 'close');
      if (status === 401 && req.url?.startsWith('/mcp'))
        res.setHeader(
          'www-authenticate',
          `Bearer resource_metadata="${config.origin}/.well-known/oauth-protected-resource/mcp", scope="${config.scope}"`,
        );
      json(res, publicError(error, locale), status);
    } finally {
      releaseRequest?.();
    }
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5000;
  server.on('close', () => {
    void handler.close();
  });
  return server;
}
