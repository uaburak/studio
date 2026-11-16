import {
  type Content,
  type ContentStatus,
  ContentStatus as ContentStatusEnum,
  MANUAL_CONTENT_TRANSITIONS,
} from "@studio/contract";
import { describe, expect, it } from "vitest";
import {
  CONTENT_STATUS,
  contentCapabilities,
  manualTransitions,
  shortHash,
} from "../src/lib/content-status.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function content(patch: Partial<Content> = {}): Content {
  return {
    id: "c1",
    brandId: "b1",
    type: "post",
    title: "Deneme",
    brief: "",
    status: "draft",
    targetPlatforms: ["instagram"],
    caption: "",
    currentVersion: { id: "v1", version: 1, contentHash: HASH_A },
    approval: null,
    createdAt: "2026-11-16T10:00:00.000Z",
    updatedAt: "2026-11-16T10:00:00.000Z",
    ...patch,
  };
}

const approval = (contentHash = HASH_A, versionId = "v1") => ({
  versionId,
  contentHash,
  approvedAt: "2026-11-16T11:00:00.000Z",
});

describe("manualTransitions", () => {
  it("offers exactly the contract's manual transitions, with Turkish labels", () => {
    for (const status of ContentStatusEnum.options) {
      const actions = manualTransitions(status);
      expect(actions.map((a) => a.to)).toEqual([...MANUAL_CONTENT_TRANSITIONS[status]]);
      for (const a of actions) expect(a.label).not.toMatch(/^[a-z_]+$/);
    }
  });

  it("asks for confirmation before revoking an approval", () => {
    const [revoke] = manualTransitions("approved");
    expect(revoke).toMatchObject({ to: "draft", label: "Onayı geri çek", intent: "danger" });
    expect(revoke?.confirm).toBeTruthy();
  });

  it("hides review until a version exists", () => {
    expect(manualTransitions("draft", false)).toEqual([]);
    expect(manualTransitions("draft", true).map((a) => a.to)).toEqual(["in_review"]);
  });

  it("has a label for every status", () => {
    for (const status of ContentStatusEnum.options)
      expect(CONTENT_STATUS[status].label).toBeTruthy();
  });
});

describe("contentCapabilities", () => {
  it("allows approving a draft that has a version", () => {
    const caps = contentCapabilities(content());
    expect(caps.canApprove).toBe(true);
    expect(caps.canSchedule).toBe(false);
    expect(caps.scheduleBlockedReason).toBeTruthy();
  });

  it("blocks approval without a version", () => {
    const caps = contentCapabilities(content({ currentVersion: null }));
    expect(caps.canApprove).toBe(false);
    expect(caps.approveBlockedReason).toBe("Onaylanacak bir sürüm yok.");
  });

  it("allows scheduling only when the approval matches the current version", () => {
    expect(
      contentCapabilities(content({ status: "approved", approval: approval() })).canSchedule,
    ).toBe(true);
    const stale = contentCapabilities(content({ status: "approved", approval: approval(HASH_B) }));
    expect(stale.canSchedule).toBe(false);
    expect(stale.scheduleBlockedReason).toBe("Onay güncel sürümle eşleşmiyor.");
  });

  it("needs a target platform to schedule", () => {
    const caps = contentCapabilities(
      content({ status: "approved", approval: approval(), targetPlatforms: [] }),
    );
    expect(caps.canSchedule).toBe(false);
  });

  it("follows the contract for delete / new version / caption locks", () => {
    const table: [ContentStatus, { del: boolean; ver: boolean; lock: boolean }][] = [
      ["draft", { del: true, ver: true, lock: false }],
      ["approved", { del: true, ver: true, lock: false }],
      ["scheduled", { del: false, ver: true, lock: false }],
      ["publishing", { del: false, ver: false, lock: true }],
      ["published", { del: false, ver: false, lock: true }],
      ["failed", { del: true, ver: true, lock: false }],
    ];
    for (const [status, expected] of table) {
      const caps = contentCapabilities(content({ status }));
      expect({ del: caps.canDelete, ver: caps.canAddVersion, lock: caps.captionLocked }).toEqual(
        expected,
      );
    }
  });

  it("warns that caption edits revoke an existing approval", () => {
    expect(contentCapabilities(content()).captionEditRevokesApproval).toBe(false);
    expect(
      contentCapabilities(content({ status: "approved", approval: approval() }))
        .captionEditRevokesApproval,
    ).toBe(true);
  });
});

describe("shortHash", () => {
  it("abbreviates SHA-256", () => {
    expect(shortHash(`12345678${"0".repeat(52)}abcd`)).toBe("12345678…abcd");
    expect(shortHash("short")).toBe("short");
  });
});
