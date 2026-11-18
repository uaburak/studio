import { z } from "zod";

export const HealthStatus = z.enum(["ok", "degraded"]);
export type HealthStatus = z.infer<typeof HealthStatus>;

/** One part of the Mac host (P9): ok, worth a look (warn) or broken (fail). */
export const HealthState = z.enum(["ok", "warn", "fail"]);
export type HealthState = z.infer<typeof HealthState>;

export const HealthComponentId = z.enum([
  "db",
  "storage",
  "migrations",
  "worker",
  "canvas",
  "vault",
  "cloud",
  "tunnel",
]);
export type HealthComponentId = z.infer<typeof HealthComponentId>;

export const HealthComponent = z
  .object({
    id: HealthComponentId,
    state: HealthState,
    /** Turkish name of the part ("Veritabanı"). */
    label: z.string().min(1).max(80),
    /** Turkish one-liner: what is going on, what to do. */
    detail: z.string().max(500),
  })
  .meta({ id: "HealthComponent" });
export type HealthComponent = z.infer<typeof HealthComponent>;

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
    /**
     * Every part of the host (P9): only for the Mac itself, its worker and paired devices;
     * anonymous callers get the summary above.
     */
    components: z.array(HealthComponent).optional(),
    /** D1 migrations: applied count, the last applied one and the one this build expects. */
    migrations: z
      .object({
        applied: z.number().int().min(0),
        last: z.string().nullable(),
        expected: z.string(),
      })
      .optional(),
  })
  .meta({ id: "HealthResponse", description: "API health check result." });
export type HealthResponse = z.infer<typeof HealthResponse>;
