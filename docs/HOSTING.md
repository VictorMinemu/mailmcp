# Hosting MailMCP on your domain

This guide prepares a single-instance hosted service for users who bring existing mail accounts. An HTTPS origin and an OAuth/OIDC identity provider are required. No public identity provider, DNS record or cloud account is created by this repository.

## Identity provider

Use a provider supporting OIDC discovery, authorization code flow with PKCE S256, signed JWTs with RS256 or ES256, and OAuth access tokens for a custom API resource. Registration, email verification, account recovery and MFA belong to that provider. Configure public registration there if you want anyone to join.

Create a **browser client**:

- Client ID: set `MAILMCP_OIDC_CLIENT_ID`.
- Exact redirect URI: `https://YOUR_DOMAIN/auth/callback`.
- Authorization code grant, PKCE S256, OIDC scopes `openid profile`.
- Public client with PKCE, or a confidential client using `client_secret_basic` and `MAILMCP_OIDC_CLIENT_SECRET`. Other client-auth methods are not implemented.
- ID-token audience must include the browser client ID. Subject identifiers must be stable and consistent with the access-token subjects used by your MCP clients.

Configure a separate **MCP API resource**:

- Audience/resource: `https://YOUR_DOMAIN/mcp`.
- Scope: `mailmcp` (or the configured `MAILMCP_OAUTH_SCOPE`). This initial scope grants management of the authenticated user's own accounts and mail; it is not an operator/admin scope.
- JWT access tokens must include `iss`, `sub`, `aud`, `iat`, `exp`, and a space-delimited `scope` claim. Opaque tokens and client-credentials/service identities are not a supported user onboarding flow.
- Configure MCP clients at the identity provider. Client registration/discovery support depends on your provider and MCP client; pre-register clients when dynamic registration is unavailable. Browser client registration alone does not register an MCP client.
- Use short-lived access tokens (for example five minutes) and provider-managed refresh/revocation. MailMCP validates JWT signatures and expiry but does not introspect token revocation. Use non-pairwise subjects across the relevant clients, or the browser and MCP may have separate account ownership.

MailMCP exposes OAuth protected-resource metadata at `/.well-known/oauth-protected-resource/mcp` and includes its URL in `WWW-Authenticate` on unauthenticated MCP requests. Authorization-server discovery and user consent are served by your configured provider. MCP clients connect to `https://YOUR_DOMAIN/mcp`. Mail-provider credentials are never reused as application access tokens.

### Automatic MCP client registration with Keycloak

The bundled Keycloak realm supports anonymous OAuth dynamic client registration (DCR). Users enter `https://mailmcp.org/mcp` in a compatible client, register/sign in at `auth.mailmcp.org`, and approve access. They do not need a shared client ID or administrator-issued secret. A DCR registration only creates an application identity; reading mail still requires that user's login and consent.

Clients must support authorization code flow with PKCE S256 and request the `mailmcp` scope advertised by protected-resource metadata. HTTPS callbacks and exact HTTP loopback callbacks (`127.0.0.1`, `localhost`, `[::1]`, including a port) are accepted. Public clients (`none`) and confidential clients using a client secret are supported. Wildcards, URL fragments, userinfo, remote HTTP callbacks, custom URI schemes, unapproved scopes and client-supplied server-fetch URLs are rejected. Browser-origin registration is not enabled globally; a client registering directly from browser JavaScript needs an explicitly permitted registration origin. Server-side and desktop clients do not need that CORS permission.

Registration enforces consent, PKCE and disabled full role scope; implicit and password grants are disabled. Anonymous clients cannot install protocol mappers. Only `openid`, `profile`, `basic` and `mailmcp` scopes are allowed; `basic` supplies the standard subject claim. Realm defaults expose `mailmcp` as an optional scope when a client omits `scope` during registration. Existing clients and user accounts are unchanged. Registration-token updates remain subject to the same constraints.

**Existing installations require a migration.** Keycloak's startup realm import skips an existing realm, so redeploying the container alone does not update its policies. The migration first installs the constraints, then removes the source-host allowlist that caused `Policy 'Trusted Hosts' ... Host not trusted`. Run from a trusted operator machine, using a private JSON file containing the existing operator's `url`, `username` and `password`:

```sh
export MAILMCP_KEYCLOAK_URL=https://auth.YOUR_DOMAIN
export MAILMCP_KEYCLOAK_CREDENTIALS_FILE=/private/operator-credentials.json
export MAILMCP_KEYCLOAK_BACKUP_FILE=/private/before-dcr.json
node scripts/configure-keycloak-dcr.mjs          # dry run
node scripts/configure-keycloak-dcr.mjs --apply  # private backup; immediate effect
```

The script preserves unrelated policies and existing client assignments. It refuses an unexpected registration-policy layout and never prints credentials. Use a new backup filename for each application. Rollback: restore the saved anonymous `trusted-hosts` component first to stop new registrations, then restore saved profile/policy and default-scope assignments through Keycloak administration. Restoring registration restrictions does not revoke clients already registered; disable such clients separately if needed.

The anonymous registration cap remains **200 total realm clients**. Monitor usage and remove abandoned registrations; do not remove the cap to solve exhaustion. Configure edge registration rate limits before scaling the public service. The application API's throttle does not cover Keycloak's registration endpoint.

Regression commands (operator credentials required):

```sh
# Disposable local Keycloak, with MAILMCP_KEYCLOAK_URL=http://127.0.0.1:PORT:
node scripts/test-keycloak-config.mjs
# Target realm: creates and removes synthetic clients/user, checks login + consent + tokens:
node scripts/test-keycloak-dcr.mjs
# Also verify the real MCP handshake/tools using the issued token:
MAILMCP_TEST_MCP_URL=https://mailmcp.org/mcp node scripts/test-keycloak-dcr.mjs
```

The local suite checks fresh imports, migration from the old blocked configuration, repeat application, existing-client preservation and adversarial registrations. For a custom resource set `MAILMCP_TEST_RESOURCE=https://YOUR_DOMAIN/mcp`; for a custom realm set `MAILMCP_KEYCLOAK_REALM`.

## Environment

Run `npm run setup` to create a random key without displaying it. Edit the resulting `.env`; preserve the generated key:

```dotenv
MAILMCP_MODE=hosted
MAILMCP_PUBLIC_URL=https://mail.example.com
MAILMCP_DOMAIN=mail.example.com
MAILMCP_BIND=0.0.0.0
MAILMCP_WEB_PORT=3210
MAILMCP_DATA_DIR=./data
MAILMCP_MASTER_KEY=YOUR_GENERATED_64_HEX_CHARACTER_KEY
MAILMCP_OIDC_ISSUER=https://identity.example.com
MAILMCP_OIDC_CLIENT_ID=mailmcp-web
# Only for a confidential browser client with client_secret_basic:
# MAILMCP_OIDC_CLIENT_SECRET=YOUR_CLIENT_SECRET
MAILMCP_OAUTH_SCOPE=mailmcp
MAILMCP_OIDC_SCOPES=openid profile
MAILMCP_ALLOWED_HOSTS=*
```

`MAILMCP_PUBLIC_URL` is an origin without a path. `MAILMCP_OAUTH_AUDIENCE`, if supplied, must equal `MAILMCP_PUBLIC_URL/mcp`. Missing authentication settings or HTTP public URLs fail closed. Set `MAILMCP_ALLOWED_HOSTS=*` to accept every public mail provider, including custom-domain servers, without maintaining a provider list. To restrict an installation, supply comma-separated exact hostnames instead; an empty or unset value blocks all mail hosts. Partial wildcards and URLs are not supported. This policy applies to account creation, updates and every outbound connection. DNS resolves once per connection; every answer must be public and the checked address is used for the connection, keeping the original hostname for certificate verification. Private, loopback, link-local/metadata, reserved, multicast and mixed public/private DNS destinations remain blocked even with `*`. Internal mail servers are deliberately unsupported for this public-service baseline.

For an existing installation, deploy the updated application and change `MAILMCP_ALLOWED_HOSTS` to `*` in its runtime environment (Portainer stack variables or `.env`). Existing exact-host lists keep their restrictive meaning. A provider must still enable IMAP/POP3/SMTP access and accept the configured authentication method; allowing a hostname does not bypass its password, app-password or subscription requirements.

## Docker and HTTPS

Point your domain at the host. Allow inbound ports 80 and 443. Keep the application port private.

```sh
docker compose up --build -d
docker compose logs --tail=30 mailmcp
```

Caddy terminates TLS and forwards the original Host header. Only Caddy publishes ports. The app trusts its configured public origin, not client-supplied Forwarded headers. Deploy on a dedicated origin without unrelated applications. If using a managed reverse proxy instead, set its backend Host header to the configured public host and keep the hop private. Restrict direct access to the backend using your platform network controls.

The `.env` file is excluded from Docker builds and injected at runtime. The container runs as a non-root user with read-only root filesystem; only the encrypted data volume is writable. Set `MAILMCP_DATA_DIR` to a persistent path on managed platforms. Ephemeral filesystems lose accounts. Hosted mode does not expose stdio ownership shortcuts.

## Launch validation

Before onboarding public users, test your chosen identity provider and mail providers end to end. This initial code has automated protocol/security fixtures, not a production certification.

1. Sign in as two real users and verify each sees only their own connected accounts.
2. Connect a real MCP client using an access token for the API audience and required scope; verify `web_open` opens the same user's accounts.
3. Verify IMAP/POP3/SMTP TLS connections with the provider and download a harmless test attachment. Send a test email only with the account owner's approval.
4. Check DNS, automatic certificate renewal, backup recovery, and the host's outbound SMTP policy. Some hosting platforms block SMTP ports.
5. Configure edge request-rate limits, abuse monitoring and provider registration controls. The app has per-user mail/API limits and a global login throttle; these do not replace network-level DoS protection.
6. Publish service-specific privacy, retention and acceptable-use information. An operator holding the master key can decrypt stored mail credentials. This is server-side encryption, not end-to-end encryption.

## Capacity, backups and lifecycle

Initial limits: 20 connected accounts per user, 10,000 globally, 3 concurrent mail operations per user / 30 globally, 20 SMTP sends per user per hour, 120 authenticated requests per user per minute, 60 login attempts per endpoint per minute, 300 total MCP authentication attempts per minute, 256 KB request bodies except authenticated MCP POST and `/api/mail/send` (40 MB to accommodate base64), 25 MB per outgoing file and 25 MB total per message (up to 10 files), 10 MB incoming messages, 5 MB individual downloads. MCP POST/send requests reserve memory capacity before buffering: one per user and two globally; excess requests return HTTP 429. Limits are intentionally conservative for the initial service. No durable mail cache is kept.

Use one application process and one persistent volume. Vault writes are synchronous and atomic; large deployments should migrate to a transactional database before scaling. A lifetime lock prevents two writers. Clean shutdown removes it. After a crash, stop all instances and verify no process is using the vault before manually removing `vault.lock`; restart afterward. Do not remove a live instance's lock.

Stop the service before taking a vault backup. Store backups encrypted and keep the master key in a separate secret store. Losing the key makes the vault unreadable. Do not replace the key on an existing vault; an automated key-rotation migration is not yet implemented.

Browser sessions and login links are held only in memory and are lost on restart. Browser sessions expire after one hour; links after 60 seconds. `web_revoke_sessions` revokes that user's browser sessions and pending links. This does not revoke OAuth tokens at the identity provider. Password changes or account disabling at the IdP do not immediately invalidate an existing local web session; it lasts at most its remaining hour unless explicitly revoked.

Attachment uploads require a proxy body limit of at least 40 MB; the supplied Nginx Proxy Manager and Caddy templates include it. Existing deployments must update their proxy configuration as well as the application. For Nginx with HTTP/2 and unbuffered uploads, keep the supplied 1 MB request buffer and preread window: smaller defaults can throttle uploads over high-latency links and cause client timeouts. To verify the public upload path without sending email, run the identity regression script with `MAILMCP_TEST_MCP_URL` and `MAILMCP_TEST_SEND_ATTACHMENTS=1`. It uploads a synthetic 25 MB file to an unknown account and expects the ownership rejection after transport/schema validation.
