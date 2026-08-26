import { ApiError } from "../api.js";

export function formatErrorSafe(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "unexpected error";
}
