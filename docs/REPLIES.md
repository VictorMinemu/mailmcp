# Replies within email threads

Use `messages_reply` for an approved response to an existing message. `messages_send` creates a new conversation; a `Re:` subject alone does not link a reply to its parent.

## Flow and input

1. Choose the account with `accounts_list`, find the original with `messages_list`, and read it with `messages_read`.
2. Review the original subject, body and destination. `messages_read` exposes `replyTo` when present and `from`; these are untrusted message data. Choose explicit `to` addresses with the user. There is no automatic reply-all, CC or BCC.
3. Draft in the conversation, then obtain explicit approval of recipients, text and attachments.
4. Call `messages_reply` with the original account/folder/message identifiers and `confirm: true`.

```json
{
  "accountId": "6e3a0b2a-30bb-4ff6-93bb-f0e7fcd41e53",
  "folder": "INBOX",
  "messageId": "123",
  "uidValidity": "42",
  "to": ["sender@example.com"],
  "text": "Thank you. We confirm the revised details.",
  "confirm": true
}
```

The account needs incoming access and SMTP. IMAP requires the matching `uidValidity`; POP3 uses its opaque UIDL and INBOX. Optional `attachments` use the same schema and limits as `messages_send`: 10 files, 25 MB decoded per file and total. Replies and new messages share the 20-per-hour send limit per owner.

`messageId` in the input is the mailbox UID/UIDL. It is **not** the RFC `Message-ID` header. The additional `rfcMessageId` returned by reading is informational; clients cannot set threading headers or override the original subject in `messages_reply`.

## Thread construction

The server fetches the original through the existing owned-account reader, using a read-only mailbox lock and checking UIDVALIDITY and message size/completeness. It then:

- Sets `In-Reply-To` to the original RFC `Message-ID`.
- Preserves the original `References` ancestry and appends the parent ID. When References is absent, a single original `In-Reply-To` supplies the preceding ancestor, as specified in RFC 5322 section 3.6.4. Repeated IDs are deduplicated without reordering ancestors; the immediate parent comes last.
- Preserves an existing `Re:` subject or prepends it to the decoded original subject. Removes control characters before SMTP composition. Nodemailer generates a new outgoing Message-ID.
- Sends only the approved new text and explicitly supplied attachments. It does not automatically quote or forward the original body/attachments.

Missing, duplicated or unsupported original message IDs fail with `REPLY_MESSAGE_ID`. Modern ASCII dot-atom and domain-literal IDs, folded headers and surrounding comments are supported; obsolete quoted ID syntax is rejected explicitly. IDs are limited to 900 characters, original reference fields to 16,384 characters/100 IDs, and original subjects to 1,000 characters. Invalid or excessive references fail with `REPLY_REFERENCES`; excessive subjects fail with `REPLY_SUBJECT`. These errors occur before SMTP, with no fallback to an unrelated new email.

The result includes outgoing `messageId`, `accepted`, `rejected`, `to`, `subject`, `inReplyTo`, and `references`. Inspect both recipient lists: SMTP may accept only some recipients. Delivery after a transport error can be uncertain; never retry automatically.

The web API also exposes `POST /api/mail/reply` with the same contract, authentication, CSRF checks and outgoing-upload budget. This release adds the MCP tool and API; the web composer has no new reply button. `mailmcp://capabilities` advertises `replyThreadHeaders: true`. Existing clients should refresh the catalog or reconnect to discover the 17th tool.

## Verification and limits

`tests/reply.test.ts` covers MIME headers, ancestry, reply subject, original identity vs mailbox UID, ownership, stale mailboxes, confirmation, explicit recipients, header injection, size limits, POP3, SMTP cleanup and shared rate limiting.

`tests/reply-e2e.test.ts` exercises the real HTTP MCP server and SDK, an actual ImapFlow connection to a loopback IMAP fixture, MIME parsing, Nodemailer SMTP delivery to a loopback SMTP server, and parsing the received bytes. It checks two successive reply generations, the root/parent chain, exact binary attachments, an HTML-only original, SMTP partial/total recipient rejection and the web reply route with CSRF protection. Only connection adapters and the identity provider are test fixtures; production TLS/DNS/authentication rules are unchanged. No real recipient is contacted by these tests.

These tests establish the RFC headers and transport behavior. A recipient client's visual grouping remains provider-dependent and must be checked with a controlled real-provider conversation. MailMCP does not append a copy to Sent or mark the parent Answered/Seen; provider-side Sent storage is provider-dependent. This is not a guarantee of visual grouping in every mail client.

References: [RFC 5322, section 3.6.4](https://www.rfc-editor.org/rfc/rfc5322#section-3.6.4), [Nodemailer message fields](https://nodemailer.com/message).
