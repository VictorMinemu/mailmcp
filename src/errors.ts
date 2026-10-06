import { ZodError } from 'zod';
import { translate, type Locale } from './i18n.js';

export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export class SendOperationError extends AppError {
  constructor(
    public operationId: string,
    cause: unknown,
    public operationState: string,
  ) {
    super(
      cause instanceof AppError ? cause.code : 'OPERATION_FAILED',
      cause instanceof AppError
        ? cause.message
        : 'Operation failed. Check configuration, connectivity and credentials. A failed send may still have been accepted; check before retrying.',
      cause instanceof AppError ? cause.status : 502,
    );
  }
}

const validationMessages: Record<string, string> = {
  invalid_type: 'Use the required field type.',
  invalid_format: 'Use the required field format.',
  invalid_value: 'Use one of the allowed values.',
  too_small: 'Value is below the minimum length or size.',
  too_big: 'Value exceeds the maximum length or size.',
  unrecognized_keys: 'Remove fields not listed in the input schema.',
  custom: 'Check the field constraints and related values.',
};

function recovery(code: string, sending: boolean) {
  if (['BUSY', 'RATE_LIMIT', 'CAPACITY'].includes(code))
    return { retryable: true, suggestedAction: 'retry_later' };
  if (code === 'MESSAGE_INCOMPLETE')
    return { retryable: true, suggestedAction: 'read_message_again' };
  const actions: Record<string, string> = {
    INVALID_INPUT: 'correct_input',
    STALE_MAILBOX: 'refresh_message_list',
    NOT_FOUND: 'refresh_available_resources',
    UNSUPPORTED: 'check_account_protocol',
    MESSAGE_BODY_UNAVAILABLE: 'inspect_attachments_or_mail_client',
    MESSAGE_SIZE: 'inspect_in_mail_client',
    ATTACHMENT_SIZE: 'inspect_in_mail_client',
    HOST_NOT_ALLOWED: 'contact_operator',
    QUOTA: 'remove_unused_account',
    UPLOAD_QUOTA: 'remove_temporary_attachments',
    SEND_QUOTA: 'wait_for_operation_expiry',
    IDEMPOTENCY_CONFLICT: 'review_operation_id',
    UNAUTHORIZED: 'sign_in',
    INVALID_TOKEN: 'sign_in',
    SCOPE: 'sign_in',
  };
  return {
    retryable: false,
    suggestedAction:
      actions[code] ?? (sending ? 'verify_delivery_before_retry' : 'check_configuration'),
  };
}

function errorDetails(error: unknown) {
  if (error instanceof AppError) return { code: error.code, message: error.message };
  if (error instanceof ZodError)
    return {
      code: 'INVALID_INPUT',
      message: 'Invalid input. Check field formats and required values.',
    };
  // Provider errors can contain credentials, message bodies and server details.
  return {
    code: 'OPERATION_FAILED',
    message:
      'Operation failed. Check configuration, connectivity and credentials. A failed send may still have been accepted; check before retrying.',
  };
}

export function publicError(error: unknown, locale: Locale = 'en', sending = false) {
  const result = errorDetails(error);
  return {
    ...(error instanceof SendOperationError
      ? { operationId: error.operationId, operationState: error.operationState }
      : {}),
    code: result.code,
    message: translate(locale, 'errors', result.message),
    messageKey: result.message,
    ...recovery(
      error instanceof SendOperationError && error.operationState === 'unknown'
        ? 'OPERATION_FAILED'
        : result.code,
      sending,
    ),
    fieldErrors:
      error instanceof ZodError
        ? error.issues.slice(0, 100).map((issue) => ({
            path: issue.path.join('.'),
            code: issue.code,
            message: translate(
              locale,
              'errors',
              validationMessages[issue.code] ?? 'Check the field constraints and related values.',
            ),
          }))
        : [],
  };
}
