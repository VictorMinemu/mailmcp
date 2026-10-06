# MCP interface

Tools are available through local stdio and authenticated hosted HTTP. Every operation uses a principal supplied by the transport; no tool accepts a user/owner ID. MCP annotations describe effects; they are not an authorization mechanism. A host must still ask its user before sending or moving mail.

| Tool                        | Purpose                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------- |
| `accounts_list`             | List redacted account profiles                                                                    |
| `accounts_add`              | Connect an existing account                                                                       |
| `accounts_update`           | Edit label, sender name, configured address, Reply-To or complete connection configuration        |
| `accounts_remove`           | Remove saved credentials and connection, with `confirm: true`                                     |
| `accounts_verify`           | Verify configured protocol logins without sending                                                 |
| `folders_list`              | IMAP folders, or POP3 INBOX                                                                       |
| `folders_create`            | Create an IMAP folder                                                                             |
| `messages_list`             | Bounded message page; IMAP returns UIDVALIDITY                                                    |
| `messages_search`           | Provider-side IMAP search by sender, recipient, subject, text, dates, flags, attachments and size |
| `messages_read`             | Plain-text message and attachment metadata                                                        |
| `attachments_list`          | Attachment indices, names, MIME types and sizes                                                   |
| `attachments_download`      | Exact attachment bytes as an embedded binary MCP resource                                         |
| `messages_flag`             | Set/clear seen or starred                                                                         |
| `messages_move`             | Move an IMAP message, with confirmation                                                           |
| `messages_reply`            | Reply to an original message with In-Reply-To/References and explicit confirmation                |
| `messages_send`             | Send plain-text mail, with confirmation                                                           |
| `messages_read_batch`       | Read up to ten explicit message references with a shared body budget                              |
| `messages_thread`           | Discover and read RFC-linked messages within one IMAP folder                                      |
| `messages_send_status`      | Inspect the authenticated user's temporary send receipt                                           |
| `attachments_upload`        | Stage one file in memory and return a temporary attachment ID                                     |
| `attachments_reuse`         | Stage an existing message attachment without returning its bytes                                  |
| `attachments_remove_upload` | Remove a staged attachment and release its capacity                                               |
| `web_open`                  | One-use URL granting the MCP user's web session                                                   |
| `web_revoke_sessions`       | Revoke that user's web sessions and pending links                                                 |

Descriptions, prompts and application errors support English and Spanish. Use `MAILMCP_LANGUAGE` in stdio or `Accept-Language` in HTTP; see [languages](LANGUAGES.md). `web_open` accepts optional `language: "en" | "es"`. Tool identifiers and JSON field names remain unchanged.

Use `tools/list` for the authoritative JSON input schemas. Credentials are validated, encrypted and never echoed by account tools. Adding them through `accounts_add` can still put them in your MCP host's transcript; prefer entering them through `web_open`.

## Discovery and assistant routing

The server publishes an email-specific title/description and `instructions`, plus localized titles, use cases, prerequisites, results, limitations and top-level parameter descriptions for all 24 tools. Existing tool names and input fields remain stable. Both stdio and hosted HTTP use the same definitions.

The instructions ask assistants to use MailMCP by default for the authenticated user's email operations, including requests that do not name MailMCP. They preserve an explicit choice of another service and do not call tools for general email advice. The recommended workflow starts with `accounts_list`, selects a mailbox, searches with `messages_search` when the user describes what to find or lists recent messages otherwise, and reads only the relevant messages or attachments. It distinguishes SMTP sending from drafting and reports the folder and criteria searched instead of implying that every folder was covered.

`mailmcp://capabilities` also advertises outgoing attachment limits, the supported search criteria, and explicitly marks provider draft storage and permanent deletion as unsupported; reply-thread headers are supported through `messages_reply`. Annotation hints describe effects, not permission: setting a read/starred flag is a provider write that overwrites a flag, and setting it to the same value is idempotent; sending is not. Read-only attachment download is explicitly idempotent. Existing user confirmation checks remain enforced in the schemas.

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

## Account capabilities and message references

Account list/add/update results include `capabilities`. `read`, `attachments` and `batchRead` require incoming mail; `search`, `createFolders`, `flag`, `move`, `uidPagination` and `threadRead` require IMAP. `send` requires SMTP, and `reply` requires both incoming mail and SMTP. `listFolders` is available for incoming accounts, with POP3 restricted to INBOX. These describe configured protocol support; `accounts_verify` checks connectivity separately. Global upload/send limits remain in `mailmcp://capabilities`.

Message list/search/read results include a reusable `messageRef`:

```json
{
  "accountId": "ACCOUNT_UUID",
  "folder": "INBOX",
  "messageId": "123",
  "uidValidity": "987654321"
}
```

Pass `{ "messageRef": <returned object> }` to read, list/download/reuse attachments, flag, move or reply. Include the action fields alongside it, such as `flag`, `value`, `index` or `to`. POP3 references omit `uidValidity`. Existing flat inputs remain supported; mixing a reference with any flat identity field is rejected. IMAP mutations require a canonical numeric UID and UIDVALIDITY. References identify resources, not authorization; every operation checks the authenticated owner.

After a move, the result returns the destination `messageRef` when the provider supplies UID mapping. Otherwise `refreshRequired: true` means refresh the destination before another action. The original reference must not be reused after moving.

## Search messages

`messages_search` sends the criteria to the mail provider as an IMAP `SEARCH`, so MailMCP never indexes or stores mail to answer it. It requires an IMAP account and searches one folder per call (default `INBOX`). At least one criterion is required; all criteria are ANDed, text criteria are case-insensitive substrings as implemented by the provider, and `recipient` matches `To` or `Cc`.

```json
{
  "accountId": "UUID",
  "folder": "INBOX",
  "sender": "ana@example.com",
  "subjectContains": "invoice",
  "dateFrom": "2026-09-01",
  "dateTo": "2026-09-30",
  "unread": true,
  "hasAttachments": true,
  "limit": 20
}
```

Other criteria: `query` (headers and body), `recipient`, `bodyContains`, `starred`, `answered`, `minSize` and `maxSize` as exclusive bounds in bytes (IMAP LARGER/SMALLER). Dates are calendar days, inclusive at both ends. `hasAttachments` filters on the provider by the `multipart/mixed` content type and each result carries a `hasAttachments` flag computed from the message structure, without downloading parts. The attachment filter is approximate: multipart/mixed may contain no files, and attachments in other MIME structures can be missed.

The response contains `total` matches within the current cursor range, `folder`, `uidValidity`, and up to 50 messages newest first with the same summary fields as `messages_list`. When more matches remain, `nextBeforeUid` is the cursor: repeat the call with the same criteria and `beforeUid` set to that value. Open a result with `messages_read` using the returned `messageId`, `folder` and `uidValidity`. POP3 accounts return `UNSUPPORTED`.

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

## Structured results and recovery

All 24 tools publish an `outputSchema`. Successful calls return `structuredContent` and retain the existing JSON text content. Object results use the same fields in both forms; array results use named objects in `structuredContent`: `{ "accounts": [...] }`, `{ "folders": [...] }` and `{ "attachments": [...] }`. Attachment downloads expose metadata in `structuredContent` and retain the embedded binary resource in `content`. Dates are ISO strings on the MCP wire. Refresh the client tool catalog after updating the server.

Tool errors retain `isError: true` and a JSON text object with `code`, localized `message`, and `messageKey`. They also include `retryable`, `suggestedAction` (a stable machine-readable action), and `fieldErrors` (an array of `{ "path", "code", "message" }`). Paths identify input fields such as `incoming.password` or `attachments.0.contentBase64`; an empty path denotes an object-level constraint. Input values, unexpected property names, and raw provider errors are not included. The browser API uses the same public error shape.

`BUSY` and `RATE_LIMIT` suggest `retry_later`; `STALE_MAILBOX` suggests `refresh_message_list`, after which the assistant must use the new message identity. `MESSAGE_INCOMPLETE` suggests `read_message_again`. Unclassified send/reply failures set `retryable: false` and suggest `verify_delivery_before_retry`. A failed send may already have reached the provider; automatic resend is unsafe. Recovery hints do not authorize sending or other mutations.

## Reading and sending

`messages_list` accepts `accountId`, optional `folder` (INBOX), `limit` (1–50, default 20) and `beforeUid` plus `uidValidity` copied from the previous result (`nextBeforeUid` is the next cursor). Default listing uses UID SEARCH/FETCH, newest UID first. New arrivals are above the descending cursor and expunges do not shift message identity. A changed UIDVALIDITY fails with `STALE_MAILBOX`. Listing performs a bounded-parser provider UID search rather than storing an index. Legacy `before`/`nextBefore` sequence pagination remains available for existing browser clients; mailbox mutations can shift that legacy cursor. Do not combine both cursors. Message reads/edits/downloads use UIDs and UIDVALIDITY to avoid reusing an ID from a different mailbox generation. POP3 lists the latest UIDLs; folder operations, flags, moving and IMAP-style pagination are unsupported.

`messages_read` accepts the message identity plus optional `maxChars` (1–100,000, default **10,000** through MCP) and `offset` (default 0). The result includes `text`, `offset`, `totalChars`, `nextOffset` and `truncated`. Positions and lengths use JavaScript UTF-16 code units. To continue, repeat the same message identity with `offset` set to `nextOffset`; `null` means there is no later content. `truncated` is true whenever this page omits any portion of the body, including earlier pages. An offset beyond the body length returns `INVALID_INPUT`.

The 10 MB message download limit still applies. Each page fetches and parses the original message on demand; pagination saves assistant context rather than provider bandwidth. Message bodies are not cached or persisted. The shared service/browser API keeps its previous 100,000-character default. Read all pages needed for the task before interpreting or replying to a partially read message. Existing `uidValidity` checks and ownership checks apply on every page.

`messages_send` takes `accountId`, `to` (up to 20 addresses), `subject`, `text` (up to 100,000 characters), and `confirm: true`. It also accepts optional `attachments` (up to 10): each entry is either `{ "attachmentId": "UPLOAD_UUID" }` or an inline file with `filename`, `contentBase64` and optional `contentType` (defaults to `application/octet-stream`). Limits are **25,000,000 decoded bytes per file and total per message**. Use standard padded base64, without a data-URL prefix. Local paths and URLs are not accepted; the MCP client reads the file and provides its bytes. SMTP providers may impose a lower limit on the final MIME message, which grows when encoded. Always inspect accepted and rejected recipients. A network error does not prove that an SMTP server rejected a message: check the provider before retrying to avoid duplicates.

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

## Batch and conversation reads

`messages_read_batch` takes `messages` (1–10 `messageRef` objects), `maxTotalChars` (1–100,000, default 20,000) and `maxCharsPerMessage` (default 10,000). Bodies are read sequentially and never exceed the shared budget. Each result includes the original reference and `status`: `read` with a `message`, `error` with a localized public error, or `budget_exhausted` without downloading that message. `returnedChars` counts body UTF-16 units; `truncated` also marks errors and omitted bodies. Partial message results retain `nextOffset` for later continuation. The budget bounds bodies, not metadata or provider bandwidth.

`messages_thread` takes an anchor `messageRef`, `limit` (1–20, default 10), optional `beforeUid`, and the same body budgets. It derives the root from RFC Message-ID/References, searches only the anchor's IMAP folder, verifies exact identifiers on retrieved messages, and returns a bounded page in ascending UID order. It does not group unrelated messages by subject or scan other folders. The next page uses the same anchor with `beforeUid: nextBeforeUid`; `scope: "folder"` and `truncated` describe coverage. Providers can return substring header candidates, so pages may contain fewer verified messages than the requested limit. Unsupported parent headers fail explicitly. POP3 supports explicit batch reading but not thread discovery.

## Temporary attachment references

Call `attachments_upload` with `{ "accountId": "ACCOUNT_UUID", "file": { "filename": "report.pdf", "contentType": "application/pdf", "contentBase64": "BASE64" } }`. A host/client can perform that upload outside the model's context. The result contains `attachmentId`, filename, MIME type, size and `expiresAt`, without bytes. Call `attachments_reuse` with a message identity and `index` to stage an existing attachment without downloading its bytes into model context. Incoming 10 MB message / 5 MB attachment limits still apply. Reuse is a read-only provider operation; identical source/content reuse returns the same internal cached ID until expiry without extending retention.

Uploads are bound to the authenticated user and exact account, kept only in memory for 15 minutes, and lost on process restart. Limits: 25 MB per file; 20 staged files and 50 MB per owner; 200 files and 100 MB globally. `attachments_remove_upload` takes `accountId` and `attachmentId` to release capacity early. Sending checks existence, ownership and the combined decoded size of inline and referenced files before SMTP; repeating an ID counts its bytes again. A successful send does not consume the upload, allowing deliberate reuse until expiry. Expired/missing references fail instead of silently omitting a file.

The session-authenticated HTTP API exposes `/api/mail/upload`, `/api/mail/reuse-attachment` and `/api/mail/remove-upload`. Upload requests use the existing authenticated 40 MB body limit and shared large-request reservations. Read-batch/thread/send-status APIs are also available under `/api/mail/`.

## Send operation receipts

Send/reply accept optional `operationId`, a client-generated UUID. Use a stable UUID for the same approved content. A receipt is reserved before message preparation; concurrent identical calls share one SMTP submission and completed repeats return the same result. Reusing the UUID with a different account, body, recipients, attachment inputs or operation kind fails with `IDEMPOTENCY_CONFLICT`. Without a caller UUID, each invocation creates a new operation and does not deduplicate a later invocation.

Successful results include `operation`; failures after reservation include `operationId` and `operationState`. Query `messages_send_status` with that ID. States are `preparing`, `submitting`, `accepted`, `partial`, `rejected`, `failed` (failure before submission), or `unknown` (submission started without a reliable outcome). Explicit SMTP negative responses distinguish rejection from disconnects. `accepted` is SMTP acceptance and does not prove final inbox delivery. The server never automatically retries. Unknown outcomes require checking the provider; neither a missing receipt nor a new UUID makes resending safe.

Receipts retain metadata and a payload hash, with no bodies, passwords or attachment bytes in the receipt store. They live in memory for 24 hours, with at most 500 operations per owner / 5,000 globally, and disappear on restart. Deduplication is limited to this process and retention window; this is not durable exactly-once delivery. Deleted accounts make their receipts inaccessible. Inspect the provider before retrying across expiry/restart.

## Actual-agent evaluations

`npm run eval:agents` runs the 50 bilingual golden cases in `evals/cases.json` through the installed, ChatGPT-authenticated Codex CLI and a disposable stdio MCP fixture. Mail and SMTP are synthetic. The agent receives the real server catalog/instructions; shell, web, apps and plugins are disabled and the shell sandbox remains read-only. The fixture server alone uses `default_tools_approval_mode="approve"` ([Codex configuration reference](https://developers.openai.com/codex/config-reference/)); this permits testing explicitly approved synthetic mutations without changing the real server's annotations or the user's configuration. Deterministic checks require executed service calls and inspect result states, argument budgets, body pagination, grounded facts, injection handling and unsafe resubmissions. Blocked attempts do not count as completed actions. No uncalibrated model judge is used.

The tracked `evals/latest-results.json` includes traces, final outputs, client configuration, CLI version, usage, latency and a fingerprint of the evaluated source. `npm run eval:check` replays the same trace/response assertions and gates CI on complete passing evidence matching the current MCP/eval source without requiring CI credentials or live model calls. Rerun the agent suite when the fingerprint changes. One run of these fixtures measures this client configuration; it does not establish statistical reliability across models, clients or live mail providers.
