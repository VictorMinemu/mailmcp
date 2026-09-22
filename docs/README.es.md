# MailMCP

MailMCP conecta cuentas de correo que ya existen a un asistente mediante MCP y a un cliente web. Está disponible como **servicio alojado gratuito en [mailmcp.org](https://mailmcp.org/)** y como software para autoalojar. **No ofrece ni crea direcciones de correo propias.**

Incluye IMAP, POP3 con TLS y SMTP; configuración de cuentas y nombres de remitente; lectura, envío y **descarga de archivos adjuntos desde el MCP y el panel**. La tool `web_open` devuelve un enlace de un solo uso, válido durante 60 segundos, para abrir la sesión del usuario que la solicita.

Hay dos modos:

- **Local:** MCP por stdio y panel en localhost. El proceso pertenece al usuario del sistema.
- **Alojado:** dominio público con HTTPS, usuarios aislados, acceso MCP con OAuth e inicio de sesión web con OIDC. El proveedor de identidad gestiona el registro de usuarios; no se crean buzones de correo.

## Preparación local

```sh
npm ci
npm run setup
npm run build
```

La instalación configura `MAILMCP_ALLOWED_HOSTS=*` para permitir todos los proveedores de correo públicos, incluidos Zoho EU y servidores de dominios propios. Las redes privadas, localhost y las direcciones reservadas siguen bloqueadas. Si quieres restringir tu instancia, sustituye `*` por una lista de nombres de servidor exactos separados por comas; el valor vacío bloquea todas las conexiones. Usa contraseñas de aplicación cuando sean necesarias. No se admite aún OAuth para conectar la cuenta del proveedor de correo; OAuth/OIDC sí se utiliza para entrar en el servicio MailMCP alojado.

Configura el cliente MCP con rutas absolutas siguiendo el [README principal](../README.md). Pide al asistente que llame a `web_open`, abre el enlace y añade tus cuentas desde el panel. No compartas el enlace ni pegues contraseñas en chats.

## Adjuntos

Usa `messages_list`, después `attachments_list` y finalmente `attachments_download` con el índice del archivo. El resultado incluye los bytes originales en un recurso binario MCP codificado en base64. El cliente MCP puede guardarlos como archivo. El panel ofrece un botón de descarga.

Límites de descarga: mensajes de hasta 10 MB y adjuntos individuales de hasta 5 MB. Los archivos no se ejecutan, no se guardan en el servidor y no se analizan con antivirus.

## Servicio alojado gratuito

Cualquier persona puede usar MailMCP en [https://mailmcp.org/](https://mailmcp.org/) sin coste: sin tarjeta, sin prueba limitada, sin plan de pago. Crea una cuenta en el proveedor de identidad, conecta tus cuentas IMAP, POP3 o SMTP desde el navegador y apunta tu cliente MCP a `https://mailmcp.org/mcp`; el cliente descubre el servidor OAuth mediante los metadatos publicados e inicia sesión con la misma identidad.

El servicio ejecuta el código de este repositorio con las mismas reglas que una instancia autoalojada: el correo se obtiene bajo demanda y nunca se escribe en disco, no hay registro de accesos ni de contenidos, y solo se guarda la configuración de conexión cifrada. Eliminar una conexión borra sus credenciales. El operador posee la clave maestra, así que no es cifrado de extremo a extremo; consulta la [política de seguridad](../SECURITY.md) y autoalójalo si necesitas controlar la clave.

## Alojarlo en tu propio dominio

La base está incluida: Docker, Caddy, autenticación OIDC/OAuth y aislamiento entre usuarios. Sigue [la guía de alojamiento](HOSTING.md) o la de [Portainer, Nginx Proxy Manager y Cloudflare](PORTAINER.md). Hacen falta el dominio, el alojamiento y la configuración del proveedor de identidad.

Las invitaciones y cuentas compartidas quedan para versiones posteriores. El cifrado es del lado del servidor: quien administra la clave maestra puede descifrar las credenciales.

## Idiomas

La web está disponible en español e inglés, con detección del idioma del navegador y selector que guarda tu preferencia. Puedes cambiarlo dentro de los formularios sin perder lo escrito. El MCP admite `MAILMCP_LANGUAGE=es` en stdio y `Accept-Language: es` en HTTP; `web_open` permite elegir `language`. Los correos y adjuntos mantienen su contenido original. [Más información](LANGUAGES.md).

## Enviar archivos adjuntos

`messages_send` admite `attachments`: una lista con `filename`, `contentBase64` y `contentType` opcional. Hasta **25 MB por archivo, 25 MB en total por correo y 10 archivos** (MB decimal). El cliente MCP lee el archivo y lo codifica en base64 estándar; no se aceptan rutas ni URLs. Revisa el correo y los archivos antes de usar `confirm: true`. El proveedor SMTP puede imponer un límite menor sobre el mensaje MIME final. Consulta el ejemplo en [la referencia MCP](MCP.md).

## Conexiones MCP duraderas

La sesión OAuth admite hasta 400 días sin renovar y dos años de duración máxima. Los tokens de acceso duran cinco minutos y el cliente MCP debe renovar y guardar los tokens de forma automática y sin renovaciones simultáneas. Reconectar con el mismo usuario conserva las cuentas. Consulta [la guía de sesiones, renovación y diagnóstico](OAUTH-SESSIONS.md).
