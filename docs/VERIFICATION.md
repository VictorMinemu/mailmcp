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
