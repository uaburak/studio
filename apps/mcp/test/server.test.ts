import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { STUDIO_DOWN_MESSAGE } from "../src/client.ts";
import { timing } from "../src/curated.ts";
import { MAX_RESULT_CHARS } from "../src/output.ts";
import { call, type Harness, parse, startHarness } from "./helpers.ts";

let h: Harness;

beforeAll(() => {
  timing.pollMs = 5;
});

afterEach(async () => {
  await h?.close();
});

describe("tool listing", () => {
  it("lists the curated tools first, then one tool per operation", async () => {
    h = await startHarness();
    const { tools } = await h.client.listTools();
    const names = tools.map((t) => t.name);
    expect(names.slice(0, 7)).toEqual([
      "studio_status",
      "studio_chat",
      "studio_chat_wait",
      "studio_answer",
      "studio_wait_job",
      "studio_brand_overview",
      "studio_upload_file",
    ]);
    expect(names.length).toBeGreaterThan(150);
    const del = tools.find((t) => t.name === "delete_assets_by_id");
    expect(del?.annotations?.destructiveHint).toBe(true);
    expect(tools.find((t) => t.name === "get_brands")?.annotations?.readOnlyHint).toBe(true);
  });

  it("can offer only the curated tools", async () => {
    h = await startHarness({ toolset: "curated" });
    const { tools } = await h.client.listTools();
    expect(tools.every((t) => t.name.startsWith("studio_"))).toBe(true);
  });
});

describe("calling the API as the owner", () => {
  it("sends the owner secret only in the header and never returns or logs it", async () => {
    h = await startHarness();
    h.api.routes.set("GET /api/brands", (req) => ({
      // A misbehaving server echoing the secret back must not leak it.
      json: { items: [{ id: "b1", name: "Marka", note: req.headers["x-studio-owner"] }] },
    }));
    const out = await call(h, "get_brands", { limit: 5 });
    expect(out.isError).toBe(false);
    expect(h.api.requests[0]?.headers["x-studio-owner"]).toBe(h.api.secret);
    expect(h.api.requests[0]?.query.get("limit")).toBe("5");
    expect(out.text).toContain("Marka");
    expect(out.text).not.toContain(h.api.secret);

    // Errors, too.
    h.api.routes.set("GET /api/brands/b2", (req) => ({
      status: 400,
      json: { error: { message: `bad ${String(req.headers["x-studio-owner"])}` } },
    }));
    const err = await call(h, "get_brands_by_id", { id: "b2" });
    expect(err.isError).toBe(true);
    expect(err.text).not.toContain(h.api.secret);

    const log = readFileSync(h.logFile, "utf8");
    expect(log).toContain("tool=get_brands status=ok");
    expect(log).toContain("tool=get_brands_by_id status=error");
    expect(log).not.toContain(h.api.secret);
    expect(log).not.toContain("Marka");
  });

  it("redacts tokens and keys in responses", async () => {
    h = await startHarness();
    h.api.routes.set("GET /api/social-accounts/s1", () => ({
      json: { id: "s1", accessToken: "EAAsecretvalue", tokenHealth: { state: "ok" } },
    }));
    const out = await call(h, "get_social_accounts_by_id", { id: "s1" });
    expect(out.text).not.toContain("EAAsecretvalue");
    expect(parse(out.text)).toMatchObject({ accessToken: "[gizli]", tokenHealth: { state: "ok" } });
  });

  it("encodes path parameters and sends JSON bodies", async () => {
    h = await startHarness();
    h.api.routes.set("PATCH /api/brands/a%2Fb", (req) => ({ json: { got: req.json } }));
    const out = await call(h, "patch_brands_by_id", { id: "a/b", body: { name: "Yeni" } });
    expect(parse(out.text)).toEqual({ got: { name: "Yeni" } });
  });

  it("explains that Studio is not running", async () => {
    h = await startHarness();
    await h.api.close();
    const out = await call(h, "get_brands");
    expect(out.isError).toBe(true);
    expect(out.text).toBe(STUDIO_DOWN_MESSAGE);
    expect(out.text).toContain("Studio açık değil: Mac uygulamasını başlatın");
    const status = await call(h, "studio_status");
    expect(status.isError).toBe(true);
    expect(parse(status.text)).toMatchObject({ up: false });
  });

  it("truncates large JSON and pages on with response_offset", async () => {
    h = await startHarness();
    const items = Array.from({ length: 2000 }, (_, i) => ({ id: `c${i}`, title: "x".repeat(40) }));
    h.api.routes.set("GET /api/contents", () => ({ json: { items, nextCursor: null } }));
    const first = await call(h, "get_contents");
    expect(first.text.length).toBeLessThan(MAX_RESULT_CHARS + 500);
    const match = /response_offset=(\d+)/.exec(first.text);
    expect(match).not.toBeNull();
    const second = await call(h, "get_contents", { response_offset: Number(match?.[1]) });
    expect(second.text.startsWith(first.text.slice(0, 10))).toBe(false);
    expect(second.text).toContain(`${MAX_RESULT_CHARS}-${2 * MAX_RESULT_CHARS}`);
  });

  it("saves binary responses to a file and inlines small images", async () => {
    h = await startHarness();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    h.api.routes.set("GET /api/assets/a1/thumbnail", () => ({ bytes: png, type: "image/png" }));
    const out = await call(h, "get_assets_thumbnail", { id: "a1" });
    const path = /saved to\): (.+)$/m.exec(out.text)?.[1] ?? "";
    expect(path.startsWith(join(h.tmpDir, "studio-mcp"))).toBe(true);
    expect(readFileSync(path)).toEqual(png);
    const image = out.content.find((c) => c.type === "image");
    expect(image?.mimeType).toBe("image/png");
    expect(Buffer.from(image?.data ?? "", "base64")).toEqual(png);
  });
});

describe("dangerous operations", () => {
  it("refuse without confirm: true and never reach the API", async () => {
    h = await startHarness();
    h.api.routes.set("DELETE /api/assets/a1", () => ({ json: { ok: true } }));
    const refused = await call(h, "delete_assets_by_id", { id: "a1" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("confirm: true");
    expect(h.api.requests).toHaveLength(0);
    expect(readFileSync(h.logFile, "utf8")).toContain("status=needs_confirm");

    const done = await call(h, "delete_assets_by_id", { id: "a1", confirm: true });
    expect(done.isError).toBe(false);
    expect(h.api.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["DELETE /api/assets/a1"]);
  });

  it("gate paid jobs by type and publish-now always", async () => {
    h = await startHarness();
    h.api.routes.set("POST /api/jobs", (req) => ({
      status: 201,
      json: { id: "j1", ...(req.json as object) },
    }));
    expect((await call(h, "post_jobs", { body: { type: "image.generate" } })).isError).toBe(true);
    expect((await call(h, "post_jobs", { body: { type: "demo.echo" } })).isError).toBe(false);
    expect(
      (await call(h, "post_jobs", { body: { type: "image.generate" }, confirm: true })).isError,
    ).toBe(false);
    expect((await call(h, "post_schedules_publish_now", { body: {} })).text).toContain(
      "Onay gerekli",
    );
    expect(h.api.requests).toHaveLength(2);
  });
});

describe("uploads", () => {
  it("studio_upload_file sends the file as multipart", async () => {
    h = await startHarness();
    const file = join(h.homeDir, "urun.png");
    writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9]));
    h.api.routes.set("POST /api/assets", (req) => ({
      status: 201,
      json: { id: "as1", contentType: req.headers["content-type"], size: req.body.length },
    }));
    const out = await call(h, "studio_upload_file", { path: file, brandId: "b1", kind: "image" });
    expect(out.isError).toBe(false);
    const sent = h.api.requests[0];
    expect(String(sent?.headers["content-type"])).toContain("multipart/form-data");
    const body = sent?.body.toString("latin1") ?? "";
    expect(body).toContain('name="file"; filename="urun.png"');
    expect(body).toContain("Content-Type: image/png");
    expect(body).toContain('name="brandId"');
    expect(body).toContain('name="kind"');
  });

  it("refuses files outside the home folder (also through the generated tool)", async () => {
    h = await startHarness();
    const secretFile = join(h.stateDir, "owner-secret");
    const a = await call(h, "studio_upload_file", { path: secretFile, brandId: "b1" });
    expect(a.isError).toBe(true);
    expect(a.text).toContain("reddedildi");
    const b = await call(h, "post_assets", { body: { file_path: "/etc/hosts", brandId: "b1" } });
    expect(b.isError).toBe(true);
    expect(h.api.requests).toHaveLength(0);
    expect(existsSync(secretFile)).toBe(true);
  });
});

describe("studio_wait_job", () => {
  it("polls until the job ends and reports progress", async () => {
    h = await startHarness();
    const states = [
      { status: "queued" },
      { status: "running", progress: 0.25, progressMessage: "Render" },
      { status: "running", progress: 0.75, progressMessage: "Kontrol" },
      { status: "succeeded", progress: 1, output: { assetIds: ["x"] } },
    ];
    let i = 0;
    h.api.routes.set("GET /api/jobs/j1", () => ({
      json: { id: "j1", type: "content.render", ...states[Math.min(i++, states.length - 1)] },
    }));
    const progress: { progress: number; message?: string }[] = [];
    const out = await call(h, "studio_wait_job", { jobId: "j1" }, (p) => progress.push(p));
    expect(out.isError).toBe(false);
    expect(parse(out.text)).toMatchObject({ done: true, job: { status: "succeeded" } });
    expect(progress.map((p) => p.progress)).toEqual([0, 25, 75, 100]);
    expect(progress[1]?.message).toBe("running: Render");
  });

  it("returns the current state when the time is up", async () => {
    h = await startHarness();
    h.api.routes.set("GET /api/jobs/j2", () => ({ json: { id: "j2", status: "running" } }));
    const out = await call(h, "studio_wait_job", { jobId: "j2", timeoutSeconds: 0.05 });
    expect(parse(out.text)).toMatchObject({ done: false, job: { status: "running" } });
  });

  it("marks failed jobs as errors", async () => {
    h = await startHarness();
    h.api.routes.set("GET /api/jobs/j3", () => ({
      json: { id: "j3", status: "failed", error: "boom" },
    }));
    const out = await call(h, "studio_wait_job", { jobId: "j3" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("boom");
  });
});

describe("studio_chat and studio_answer", () => {
  function chatApi(harness: Harness) {
    const state = {
      runStatus: "queued",
      polls: 0,
      parts: [] as Record<string, unknown>[],
      consentAnswered: null as boolean | null,
    };
    const routes = harness.api.routes;
    routes.set("POST /api/conversations", (req) => ({
      status: 201,
      json: { id: "cv1", brandId: (req.json as { brandId?: string }).brandId ?? null },
    }));
    routes.set("POST /api/conversations/cv1/messages", () => ({
      status: 201,
      json: {
        message: { id: "m1", role: "user" },
        run: { id: "r1", status: "queued" },
        replayed: false,
      },
    }));
    routes.set("GET /api/agent-runs/r1", () => {
      state.polls++;
      return { json: { id: "r1", status: state.runStatus, model: "sonnet", error: null } };
    });
    routes.set("GET /api/conversations/cv1/messages", () => ({
      json: {
        items: [
          {
            id: "m2",
            conversationId: "cv1",
            role: "assistant",
            status: state.runStatus === "completed" ? "complete" : "streaming",
            runId: "r1",
            parts: state.parts,
          },
          {
            id: "m1",
            conversationId: "cv1",
            role: "user",
            status: "complete",
            runId: null,
            parts: [],
          },
        ],
        nextCursor: null,
      },
    }));
    routes.set("POST /api/conversations/cv1/messages/m2/consent", (req) => {
      const body = req.json as { consentId: string; allow: boolean };
      state.consentAnswered = body.allow;
      state.parts = state.parts.map((p) =>
        p.type === "consent" ? { ...p, state: body.allow ? "allowed" : "denied" } : p,
      );
      state.parts.push({ type: "text", text: "Zamanlandı." });
      state.runStatus = "completed";
      return { json: { message: { id: "m2", runId: "r1", parts: state.parts } } };
    });
    return state;
  }

  it("creates a conversation, sends the message and waits for the reply", async () => {
    h = await startHarness();
    const state = chatApi(h);
    // The worker finishes after a few polls.
    h.api.routes.set("GET /api/agent-runs/r1", () => {
      state.polls++;
      if (state.polls === 2) {
        state.runStatus = "running";
        state.parts = [
          { type: "progress", stepId: "s", label: "Marka okunuyor", state: "running" },
        ];
      }
      if (state.polls >= 4) {
        state.runStatus = "completed";
        state.parts = [
          { type: "tool_step", tool: "list_posts", title: "Postlar", state: "done", input: "…" },
          { type: "text", text: "Merhaba, üç post hazır." },
          { type: "content_ref", contentId: "c1", version: 1, note: null },
        ];
      }
      return { json: { id: "r1", status: state.runStatus, model: "sonnet", error: null } };
    });
    const progress: string[] = [];
    const out = await call(h, "studio_chat", { text: "Üç post hazırla", brandId: "b1" }, (p) =>
      progress.push(p.message ?? ""),
    );
    expect(out.isError).toBe(false);
    const result = parse(out.text) as {
      conversationId: string;
      state: string;
      reply: { text: string; parts: Record<string, unknown>[] }[];
    };
    expect(result.conversationId).toBe("cv1");
    expect(result.state).toBe("completed");
    expect(result.reply[0]?.text).toBe("Merhaba, üç post hazır.");
    expect(result.reply[0]?.parts).toContainEqual({
      type: "tool_step",
      tool: "list_posts",
      title: "Postlar",
      state: "done",
    });
    expect(progress).toContain("Marka okunuyor");
    const sent = h.api.requests.find(
      (r) => r.path === "/api/conversations/cv1/messages" && r.method === "POST",
    );
    expect(sent?.json).toMatchObject({ text: "Üç post hazırla" });
    expect(
      String((sent?.json as { clientMessageId?: string } | undefined)?.clientMessageId),
    ).toMatch(/^mcp-/);
    const created = h.api.requests.find(
      (r) => r.path === "/api/conversations" && r.method === "POST",
    );
    expect(created?.json).toEqual({ brandId: "b1" });
  });

  it("stops at a consent card, refuses to allow without confirm, then allows and waits", async () => {
    h = await startHarness();
    const state = chatApi(h);
    state.runStatus = "running";
    state.parts = [
      {
        type: "consent",
        consentId: "k1",
        tool: "schedule_post",
        title: "Postu zamanla",
        detail: "Instagram, yarın 10:00",
        state: "pending",
        decidedAt: null,
      },
    ];
    const first = parse(
      (await call(h, "studio_chat", { conversationId: "cv1", text: "Yarın 10'da paylaş" })).text,
    ) as { state: string; waitingFor: Record<string, unknown>[] };
    expect(first.state).toBe("waiting_for_owner");
    expect(first.waitingFor).toEqual([
      expect.objectContaining({ kind: "consent", messageId: "m2", consentId: "k1" }),
    ]);

    const refused = await call(h, "studio_answer", {
      conversationId: "cv1",
      messageId: "m2",
      consentId: "k1",
      allow: true,
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("confirm: true");
    expect(state.consentAnswered).toBeNull();

    const allowed = await call(h, "studio_answer", {
      conversationId: "cv1",
      messageId: "m2",
      consentId: "k1",
      allow: true,
      confirm: true,
    });
    expect(state.consentAnswered).toBe(true);
    const result = parse(allowed.text) as { state: string; reply: { text: string }[] };
    expect(result.state).toBe("completed");
    expect(result.reply[0]?.text).toBe("Zamanlandı.");
  });

  it("denies a consent without confirm", async () => {
    h = await startHarness();
    const state = chatApi(h);
    state.runStatus = "running";
    state.parts = [{ type: "consent", consentId: "k1", tool: "x", title: "X", state: "pending" }];
    const out = await call(h, "studio_answer", {
      conversationId: "cv1",
      messageId: "m2",
      consentId: "k1",
      allow: false,
    });
    expect(out.isError).toBe(false);
    expect(state.consentAnswered).toBe(false);
  });

  it("answers a question card and waits for the new run", async () => {
    h = await startHarness();
    const state = chatApi(h);
    state.runStatus = "completed";
    h.api.routes.set("POST /api/conversations/cv1/messages/m2/answer", (req) => {
      expect(req.json).toEqual({ questionId: "q1", optionIds: ["a"] });
      return { json: { message: { id: "m2", runId: "r1", parts: [] }, run: { id: "r1" } } };
    });
    state.parts = [{ type: "text", text: "Tamam, A ile devam." }];
    const out = await call(h, "studio_answer", {
      conversationId: "cv1",
      messageId: "m2",
      questionId: "q1",
      optionIds: ["a"],
    });
    expect(parse(out.text)).toMatchObject({ state: "completed" });
  });

  it("needs exactly one of consentId / questionId", async () => {
    h = await startHarness();
    const out = await call(h, "studio_answer", { conversationId: "cv1", messageId: "m2" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("Geçersiz argüman");
  });
});

describe("studio_status and studio_brand_overview", () => {
  it("collects status from the AI and worker routes", async () => {
    h = await startHarness();
    h.api.routes.set("GET /api/health", () => ({ json: { ok: true, version: "1" } }));
    h.api.routes.set("GET /api/brands", () => ({
      json: { items: [{ id: "b1", name: "Marka", status: "active", kit: {} }], nextCursor: null },
    }));
    h.api.routes.set("GET /api/workers/claude", () => ({ json: { signedIn: true } }));
    h.api.routes.set("GET /api/workers/gemini", () => ({
      json: { apiKey: "AIzaXYZ", ready: true },
    }));
    h.api.routes.set("GET /api/ai/spend", () => ({ json: { monthUsd: 1.5 } }));
    const out = await call(h, "studio_status");
    const status = parse(out.text) as Record<string, unknown>;
    expect(status).toMatchObject({
      up: true,
      brands: [{ id: "b1", name: "Marka", status: "active" }],
      claude: { signedIn: true },
      gemini: { apiKey: "[gizli]", ready: true },
      aiSpend: { monthUsd: 1.5 },
      worker: { error: "HTTP 404" },
    });
  });

  it("gathers a brand in one call", async () => {
    h = await startHarness();
    h.api.routes.set("GET /api/brands/b1", () => ({ json: { id: "b1", name: "Marka" } }));
    h.api.routes.set("GET /api/brands/b1/kit", () => ({ json: { palette: ["#000"] } }));
    h.api.routes.set("GET /api/brands/b1/products", () => ({ json: { items: [{ id: "p1" }] } }));
    h.api.routes.set("GET /api/brands/b1/skills", () => ({ json: { items: [] } }));
    h.api.routes.set("GET /api/social-accounts", (req) => ({
      json: { items: [{ id: "s1", brandId: req.query.get("brandId"), accessToken: "t0k" }] },
    }));
    const out = parse((await call(h, "studio_brand_overview", { brandId: "b1" })).text);
    expect(out).toMatchObject({
      brand: { id: "b1" },
      kit: { palette: ["#000"] },
      currentProfile: null,
      products: { items: [{ id: "p1" }] },
      socialAccounts: { items: [{ id: "s1", brandId: "b1", accessToken: "[gizli]" }] },
    });
  });
});

describe("unknown tools", () => {
  it("answers with an error", async () => {
    h = await startHarness();
    const out = await call(h, "run_shell", { cmd: "ls" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("Bilinmeyen araç");
  });
});
