# Message body extraction

`messages_list` reads IMAP envelope metadata. Finding a message does not establish that its body has been read successfully. `messages_read` downloads the RFC 822 source and parses MIME before returning plain text. Neither operation marks the message as read.

## Empty-body failure confirmed on 2026-09-24

A read-only production diagnosis reproduced a successful `messages_read` response with `text: ""` and `truncated: false`. The source was complete: both the IMAP size and received buffer were 61,809 bytes. Its structure was:

```text
multipart/alternative
└── multipart/related (type=text/html)
    ├── text/html (UTF-8, base64)
    ├── image/png
    ├── image/png
    └── image/png
```

MailParser preserved 26,516 HTML characters but did not generate `text`, despite `skipHtmlToText: false`. Converting that decoded HTML produced 12,004 readable characters, including the actual reply. A blank `text/plain` alternative also reproduces the failure. The application previously returned `parsed.text ?? ''` without checking the available HTML.

The regression fixture reproduces the MIME topology with synthetic text and images; no real message content or credentials are stored in the repository.

## Read contract

- Preserve nonblank plain text and its formatting.
- When plain text is absent or whitespace-only, convert the decoded HTML body to plain text. Do not execute HTML or treat attachment contents as the body.
- Apply the 100,000-character response limit and `truncated` flag to the selected text.
- Return `MESSAGE_BODY_UNAVAILABLE` when neither representation yields readable text, including empty messages, attachment-only messages and unsupported/encrypted content. This means extraction was unavailable, not proof that the sender wrote nothing. Attachments remain accessible through `attachments_list` and `attachments_download`.
- Return `MESSAGE_INCOMPLETE` when IMAP returns fewer source bytes than its advertised message size. Do not expose that partial source as a complete read.
- Clients must report unavailable context and must not draft as if an unsuccessful read succeeded. A truncated result supplies partial context only.

The same body selection applies to IMAP and POP3, and is shared by MCP and the web API. The message and attachment size limits, mailbox identity validation and account ownership checks remain in force.

Validation: `npm run check`; focused regressions: `node --import tsx --test tests/message-body.test.ts`.

References: [MailParser API](https://nodemailer.com/extras/mailparser), [HTML-to-text converter](https://github.com/html-to-text/node-html-to-text/tree/master/packages/html-to-text).
