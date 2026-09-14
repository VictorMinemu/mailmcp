# MailMCP initial design

MailMCP is open-source software for connecting existing email accounts through MCP and a web client. It supports both local self-hosting and a hosted service on a public HTTPS domain. Users bring their own accounts: creating or selling email addresses and provisioning provider mailboxes are outside scope. Invitations and shared accounts are future work. The public repository uses MIT; contributor documentation is English and the first UI is Spanish.

## Architecture and identity

TypeScript on Node.js >=22.17.0 with the official MCP SDK. A shared account/mail service serves stdio MCP in local mode and OAuth-authenticated HTTP MCP in hosted mode. Tools, resources and a drafting prompt use the same factory, bound to an authenticated owner. No endpoint accepts an owner from request input.

Local mode binds the web server to 127.0.0.1 and trusts the OS user's configured MCP process. Hosted mode accepts an explicit HTTPS public origin and binds to a private backend interface behind a TLS proxy. It disables the local stdio ownership shortcut. OIDC authorization code login with PKCE, state binding and nonce verification establishes browser identity. The identity provider handles user registration, recovery and MFA. MCP bearer JWTs are verified against the configured issuer, signature, expiry, subject, audience and scope. Owner IDs derive from issuer and subject, never email address. Browser and MCP clients need consistent subjects at the identity provider.

## Persistence and protocols

The entire account vault is encrypted using AES-256-GCM with a separate random 32-byte key. Atomic writes, restricted permissions and a lifetime writer lock protect a single-process deployment. No mail bodies or attachments are persisted. Session state is in memory and expires on restart.

IMAP uses ImapFlow; SMTP uses Nodemailer; POP3 uses a bounded TLS-only adapter. Mail destinations must be operator-allowlisted and resolve only to public addresses. The checked IP is used for the connection; the original hostname remains the TLS server name. Certificates are always verified and STARTTLS fails closed. Mail concurrency, time, request sizes and sends are limited.

Users can connect, list, edit, remove and verify accounts, including labels, sender display names, configured addresses and Reply-To. Connection updates replace credentials explicitly. Configured address changes do not rename a provider mailbox or authorize aliases. IMAP supports folders, message listing/reading, seen/starred flags, moving and creating folders. UIDVALIDITY protects reads and mutations from stale mailbox generations. POP3 supports UIDL listing and reads without deletion. SMTP sends plain text after an explicit confirmation marker, without automatic retries.

## Attachment downloads

Attachment download is part of the initial release. `attachments_list` exposes indices, names, content types and sizes. `attachments_download` returns exact bytes in an embedded binary MCP resource encoded as base64, plus metadata. Every call rechecks account ownership and message identity. The client chooses where to save the file; the server accepts no arbitrary output paths. The web client downloads the same bytes through the session-protected API. Filename paths and control characters are stripped. Files are not executed or scanned. Initial limits: 10 MB message size and 5 MB per downloaded attachment.

## Browser sessions and UI

`web_open` issues a random 256-bit one-use token for the authenticated owner's session, valid for 60 seconds. The token hash is held in memory. The URL carries it in the fragment; the page removes it, then redeems it by explicit same-origin JSON POST. Hosted sessions use Secure, HttpOnly, SameSite=Strict cookies with one-hour expiry and revocation. OIDC correlation cookies are SameSite=Lax for the provider callback. Host and Origin validation, no-store responses and a restrictive CSP apply.

The UI has account navigation, a message list and reader, connection forms, a compose form and attachment download actions. Text rendering prevents email HTML execution and remote tracking images. The design uses paper white (#ffffff), blue-grey canvas (#f1f5f8), navy actions (#174f76), slate text (#223c50), muted text (#596d7b) and separators (#cedbe4). Avenir/Segoe UI handles app controls; Georgia distinguishes the quiet entry/empty states. Readability and mail tasks determine the layout.

## Verification and delivery

Tests cover encrypted persistence, wrong keys/tampering, exclusive locking, ownership and redaction, schema validation, private-network rejection, token replay/expiry/revocation, OAuth JWT checks, OIDC state/nonce/PKCE, POP3 framing, MIME bytes and real MCP clients over stdio and hosted HTTP. Protocol and identity fixtures use synthetic data; live provider validation remains deployment-specific. Browser smoke checks exercise login, account editing and attachment download. CI checks Node 22/24 and the container build. Publish source without credentials or data, with security reporting, contributor docs, deployment templates and a roadmap.

## Next work

Actual public service domain/identity deployment and provider validation; mail-provider OAuth; larger streaming files and sending attachments; search, drafts and Sent-folder behavior; transactional storage and key rotation; invitations, roles and account sharing. These are not advertised as already implemented.
