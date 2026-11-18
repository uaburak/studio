import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeAuthController } from "../src/claude/auth.ts";
import {
  claudeProfilePath,
  profileNameFromClaudeJson,
  readClaudeProfileName,
} from "../src/claude/profile.ts";

/** A sample `~/.claude.json` (fixture only; tests never read the real file). */
const FIXTURE = join(import.meta.dirname, "fixtures", "claude-profile.json");

describe("Claude profile name", () => {
  it("reads displayName from the sample .claude.json", async () => {
    expect(await readClaudeProfileName(FIXTURE)).toBe("Deniz");
    expect(profileNameFromClaudeJson(await readFile(FIXTURE, "utf8"))).toBe("Deniz");
  });

  it("falls back to the first word of fullName", () => {
    const json = (account: Record<string, unknown>) => JSON.stringify({ oauthAccount: account });
    expect(profileNameFromClaudeJson(json({ fullName: "Ayşe Nur Kaya" }))).toBe("Ayşe");
    expect(profileNameFromClaudeJson(json({ displayName: "  ", fullName: "Can Öz" }))).toBe("Can");
    expect(profileNameFromClaudeJson(json({ displayName: "Deniz Yılmaz" }))).toBe("Deniz Yılmaz");
  });

  it("never uses the email address and gives up without an account", () => {
    const json = (value: unknown) => JSON.stringify(value);
    expect(
      profileNameFromClaudeJson(json({ oauthAccount: { emailAddress: "a@b.co" } })),
    ).toBeNull();
    expect(profileNameFromClaudeJson(json({ oauthAccount: { displayName: "a@b.co" } }))).toBeNull();
    expect(profileNameFromClaudeJson(json({ oauthAccount: { fullName: "123 456" } }))).toBeNull();
    expect(profileNameFromClaudeJson(json({ numStartups: 1 }))).toBeNull();
    expect(profileNameFromClaudeJson("{ not json")).toBeNull();
  });

  it("returns null for a missing file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "studio-profile-"));
    expect(await readClaudeProfileName(join(dir, ".claude.json"))).toBeNull();
  });

  it("finds the profile next to CLAUDE_CONFIG_DIR, else in HOME", async () => {
    expect(claudeProfilePath({ HOME: "/Users/x" })).toBe("/Users/x/.claude.json");
    expect(claudeProfilePath({ HOME: "/Users/x", CLAUDE_CONFIG_DIR: "/tmp/cfg" })).toBe(
      "/tmp/cfg/.claude.json",
    );
    const dir = await mkdtemp(join(tmpdir(), "studio-profile-"));
    await writeFile(join(dir, ".claude.json"), await readFile(FIXTURE, "utf8"));
    expect(await readClaudeProfileName(claudeProfilePath({ CLAUDE_CONFIG_DIR: dir }))).toBe(
      "Deniz",
    );
  });

  it("reports the name in the signed-in account only", async () => {
    const signedIn = new ClaudeAuthController({
      probe: async () => ({ cliVersion: "2.0.0", loggedIn: true, subscriptionType: "max" }),
      profileName: () => readClaudeProfileName(FIXTURE),
    });
    expect((await signedIn.refresh()).displayName).toBe("Deniz");

    const signedOut = new ClaudeAuthController({
      probe: async () => ({ cliVersion: "2.0.0", loggedIn: false }),
      profileName: () => readClaudeProfileName(FIXTURE),
    });
    expect((await signedOut.refresh()).displayName).toBeUndefined();

    // An injected probe without a profile reader never touches the real home folder.
    const hermetic = new ClaudeAuthController({
      probe: async () => ({ cliVersion: "2.0.0", loggedIn: true }),
    });
    expect((await hermetic.refresh()).displayName).toBeNull();
  });
});
