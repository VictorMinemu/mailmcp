# MailMCP

MailMCP conecta cuentas de correo que ya existen a un asistente mediante MCP y a un cliente web. **No ofrece ni crea direcciones de correo propias.**

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

Edita `.env` para permitir los servidores de correo de tus proveedores. Usa contraseñas de aplicación cuando sean necesarias. No se admite aún OAuth para conectar la cuenta del proveedor de correo; OAuth/OIDC sí se utiliza para entrar en el servicio MailMCP alojado.

Configura el cliente MCP con rutas absolutas siguiendo el [README principal](../README.md). Pide al asistente que llame a `web_open`, abre el enlace y añade tus cuentas desde el panel. No compartas el enlace ni pegues contraseñas en chats.

## Adjuntos

Usa `messages_list`, después `attachments_list` y finalmente `attachments_download` con el índice del archivo. El resultado incluye los bytes originales en un recurso binario MCP codificado en base64. El cliente MCP puede guardarlos como archivo. El panel ofrece un botón de descarga.

Límites iniciales: mensajes de hasta 10 MB y adjuntos individuales de hasta 5 MB. Los archivos no se ejecutan, no se guardan en el servidor y no se analizan con antivirus.

## Servicio gratuito con dominio

La base para alojarlo está incluida: Docker, Caddy, autenticación OIDC/OAuth y aislamiento entre usuarios. Sigue [la guía de alojamiento](HOSTING.md). Para activarlo hacen falta el dominio, el alojamiento y la configuración del proveedor de identidad. El repositorio por sí solo no publica un servicio web.

Las invitaciones y cuentas compartidas quedan para versiones posteriores. El cifrado es del lado del servidor: quien administra la clave maestra puede descifrar las credenciales. La versión inicial tiene pruebas automatizadas; falta validar la configuración concreta con proveedores reales antes de abrir un servicio al público.

## Idiomas

La web está disponible en español e inglés, con detección del idioma del navegador y selector que guarda tu preferencia. Puedes cambiarlo dentro de los formularios sin perder lo escrito. El MCP admite `MAILMCP_LANGUAGE=es` en stdio y `Accept-Language: es` en HTTP; `web_open` permite elegir `language`. Los correos y adjuntos mantienen su contenido original. [Más información](LANGUAGES.md).
