// @studio/publishers — Instagram and Facebook Page publishing through the
// Meta Graph API. Runtime-agnostic (fetch + Web APIs only); runs in workerd.
// See README.md (Turkish) for the supported matrix and the scheduler contract.

export const PACKAGE_NAME = "@studio/publishers";

export * from "./accounts.ts";
export * from "./engagement/comments.ts";
export * from "./engagement/errors.ts";
export * from "./engagement/insights.ts";
export * from "./errors.ts";
export { type FacebookPhase, FacebookPublisher, type FacebookState } from "./facebook/publisher.ts";
export {
  type FirstCommentState,
  firstCommentFailedMessage,
  firstCommentOf,
  postFirstComment,
  postPublishWarnings,
} from "./first-comment.ts";
export * from "./graph/client.ts";
export { encodeParamPairs, type Params, type ParamValue } from "./graph/encode.ts";
export {
  type InstagramItemState,
  type InstagramPhase,
  InstagramPublisher,
  type InstagramState,
  itemContainerParams,
  readPublishingQuota,
} from "./instagram/publisher.ts";
export {
  DEFAULT_LINKEDIN_BASE_URL,
  LINKEDIN_API_VERSION,
  LINKEDIN_TIMEOUT_MS,
  LINKEDIN_UPLOAD_TIMEOUT_MS,
  type LinkedInPhase,
  LinkedInPublisher,
  type LinkedInPublisherOptions,
  type LinkedInState,
  type LinkedInUploadPart,
  type LinkedInUploadSlot,
  linkedinPermalink,
  toLittleText,
} from "./linkedin/publisher.ts";
export {
  DEFAULT_MACHINE_OPTIONS,
  type MachineOptions,
  type Publisher,
  type RunOptions,
  runToCompletion,
  STATE_VERSION,
  type StepContext,
  type StepOutcome,
} from "./machine.ts";
export * from "./models.ts";
export * from "./publisher.ts";
export { REDACTED, redact, redactDeep } from "./redact.ts";
export * from "./runtime.ts";
export * from "./validation/index.ts";
export { FACEBOOK_LIMITS, INSTAGRAM_LIMITS, LINKEDIN_LIMITS } from "./validation/rules.ts";
