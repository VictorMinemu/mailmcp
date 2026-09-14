# MailMCP

Connect existing email accounts to AI assistants through MCP, and manage the same accounts in a web client.

MailMCP is open-source software for self-hosting or running a hosted service on your own domain. It **does not sell, provision or host email addresses**. Users bring their own IMAP, POP3 and SMTP accounts.

**Status:** initial 0.1 implementation. Automated tests cover the core security boundaries and MCP flows; live mail-provider and identity-provider interoperability still needs deployment-specific validation. This repository is not an announcement of an already-running public service.

[Guía en español](docs/README.es.md) · [Hosting](docs/HOSTING.md) · [Security](SECURITY.md) · [MCP tools](docs/MCP.md) · [Contributing](CONTRIBUTING.md)

## Included

- Connect, list, edit, verify and remove mail accounts. Set a label, configured address, sender name and Reply-To independently of credentials.
- IMAP folders, message listing and reading, seen/starred flags, moving messages and creating folders.
- POP3 over implicit TLS: UIDL listing and message retrieval, without deleting mail.
- SMTP text messages with explicit confirmation. Supports TLS or mandatory STARTTLS.
- **List and download attachments through MCP**, returning an embedded binary resource; download the same attachments in the browser.
- `web_open`: a one-time, 60-second URL opening a browser session for the authenticated MCP user.
- Tools, account/capability resources and a drafting prompt using the official MCP TypeScript SDK.
- Encrypted account storage, isolated user ownership, restricted network destinations and ephemeral browser sessions.
- Local stdio mode and hosted HTTP MCP with OAuth access-token validation and OIDC web login.

## Local quick start

Requires Node.js 22.17 or newer and npm.

```sh
git clone https://github.com/VictorMinemu/mailmcp.git
cd mailmcp
npm ci
npm run setup
npm run build
```

Edit `.env` to allow your provider's exact mail hostnames. Connections to private, loopback or reserved IP addresses are rejected, including when allowlisted. Use an app password if your provider supports one. Mail-provider OAuth account connection is a future feature; a provider that disables password authentication will not work with this release.

Configure a local MCP client with absolute paths (replace `/absolute/path/mailmcp`):

```json
{
  "mcpServers": {
    "mailmcp": {
      "command": "node",
      "args": ["--env-file=/absolute/path/mailmcp/.env", "/absolute/path/mailmcp/dist/index.js"],
      "env": {
        "MAILMCP_DATA_DIR": "/absolute/path/mailmcp/data"
      }
    }
  }
}
```

Ask your assistant to call `web_open`, open the returned URL, and choose **Abrir mi sesión**. Add account credentials in the browser to avoid putting them into chat history. Keep the MCP process running while using the panel. Local mode listens at `http://127.0.0.1:3210`; it is authenticated through the trusted local MCP process and one-time browser links.

Run one process per vault. A second client should use a separate data directory and port, or connect to hosted mode. The web session expires after one hour. Restarting the process revokes all web sessions and unused login links.

## Hosted service with a domain

Hosted mode supports different users with separate accounts. It uses your OAuth/OIDC identity provider for user registration and login; MailMCP itself does not store user login passwords.

```dotenv
MAILMCP_MODE=hosted
MAILMCP_PUBLIC_URL=https://mail.example.com
MAILMCP_OIDC_ISSUER=https://identity.example.com
MAILMCP_OIDC_CLIENT_ID=mailmcp-web
MAILMCP_OAUTH_SCOPE=mailmcp
```

Provide a generated master key and the remaining environment values, configure the provider, and use the included Docker/Caddy deployment. Follow [the complete hosting guide](docs/HOSTING.md), including the distinct browser client and MCP resource configuration. Do not expose the application's internal HTTP port directly to the internet.

## Attachment example

1. `messages_list` returns a message ID and, for IMAP, `uidValidity`.
2. `attachments_list` returns each attachment's zero-based `index`, filename, MIME type and byte size.
3. `attachments_download` returns metadata and an MCP embedded resource with the original attachment bytes in `resource.blob` (base64). Your MCP client can save those bytes as a file.

Downloads are limited to **5 MB per attachment** in messages of at most **10 MB**. The server does not execute files, save them into arbitrary client paths or scan them for malware. Reading a message or attachment does not mark it as seen. See [the tool reference](docs/MCP.md) for exact inputs.

## Languages

The web client supports **English and Spanish**, with browser-language detection, a saved preference and selectors inside forms. MCP descriptions, prompts and application errors support the same languages: set `MAILMCP_LANGUAGE=es` for stdio or send `Accept-Language: es` over HTTP. `web_open` can take `{ "language": "es" }`. Email content and attachments retain their original language and bytes. See [language configuration and contribution instructions](docs/LANGUAGES.md).

## Development

```sh
npm run check
npm run dev
```

`check` runs type checking, automated tests and compilation. Tests use synthetic mail and temporary encrypted vaults; no live accounts or outbound message delivery are needed. CI also builds the container. The development command is a stdio MCP server, so run it from a client or use `web_open` through the client for access.

## Current boundaries

Single process with an encrypted file vault; no horizontal replicas. Incoming mail is fetched on demand, not synchronized or persisted. Sending does not append a copy to IMAP Sent (some SMTP providers do this themselves). No automatic retry of ambiguous SMTP failures. No HTML rendering, attachment uploads, mail-provider OAuth token refresh, sharing or invitations. No public demo is configured yet.

See [the roadmap](docs/ROADMAP.md). MIT licensed.
