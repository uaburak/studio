// Design contract v1: constants, zod schemas of the layer model, and the Markdown text for prompts.

export { CONTRACT_VERSION, type ContractVersion, SUPPORTED_CONTRACT_VERSIONS } from "../version.ts";
export * from "./constants.ts";
export * from "./schemas.ts";
export { DESIGN_CONTRACT_MD } from "./text.ts";
