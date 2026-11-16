import { defineConfig } from "drizzle-kit";

// Generates SQL migrations into ./migrations, which wrangler applies to D1
// (`pnpm db:migrate` locally). No credentials: generation is offline.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./migrations",
});
