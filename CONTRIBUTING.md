# Contributing

MailMCP welcomes bug reports, documentation fixes and focused pull requests. Discuss new protocols, authentication changes and ownership changes in an issue first. Do not publish sensitive mail or credentials.

Use Node.js 22.17 or later. Run `npm ci`, `npm run format:check` and `npm run check`. Use `npm run format` to apply the shared formatting rules. Automated tests need no external accounts. Keep lockfile updates with dependency changes; CI runs Node 22 and 24 and builds the container.

Application services live in `src/accounts.ts` and `src/mail.ts`. Both MCP and HTTP call them. Put validation and ownership checks in these services, not only in transport handlers. Every operation touching an account must take an authenticated owner; never accept ownership from request JSON. Keep provider errors and secrets out of responses and stdout. Stdout belongs to the local MCP transport.

Changes to credentials, sessions, access tokens, attachments or account mutations need meaningful tests for unauthorized access and failure paths. Prefer synthetic MIME fixtures and temporary directories. Clearly distinguish fixture coverage from live provider integration checks. UI strings are Spanish in this first version; contributor documentation is English.

Before submitting, verify `npm run check`, inspect the diff for secrets, and describe the resulting behavior and any limitations. Follow the MIT license, be respectful and give actionable feedback. Invitations, email hosting/provisioning and unrelated SaaS features should not be mixed into focused fixes.
