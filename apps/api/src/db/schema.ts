import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Trivial bootstrap table so the migration pipeline is exercised end to end.
 * The real data model (brands, contents, jobs, ...) belongs to task F1-1.
 */
export const appMeta = sqliteTable("app_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});
