// Whether the first-run guide is shown, and the step a reopen asked for. Its progress
// (completed / skipped / step) lives in the desktop settings.
import { create } from "zustand";
import type { OnboardingStep } from "./model.ts";

interface OnboardingSheetState {
  open: boolean;
  /** Set by `openOnboarding(step)`; the sheet starts there. */
  requested: OnboardingStep | null;
  /** Bumped on every open (the sheet re-reads where to start). */
  openId: number;
  setOpen(open: boolean): void;
}

export const useOnboardingSheet = create<OnboardingSheetState>((set) => ({
  open: false,
  requested: null,
  openId: 0,
  setOpen(open) {
    set({ open, ...(open ? {} : { requested: null }) });
  },
}));

export function openOnboarding(step?: OnboardingStep): void {
  const s = useOnboardingSheet.getState();
  useOnboardingSheet.setState({ open: true, requested: step ?? null, openId: s.openId + 1 });
}
