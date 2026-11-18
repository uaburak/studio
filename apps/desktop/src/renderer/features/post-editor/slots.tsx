// The app's shell keeps its layout while a post is open: the top bar's title area, the panel
// header above the right panel and the right panel itself are slots the post workspace renders
// into (React portals), so everything of the open post lives in one component tree (its
// editor, canvas, draft and keys) while the shell stays the shell.
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";

export type SlotName = "title" | "panel-header" | "panel";

interface SlotsState {
  els: Partial<Record<SlotName, HTMLElement>>;
  set(name: SlotName, el: HTMLElement | null): void;
}

export const useSlots = create<SlotsState>((set, get) => ({
  els: {},
  set(name, el) {
    if ((get().els[name] ?? null) === el) return;
    const els = { ...get().els };
    if (el) els[name] = el;
    else delete els[name];
    set({ els });
  },
}));

/** A place in the shell the open post renders into. */
export function WorkspaceSlot({ name, className }: { name: SlotName; className?: string }) {
  return (
    <div
      data-workspace-slot={name}
      className={className}
      ref={(el) => {
        useSlots.getState().set(name, el);
        return () => {
          if (useSlots.getState().els[name] === el) useSlots.getState().set(name, null);
        };
      }}
    />
  );
}

/** Renders `children` into the shell's slot (nothing until the shell shows it). */
export function InSlot({ name, children }: { name: SlotName; children: ReactNode }) {
  const el = useSlots((s) => s.els[name]);
  return el ? createPortal(children, el) : null;
}
