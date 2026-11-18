import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultSettings, normalizeSettings, SettingsStore } from "../../src/main/settings.ts";

describe("desktop settings: side panel widths", () => {
  const defaults = defaultSettings("/repo");

  it("defaults the widths for older files and keeps saved ones within bounds", () => {
    expect(
      normalizeSettings({ session: { sidebarPresented: false } }, defaults).session,
    ).toMatchObject({ sidebarPresented: false, sidebarWidth: 265, panelWidth: 357 });
    const saved = normalizeSettings(
      { session: { sidebarWidth: 312.6, panelWidth: 480 } },
      defaults,
    );
    expect(saved.session).toMatchObject({ sidebarWidth: 313, panelWidth: 480 });
    const wild = normalizeSettings(
      { session: { sidebarWidth: 5000, panelWidth: -3 } },
      defaults,
    ).session;
    expect(wild).toMatchObject({ sidebarWidth: 420, panelWidth: 300 });
    const broken = normalizeSettings(
      { session: { sidebarWidth: "wide", panelWidth: null } },
      defaults,
    ).session;
    expect(broken).toMatchObject({ sidebarWidth: 265, panelWidth: 357 });
  });

  it("persists a width change to the file", () => {
    const file = join(mkdtempSync(join(tmpdir(), "studio-settings-")), "desktop-settings.json");
    const store = new SettingsStore(file, defaults);
    store.update({ session: { sidebarWidth: 300, panelWidth: 440 } });
    const written = JSON.parse(readFileSync(file, "utf8"));
    expect(written.session).toMatchObject({ sidebarWidth: 300, panelWidth: 440 });
    // Other session fields stay as they were.
    expect(written.session.route).toBe("new");
    expect(new SettingsStore(file, defaults).get().session.panelWidth).toBe(440);
  });
});
