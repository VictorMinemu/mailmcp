# Security policy

Report suspected vulnerabilities privately through [GitHub security advisories](https://github.com/VictorMinemu/mailmcp/security/advisories/new). Never put passwords, access tokens, real email bodies or private attachments into public issues. Supported code is the current main branch until versioned releases are established.

## Security model

Local stdio trusts the OS user and the configured MCP host. Hosted HTTP verifies the configured issuer, JWT signature (RS256/ES256), expiry, subject, resource audience and required scope before constructing a user-scoped MCP server. Browser login uses OIDC code flow with PKCE, browser-bound state and ID-token nonce validation. Account access always checks both account ID and authenticated ownership.

The complete account vault, including credentials and account profiles, is encrypted with AES-256-GCM using an external 256-bit master key and a fresh nonce per write. Disk permissions are restricted; updates use atomic replacement and a lifetime writer lock. The operator can decrypt credentials using the key. Compromising the server process or key compromises the vault. This is not end-to-end encryption.

Web login links are single-use random tokens valid for 60 seconds, stored only as hashes and sent in URL fragments. The fragment is removed before redemption. Sessions are opaque random tokens, stored hashed, valid for an hour and revocable. Hosted cookies are Secure, HttpOnly, SameSite=Strict with `__Host-` names. OIDC correlation uses a short-lived SameSite=Lax cookie for the external redirect. Host and Origin validation, JSON-only mutation endpoints and a restrictive CSP protect the web boundary.

Mail connections require verified TLS 1.2 or later. STARTTLS must succeed before credentials are sent. Operators can allow every public mail provider with `MAILMCP_ALLOWED_HOSTS=*`, or restrict connections to exact hostnames. Empty configuration denies all mail hosts. In either mode, DNS is resolved and every returned address must be public before connecting to a pinned IP with the original hostname for certificate verification. Private, loopback, metadata/link-local, reserved and multicast destinations, including mixed DNS answers and IPv4-mapped private IPv6 addresses, are rejected. DNS is checked again for each connection. Arbitrary URL or local file loading through SMTP is disabled. Only authenticated users can send, using their own SMTP credentials.

Email text, headers, filenames and attachments are untrusted. The web client uses text rendering, no remote images or HTML execution. Attachment bytes are served for download, with sanitized filenames and size limits, never evaluated. The MCP host must treat returned mail as data and ask the user before external actions. Tool `confirm` fields and annotations are intent markers, not proof of human consent.

## Operational boundaries

- TLS terminates at the hosting proxy; keep its backend hop private. Forwarded headers are not used to derive identity, public origins or rate-limit keys.
- No access/body logging is enabled. Infrastructure and MCP clients may still record credentials or returned mail. Configure their logging deliberately. Enter mail secrets through the browser when possible.
- OIDC discovery URLs are trusted operator configuration. Do not allow users to configure identity issuers or JWKS endpoints.
- JWT revocation is effective at token expiry; browser sessions persist up to an hour independently of provider logout. `web_revoke_sessions` invalidates only this app's sessions and links. Prefer short access-token lifetimes.
- Use one process per vault. The encrypted file store and in-memory session store are an initial architecture, not a horizontally scalable service.
- Vault backups remain sensitive. Back up the key separately. Key rotation, long-term audit logs, malware scanning and full multi-role permissions are not yet implemented.
- Size, rate and concurrency limits reduce abuse but do not guarantee availability under attack. Configure edge limits, registration controls and SMTP abuse handling before public registration.
- No live provider compatibility or independent security audit is claimed by the automated fixtures. Validate the intended deployment and account recovery process before onboarding public users.

Outgoing attachments are validated as canonical base64 before decoding, with a 25 MB decoded per-file and total limit and at most ten files. Only validated filenames, MIME types and in-memory bytes reach the MIME composer; file paths, URLs and custom attachment headers are rejected. Uploads require authentication and account ownership, are not persisted, and remain subject to send confirmation and rate limits. Hosted bodies larger than 256 KB or with unknown length reserve capacity for one MCP POST/send per user and two globally, with a 40 MB wire limit. Small MCP requests remain available during uploads. Other API bodies retain the 256 KB limit.
