/**
 * The vision model behind the product picture line (docs/URETIM-RESIM.md §8–9): reading a
 * product photo exactly ("birebir tarif") and checking a generated picture against the product
 * ("kontrol yapay zekâda"). Gemini (structured JSON with inline pictures) when a key is set,
 * Claude (the worker's gate, image blocks) when Gemini is missing or fails and Claude is signed
 * in; `null` when neither can run. Tests inject their own caller (never a paid call).
 */
import sharp from "sharp";
import type { AgentDeps } from "../agent.ts";
import { geminiUsageSink } from "../ai/usage-recorder.ts";
import type { ClaudeContentBlock } from "../claude/runner.ts";
import { callGeminiJson, getGeminiApiKey } from "../gemini/json-call.ts";
import { resolveGeminiModelId } from "../gemini/models.ts";

export interface VisionModelRequest {
  /** Short name for logs. */
  label: string;
  system: string;
  content: ClaudeContentBlock[];
  schema: object;
  signal: AbortSignal;
}

export type VisionModelCaller = (
  req: VisionModelRequest,
) => Promise<{ output: unknown; model: string }>;

/** Long edge of the pictures sent to the vision model (labels stay legible). */
export const VISION_MODEL_EDGE = 1536;

/** A picture as a model content block: upright JPEG, long edge ≤ VISION_MODEL_EDGE. */
export async function modelPicture(
  bytes: Uint8Array,
  edge = VISION_MODEL_EDGE,
): Promise<ClaudeContentBlock> {
  const jpeg = await sharp(bytes, { animated: false })
    .rotate()
    .resize(edge, edge, { fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 90 })
    .toBuffer();
  return {
    type: "image",
    mediaType: "image/jpeg",
    data: new Uint8Array(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength),
  };
}

/**
 * The caller for `kind` (describe / verify): Gemini Pro (accuracy matters more than the few
 * cents; the description is cached per photo), else Claude Sonnet.
 */
export function productVisionCaller(
  deps: Pick<AgentDeps, "settings" | "gate" | "health" | "logger" | "aiUsage" | "geminiFetch">,
  jobId: string | undefined,
  kind: "describe" | "verify",
): VisionModelCaller | null {
  const { settings } = deps;
  const apiKey = getGeminiApiKey(settings);
  const claudeReady = () => deps.health().state === "ok";
  const viaClaude: VisionModelCaller = async (req) => {
    const res = await deps.gate.call(
      {
        label: req.label,
        system: req.system,
        content: req.content,
        schema: req.schema,
        model: "sonnet",
        effort: "medium",
        timeoutMs: Math.min(settings.claudeTimeoutMs, 300_000),
        signal: req.signal,
      },
      {},
    );
    return { output: res.output, model: res.model ?? "sonnet" };
  };
  if (apiKey) {
    const modelId = resolveGeminiModelId("gemini-pro", settings.geminiModels);
    return async (req) => {
      try {
        const res = await callGeminiJson({
          apiKey,
          modelId,
          system: req.system,
          content: req.content,
          schema: req.schema,
          effort: "medium",
          signal: req.signal,
          ...(deps.geminiFetch ? { fetch: deps.geminiFetch } : {}),
          onUsage: geminiUsageSink(deps.aiUsage, {
            kind: kind === "describe" ? "image-describe" : "image-check",
            ...(jobId ? { jobId } : {}),
          }),
        });
        return { output: res.output, model: res.model };
      } catch (error) {
        if (req.signal.aborted || !claudeReady()) throw error;
        deps.logger.warn(`${req.label}: Gemini failed, using Claude: ${(error as Error).message}`);
        return viaClaude(req);
      }
    };
  }
  return claudeReady() ? viaClaude : null;
}
