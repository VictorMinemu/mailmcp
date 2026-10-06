import { z } from 'zod';
import { line } from './schemas.js';

export const messageRefSchema = z
  .object({
    accountId: z.uuid(),
    folder: line,
    messageId: line,
    uidValidity: z.string().regex(/^\d+$/).optional(),
  })
  .strict();
export type MessageRef = z.output<typeof messageRefSchema>;
const identityFields = ['accountId', 'folder', 'messageId', 'uidValidity', 'uid'];

export function resolveMessageReference(input: unknown, mutation = false): unknown {
  if (!input || typeof input !== 'object' || !('messageRef' in input)) return input;
  const { messageRef, ...other } = input as Record<string, unknown>;
  const ref = messageRefSchema.parse(messageRef);
  if (identityFields.some((key) => other[key] !== undefined))
    throw new z.ZodError([
      {
        code: 'custom',
        path: ['messageRef'],
        message: 'Use either messageRef or legacy identity fields.',
      },
    ]);
  if (!mutation) return { ...other, ...ref };
  const { messageId, ...identity } = ref;
  if (!/^[1-9]\d*$/.test(messageId))
    throw new z.ZodError([
      {
        code: 'custom',
        path: ['messageRef', 'messageId'],
        message: 'IMAP mutations require a numeric UID.',
      },
    ]);
  return { ...other, ...identity, uid: Number(messageId) };
}

// Publish both forms, then validate the resolved identity against the original
// schema. This keeps required UIDVALIDITY and all existing object refinements.
export function withMessageRef(schema: z.ZodObject, mutation = false) {
  const changes: Record<string, z.ZodType> = { messageRef: messageRefSchema.optional() };
  for (const key of identityFields) {
    if (key in schema.shape)
      changes[key] = key === 'folder' ? line.optional() : schema.shape[key]!.optional();
  }
  return schema.safeExtend(changes).superRefine((value, ctx) => {
    try {
      const result = schema.safeParse(resolveMessageReference(value, mutation));
      if (!result.success) for (const issue of result.error.issues) ctx.addIssue({ ...issue });
    } catch (error) {
      if (error instanceof z.ZodError) for (const issue of error.issues) ctx.addIssue({ ...issue });
      else throw error;
    }
  });
}
