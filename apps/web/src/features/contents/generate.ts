import type { Content } from "@studio/contract";

/**
 * Payload for a `content.generate` job. The contract leaves it free-form until
 * the worker pipeline (F1-3) defines a schema; we send what the agent needs
 * to start from the brief. The worker should still re-read the content row.
 */
export function generatePayload(content: Content): Record<string, unknown> {
  return {
    brief: content.brief,
    title: content.title,
    type: content.type,
    targetPlatforms: content.targetPlatforms,
    ...(content.currentVersion ? { baseVersion: content.currentVersion.version } : {}),
  };
}
