// Platform presets and export validation (isomorphic).
export {
  type ExportConstraints,
  type ExportFormat,
  getPreset,
  maxDeviceScale,
  PLATFORM_PRESETS,
  type Platform,
  type PlatformPreset,
  PRESET_IDS,
  type PresetId,
  presetsForSize,
} from "./platforms.ts";
export {
  type ExportFile,
  type ExportIssue,
  type ExportValidation,
  validateExport,
} from "./validate.ts";
