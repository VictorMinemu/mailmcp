# Roadmap

## Initial foundation

Existing account management; IMAP/POP3S/SMTP; authenticated local and hosted MCP; OIDC browser login; isolated accounts; encrypted persistence; token-based web access; MIME attachment listing/download; plain-text web client; tests, CI and deployment templates.

## Public service launch

Select the actual domain, hosting and identity provider. Validate OAuth client onboarding and live provider connections. Add service-specific privacy/retention documentation, monitoring, abuse handling and recovery procedures. Verify backup restoration and run a focused security review before inviting public users. The repository does not imply that a free hosted service is already online.

## Mail compatibility and usability

Mail-provider OAuth grants and refresh, larger streaming attachments, sending attachments, full-text search, drafts/replies, Sent-folder behavior, pagination resilient to mailbox changes, richer folder management and optional hardened HTML viewing. No automatic rendering of downloaded active content.

## Operations and growth

Transactional persistent storage, migrations, envelope key rotation, durable audit events, distributed quotas/session revocation and horizontal scaling. Add narrower OAuth permissions for read-only clients and account-specific grants.

## Collaboration

Invitations, roles and explicitly shared account access, with tests for every authorization boundary. Users continue bringing their own existing email accounts. Mailbox provisioning and selling email addresses are outside the product scope.
