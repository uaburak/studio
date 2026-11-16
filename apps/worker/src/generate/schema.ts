/**
 * Output of a design call (design contract v1 §9): slides as full HTML documents,
 * the caption, a short rationale and, in the critique pass, the critique and changes.
 */
import { z } from "zod";

export function designJsonSchema(options: {
  minSlides: number;
  maxSlides: number;
  critique: boolean;
}): object {
  const slide = {
    type: "object",
    additionalProperties: false,
    required: ["id", "html"],
    properties: {
      id: { type: "string", pattern: "^slide-[0-9]{1,2}$" },
      html: {
        type: "string",
        description: "Complete HTML document following the design contract.",
      },
    },
  };
  const critique = {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      required: ["issue", "severity", "fix"],
      properties: {
        issue: { type: "string" },
        severity: { type: "string", enum: ["high", "medium", "low"] },
        fix: { type: "string" },
      },
    },
  };
  return {
    type: "object",
    additionalProperties: false,
    required: options.critique
      ? ["critique", "slides", "caption", "rationale", "changes"]
      : ["slides", "caption", "rationale"],
    properties: {
      ...(options.critique ? { critique } : {}),
      slides: {
        type: "array",
        minItems: options.minSlides,
        maxItems: options.maxSlides,
        items: slide,
      },
      caption: { type: "string" },
      rationale: { type: "string" },
      ...(options.critique ? { changes: { type: "array", items: { type: "string" } } } : {}),
    },
  };
}

export const DesignOutput = z.object({
  slides: z.array(z.object({ id: z.string(), html: z.string().min(1) })).min(1),
  caption: z.string().default(""),
  rationale: z.string().default(""),
  critique: z
    .array(z.object({ issue: z.string(), severity: z.string(), fix: z.string() }))
    .default([]),
  changes: z.array(z.string()).default([]),
});
export type DesignOutput = z.infer<typeof DesignOutput>;
