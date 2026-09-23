# Connect MailMCP to your assistant / Conectar MailMCP a tu asistente

Hosted endpoint: https://mailmcp.org/mcp
Transport: Streamable HTTP. Authentication: OAuth with PKCE.
OAuth scopes for explicit login: `openid,mailmcp`.
Public installation prompt: https://mailmcp.org/#install
Discovery: https://mailmcp.org/.well-known/oauth-protected-resource/mcp

## English

### Codex on your computer

1. Check the existing configuration with `codex mcp list`. Reuse an existing entry for the same endpoint; do not overwrite unrelated servers. The commands below use the name `mailmcp`; substitute the existing name if different.
2. If missing, add the hosted server:

   ```sh
   codex mcp add mailmcp --url https://mailmcp.org/mcp
   ```

3. If adding starts an OAuth login, finish that login before running anything else. If the server is already registered but needs authentication, run:

   ```sh
   codex mcp login mailmcp --scopes openid,mailmcp
   ```

4. Keep the login command running while the user signs in and grants access at `auth.mailmcp.org`. If the browser does not open, open the exact authorization URL displayed by the client. An assistant must surface that URL to the user while the command is waiting, rather than wait silently until it times out. Do not start another login in parallel or stop the process when a tool returns a still-running session ID.
5. Wait for the client to confirm login completed. Check the MCP status (`/mcp` in the Codex terminal UI), then ask the assistant to call `accounts_list`. An empty list is valid. Configuration appearing in `codex mcp list` alone does not prove authentication or tool access. Restart the client or start a new conversation if it has not loaded the new tools; then check again.
6. Offer `web_open` after the authenticated tool call succeeds. Open the returned one-time link promptly (it expires in 60 seconds) to connect existing mailboxes in the web panel. Use the same MailMCP identity on reconnection to retain those mailboxes.

For the app or IDE, use its MCP server settings: add a Streamable HTTP server with the URL above, save/restart as requested, then select **Authenticate**. CLI and graphical clients must use the same Codex host and configuration for a CLI login to apply. If the assistant cannot execute local commands, it should provide these commands for the user's terminal or guide the user through the client's settings.

### When the sign-in window does not open

- Opening `https://mailmcp.org/` or `/auth/login` independently logs into the website, not the MCP client. The client must initiate its own OAuth flow. `/mcp` is a protocol endpoint, not a browser sign-in page.
- A browser-opening failure does not necessarily mean OAuth failed: use the authorization URL from the still-running login. If that flow has expired, finish/cancel the old attempt before starting one new login. Never fabricate an authorization URL, reuse an old authorization link or manually edit its `state`, PKCE or redirect parameters.
- If the callback is `http://127.0.0.1:PORT/...` or `localhost`, the browser must reach the listener on the machine running login. With SSH, containers or cloud agents, the user's browser and the agent may be on different machines. If Codex is local, run login in the user's local terminal. For a truly remote Codex host, use its documented callback setup (for example, an SSH local forward for the exact callback port) or the client's own supported manual callback flow. Only enter a callback into that client's trusted local input, never into an AI chat. Do not expose a callback listener publicly or disable TLS verification to work around this.
- Check `codex mcp --help` and `codex mcp login --help` for the installed version. If a command or option is missing, use the current supported Codex release. A `401` before authorization is expected; persistent errors after login need diagnosis, not a static token pasted into configuration.
- For `invalid_grant` or an invalid refresh token, authenticate the existing entry again. Do not delete mailbox configurations. The client must persist rotated refresh tokens and avoid parallel refreshes; see the OAuth session guide below.
- If authentication still fails, report the client version, whether it runs locally or remotely, and the error with credentials, authorization codes, cookies and tokens removed. Do not claim installation succeeded until an authenticated tool call works.

### Other assistants

Use the client's own **remote MCP / Streamable HTTP** setup with `https://mailmcp.org/mcp` and its **Connect / Authenticate** action. It must support OAuth discovery, PKCE and dynamic client registration for this service. Do not assume that a stdio-only client or a cloud chat can load a local Codex configuration. Follow the current official instructions for that client. The hosted service does not require cloning this repository, running a local MailMCP server, an API key or a manually supplied OAuth client secret.

Passwords and tokens must not enter chat. Add mailbox credentials through the web panel. Setup verification must not send, move or delete email.

## Español

### Codex en tu ordenador

1. Comprueba la configuración con `codex mcp list`. Reutiliza la entrada que apunte al mismo endpoint sin sobrescribir otros servidores. Si su nombre no es `mailmcp`, utiliza ese nombre en los comandos siguientes.
2. Si falta, añade el servidor:

   ```sh
   codex mcp add mailmcp --url https://mailmcp.org/mcp
   ```

3. Si al añadirlo empieza OAuth, completa ese proceso. Si ya está registrado pero falta autenticarlo, ejecuta:

   ```sh
   codex mcp login mailmcp --scopes openid,mailmcp
   ```

4. Mantén vivo el comando mientras el usuario inicia sesión y autoriza en `auth.mailmcp.org`. Si no se abre el navegador, muestra y abre el enlace exacto que genera el cliente. La IA debe mostrarlo mientras el proceso espera, sin quedarse esperando en silencio hasta que caduque. Si la herramienta devuelve un identificador de proceso en ejecución, consérvalo. No lances otro login simultáneo.
5. Espera a que el cliente confirme la autorización. Comprueba el estado (`/mcp` en la interfaz de terminal de Codex) y llama a `accounts_list`. Una lista vacía es correcta. Que aparezca en `codex mcp list` no demuestra que esté autenticado. Si faltan las herramientas, reinicia el cliente o abre una conversación nueva y vuelve a comprobarlo.
6. Después ofrece `web_open` para añadir los buzones en el panel web. Abre su enlace de un solo uso antes de 60 segundos. Usa siempre la misma identidad de MailMCP para conservar los buzones al reconectar.

En la aplicación o el IDE, abre los ajustes de servidores MCP, añade la URL como **Streamable HTTP**, guarda/reinicia cuando lo indique y pulsa **Autenticar / Authenticate**. La terminal y la aplicación deben utilizar la misma máquina y configuración de Codex. Si la IA no puede ejecutar comandos locales, debe darte estos comandos para tu terminal o guiarte por los ajustes.

### Si no aparece la ventana de autenticación

- Entrar por tu cuenta en `mailmcp.org` o `/auth/login` inicia sesión en la web, pero no autoriza al cliente MCP. El cliente debe iniciar OAuth. `/mcp` no es una página de login.
- Abre el enlace real que muestra el proceso de login, manteniendo ese proceso activo. Si caduca, termina/cancela el intento anterior antes de iniciar uno nuevo. No inventes enlaces, no reutilices uno antiguo y no edites sus parámetros de autorización.
- Un callback a `127.0.0.1` o `localhost` debe llegar al proceso de login. Con SSH, contenedores o agentes en la nube, el navegador puede estar en otra máquina. Si Codex es local, ejecuta el login en tu terminal local. Si Codex es remoto, configura el callback según su documentación (por ejemplo, un túnel SSH local para el puerto exacto) o utiliza el flujo manual que admita el propio cliente. Los callbacks solo se introducen en la entrada de confianza del cliente, nunca en el chat. No publiques el listener ni desactives TLS.
- Comprueba `codex mcp --help` y `codex mcp login --help`. Si tu versión no admite un comando u opción, usa una versión actual compatible. Un `401` antes de autorizar es normal; si persiste después, hay que diagnosticarlo.
- Ante `invalid_grant` o un refresh token inválido, vuelve a autenticar la entrada existente. No borres las cuentas de correo. El cliente debe guardar los refresh tokens renovados y evitar renovaciones simultáneas.
- Si sigue fallando, comunica la versión, si es local/remoto y el error sin contraseñas, tokens, cookies ni códigos. No afirmes que funciona hasta que una herramienta autenticada responda.

### Otros asistentes

Utiliza su configuración de **MCP remoto / Streamable HTTP** con `https://mailmcp.org/mcp` y su acción **Conectar / Autenticar**. Necesita soporte de descubrimiento OAuth, PKCE y registro dinámico de clientes. Un cliente que solo admite stdio o un chat en la nube no tiene por qué leer la configuración local de Codex. Consulta las instrucciones oficiales de ese cliente. El servicio alojado no requiere clonar este repositorio, ejecutar un servidor local, una API key ni un secreto OAuth manual.

Introduce las credenciales de correo en el panel web, nunca en el chat. La comprobación de instalación no debe enviar, mover ni borrar correos.

## References / Referencias

- Official Codex MCP documentation: https://developers.openai.com/codex/mcp
- Official Codex CLI reference: https://developers.openai.com/codex/cli/reference
- MailMCP OAuth sessions and client renewal responsibilities: https://github.com/VictorMinemu/mailmcp/blob/main/docs/OAUTH-SESSIONS.md
- Self-hosting (a separate installation): https://github.com/VictorMinemu/mailmcp/blob/main/docs/HOSTING.md

Instructions checked on 2026-09-23. Client interfaces and command options can change; use the installed client's help and current official documentation when they differ.
