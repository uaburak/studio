/**
 * Adapter for the `worker.usage` frame (worker -> hub): subscription usage windows
 * after every Claude call and at (re)connect. The frame type is being added to
 * `@studio/contract` by another task; until the contract's `ProtocolMessage`
 * accepts it, nothing is sent (sending an unknown type would throw in `encodeMessage`).
 */
import { ProtocolMessage, type WorkerToHubMessage } from "@studio/contract";
import type { UsageReport } from "./claude/usage.ts";

export interface WorkerUsageFrame extends UsageReport {
  type: "worker.usage";
}

export function workerUsageFrame(report: UsageReport): WorkerUsageFrame {
  return {
    type: "worker.usage",
    windows: report.windows.map((w) => ({
      kind: w.kind,
      ...(w.usedPercent !== undefined ? { usedPercent: w.usedPercent } : {}),
      ...(w.resetsAt ? { resetsAt: w.resetsAt } : {}),
      limited: w.limited,
      ...(w.name ? { name: w.name } : {}),
    })),
    source: report.source,
    observedAt: report.observedAt,
  };
}

/**
 * The frame as the contract knows it, or null when the contract has no `worker.usage`
 * yet (or a different shape). Unknown extra fields (`name`) are dropped by the schema.
 */
export function encodableUsageFrame(report: UsageReport): WorkerToHubMessage | null {
  const parsed = ProtocolMessage.safeParse(workerUsageFrame(report));
  if (parsed.success) return parsed.data as WorkerToHubMessage;
  // Retry without the optional window name in case the schema is strict.
  const bare = workerUsageFrame(report);
  for (const w of bare.windows) delete (w as { name?: string }).name;
  const second = ProtocolMessage.safeParse(bare);
  return second.success ? (second.data as WorkerToHubMessage) : null;
}
