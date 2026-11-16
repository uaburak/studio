/** Version of this library (kept in sync with package.json by a test). */
export const KIT_VERSION = "0.1.0";

/** Design contract version written into `<meta name="studio:contract">`. */
export const CONTRACT_VERSION = "v1";

/** Contract versions the parser and linter accept (older ones produce an info issue). */
export const SUPPORTED_CONTRACT_VERSIONS = ["v0", "v1"] as const;
export type ContractVersion = (typeof SUPPORTED_CONTRACT_VERSIONS)[number];

/** Identifier of the lint report JSON format. Bump on breaking changes. */
export const LINT_REPORT_SCHEMA = "studio.lint/1";

/** Identifier of the patch operation format stored in version history. */
export const PATCH_SCHEMA = "studio.patch/1";
