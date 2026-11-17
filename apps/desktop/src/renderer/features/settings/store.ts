// Opening Ayarlar at a section (deep links: "Ayarlar → Hesaplar" from the right panel, the
// onboarding, a toast). ⌘, opens the remembered section (app-store's `settingsOpen`).
import { create } from "zustand";
import { useAppStore } from "../../state/app-store.ts";
import type { SectionId } from "./catalog.ts";

interface SettingsSheetState {
  /** A section asked for by a deep link; the sheet takes it when it opens (or is open). */
  requested: SectionId | null;
  /** Bumped on every request, so asking for the shown section again still clears a search. */
  requestId: number;
  request(section: SectionId | null): void;
}

export const useSettingsSheet = create<SettingsSheetState>((set, get) => ({
  requested: null,
  requestId: 0,
  request(section) {
    set({ requested: section, requestId: get().requestId + 1 });
  },
}));

export function openSettings(section?: SectionId): void {
  if (section) useSettingsSheet.getState().request(section);
  useAppStore.getState().setSettingsOpen(true);
}

export function closeSettings(): void {
  useAppStore.getState().setSettingsOpen(false);
}
