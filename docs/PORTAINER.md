# Portainer, Nginx Proxy Manager and Cloudflare

Use `deploy/portainer.yaml` for an existing Nginx Proxy Manager installation. It replaces the Caddy deployment; do not deploy both proxies on ports 80/443. The application has no published host port, no Docker socket, and no privileged capabilities. The data volume persists across redeployments.

The runtime uses a distroless Node.js image without a shell or package manager, running as UID/GID 65532. A fresh named volume receives the correct ownership from the image. When migrating an existing volume from an older image, back up the encrypted vault and master key first, stop the old process, and change that volume's ownership to 65532:65532 before starting the new image. Do not make the volume world-writable. Container health checks use `/nodejs/bin/node`.

In Portainer, create an administrator-owned stack named `mailmcp`, using this repository and compose path `deploy/portainer.yaml`. Disable automatic Git redeployment until release changes have been reviewed. Configure the variables in Portainer rather than a committed `stack.env`:

- `MAILMCP_MASTER_KEY`: a newly generated persistent 32-byte hex key. Back it up separately from the encrypted data. Never replace the key of an existing vault.
- `MAILMCP_PUBLIC_URL`: `https://mailmcp.org`.
- `MAILMCP_PROXY_NETWORK`: the existing Docker network used by Nginx Proxy Manager; this deployment defaults to `nginx-proxy-manager_default`.
- `MAILMCP_OIDC_ISSUER` and `MAILMCP_OIDC_CLIENT_ID`: required. Configure the provider, redirect URI and MCP audience following [Hosting](HOSTING.md). Do not substitute a fake issuer or switch to local mode to get a deployment running.
- `MAILMCP_OIDC_CLIENT_SECRET`: only if the provider uses a confidential browser client.
- `MAILMCP_ALLOWED_HOSTS`: exact mail-provider hostnames approved by the operator. An empty value blocks all new outbound mail connections.

Before deploying, confirm the named proxy network exists and the repository revision has passed CI. One MailMCP process must own the data volume. See the vault lock/recovery limitations in [Hosting](HOSTING.md).

Create a Cloudflare proxied A record for the domain pointing to the server. In Nginx Proxy Manager create the domain host pointing to `http://mailmcp:3210`, disable asset caching, and paste [the host configuration](../deploy/nginx-proxy-manager.conf). Forward the original Host header. Obtain a domain certificate and enable Force SSL. Set Cloudflare SSL/TLS mode to **Full (strict)** so the origin certificate is verified; Flexible mode is unsuitable. Keep cache rules from caching `/api/`, `/mcp`, `/auth/` or HTML containing authentication state. Configure edge rate limits for login and API traffic without challenging legitimate MCP clients with browser-only CAPTCHA flows.

Verify HTTPS, `/healthz`, the unauthenticated 401 from `/api/accounts` and `/mcp`, and OAuth metadata before creating mail connections. Then perform the two-user and real-client launch checks in [Hosting](HOSTING.md). A healthy container alone does not demonstrate working user authentication.

The Portainer and proxy administration consoles themselves should be restricted to an operator network and use HTTPS. Changes to existing shared administration services must be planned separately to avoid disrupting unrelated applications.
