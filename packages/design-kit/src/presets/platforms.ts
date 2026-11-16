/**
 * Platform presets: artboard size, safe area and export constraints per placement.
 *
 * Sources (checked 2026-11-16): Instagram and Facebook limits mirror
 * `@studio/publishers` (INSTAGRAM_LIMITS / FACEBOOK_LIMITS, Graph API v27.0 docs).
 * Story/Reels UI overlay sizes are industry guidance, not official numbers.
 * LinkedIn limits come from the Images/Documents API pages and are marked `verified: false`
 * where the docs are vague.
 */
import type { SafeArea } from "../lint/report.ts";

export type Platform = "instagram" | "facebook" | "linkedin";
export type ExportFormat = "jpeg" | "png" | "pdf";

export interface ExportConstraints {
  /** Formats the platform accepts for this placement. */
  formats: readonly ExportFormat[];
  /** What the worker should produce. */
  preferred: ExportFormat;
  maxBytes: number;
  /** Above this, a warning (some platforms rescale instead of failing). */
  softMaxBytes?: number;
  minWidth?: number;
  maxWidth?: number;
  /** width / height */
  minAspect?: number;
  maxAspect?: number;
  maxPixels?: number;
  /** PDF only */
  maxPages?: number;
  colorSpace: "srgb";
}

export interface PlatformPreset {
  id: string;
  platform: Platform;
  surface: "feed" | "story" | "reel-cover" | "document";
  label: string;
  width: number;
  height: number;
  /** `W:H` */
  ratio: string;
  /** Keep text and logos inside (px from each edge). */
  safeArea: SafeArea;
  export: ExportConstraints;
  /** Whether every number above comes from official docs. */
  verified: boolean;
  notes?: string;
}

const MiB = 1024 * 1024;
const all = (n: number): SafeArea => ({ top: n, right: n, bottom: n, left: n });

const IG_IMAGE: ExportConstraints = {
  formats: ["jpeg"],
  preferred: "jpeg",
  maxBytes: 8 * MiB,
  minWidth: 320,
  maxWidth: 1440,
  minAspect: 4 / 5,
  maxAspect: 1.91,
  colorSpace: "srgb",
};
const IG_STORY: ExportConstraints = {
  formats: ["jpeg"],
  preferred: "jpeg",
  maxBytes: 8 * MiB,
  colorSpace: "srgb",
};
const FB_PHOTO: ExportConstraints = {
  formats: ["jpeg", "png"],
  preferred: "jpeg",
  maxBytes: 10 * MiB,
  softMaxBytes: 1 * MiB,
  colorSpace: "srgb",
};
const LI_IMAGE: ExportConstraints = {
  formats: ["jpeg", "png"],
  preferred: "jpeg",
  maxBytes: 8 * MiB,
  maxPixels: 36_152_320,
  colorSpace: "srgb",
};
const LI_DOC: ExportConstraints = {
  formats: ["pdf"],
  preferred: "pdf",
  maxBytes: 100 * MiB,
  maxPages: 300,
  colorSpace: "srgb",
};

/** Story UI covers the top (profile row) and the bottom (reply bar). */
const STORY_SAFE: SafeArea = { top: 250, right: 64, bottom: 340, left: 64 };
/** Reels cover: caption and buttons at the bottom/right; profile grid crops it to 3:4. */
const REEL_COVER_SAFE: SafeArea = { top: 240, right: 140, bottom: 420, left: 64 };

export const PLATFORM_PRESETS = {
  "instagram-feed-portrait": {
    id: "instagram-feed-portrait",
    platform: "instagram",
    surface: "feed",
    label: "Instagram feed 4:5",
    width: 1080,
    height: 1350,
    ratio: "4:5",
    safeArea: all(64),
    export: IG_IMAGE,
    verified: true,
    notes: "64px also covers the profile grid's 3:4 crop (~34px each side).",
  },
  "instagram-feed-square": {
    id: "instagram-feed-square",
    platform: "instagram",
    surface: "feed",
    label: "Instagram feed 1:1",
    width: 1080,
    height: 1080,
    ratio: "1:1",
    safeArea: all(64),
    export: IG_IMAGE,
    verified: true,
  },
  "instagram-story": {
    id: "instagram-story",
    platform: "instagram",
    surface: "story",
    label: "Instagram story 9:16",
    width: 1080,
    height: 1920,
    ratio: "9:16",
    safeArea: STORY_SAFE,
    export: IG_STORY,
    verified: false,
    notes: "Overlay sizes are guidance; no stickers or links via the API.",
  },
  "instagram-reel-cover": {
    id: "instagram-reel-cover",
    platform: "instagram",
    surface: "reel-cover",
    label: "Instagram Reels cover 9:16",
    width: 1080,
    height: 1920,
    ratio: "9:16",
    safeArea: REEL_COVER_SAFE,
    export: IG_STORY,
    verified: false,
  },
  "facebook-feed-portrait": {
    id: "facebook-feed-portrait",
    platform: "facebook",
    surface: "feed",
    label: "Facebook feed 4:5",
    width: 1080,
    height: 1350,
    ratio: "4:5",
    safeArea: all(64),
    export: FB_PHOTO,
    verified: true,
  },
  "facebook-feed-square": {
    id: "facebook-feed-square",
    platform: "facebook",
    surface: "feed",
    label: "Facebook feed 1:1",
    width: 1080,
    height: 1080,
    ratio: "1:1",
    safeArea: all(64),
    export: FB_PHOTO,
    verified: true,
  },
  "facebook-story": {
    id: "facebook-story",
    platform: "facebook",
    surface: "story",
    label: "Facebook story 9:16",
    width: 1080,
    height: 1920,
    ratio: "9:16",
    safeArea: STORY_SAFE,
    export: FB_PHOTO,
    verified: false,
  },
  "linkedin-feed-portrait": {
    id: "linkedin-feed-portrait",
    platform: "linkedin",
    surface: "feed",
    label: "LinkedIn feed 4:5",
    width: 1080,
    height: 1350,
    ratio: "4:5",
    safeArea: all(64),
    export: LI_IMAGE,
    verified: false,
  },
  "linkedin-feed-square": {
    id: "linkedin-feed-square",
    platform: "linkedin",
    surface: "feed",
    label: "LinkedIn feed 1:1",
    width: 1080,
    height: 1080,
    ratio: "1:1",
    safeArea: all(64),
    export: LI_IMAGE,
    verified: false,
  },
  "linkedin-document-portrait": {
    id: "linkedin-document-portrait",
    platform: "linkedin",
    surface: "document",
    label: "LinkedIn document (PDF carousel) 4:5",
    width: 1080,
    height: 1350,
    ratio: "4:5",
    safeArea: all(64),
    export: LI_DOC,
    verified: false,
    notes: "One PDF page per slide; LinkedIn shows the pages as a swipeable document.",
  },
  "linkedin-document-square": {
    id: "linkedin-document-square",
    platform: "linkedin",
    surface: "document",
    label: "LinkedIn document (PDF carousel) 1:1",
    width: 1080,
    height: 1080,
    ratio: "1:1",
    safeArea: all(64),
    export: LI_DOC,
    verified: false,
  },
} as const satisfies Record<string, PlatformPreset>;

export type PresetId = keyof typeof PLATFORM_PRESETS;
export const PRESET_IDS = Object.keys(PLATFORM_PRESETS) as PresetId[];

export function getPreset(id: string): PlatformPreset | undefined {
  return Object.hasOwn(PLATFORM_PRESETS, id)
    ? (PLATFORM_PRESETS as Record<string, PlatformPreset>)[id]
    : undefined;
}

/** Presets an artboard size fits (same pixel size). */
export function presetsForSize(width: number, height: number): PlatformPreset[] {
  return Object.values(PLATFORM_PRESETS).filter((p) => p.width === width && p.height === height);
}

/** Largest device scale factor that keeps the export within the platform's max width. */
export function maxDeviceScale(preset: PlatformPreset): number {
  return preset.export.maxWidth
    ? Math.floor((preset.export.maxWidth / preset.width) * 100) / 100
    : 4;
}
