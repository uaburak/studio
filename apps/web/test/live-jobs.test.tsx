import type { Job, JobStreamMessage, JobWatchStatus, WorkerPresence } from "@studio/contract";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { describePresence } from "../src/lib/live-jobs.tsx";
import { brand, createMockApi, page, renderRoute } from "./helpers.tsx";

const T = "2026-11-16T10:00:00.000Z";

function makePresence(patch: Partial<WorkerPresence> = {}): WorkerPresence {
  return {
    online: true,
    lastSeenAt: T,
    workers: [],
    currentJobs: [],
    queueLength: 0,
    usage: {
      windows: [{ kind: "five_hour", usedPercent: 42, limited: false }],
      source: "claude-cli",
      observedAt: T,
    },
    claude: {
      status: "signed_in",
      email: "burak@example.com",
      plan: "Claude Max",
      cliVersion: "1.0.0",
      loginUrl: null,
      detail: null,
      checkedAt: T,
    },
    gemini: {
      status: "ready",
      mode: "api",
      apiKeyConfigured: true,
      cliVersion: null,
      defaultModel: "gemini-2.5-flash",
      detail: null,
      checkedAt: T,
    },
    ...patch,
  };
}

describe("describePresence", () => {
  it("reports Mac hazır, Claude usage percentage, and Gemini readiness", () => {
    const summary = describePresence(makePresence());
    expect(summary.macLabel).toBe("Mac hazır");
    expect(summary.macTone).toBe("good");
    expect(summary.claudeLabel).toBe("Claude %42");
    expect(summary.geminiLabel).toBe("Gemini hazır");
    expect(summary.geminiReady).toBe(true);
  });

  it("reports Mac çevrimdışı when worker is disconnected", () => {
    const summary = describePresence(makePresence({ online: false, queueLength: 2 }));
    expect(summary.macLabel).toBe("Mac çevrimdışı");
    expect(summary.macTone).toBe("warn");
    expect(summary.macDetail).toContain("2 iş sırada");
  });
});

describe("Live job stream, status bar & job cancellation", () => {
  it("updates Mac status, job progress bar + progressMessage live via jobs.watch and cancels running jobs", async () => {
    const api = createMockApi();
    api.brands.list.mockImplementation(() => page([brand()]));

    let emitMessage: ((msg: JobStreamMessage) => void) | undefined;
    let emitStatus: ((s: JobWatchStatus) => void) | undefined;

    api.jobs.watch.mockImplementation((_query, handlers) => {
      emitMessage = handlers.onMessage;
      emitStatus = handlers.onStatus;
      handlers.onStatus?.("open");
      return { close: vi.fn() };
    });

    const initialJob: Job = {
      id: "job-live-1",
      type: "content.generate",
      status: "running",
      brandId: "brand-1",
      payload: { brief: "Test" },
      progress: 0.25,
      progressMessage: "Varyantlar yazılıyor…",
      createdAt: T,
      updatedAt: T,
    };

    api.jobs.list.mockResolvedValue({ items: [initialJob], nextCursor: null });
    api.jobs.cancel.mockImplementation(async (id) => ({
      ...initialJob,
      id,
      status: "cancelled",
      updatedAt: T,
    }));

    const user = userEvent.setup();
    renderRoute("/isler", api);

    await act(async () => {
      emitMessage?.({
        type: "jobs.snapshot",
        jobs: [initialJob],
        presence: makePresence(),
      });
    });

    expect((await screen.findAllByText("Mac hazır")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Claude %42").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Gemini hazır").length).toBeGreaterThan(0);
    expect(screen.getAllByText("%25").length).toBeGreaterThan(0);

    // Push live progress update
    await act(async () => {
      emitMessage?.({
        type: "job.updated",
        job: {
          ...initialJob,
          progress: 0.75,
          progressMessage: "Kalite denetimi çalışıyor…",
        },
      });
    });

    expect((await screen.findAllByText("%75")).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Kalite denetimi çalışıyor/).length).toBeGreaterThan(0);

    // Simulate worker going offline over stream
    await act(async () => {
      emitMessage?.({
        type: "presence",
        presence: makePresence({ online: false }),
      });
    });
    expect((await screen.findAllByText("Mac çevrimdışı")).length).toBeGreaterThan(0);

    // Click "İptal et" on the running job
    const cancelButtons = screen.getAllByRole("button", { name: "İptal et" });
    await user.click(cancelButtons[0] as HTMLElement);

    await waitFor(() => expect(api.jobs.cancel).toHaveBeenCalledWith("job-live-1"));

    // Verify graceful fallback when WebSocket closes
    api.workers.presence.mockResolvedValue(makePresence({ online: true }));
    await act(async () => {
      emitStatus?.("closed");
    });
    await waitFor(() => expect(api.workers.presence).toHaveBeenCalled());
  });
});
