import { type ApiErrorBody, ERROR_STATUS, type ErrorCode, type ErrorIssue } from "@studio/contract";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ZodError } from "zod";

/** Throw from any handler; the app's onError turns it into the contract error shape. */
export class ApiProblem extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly issues?: ErrorIssue[],
  ) {
    super(message);
    this.name = "ApiProblem";
  }

  get status() {
    return ERROR_STATUS[this.code];
  }
}

export const notFound = (what: string, id: string | number) =>
  new ApiProblem("not_found", `${what} ${id} not found`);
export const conflict = (message: string) => new ApiProblem("conflict", message);
export const invalidTransition = (message: string) => new ApiProblem("invalid_transition", message);
export const badRequest = (message: string, issues?: ErrorIssue[]) =>
  new ApiProblem("validation_error", message, issues);

export function zodIssues(error: ZodError): ErrorIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
}

export function validationProblem(error: ZodError, target?: string): ApiProblem {
  const where = target ? ` in ${target}` : "";
  return badRequest(`invalid request${where}`, zodIssues(error));
}

export function errorBody(code: ErrorCode, message: string, issues?: ErrorIssue[]): ApiErrorBody {
  return { error: { code, message, ...(issues ? { issues } : {}) } };
}

/** Walk an error and its `cause` chain (Drizzle wraps D1 errors). */
function messages(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth++) {
    if (current instanceof Error) {
      parts.push(current.message);
      current = current.cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join(" | ");
}

/** Map anything thrown by a handler to the contract error shape. */
export function toProblem(err: unknown): ApiProblem {
  if (err instanceof ApiProblem) return err;
  if (err instanceof HTTPException) {
    // Hono's own validators (e.g. malformed JSON body) throw HTTPException(400).
    if (err.status === 413) return new ApiProblem("payload_too_large", err.message);
    if (err.status >= 400 && err.status < 500) return badRequest(err.message || "bad request");
  }
  const text = messages(err);
  // Constraint violations are a safety net for races the handlers cannot see.
  if (text.includes("UNIQUE constraint failed")) {
    return conflict("a record with the same unique value already exists");
  }
  if (text.includes("FOREIGN KEY constraint failed")) {
    return conflict("the change would break a reference between records");
  }
  if (text.includes("CHECK constraint failed")) {
    return conflict("the change violates a data integrity rule");
  }
  return new ApiProblem("internal_error", "internal error");
}

export function handleError(err: unknown, c: Context) {
  const problem = toProblem(err);
  if (problem.code === "internal_error") console.error("api: unhandled error", err);
  return c.json(errorBody(problem.code, problem.message, problem.issues), problem.status);
}
