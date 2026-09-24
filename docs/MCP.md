# MCP interface

Tools are available through local stdio and authenticated hosted HTTP. Every operation uses a principal supplied by the transport; no tool accepts a user/owner ID. MCP annotations describe effects; they are not an authorization mechanism. A host must still ask its user before sending or moving mail.

| Tool                   | Purpose                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| `accounts_list`        | List redacted account profiles                                                             |
| `accounts_add`         | Connect an existing account                                                                |
| `accounts_update`      | Edit label, sender name, configured address, Reply-To or complete connection configuration |
| `accounts_remove`      | Remove saved credentials and connection, with `confirm: true`                              |
| `accounts_verify`      | Verify configured protocol logins without sending                                          |
| `folders_list`         | IMAP folders, or POP3 INBOX                                                                |
| `folders_create`       | Create an IMAP folder                                                                      |
| `messages_list`        | Bounded message page; IMAP returns UIDVALIDITY                                             |
| `messages_read`        | Plain-text message and attachment metadata                                                 |
| `attachments_list`     | Attachment indices, names, MIME types and sizes                                            |
| `attachments_download` | Exact attachment bytes as an embedded binary MCP resource                                  |
| `messages_flag`        | Set/clear seen or starred                                                                  |
| `messages_move`        | Move an IMAP message, with confirmation                                                    |
| `messages_reply`       | Reply to an original message with In-Reply-To/References and explicit confirmation         |
| `messages_send`        | Send plain-text mail, with confirmation                                                    |
| `web_open`             | One-use URL granting the MCP user's web session                                            |
| `web_revoke_sessions`  | Revoke that user's web sessions and pending links                                          |

Descriptions, prompts and application errors support English and Spanish. Use `MAILMCP_LANGUAGE` in stdio or `Accept-Language` in HTTP; see [languages](LANGUAGES.md). `web_open` accepts optional `language: "en" | "es"`. Tool identifiers and JSON field names remain unchanged.

Use `tools/list` for the authoritative JSON input schemas. Credentials are validated, encrypted and never echoed by account tools. Adding them through `accounts_add` can still put them in your MCP host's transcript; prefer entering them through `web_open`.

## Discovery and assistant routing

The server publishes an email-specific title/description and `instructions`, plus localized titles, use cases, prerequisites, results, limitations and top-level parameter descriptions for all 17 tools. Existing tool names and input fields remain stable. Both stdio and hosted HTTP use the same definitions.

The instructions ask assistants to use MailMCP by default for the authenticated user's email operations, including requests that do not name MailMCP. They preserve an explicit choice of another service and do not call tools for general email advice. The recommended workflow starts with `accounts_list`, selects a mailbox, lists folders/messages, and reads only the relevant messages or attachments. It distinguishes SMTP sending from drafting and reports the scope of a bounded search instead of implying that every message was searched.

`mailmcp://capabilities` also advertises outgoing attachment limits and explicitly marks server-side search, provider draft storage and permanent deletion as unsupported; reply-thread headers are supported through `messages_reply`. Annotation hints describe effects, not permission: setting a read/starred flag is a provider write that overwrites a flag, and setting it to the same value is idempotent; sending is not. Read-only attachment download is explicitly idempotent. Existing user confirmation checks remain enforced in the schemas.

Clients decide how to expose descriptions and server instructions to their models; MCP metadata cannot force a model to choose a particular server. After an update, refresh the tool catalog or reconnect/restart the client to load the new guidance. See [the routing evaluation checklist](MCP-ROUTING-EVAL.md) for direct, indirect and negative prompts. Protocol tests check what clients receive; they do not measure a model's routing accuracy.

Implementation references (reviewed 2026-09-23): [official MCP server guide](https://modelcontextprotocol.io/docs/develop/build-server), [tool metadata specification](https://modelcontextprotocol.io/specification/2026-07-28/server/tools), [MCP server instructions guidance](https://blog.modelcontextprotocol.io/posts/2025-11-03-using-server-instructions/), and [OpenAI tool metadata guidance](https://developers.openai.com/plugins/guides/optimize-metadata).

## Connect an account

```json
{
  "label": "Work",
  "email": "me@example.com",
  "senderName": "My Name",
  "incoming": {
    "protocol": "imap",
    "host": "imap.example.com",
    "port": 993,
    "security": "tls",
    "username": "me@example.com",
    "password": "APPLICATION_PASSWORD"
  },
  "smtp": {
    "host": "smtp.example.com",
    "port": 465,
    "security": "tls",
    "username": "me@example.com",
    "password": "APPLICATION_PASSWORD"
  }
}
```

At least one connection is required. Incoming authentication and SMTP authentication are independent. POP3 supports `security: "tls"` only. SMTP/IMAP accept `starttls` but never fall back to plaintext. Common ports are IMAP TLS 993 / STARTTLS 143, POP3 TLS 995 and SMTP TLS 465 / STARTTLS 587.

`accounts_update` takes `{ "accountId": "UUID", "changes": { "senderName": "New Name" } }`. Omitting connection fields preserves credentials; supplying a connection replaces that complete connection. `null` removes a connection or clears Reply-To. Changes affect this client's configuration only; the mail provider decides which sender aliases are authorized.

## Download an attachment

List messages first. For IMAP, copy `uidValidity` from that response and the message's `messageId`. POP3 uses the UIDL identifier and omits UIDVALIDITY.

```json
{
  "accountId": "ACCOUNT_UUID",
  "folder": "INBOX",
  "messageId": "123",
  "uidValidity": "987654321"
}
```

Pass this to `attachments_list`. To call `attachments_download`, add `"index": 0` for the first attachment. The result contains metadata and:

```json
{
  "type": "resource",
  "resource": {
    "uri": "mailmcp://attachment/ACCOUNT_UUID/INBOX/123/987654321/0",
    "mimeType": "application/pdf",
    "blob": "BASE64_ENCODED_ORIGINAL_BYTES"
  }
}
```

The resource is embedded in the tool result; its URI is an identifier, not a public HTTP download URL. Decode `resource.blob` as base64 in the MCP client and save it using the returned filename. No file-system path is accepted by the server. Filenames have directory components and control characters stripped. Downloads are untrusted files; MailMCP does not execute or malware-scan them.

Maximum message size is 10 MB; maximum downloaded attachment size is 5 MB. Oversize files produce an explicit error rather than partial bytes. Attachments are parsed in memory on demand and not saved to disk. The browser API uses the same service with a session cookie; it downloads a Blob using `application/octet-stream` to avoid inline rendering.

## Reading and sending

`messages_list` accepts `accountId`, optional `folder` (INBOX), `limit` (1–50, default 20) and `before` (use returned `nextBefore`). The IMAP cursor is a sequence position; mailbox mutations can shift pagination. Message reads/edits/downloads use UIDs and UIDVALIDITY to avoid reusing an ID from a different mailbox generation. POP3 lists the latest UIDLs; folder operations, flags, moving and IMAP-style pagination are unsupported.

`messages_send` takes `accountId`, `to` (up to 20 addresses), `subject`, `text` (up to 100,000 characters), and `confirm: true`. It also accepts optional `attachments` (up to 10), each with `filename`, `contentBase64` and optional `contentType` (defaults to `application/octet-stream`). Limits are **25,000,000 decoded bytes per file and total per message**. Use standard padded base64, without a data-URL prefix. Local paths and URLs are not accepted; the MCP client reads the file and provides its bytes. SMTP providers may impose a lower limit on the final MIME message, which grows when encoded. Always inspect accepted and rejected recipients. A network error does not prove that an SMTP server rejected a message: check the provider before retrying to avoid duplicates.

Example `messages_send` arguments:

```json
{
  "accountId": "ACCOUNT_UUID",
  "to": ["recipient@example.com"],
  "subject": "Document",
  "text": "Please find the file attached.",
  "attachments": [
    { "filename": "hola.txt", "contentType": "text/plain", "contentBase64": "SG9sYQ==" }
  ],
  "confirm": true
}
```

Review recipients, message and attachments before confirming. The server does not persist uploaded files. The authenticated `/api/mail/send` endpoint accepts the same schema; the browser compose form does not yet include a file picker.

Resources: `mailmcp://accounts` and `mailmcp://capabilities`. Prompt: `draft_reply(context, goal)` drafts for review and never sends. No sampling or model API is invoked by MailMCP itself.

## Reply within an existing thread

Use `messages_reply`, not `messages_send`, for an approved response to an original message. It accepts `accountId`, `folder`, the original mailbox `messageId`, IMAP `uidValidity`, explicit `to`, `text`, optional `attachments` and `confirm: true`. The server derives the subject, `In-Reply-To` and `References` from the original. `messages_read` exposes `rfcMessageId` and `replyTo` for inspection; the input `messageId` remains the mailbox UID/UIDL. Missing or unsupported parent headers fail before SMTP. See [reply behavior and end-to-end tests](REPLIES.md).
