# Roadmap

## Initial foundation

Existing account management; IMAP/POP3S/SMTP; authenticated local and hosted MCP; OIDC browser login; isolated accounts; encrypted persistence; token-based web access; MIME attachment listing/download and sending via MCP; plain-text web client; tests, CI and deployment templates.

## Public service

The free hosted service runs at [https://mailmcp.org/](https://mailmcp.org/) on the Portainer, Nginx Proxy Manager, Cloudflare and Keycloak deployment described in the docs, with the public landing page, `robots.txt`, `sitemap.xml` and `llms.txt` served from the same process. Ongoing operational work: service-specific privacy and retention documentation, monitoring, abuse handling, recovery procedures, periodic backup-restoration drills and focused security reviews as usage grows.

## Mail compatibility and usability

Mail-provider OAuth grants and refresh, larger streaming attachments, browser attachment picker, full-text search, drafts/replies, Sent-folder behavior, pagination resilient to mailbox changes, richer folder management and optional hardened HTML viewing. No automatic rendering of downloaded active content.

## Operations and growth

Transactional persistent storage, migrations, envelope key rotation, durable audit events, distributed quotas/session revocation and horizontal scaling. Add narrower OAuth permissions for read-only clients and account-specific grants.

## Collaboration

Invitations, roles and explicitly shared account access, with tests for every authorization boundary. Users continue bringing their own existing email accounts. Mailbox provisioning and selling email addresses are outside the product scope.
