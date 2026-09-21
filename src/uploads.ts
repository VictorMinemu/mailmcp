export const MAX_OUTGOING_ATTACHMENT_BYTES = 25_000_000;
export const MAX_OUTGOING_TOTAL_BYTES = 25_000_000;
export const MAX_OUTGOING_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BASE64_LENGTH = Math.ceil(MAX_OUTGOING_ATTACHMENT_BYTES / 3) * 4;
// Base64, JSON metadata and the message body fit without lifting other API limits.
export const MAX_SEND_REQUEST_BYTES = 40_000_000;

export function base64Bytes(value: string) {
  return (value.length / 4) * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0);
}

export function validAttachmentBase64(value: string) {
  if (
    value.length > MAX_ATTACHMENT_BASE64_LENGTH ||
    value.length % 4 !== 0 ||
    base64Bytes(value) > MAX_OUTGOING_ATTACHMENT_BYTES ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  )
    return false;
  // Require canonical padding bits without decoding/allocating file buffers at validation time.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  if (value.endsWith('==')) return (alphabet.indexOf(value.at(-3)!) & 15) === 0;
  if (value.endsWith('=')) return (alphabet.indexOf(value.at(-2)!) & 3) === 0;
  return true;
}
