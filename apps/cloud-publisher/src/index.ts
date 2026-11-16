// Worker entry module. workerd only accepts handlers and Durable Object
// classes as exports here; everything else lives in other modules.
import { app } from "./app.ts";

export { Scheduler } from "./scheduler.ts";

export default {
  fetch: app.fetch,
  /**
   * Cron watchdog: the Scheduler's alarm is the primary wake-up; this makes
   * sure a lost alarm never strands a due post for more than 5 minutes.
   */
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(env.SCHEDULER.getByName("main").tick());
  },
} satisfies ExportedHandler<Env>;
