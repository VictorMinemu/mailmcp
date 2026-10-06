import { z } from 'zod';
import { messageRefSchema } from './references.js';
import { idSchema, outgoingAttachmentSchema } from './schemas.js';
export const batchReadSchema = z
  .object({
    messages: z.array(messageRefSchema).min(1).max(10),
    maxTotalChars: z.number().int().min(1).max(100_000).default(20_000),
    maxCharsPerMessage: z.number().int().min(1).max(100_000).default(10_000),
  })
  .strict();
export const threadReadSchema = z
  .object({
    messageRef: messageRefSchema,
    limit: z.number().int().min(1).max(20).default(10),
    beforeUid: z.number().int().positive().optional(),
    maxTotalChars: batchReadSchema.shape.maxTotalChars,
    maxCharsPerMessage: batchReadSchema.shape.maxCharsPerMessage,
  })
  .strict();
export const attachmentUploadSchema = idSchema.extend({ file: outgoingAttachmentSchema });
export const attachmentRemoveSchema = idSchema.extend({ attachmentId: z.uuid() });
export const sendStatusSchema = z.object({ operationId: z.uuid() }).strict();
