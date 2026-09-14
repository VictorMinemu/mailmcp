import { z } from 'zod';

export const line = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\r\n\x00]+$/);
export const host = z
  .string()
  .min(1)
  .max(253)
  .regex(/^(?=.{1,253}$)[a-zA-Z0-9]+(?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/)
  .transform((v) => v.toLowerCase());
const credentials = {
  host,
  port: z.number().int().min(1).max(65535),
  username: line,
  password: z
    .string()
    .min(1)
    .max(2048)
    .regex(/^[^\r\n\x00]+$/),
  security: z.enum(['tls', 'starttls']),
};
export const incomingSchema = z
  .object({ ...credentials, protocol: z.enum(['imap', 'pop3']) })
  .strict()
  .refine((v) => v.protocol !== 'pop3' || v.security === 'tls', 'POP3 requires implicit TLS');
export const smtpSchema = z.object(credentials).strict();
export const accountSchema = z
  .object({
    label: line,
    email: z.email().max(254),
    senderName: line,
    replyTo: z.email().max(254).optional(),
    incoming: incomingSchema.optional(),
    smtp: smtpSchema.optional(),
  })
  .strict()
  .refine((v) => v.incoming || v.smtp, 'At least one connection is required');
export type AccountInput = z.infer<typeof accountSchema>;
export type Account = AccountInput & {
  id: string;
  owner: string;
  createdAt: string;
  updatedAt: string;
};
export const accountPatch = z
  .object({
    label: line.optional(),
    email: z.email().max(254).optional(),
    senderName: line.optional(),
    replyTo: z.email().max(254).nullable().optional(),
    incoming: incomingSchema.nullable().optional(),
    smtp: smtpSchema.nullable().optional(),
  })
  .strict();
export const idSchema = z.object({ accountId: z.uuid() }).strict();
export const listSchema = idSchema.extend({
  folder: line.default('INBOX'),
  limit: z.number().int().min(1).max(50).default(20),
  before: z.number().int().min(1).optional(),
});
export const readSchema = idSchema.extend({
  folder: line.default('INBOX'),
  messageId: line,
  uidValidity: z.string().regex(/^\d+$/).optional(),
});
export const sendSchema = idSchema.extend({
  to: z.array(z.email().max(254)).min(1).max(20),
  subject: line,
  text: z.string().min(1).max(100_000),
  confirm: z.literal(true),
});
export const flagSchema = idSchema.extend({
  folder: line.default('INBOX'),
  uid: z.number().int().positive(),
  uidValidity: z.string().regex(/^\d+$/),
  flag: z.enum(['seen', 'starred']),
  value: z.boolean(),
});
export const moveSchema = idSchema.extend({
  folder: line.default('INBOX'),
  uid: z.number().int().positive(),
  uidValidity: z.string().regex(/^\d+$/),
  destination: line,
  confirm: z.literal(true),
});

export const attachmentSchema = readSchema.extend({ index: z.number().int().min(0).max(999) });
