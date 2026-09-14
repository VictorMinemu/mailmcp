# Self-hosted identity with Keycloak

The optional `deploy/keycloak.yaml` Portainer stack provides Keycloak 26.7.3 and a private PostgreSQL database. Deploy it as `mailmcp-identity` using the public repository. No service publishes a host port. Set a strong database password and temporary bootstrap administrator password in Portainer; keep them out of Git. Configure the existing proxy network and its trusted CIDR for your installation.

Create `auth.YOUR_DOMAIN` in DNS and an HTTPS proxy to `mailmcp-keycloak:8080`, preserving the original Host and setting X-Forwarded-Proto/Host/Port correctly. Disable proxy asset caching and access logs for authorization URLs. Keep Cloudflare in Full (strict). The management/metrics port 9000 and PostgreSQL must remain private.

Set `MAILMCP_IDENTITY_URL=https://auth.YOUR_DOMAIN` and `MAILMCP_PUBLIC_URL=https://YOUR_DOMAIN` before the initial import. In the application stack, set `MAILMCP_OIDC_ISSUER=https://auth.YOUR_DOMAIN/realms/mailmcp`, `MAILMCP_OIDC_CLIENT_ID=mailmcp-web` and `MAILMCP_OAUTH_SCOPE=mailmcp`. Generate and back up a persistent application master key separately from encrypted data.

## Registration and administration

The realm enables English and Spanish, username/password registration, a 14-character password minimum, and throttling after failed login attempts. Password grants are disabled for application clients. Users identify themselves by username; an unverified email address does not grant access to any mail account. Mail credentials must be connected separately.

Email verification and password recovery are initially disabled because no outbound notification SMTP is configured. Configure a service-owned SMTP account in Keycloak before enabling those features. Never use end users' connected mail accounts to send service notifications.

Use the temporary bootstrap administrator only to create a permanent operator in the **master** realm, assign its `admin` realm role and verify access. Delete the bootstrap account afterward and remove its password from Portainer. Enable MFA for operators and restrict administrative access to trusted operators. User self-registration occurs in the separate `mailmcp` realm and grants no administrative rights.

## MCP clients

The public `mailmcp-mcp` client uses authorization code flow, PKCE S256 and user consent. Its initial callback is exactly `http://127.0.0.1:8765/callback`, suitable for a local client configured on that port. Access tokens last five minutes. Request scope `mailmcp`; its audience mapper issues `aud=https://YOUR_DOMAIN/mcp`, which the server validates. Browser ID tokens have a different audience and cannot authorize MCP requests.

For another MCP client, pre-register a separate public/confidential client with its exact documented redirect URI, PKCE S256 and the optional `mailmcp` scope. Configure that client ID in the MCP client. Do not allow arbitrary redirect URLs or unauthenticated client registration from every host. Dynamic registration and experimental client-metadata fetching are not enabled by this deployment.

Keycloak does not yet process RFC 8707 resource indicators. The scope-to-audience mapping follows [Keycloak's documented MCP integration](https://www.keycloak.org/securing-apps/mcp-authz-server); full interoperability must be checked with each MCP client. The endpoint is `https://YOUR_DOMAIN/mcp`.

## Persistence and updates

PostgreSQL stores users, clients and signing keys in `identity_data`. Back it up and test recovery. The realm JSON is imported only when the realm is absent; changing the JSON does not overwrite an existing realm on restart. Apply reviewed changes to existing realms through the administration console. Never remove the database volume to apply a configuration update.

The containers run without privileges and use read-only roots with narrowly scoped writable temporary directories. The PostgreSQL image installs available Alpine security updates and removes the unused root privilege-switch helper. Rebuild and scan images regularly; image scans do not guarantee that unknown vulnerabilities are absent.
