# Reliable MCP connections

MailMCP is the OAuth resource server. Keycloak issues access and refresh tokens; the MCP client (for example idem) stores and renews them. MailMCP receives only access tokens and cannot refresh a token held by another application.

## Lifetimes

The hosted policy and realm template allow **400 days of inactivity and a 730-day absolute session lifetime**. Refreshing resets the idle deadline, but not the absolute deadline. Clients inherit these limits unless they have an explicit shorter override. Access tokens still expire after five minutes; refresh-token rotation and replay detection remain enabled. A continuous integration can stay authorized beyond one year, but must reauthorize at the two-year ceiling or after revocation. These durations are policy ceilings, not a guarantee against client data loss, administrative logout or provider failures.

The `mailmcp-web` identity client retains a 30-minute idle / eight-hour maximum client session; MailMCP's own browser cookie lasts one hour. The shared Keycloak SSO session follows the longer realm ceiling, so browser reauthorization may reuse existing SSO. No account owner identifiers or mailbox credentials change.

The previous 30-minute idle / eight-hour absolute limit could invalidate a refresh token overnight even if the mailbox configuration was correct. Existing already-expired tokens cannot be revived. A still-valid token must refresh to receive the new expiry; an already-disconnected client must reconnect once using the **same MailMCP user**. Accounts are keyed by issuer and user subject, so reconnecting (even with a new OAuth client ID) preserves them. A different user has a separate account list.

## Client renewal contract

1. Persist `access_token`, `refresh_token`, `expires_in`, `refresh_expires_in` and receipt time together, encrypted at rest. Do not log them. Calculate deadlines from the response, not hardcoded defaults.
2. Refresh around 60 seconds before access-token expiry, with a little jitter. After sleep/restart, check deadlines before making an MCP call. A mailbox operation does not extend an OAuth session; successful refreshes do.
3. Use one refresh operation at a time **per authorization connection**, across all workers. Waiters reuse that operation's result. Multiple processes need a distributed lock plus an atomic version/CAS update; an in-process promise alone is insufficient.
4. Save the rotated refresh token atomically with the access token before releasing the lock or serving waiters. Never overwrite a newer generation with a stale response. A crash after rotation but before durable storage can still require reconnecting.
5. On a definitive `invalid_grant`, stop retrying and request reconnection. For transient outages, back off and keep the saved connection. If another worker renewed meanwhile, reload the newer stored generation. An ambiguous timeout after submitting a refresh is not permission to replay the old token indefinitely.
6. After reauthorization, retain the connected accounts and verify with `accounts_list`. Never automatically retry a mail send merely because a network/authentication error occurred; delivery may already have happened.

Rotating tokens are intentionally not reusable. Removing rotation or allowing unlimited replay would hide client synchronization bugs while weakening stolen-token protection. A server-side session change cannot repair idem's token persistence or locking; that implementation must follow this contract.

## Health checks and warnings

`node scripts/check-auth-health.mjs` checks the public app, protected-resource metadata, OIDC discovery, signing keys, refresh grant advertisement and the unauthenticated MCP challenge. `.github/workflows/health.yml` runs this every hour and on manual dispatch. Failures appear in GitHub Actions; notification delivery depends on repository/user notification settings. The public probe does not authenticate a real user or prove that their saved refresh token is still valid.

For the operator, add `MAILMCP_KEYCLOAK_URL`, `MAILMCP_KEYCLOAK_CREDENTIALS_FILE` and optionally `MAILMCP_KEYCLOAK_REALM`. This read-only mode also checks session policy, shorter MCP client overrides, refresh errors in the last hour, and parent SSO sessions approaching idle/absolute expiry within seven days. It emits aggregate counts and warning codes, not user identities, credentials or tokens. Exit code 1 signals a warning/failure to an operator's scheduler. Event/session samples are bounded and explicitly flag truncation. Only existing MCP clients are considered; deleted synthetic test clients are excluded. This privileged mode is not installed in the public GitHub workflow and requires operator-managed scheduling.

Only the MCP client knows the expiry of its particular stored refresh token. It should surface an advance reconnect warning and a degraded connection state locally. A healthy public endpoint cannot predict lost tokens, revocation or client-side refresh races.

## Applying to existing installations

Realm import does not update an existing realm on restart. Use the focused migration:

```sh
MAILMCP_KEYCLOAK_URL=https://auth.example.com \
MAILMCP_KEYCLOAK_CREDENTIALS_FILE=/private/operator.json \
node scripts/configure-keycloak-sessions.mjs
```

Inspect the dry-run result, then run with `--apply` and `MAILMCP_KEYCLOAK_BACKUP_FILE=/private/sessions-before.json`. The backup must not already exist and is created with mode 0600. The migration patches only lifetime/rotation/event settings and the browser client's session attributes, without recreating users or clients. It records refresh failures for seven days. Per-client overrides are reported by the health check rather than overwritten silently.

Tests cover fresh imports, idempotent migration, refresh lifetimes exceeding one year, consecutive rotations, rejection of stale tokens, stable identity, and production reconnection retaining a synthetic account. Source: [Keycloak session timeouts and refresh rotation](https://www.keycloak.org/docs/26.7.0/server_admin/#_timeouts).
