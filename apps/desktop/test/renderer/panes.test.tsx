import type { ApiClient, MacRoutes, PairingCode, Schedule } from "@studio/contract";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../../src/renderer/components/chat/composer.tsx";
import {
  buildEntries,
  daySummaries,
  SCHEDULE_DRAG_MIME,
} from "../../src/renderer/features/calendar/calendar-model.ts";
import { AgendaRow, MiniMonth } from "../../src/renderer/features/calendar/calendar-views.tsx";
import { PairingController } from "../../src/renderer/features/devices/pairing-controller.ts";
import { PairingCard } from "../../src/renderer/features/devices/phone-pane.tsx";
import { ApiContext } from "../../src/renderer/lib/api.ts";
import {
  type AssetDragPayload,
  requestComposerAttach,
  STUDIO_ASSET_MIME,
} from "../../src/renderer/lib/asset-drag.ts";
import { encodeQr } from "../../src/renderer/lib/qr.ts";
import { T } from "./fixtures.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

function withApi(ui: ReactNode, api: Partial<ApiClient> = {}) {
  return render(<ApiContext.Provider value={api as ApiClient}>{ui}</ApiContext.Provider>);
}

function dataTransfer(data: Record<string, string>, files: File[] = []) {
  return {
    types: [...Object.keys(data), ...(files.length ? ["Files"] : [])],
    files,
    getData: (type: string) => data[type] ?? "",
    setData: () => undefined,
    dropEffect: "none",
    effectAllowed: "all",
  };
}

const payload = (over: Partial<AssetDragPayload> = {}): AssetDragPayload => ({
  assetId: "asset-tarla",
  brandId: "b1",
  mimeType: "image/jpeg",
  filename: "tarla.jpg",
  width: 1080,
  height: 1350,
  ...over,
});

describe("composer takes Studio assets", () => {
  it("attaches a dropped asset of its brand without uploading and sends it", async () => {
    const upload = vi.fn();
    const onSend = vi.fn(async () => true);
    withApi(<Composer placeholder="x" working={false} brandId="b1" onSend={onSend} />, {
      assets: { upload } as unknown as ApiClient["assets"],
    });
    const box = screen.getByRole("textbox", { name: "Mesaj" });
    const shell = box.closest(".glass-composer") as HTMLElement;
    const dt = dataTransfer({ [STUDIO_ASSET_MIME]: JSON.stringify([payload()]) });
    fireEvent.dragOver(shell, { dataTransfer: dt });
    fireEvent.drop(shell, { dataTransfer: dt });
    expect(await screen.findByText("@image")).toBeInTheDocument();
    expect(upload).not.toHaveBeenCalled();
    // The same asset twice is attached once.
    fireEvent.drop(shell, { dataTransfer: dt });
    expect(screen.getAllByText(/^@image/)).toHaveLength(1);
    await userEvent.type(box, "bunu kullan{Enter}");
    expect(onSend).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "bunu kullan",
        attachments: [{ assetId: "asset-tarla", alias: "image" }],
      }),
      { now: false },
    );
  });

  it("copies an asset of another brand into its own brand", async () => {
    const upload = vi.fn(async () => ({ id: "asset-copy" }));
    // A plain stand-in: jsdom's File does not take Node's Response blobs.
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      blob: async () => new Blob(["x"], { type: "image/jpeg" }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    withApi(<Composer placeholder="x" working={false} brandId="b2" onSend={async () => true} />, {
      assets: { upload } as unknown as ApiClient["assets"],
    });
    act(() => {
      expect(requestComposerAttach([payload()])).toBe(true);
    });
    await waitFor(() => expect(upload).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith("/api/assets/asset-tarla/content");
    expect(upload).toHaveBeenCalledWith(
      expect.objectContaining({ brandId: "b2", kind: "image", source: "upload" }),
    );
  });

  it("refuses without a brand and says why", async () => {
    withApi(
      <Composer
        placeholder="x"
        working={false}
        brandId={null}
        attachDisabledReason="Önce bir marka seç."
        onSend={async () => true}
      />,
    );
    act(() => {
      requestComposerAttach([payload()]);
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("Önce bir marka seç.");
  });
});

describe("calendar views", () => {
  const schedule: Schedule = {
    id: "s1",
    contentId: "p1",
    brandId: "b1",
    platform: "instagram",
    socialAccountId: "acc",
    versionId: "v1",
    contentHash: "a".repeat(64),
    scheduledAt: new Date("2026-11-18T10:00:00").toISOString(),
    status: "pending",
    cancelledAt: null,
    createdAt: T,
    updatedAt: T,
  };
  const entries = buildEntries({ schedules: [schedule], contents: [], plans: [] });

  it("marks today, the selected day and the days with posts; drops a schedule on a day", () => {
    const onSelect = vi.fn();
    const onDrop = vi.fn();
    render(
      <MiniMonth
        month={{ year: 2026, month: 11 }}
        today="2026-11-17"
        selected="2026-11-18"
        summaries={daySummaries(entries)}
        onSelect={onSelect}
        onDropSchedule={onDrop}
      />,
    );
    const day18 = screen.getByRole("button", { name: "18, 1 paylaşım" });
    expect(day18).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "17" })).toHaveAttribute("aria-current", "date");
    fireEvent.click(screen.getByRole("button", { name: "20" }));
    expect(onSelect).toHaveBeenCalledWith("2026-11-20");
    const target = screen.getByRole("button", { name: "25" });
    const dt = dataTransfer({ [SCHEDULE_DRAG_MIME]: "s1" });
    fireEvent.dragOver(target, { dataTransfer: dt });
    fireEvent.drop(target, { dataTransfer: dt });
    expect(onDrop).toHaveBeenCalledWith("s1", "2026-11-25");
  });

  it("shows an agenda row and opens the post", async () => {
    const onOpen = vi.fn();
    const entry = entries[0];
    if (!entry) throw new Error("no entry");
    render(<AgendaRow entry={entry} onOpen={onOpen} />);
    const row = screen.getByRole("button", { name: /Post/ });
    expect(row).toHaveAttribute("draggable", "true");
    expect(row).toHaveTextContent("10:00");
    expect(row).toHaveTextContent("Zamanlandı");
    await userEvent.click(row);
    expect(onOpen).toHaveBeenCalledWith(entry, expect.anything());
  });
});

describe("iPhone pairing card", () => {
  it("renders the QR of the invite and the typed code", async () => {
    const now = Date.now();
    const routes: MacRoutes = {
      macName: "Mac",
      macId: "m1",
      lanAddresses: ["192.168.1.2"],
      lanPort: 8791,
      bonjourName: null,
      tunnelUrl: null,
      updatedAt: T,
    };
    const offer: PairingCode = {
      code: "123456",
      expiresAt: new Date(now + 105_500).toISOString(),
      secret: "Q1w2E3r4T5y6U7i8O9p0A1s2D3f4G5h6J7k8L9z0X1c",
      secretExpiresAt: new Date(now + 600_000).toISOString(),
    };
    const controller = new PairingController({
      autoRefresh: false,
      api: () => ({
        createCode: async () => offer,
        routes: async () => routes,
        devices: async () => [],
        revoke: async () => {
          throw new Error("no");
        },
      }),
    });
    controller.show();
    await controller.step();
    render(<PairingCard controller={controller} snapshot={controller.getSnapshot()} />);
    expect(screen.getByText("iPhone'unda Studio'yu aç ve bu kodu okut")).toBeInTheDocument();
    const qr = screen.getByRole("img", { name: "iPhone'u bağlamak için QR kod" });
    const url = controller.getSnapshot().url ?? "";
    expect(url).toMatch(/^studio:\/\/pair\?v=1&n=Mac&s=Q1w2/);
    expect(qr.getAttribute("data-qr-version")).toBe(String(encodeQr(url).version));
    expect(qr.querySelector("path")?.getAttribute("d")?.length).toBeGreaterThan(100);
    expect(screen.getByTestId("pairing-code")).toHaveTextContent(
      "Kodu elle girmek için: 123 456 · 1:46",
    );
    expect(screen.getByRole("button", { name: "Yeni kod" })).toBeInTheDocument();
  });
});
