import { z } from "zod";

export const HealthStatus = z.enum(["ok", "degraded"]);
export type HealthStatus = z.infer<typeof HealthStatus>;

export const HealthResponse = z
  .object({
    status: HealthStatus,
    service: z.literal("studio-api"),
    version: z.string().min(1),
    /** Server time, ISO 8601 (UTC). */
    time: z.iso.datetime(),
    checks: z.object({
      db: z.enum(["ok", "error"]),
    }),
  })
  .meta({ id: "HealthResponse", description: "API health check result." });
export type HealthResponse = z.infer<typeof HealthResponse>;
