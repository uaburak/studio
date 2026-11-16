import { OpenAPIHono, z } from "@hono/zod-openapi";
import { ApiErrorBody, EntityId } from "@studio/contract";
import type { Principal } from "../middleware/access.ts";
import { errorBody, zodIssues } from "./errors.ts";

export type AppEnv = { Bindings: Env; Variables: { principal?: Principal } };

/**
 * Every router shares one validation hook, so a bad body, query or path
 * parameter always yields `400 { error: { code: "validation_error", issues } }`.
 */
export function createRouter() {
  return new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json(
          errorBody(
            "validation_error",
            `invalid request ${result.target}`,
            zodIssues(result.error),
          ),
          400,
        );
      }
    },
  });
}

export function json<T extends z.ZodType>(schema: T, description: string) {
  return { description, content: { "application/json": { schema } } } as const;
}

export function jsonBody<T extends z.ZodType>(schema: T) {
  return { required: true, content: { "application/json": { schema } } } as const;
}

const errorResponse = (description: string) => json(ApiErrorBody, description);

/** Error responses for OpenAPI docs; handlers throw ApiProblem rather than returning these. */
export const errors = {
  400: errorResponse("Validation error (`validation_error`)."),
  404: errorResponse("Resource not found (`not_found`)."),
  409: errorResponse("State conflict (`conflict`, `invalid_transition`, `hash_mismatch`)."),
} as const;

export const IdParams = z.object({ id: EntityId });
