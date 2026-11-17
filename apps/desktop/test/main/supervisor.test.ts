import { describe, expect, it } from "vitest";
import type { ProcessLauncher, ProcessSpec, RunningProcess } from "../../src/main/host/process.ts";
import { waitOneShot } from "../../src/main/host/process.ts";
import { backoffDelay, DEFAULT_POLICY, ServiceSupervisor } from "../../src/main/host/supervisor.ts";
import type { ServicePhase } from "../../src/shared/ipc.ts";

const spec: ProcessSpec = {
  name: "api",
  executable: "/usr/bin/true",
  args: [],
  env: {},
  cwd: "/",
  logFile: "/tmp/x.log",
};

/** A process the test ends by hand. */
class FakeProcess implements RunningProcess {
  private resolveExit!: (code: number) => void;
  private readonly exit = new Promise<number>((r) => {
    this.resolveExit = r;
  });
  terminated = false;
  constructor(readonly pid: number) {}
  waitForExit() {
    return this.exit;
  }
  end(code: number) {
    this.resolveExit(code);
  }
  async terminate() {
    this.terminated = true;
    this.resolveExit(143);
    await this.exit;
  }
}

class FakeLauncher implements ProcessLauncher {
  launched: FakeProcess[] = [];
  fail = false;
  launch(): RunningProcess {
    if (this.fail) throw new Error("kaboom");
    const p = new FakeProcess(100 + this.launched.length);
    this.launched.push(p);
    return p;
  }
}

const tick = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

describe("backoffDelay", () => {
  it("doubles from the base delay and caps at the maximum", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => backoffDelay(DEFAULT_POLICY, n))).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000,
    ]);
    expect(backoffDelay({ ...DEFAULT_POLICY, baseDelayMs: 500, maxDelayMs: 1_500 }, 3)).toBe(1_500);
  });
});

describe("ServiceSupervisor", () => {
  function make(now: { t: number }, sleeps: number[]) {
    const launcher = new FakeLauncher();
    const phases: ServicePhase[] = [];
    const supervisor = new ServiceSupervisor("API", () => spec, launcher, {
      now: () => now.t,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      policy: { maxQuickFailures: 3 },
    });
    supervisor.onChange = (p) => phases.push(p);
    return { launcher, phases, supervisor };
  }

  it("relaunches a crashed child with growing delays and gives up after too many quick crashes", async () => {
    const now = { t: 0 };
    const sleeps: number[] = [];
    const { launcher, phases, supervisor } = make(now, sleeps);
    supervisor.start();
    for (let i = 0; i < 4; i++) {
      await tick();
      launcher.launched.at(-1)?.end(1);
      await tick();
    }
    await tick();
    expect(launcher.launched).toHaveLength(4);
    expect(sleeps).toEqual([1_000, 2_000, 4_000]);
    expect(supervisor.phase).toEqual({
      kind: "failed",
      message: "API art arda 3 kez kapandı (son çıkış kodu 1).",
    });
    expect(phases.some((p) => p.kind === "restarting")).toBe(true);
    expect(supervisor.isActive).toBe(false);
  });

  it("a long, stable run resets the crash counter", async () => {
    const now = { t: 0 };
    const sleeps: number[] = [];
    const { launcher, supervisor } = make(now, sleeps);
    supervisor.start();
    await tick();
    launcher.launched[0]?.end(1); // quick crash → 1 s
    await tick();
    await tick();
    now.t = 120_000; // the second run lasts two minutes
    launcher.launched[1]?.end(1);
    await tick();
    await tick();
    expect(sleeps).toEqual([1_000, 1_000]);
    await supervisor.stop();
  });

  it("stop terminates the child and does not relaunch it", async () => {
    const now = { t: 0 };
    const { launcher, supervisor } = make(now, []);
    supervisor.start();
    await tick();
    expect(supervisor.phase).toEqual({ kind: "running", pid: 100 });
    await supervisor.stop();
    expect(launcher.launched[0]?.terminated).toBe(true);
    expect(launcher.launched).toHaveLength(1);
    expect(supervisor.phase).toEqual({ kind: "stopped" });
  });

  it("a launch error fails at once", async () => {
    const { launcher, supervisor } = make({ t: 0 }, []);
    launcher.fail = true;
    supervisor.start();
    await tick();
    expect(supervisor.phase).toEqual({ kind: "failed", message: "kaboom" });
  });
});

describe("waitOneShot", () => {
  it("reports the exit code", async () => {
    const p = new FakeProcess(1);
    const outcome = waitOneShot(p, 1_000);
    p.end(0);
    expect(await outcome).toEqual({ kind: "exited", code: 0 });
  });

  it("times out and terminates a hung child", async () => {
    const p = new FakeProcess(1);
    const outcome = await waitOneShot(p, 10, { graceMs: 5 });
    expect(outcome).toEqual({ kind: "timedOut" });
    expect(p.terminated).toBe(true);
  });

  it("cancels with the host", async () => {
    const p = new FakeProcess(1);
    const abort = new AbortController();
    const outcome = waitOneShot(p, 10_000, { signal: abort.signal });
    abort.abort();
    expect(await outcome).toEqual({ kind: "cancelled" });
    expect(p.terminated).toBe(true);
  });
});
