# MailMCP

Connect existing email accounts to AI assistants through MCP, and manage the same accounts in a web client.

MailMCP is open-source software with a **free hosted service at [mailmcp.org](https://mailmcp.org/)** and full support for self-hosting on your own machine or domain. It **does not sell, provision or host email addresses**. Users bring their own IMAP, POP3 and SMTP accounts.

**Status:** initial 0.1 implementation, running in production at [mailmcp.org](https://mailmcp.org/). Automated tests cover the core security boundaries and MCP flows; interoperability with additional mail providers and MCP clients is validated as they are used.

[Guía en español](docs/README.es.md) · [Hosting](docs/HOSTING.md) · [Security](SECURITY.md) · [MCP tools](docs/MCP.md) · [Contributing](CONTRIBUTING.md)

## Included

- Connect, list, edit, verify and remove mail accounts. Set a label, configured address, sender name and Reply-To independently of credentials.
- IMAP folders, message listing and reading, seen/starred flags, moving messages and creating folders.
- POP3 over implicit TLS: UIDL listing and message retrieval, without deleting mail.
- SMTP text messages with explicit confirmation. Supports TLS or mandatory STARTTLS.
- **Send attachments through MCP**: up to 10 files, 25 MB per file and 25 MB total, using `messages_send`.
- **List and download attachments through MCP**, returning an embedded binary resource; download the same attachments in the browser.
- `web_open`: a one-time, 60-second URL opening a browser session for the authenticated MCP user.
- Tools, account/capability resources and a drafting prompt using the official MCP TypeScript SDK.
- Encrypted account storage, isolated user ownership, restricted network destinations and ephemeral browser sessions.
- Local stdio mode and hosted HTTP MCP with OAuth access-token validation and OIDC web login.

## Free hosted service

Anyone can use MailMCP at [https://mailmcp.org/](https://mailmcp.org/) at no cost: no card, no trial, no paid tier. Create an account with the identity provider, connect your existing IMAP, POP3 or SMTP accounts in the browser, and point any MCP client at `https://mailmcp.org/mcp`; the client discovers the OAuth authorization server through the published protected-resource metadata and signs in with the same identity.

The hosted service runs this repository's code under the same rules as a self-hosted instance: mail is fetched on demand and never written to disk, there is no access or body logging, and only encrypted connection settings are stored. Removing a connection deletes its credentials. The operator holds the master key, so it is not end-to-end encryption; read the [security policy](SECURITY.md) for the exact threat model and self-host if you need to hold the key yourself.

## Local quick start

Requires Node.js 22.17 or newer and npm.

```sh
git clone https://github.com/VictorMinemu/mailmcp.git
cd mailmcp
npm ci
npm run setup
npm run build
```

Setup enables all public mail providers with `MAILMCP_ALLOWED_HOSTS=*`. Operators can instead restrict connections to a comma-separated list of exact hostnames; an empty value blocks all mail hosts. Private, loopback and reserved IP addresses remain blocked in every mode, including mixed public/private DNS answers. Use an app password if your provider supports one. Mail-provider OAuth account connection is a future feature; a provider that disables password authentication will not work with this release.

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

Provide a generated master key and the remaining environment values, configure the provider, and use the included Docker/Caddy deployment or [Portainer with Nginx Proxy Manager and Cloudflare](docs/PORTAINER.md). Follow [the complete hosting guide](docs/HOSTING.md), including the distinct browser client and MCP resource configuration. Do not expose the application's internal HTTP port directly to the internet.

## Attachment example

1. `messages_list` returns a message ID and, for IMAP, `uidValidity`.
2. `attachments_list` returns each attachment's zero-based `index`, filename, MIME type and byte size.
3. `attachments_download` returns metadata and an MCP embedded resource with the original attachment bytes in `resource.blob` (base64). Your MCP client can save those bytes as a file.

Downloads are limited to **5 MB per attachment** in messages of at most **10 MB**. The server does not execute files, save them into arbitrary client paths or scan them for malware. Reading a message or attachment does not mark it as seen. See [the tool reference](docs/MCP.md) for exact inputs.

## Landing page and discoverability

The root page is a public, English-first landing page describing the zero-mail-retention model, the free hosted service and self-hosting; the same document becomes the mail client after login. Sign-up buttons link to `/auth/login` and are shown only in hosted mode, where the identity provider handles registration. It ships with a canonical URL and Open Graph tags bound to `MAILMCP_PUBLIC_URL`, Schema.org JSON-LD (software, source code and FAQ), `/robots.txt`, `/sitemap.xml` and `/llms.txt` for search engines and AI assistants. All landing copy is translated through the same `data-i18n` catalogs as the client, and every animation respects `prefers-reduced-motion`. The content security policy still forbids inline scripts, inline styles and third-party assets, so the page loads no web fonts or analytics.

## Languages

The web client supports **English and Spanish**, with browser-language detection, a saved preference and selectors inside forms. MCP descriptions, prompts and application errors support the same languages: set `MAILMCP_LANGUAGE=es` for stdio or send `Accept-Language: es` over HTTP. `web_open` can take `{ "language": "es" }`. Email content and attachments retain their original language and bytes. See [language configuration and contribution instructions](docs/LANGUAGES.md).

## Development

```sh
npm run check
npm run dev
```

`check` runs type checking, automated tests and compilation. Tests use synthetic mail and temporary encrypted vaults; no live accounts or outbound message delivery are needed. CI also builds the container. The development command is a stdio MCP server, so run it from a client or use `web_open` through the client for access.

## Current boundaries

Single process with an encrypted file vault; no horizontal replicas. Incoming mail is fetched on demand, not synchronized or persisted. Sending does not append a copy to IMAP Sent (some SMTP providers do this themselves). No automatic retry of ambiguous SMTP failures. No HTML rendering, browser attachment picker, mail-provider OAuth token refresh, sharing or invitations. The hosted service at mailmcp.org is a single-instance deployment.

See [the roadmap](docs/ROADMAP.md). MIT licensed.
