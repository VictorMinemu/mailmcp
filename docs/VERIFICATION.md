# Initial verification

Verified locally on 2026-09-14. This is a record of observed checks, not a claim of production certification.

| Check                                                  | Result                                                                                        |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Clean `npm ci`                                         | Passed                                                                                        |
| TypeScript type check and build                        | Passed                                                                                        |
| Automated Node tests                                   | 16 passed                                                                                     |
| Production dependency audit                            | No known vulnerabilities reported at verification time                                        |
| Docker image build                                     | Passed                                                                                        |
| Hosted container with read-only root and non-root user | Started; health endpoint returned 200 and unauthenticated account request returned 401        |
| Real SDK stdio client                                  | Handshake, tools, resources, prompt, account creation and web link redemption passed          |
| Real SDK HTTP clients with synthetic identities        | Separate users could not access each other's accounts                                         |
| JWT/OIDC fixtures                                      | Signature, issuer, audience, expiry, scope, browser-bound state, PKCE and nonce checks passed |
| Attachment MCP download                                | Original binary fixture bytes matched embedded resource                                       |
| Browser attachment download                            | Saved `ejemplo.txt`; bytes matched the original synthetic attachment                          |
| Browser layout                                         | Inspected desktop and 390px mobile layouts                                                    |
| Account editing in browser                             | Sender-name update preserved credentials when connection fields were unchanged                |
| Secret-pattern / ignored-file review                   | No key/token values in source; `.env`, vaults and browser artifacts excluded                  |

The browser fixture used fake accounts and synthetic MIME messages. No real email was sent. Attachment parsing used a controlled IMAP adapter; POP3 framing used a stream fixture. The OIDC tests use signed synthetic JWTs and a controlled key set. Live IMAP, POP3, SMTP, provider OAuth client onboarding, DNS/TLS proxy configuration and multi-user sign-in with a selected real identity provider still need deployment-specific validation.

The browser review also found and fixed handling of a new fragment login token in an already-open tab. A fresh document clears the previous identity’s UI and pending requests. Tokens are removed from the visible URL and explicitly redeemed; expired links are rejected.

GitHub CI on the initial published commit passed on Node.js 22 and 24, including the container build: [initial CI run](https://github.com/VictorMinemu/mailmcp/actions/runs/34876484302).

## Multilingual update — 2026-09-14

English and Spanish passed type checking, all 20 automated tests, and a Docker image build. Added checks cover catalog completeness and placeholders, regional language negotiation, translated MCP descriptions/errors/prompts and web links, HTTP error language, and separate hosted clients using different languages.

Browser checks with synthetic mail confirmed automatic language selection, switching without losing a populated draft, translated validation feedback and dates, and persistence after reload. Switching the message reader translated attachment actions while preserving the original message and filename. Downloaded `ejemplo.txt` still contained the original `Hola desde MailMCP` bytes. The compose dialog and its language selector were inspected at 390px width. No real email was sent.

## Deployment security review — 2026-09-14

All 23 tests, TypeScript checks and the build passed after adding protocol resource limits. Regression tests exercise oversized IMAP literals and unterminated lines, a trickling SMTP peer and POP3 disconnection during the TLS handshake. SMTP now owns its underlying socket so a hard deadline closes active connections; POP3 handshake cancellation rejects promptly. Static asset lookup rejects inherited object properties.

The complete npm audit reported zero known dependency vulnerabilities. Trivy 0.74.0 found 69 high/critical findings in the previous Debian slim runtime, including the bundled npm tooling. The replacement distroless Node.js runtime reported zero high/critical findings in the local image scan. This result is limited to the scanned image and vulnerability database at that time; it is not a guarantee that no vulnerabilities exist. CI now scans each built runtime image and fails for high/critical findings.

The hardened container started with a read-only root, all capabilities dropped, no-new-privileges and a fresh persistent volume. UID 65532 could write the data directory. HTTP checks returned 200 for health and the Spanish catalog, 401 for unauthenticated accounts and MCP, and 404 for an inherited-property path. Graceful shutdown returned exit code zero. Synthetic identity configuration was used only for this local smoke test; it does not establish real-provider sign-in.

The Portainer deployment joins an existing proxy network without publishing an application port. Its health check, memory/process limits, bounded logs and data-volume ownership are documented in [the deployment guide](PORTAINER.md). Real identity-provider login, MCP client onboarding and mail-provider interoperability remain launch checks.
