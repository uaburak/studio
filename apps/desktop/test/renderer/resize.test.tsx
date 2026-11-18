import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResizeHandle } from "../../src/renderer/components/shell/resize-handle.tsx";
import { createFallbackBridge, defaultSession, setBridge } from "../../src/renderer/lib/bridge.ts";
import {
  PANEL_MAX_WIDTH,
  PANEL_MIN_WIDTH,
  PANEL_WIDTH,
  PANEL_WIDTH_EXPANDED,
  panelWidthOf,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_WIDTH,
  sessionOf,
  useAppStore,
} from "../../src/renderer/state/app-store.ts";
import { StudioProvider } from "../../src/renderer/state/studio.tsx";
import type { StudioBridge } from "../../src/shared/ipc.ts";

const app = () => useAppStore.getState();

beforeEach(() => {
  useAppStore.setState({
    sidebarWidth: SIDEBAR_WIDTH,
    panelWidth: PANEL_WIDTH,
    panelExpanded: false,
  });
});

afterEach(() => {
  setBridge(undefined);
});

describe("side panel widths", () => {
  it("clamps the sidebar and the panel to their bounds", () => {
    app().setSidebarWidth(310.4);
    expect(app().sidebarWidth).toBe(310);
    app().setSidebarWidth(10);
    expect(app().sidebarWidth).toBe(SIDEBAR_MIN_WIDTH);
    app().setSidebarWidth(9_999);
    expect(app().sidebarWidth).toBe(SIDEBAR_MAX_WIDTH);
    app().setPanelWidth(100);
    expect(app().panelWidth).toBe(PANEL_MIN_WIDTH);
    app().setPanelWidth(9_999);
    expect(app().panelWidth).toBe(PANEL_MAX_WIDTH);
  });

  it("expands the panel and lets a dragged width replace the expanded one", () => {
    app().togglePanelExpanded();
    expect(panelWidthOf(app())).toBe(PANEL_WIDTH_EXPANDED);
    app().setPanelWidth(430);
    expect(app().panelExpanded).toBe(false);
    expect(panelWidthOf(app())).toBe(430);
    // Dragged wider than "expanded": the button shrinks it back to the default.
    app().setPanelWidth(600);
    app().togglePanelExpanded();
    expect(panelWidthOf(app())).toBe(PANEL_WIDTH);
  });

  it("saves the widths in the session and restores them (defaults for older sessions)", () => {
    app().setSidebarWidth(300);
    app().setPanelWidth(450);
    const session = sessionOf(app());
    expect(session).toMatchObject({ sidebarWidth: 300, panelWidth: 450 });

    app().restore({ ...defaultSession, sidebarWidth: 240, panelWidth: 500 });
    expect(app()).toMatchObject({ sidebarWidth: 240, panelWidth: 500 });

    const older = { ...defaultSession } as Partial<typeof defaultSession>;
    delete older.sidebarWidth;
    delete older.panelWidth;
    app().restore(older as typeof defaultSession);
    expect(app()).toMatchObject({ sidebarWidth: SIDEBAR_WIDTH, panelWidth: PANEL_WIDTH });
  });

  it("writes a new width to the desktop settings shortly after the drag", async () => {
    const base = createFallbackBridge();
    const update = vi.fn(base.settings.update);
    const bridge: StudioBridge = {
      ...base,
      host: {
        ...base.host,
        get: async () => ({ ...(await base.host.get()), status: { kind: "stopped" } }),
      },
      settings: { ...base.settings, update },
    };
    setBridge(bridge);
    render(
      <StudioProvider>
        <p>ready</p>
      </StudioProvider>,
    );
    await screen.findByText("ready");
    app().setSidebarWidth(333);
    app().setPanelWidth(444);
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({
        session: expect.objectContaining({ sidebarWidth: 333, panelWidth: 444 }),
      }),
    );
    expect((await bridge.settings.get()).session).toMatchObject({
      sidebarWidth: 333,
      panelWidth: 444,
    });
  });
});

describe("resize handle", () => {
  function setup(edge: "left" | "right", width = 300) {
    const onResize = vi.fn();
    const onReset = vi.fn();
    const { container } = render(
      <ResizeHandle
        edge={edge}
        label="Boyutlandır"
        width={width}
        min={200}
        max={500}
        onResize={onResize}
        onReset={onReset}
      />,
    );
    const handle = within(container).getByRole("separator", { name: "Boyutlandır" });
    return { handle, onResize, onReset };
  }

  it("drags the sidebar's right edge wider and the panel's left edge wider", () => {
    const right = setup("right");
    fireEvent.pointerDown(right.handle, { button: 0, clientX: 100 });
    expect(document.documentElement.dataset.resizing).toBe("");
    fireEvent.pointerMove(window, { clientX: 160 });
    fireEvent.pointerUp(window, { clientX: 160 });
    expect(right.onResize).toHaveBeenLastCalledWith(360);
    expect(document.documentElement.dataset.resizing).toBeUndefined();
    // After the drag, moves no longer resize.
    fireEvent.pointerMove(window, { clientX: 400 });
    expect(right.onResize).toHaveBeenCalledTimes(1);

    const left = setup("left", 357);
    fireEvent.pointerDown(left.handle, { button: 0, clientX: 900 });
    fireEvent.pointerMove(window, { clientX: 850 });
    fireEvent.pointerUp(window);
    expect(left.onResize).toHaveBeenLastCalledWith(407);
  });

  it("resets on double-click and steps with the arrow keys", () => {
    const { handle, onResize, onReset } = setup("right");
    fireEvent.doubleClick(handle);
    expect(onReset).toHaveBeenCalled();
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(onResize).toHaveBeenLastCalledWith(316);
    fireEvent.keyDown(handle, { key: "ArrowLeft", shiftKey: true });
    expect(onResize).toHaveBeenLastCalledWith(252);
    expect(handle).toHaveAttribute("aria-valuenow", "300");
  });

  it("ignores other mouse buttons", () => {
    const { handle, onResize } = setup("right");
    fireEvent.pointerDown(handle, { button: 2, clientX: 100 });
    fireEvent.pointerMove(window, { clientX: 200 });
    expect(onResize).not.toHaveBeenCalled();
  });
});
