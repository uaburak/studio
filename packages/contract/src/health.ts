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
    /**
     * Random id of the Mac host that started this API (STUDIO_INSTANCE_ID).
     * The Mac app uses it to attach to its own running copy instead of
     * starting a second one. Absent when the API was started by hand.
     */
    instance: z.string().min(1).max(128).optional(),
  })
  .meta({ id: "HealthResponse", description: "API health check result." });
export type HealthResponse = z.infer<typeof HealthResponse>;
