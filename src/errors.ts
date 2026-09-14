import { ZodError } from 'zod';

export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export function publicError(error: unknown) {
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
