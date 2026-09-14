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
| `messages_send`        | Send plain-text mail, with confirmation                                                    |
| `web_open`             | One-use URL granting the MCP user's web session                                            |
| `web_revoke_sessions`  | Revoke that user's web sessions and pending links                                          |

Use `tools/list` for the authoritative JSON input schemas. Credentials are validated, encrypted and never echoed by account tools. Adding them through `accounts_add` can still put them in your MCP host's transcript; prefer entering them through `web_open`.

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

`messages_send` takes `accountId`, `to` (up to 20 addresses), `subject`, `text` (up to 100,000 characters), and `confirm: true`. It does not currently upload attachments. Always inspect accepted and rejected recipients. A network error does not prove that an SMTP server rejected a message: check the provider before retrying to avoid duplicates.

Resources: `mailmcp://accounts` and `mailmcp://capabilities`. Prompt: `draft_reply(context, goal)` drafts for review and never sends. No sampling or model API is invoked by MailMCP itself.
