/**
 * The approval gate of the generation checks (E7): approving a version is refused while its
 * checks hold approval back — the latest run of that exact version has blocking results under
 * the brand's settings (switched-off checks left out; `fail`, plus `warn` when strict), or no
 * run of it has finished yet while the brand has checks switched on. The request may carry
 * `acknowledgeChecks: true` (the user saw the results and approves anyway): then nothing is
 * refused. Old clients without the flag get the 409 (a Turkish message about "kontroller").
 */
import {
  anyCheckEnabled,
  approvalBlockers,
  type BrandCheckSettings,
  CHECK_CATALOG,
  defaultCheckSettings,
  type ErrorIssue,
  isCheckId,
} from "@studio/contract";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { toBrandCheckSettings } from "../db/mappers.ts";
import { brandCheckSettings, contentCheckRuns } from "../db/schema.ts";
import { ApiProblem } from "./errors.ts";

const label = (id: string) => (isCheckId(id) ? CHECK_CATALOG[id].label : id);

export async function loadCheckSettings(db: Db, brandId: string): Promise<BrandCheckSettings> {
  const row = await db.query.brandCheckSettings.findFirst({
    where: eq(brandCheckSettings.brandId, brandId),
  });
  return row ? toBrandCheckSettings(row) : defaultCheckSettings(brandId);
}

/**
 * Throws 409 when the checks of `version` hold its approval back (see the top). Call it only
 * when the request did not acknowledge the checks.
 */
export async function assertChecksAllowApproval(
  db: Db,
  content: { id: string; brandId: string },
  version: { id: string; version: number },
): Promise<void> {
  const settings = await loadCheckSettings(db, content.brandId);
  if (!anyCheckEnabled(settings)) return;
  const [run] = await db
    .select({
      versionId: contentCheckRuns.versionId,
      results: contentCheckRuns.results,
    })
    .from(contentCheckRuns)
    .where(
      and(
        eq(contentCheckRuns.contentId, content.id),
        eq(contentCheckRuns.version, version.version),
      ),
    )
    .orderBy(desc(contentCheckRuns.id))
    .limit(1);
  // A run stored for another version row with the same number does not count.
  if (!run || (run.versionId !== null && run.versionId !== version.id)) {
    throw new ApiProblem(
      "conflict",
      `v${version.version} için kontroller henüz bitmedi; sonuçlar gelmeden onaylanamaz. ` +
        "Kontrolleri bekleyin ya da sonuçları görmeden onaylamak istediğinizi belirtin.",
    );
  }
  const blocking = approvalBlockers(run.results, settings);
  if (blocking.length === 0) return;
  const names = [...new Set(blocking.map((r) => label(r.checkId)))];
  const issues: ErrorIssue[] = blocking.slice(0, 10).map((r) => ({
    path: `checks.${r.checkId}`,
    message: `${label(r.checkId)}: ${r.message}`,
  }));
  throw new ApiProblem(
    "conflict",
    `v${version.version} için ${blocking.length} kontrol geçmedi: ${names.slice(0, 4).join(", ")}${
      names.length > 4 ? "…" : ""
    }. Sonuçlara bakıp yine de onaylamak istediğinizi belirtin.`,
    issues,
  );
}
