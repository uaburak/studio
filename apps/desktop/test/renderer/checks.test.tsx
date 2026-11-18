import type {
  ApiClient,
  BrandCheckSettings,
  ContentCheckResult,
  ContentCheckRun,
} from "@studio/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkKeys } from "../../src/renderer/features/checks/checks-data.ts";
import {
  addBannedWords,
  approvalWarning,
  draftPut,
  fixableChecks,
  fromVersion,
  inVersion,
  listView,
  placeLabel,
  settingsDraft,
  summaryText,
  toggleCategory,
} from "../../src/renderer/features/checks/checks-model.ts";
import {
  ChecksList,
  ChecksPanel,
  useApproveGuard,
} from "../../src/renderer/features/checks/checks-panel.tsx";
import {
  ChecksSettingsForm,
  ChecksSettingsSection,
} from "../../src/renderer/features/checks/checks-settings.tsx";
import { usePostsStore } from "../../src/renderer/features/posts/store.ts";
import { ApiContext } from "../../src/renderer/lib/api.ts";

vi.mock("../../src/renderer/state/studio.tsx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/renderer/state/studio.tsx")>();
  return { ...actual, useJobs: () => ({ jobs: [], presence: null, controller: {} }) };
});

const T = "2026-11-18T09:00:00.000Z";

const result = (
  checkId: string,
  status: ContentCheckResult["status"],
  overrides: Partial<ContentCheckResult> = {},
): ContentCheckResult => ({
  checkId,
  category: checkId.split(".")[0] as ContentCheckResult["category"],
  status,
  message: `${checkId} mesajı`,
  refs: [],
  evidence: null,
  source: "deterministic",
  fixable: false,
  ...overrides,
});

function run(overrides: Partial<ContentCheckRun> = {}): ContentCheckRun {
  const results = overrides.results ?? [
    result("layout.overflow", "fail", {
      message: '"headline" metni kutusuna sığmıyor.',
      refs: [{ slide: 1, layer: "headline" }],
      fixable: true,
    }),
    result("text.language", "warn", {
      source: "model",
      message: "Yazım hatası. Öneri: Toprağınız",
    }),
    result("layout.safe-area", "fixed", { message: "Düzeltildi: taşındı" }),
    result("brand.fonts", "pass"),
    result("brand.voice", "skipped"),
  ];
  return {
    id: "run_1",
    contentId: "content_1",
    brandId: "brand_1",
    version: 3,
    versionId: "ver_3",
    trigger: "generate",
    jobId: "job_1",
    strictness: "standard",
    summary: {
      pass: results.filter((r) => r.status === "pass").length,
      warn: results.filter((r) => r.status === "warn").length,
      fail: results.filter((r) => r.status === "fail").length,
      fixed: results.filter((r) => r.status === "fixed").length,
      skipped: results.filter((r) => r.status === "skipped").length,
    },
    blocking: results.filter((r) => r.status === "fail").length,
    results,
    model: "gemini-2.5-flash-lite",
    fromVersion: null,
    fixedVersion: null,
    note: "",
    createdAt: T,
    ...overrides,
  };
}

function providers(ui: ReactNode, api: unknown = {}, seed?: (q: QueryClient) => void) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seed?.(queryClient);
  return render(
    <QueryClientProvider client={queryClient}>
      <ApiContext.Provider value={api as ApiClient}>{ui}</ApiContext.Provider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  usePostsStore.setState({ opened: null });
});

describe("checks model", () => {
  it("orders the list, summarises and finds what can be fixed", () => {
    const r = run();
    const view = listView(r);
    expect(view.problems.map((x) => x.status)).toEqual(["fail", "warn", "fixed"]);
    expect(view.rest.map((x) => x.status)).toEqual(["skipped", "pass"]);
    expect(summaryText(r)).toBe("1 başarısız · 1 uyarı · 1 düzeltildi · 1 geçti · 1 atlandı");
    expect(summaryText(run({ results: [result("brand.fonts", "pass")] }))).toBe(
      "Hepsi geçti · 1 geçti",
    );
    expect(fixableChecks(r)).toEqual(["layout.overflow"]);
    expect(placeLabel(view.problems[0] as ContentCheckResult)).toBe("Slayt 2 · headline");
    expect(placeLabel(result("text.hashtags", "warn"))).toBe("Açıklama");
  });

  it("warns before approval only when something blocks", () => {
    expect(approvalWarning(null)).toBeNull();
    expect(approvalWarning(run({ blocking: 0 }))).toBeNull();
    const warning = approvalWarning(run());
    expect(warning).toMatchObject({ blocking: 1, title: "v3'te 1 kontrol geçmedi" });
    expect(warning?.lines).toEqual(['Metin taşması: "headline" metni kutusuna sığmıyor.']);
    // Strict: warnings are listed too.
    const strict = approvalWarning(run({ strictness: "strict", blocking: 2 }));
    expect(strict?.lines).toHaveLength(2);
  });

  it("puts Turkish case endings after version numbers", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 40, 60, 70, 100, 13].map(inVersion)).toEqual([
      "v1'de",
      "v2'de",
      "v3'te",
      "v4'te",
      "v5'te",
      "v6'da",
      "v7'de",
      "v8'de",
      "v9'da",
      "v10'da",
      "v20'de",
      "v40'ta",
      "v60'ta",
      "v70'te",
      "v100'de",
      "v13'te",
    ]);
    expect(fromVersion(2)).toBe("v2'den");
  });

  it("edits the settings draft", () => {
    const settings: BrandCheckSettings = {
      brandId: "brand_1",
      disabledChecks: ["text.language", "nope"],
      bannedWords: ["bedava"],
      strictness: "standard",
      autoFix: true,
      updatedAt: null,
    };
    const draft = settingsDraft(settings);
    expect([...draft.disabled]).toEqual(["text.language"]);
    const off = toggleCategory(draft.disabled, ["brand.colors", "brand.fonts"], false);
    expect(
      draftPut({
        ...draft,
        disabled: off,
        bannedWords: addBannedWords(["bedava"], "Garanti, bedava\nmucize"),
      }),
    ).toEqual({
      disabledChecks: ["brand.colors", "brand.fonts", "text.language"],
      bannedWords: ["bedava", "Garanti", "mucize"],
      strictness: "standard",
      autoFix: true,
    });
  });
});

describe("ChecksList", () => {
  it("shows problems with their place, fixes and locates, folds the rest", async () => {
    const user = userEvent.setup();
    const onFix = vi.fn();
    const onLocate = vi.fn();
    const onRun = vi.fn();
    render(<ChecksList run={run()} version={3} onFix={onFix} onLocate={onLocate} onRun={onRun} />);
    const list = screen.getByRole("region", { name: "Kontroller" });
    expect(
      within(list).getByText("1 başarısız · 1 uyarı · 1 düzeltildi · 1 geçti · 1 atlandı"),
    ).toBeTruthy();
    expect(within(list).getByText("AI")).toBeTruthy();
    await user.click(within(list).getByRole("button", { name: "Düzelt" }));
    expect(onFix).toHaveBeenCalledWith(["layout.overflow"]);
    await user.click(within(list).getByTitle("Slaytta göster"));
    expect(onLocate).toHaveBeenCalledWith({ slide: 1, layer: "headline" });
    expect(within(list).queryByText("Marka fontları")).toBeNull();
    await user.click(within(list).getByRole("button", { name: /1 kontrol geçti · 1 atlandı/ }));
    expect(within(list).getByText("Marka fontları")).toBeTruthy();
    await user.click(within(list).getByRole("button", { name: "Yeniden çalıştır" }));
    expect(onRun).toHaveBeenCalled();
  });

  it("explains why it cannot fix and says when a version was never checked", () => {
    const { rerender } = render(
      <ChecksList run={run()} version={3} onFix={() => {}} fixBlocker="Eski sürüm." />,
    );
    expect(screen.getByRole("button", { name: "Düzelt" }).hasAttribute("disabled")).toBe(true);
    rerender(<ChecksList run={null} version={2} onRun={() => {}} running={null} />);
    expect(screen.getByText("v2 henüz denetlenmedi.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Kontrolleri çalıştır" })).toBeTruthy();
    rerender(<ChecksList run={null} version={2} running="Slaytlar ölçülüyor…" />);
    expect(screen.getAllByText(/Slaytlar ölçülüyor/).length).toBeGreaterThan(0);
  });
});

describe("ChecksPanel and the approve guard", () => {
  const snapshot = {
    content: { id: "content_1", brandId: "brand_1", status: "draft", type: "post" },
    current: { version: 3 },
    displayed: null,
  };

  it("runs the checks, fixes on the current version and opens the layer", async () => {
    const user = userEvent.setup();
    const create = vi.fn(async (input: unknown) => ({ id: "job_9", ...(input as object) }));
    const editor = { selectSlide: vi.fn(), selectLayer: vi.fn() };
    usePostsStore.setState({
      opened: { contentId: "content_1", tab: "post", origin: null },
    } as never);
    providers(<ChecksPanel snapshot={snapshot} editor={editor} />, { jobs: { create } }, (q) =>
      q.setQueryData(checkKeys.run("content_1", 3), run()),
    );
    await user.click(screen.getByRole("button", { name: "Düzelt" }));
    expect(create).toHaveBeenCalledWith({
      type: "content.check",
      brandId: "brand_1",
      contentId: "content_1",
      payload: { version: 3, fix: ["layout.overflow"], model: false },
    });
    await user.click(screen.getByRole("button", { name: "Yeniden çalıştır" }));
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ payload: { version: 3 } }));
    await user.click(screen.getByTitle("Slaytta göster"));
    expect(editor.selectSlide).toHaveBeenCalledWith(1);
    expect(editor.selectLayer).toHaveBeenCalledWith("headline");
    expect(usePostsStore.getState().opened?.tab).toBe("edit");
  });

  function GuardHarness({ approve }: { approve(): void }) {
    const guard = useApproveGuard(snapshot);
    return (
      <>
        <button type="button" onClick={() => guard.guard(approve)}>
          Onayla
        </button>
        {guard.dialog}
      </>
    );
  }

  it("asks before approving a version whose checks failed, and approves on override", async () => {
    const user = userEvent.setup();
    const approve = vi.fn();
    providers(<GuardHarness approve={approve} />, {}, (q) =>
      q.setQueryData(checkKeys.run("content_1", 3), run()),
    );
    await user.click(screen.getByRole("button", { name: "Onayla" }));
    expect(approve).not.toHaveBeenCalled();
    expect(screen.getByText("v3'te 1 kontrol geçmedi")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Yine de onayla" }));
    expect(approve).toHaveBeenCalledTimes(1);
  });

  it("approves right away when the checks passed or never ran", async () => {
    const user = userEvent.setup();
    const approve = vi.fn();
    providers(<GuardHarness approve={approve} />);
    await user.click(screen.getByRole("button", { name: "Onayla" }));
    expect(approve).toHaveBeenCalledTimes(1);
  });
});

describe("check settings", () => {
  it("switches a category off and adds banned words", async () => {
    const user = userEvent.setup();
    let draft = settingsDraft({
      brandId: "brand_1",
      disabledChecks: [],
      bannedWords: [],
      strictness: "standard",
      autoFix: true,
      updatedAt: null,
    });
    const onChange = vi.fn((next: typeof draft) => {
      draft = next;
    });
    const { rerender } = render(<ChecksSettingsForm draft={draft} onChange={onChange} />);
    await user.click(screen.getByRole("switch", { name: "Marka uyumu kontrolleri" }));
    rerender(<ChecksSettingsForm draft={draft} onChange={onChange} />);
    expect([...draft.disabled].sort()).toEqual([
      "brand.colors",
      "brand.fonts",
      "brand.logo",
      "brand.voice",
    ]);
    await user.type(
      screen.getByRole("textbox", { name: "Yasak kelime ekle" }),
      "bedava, garanti{Enter}",
    );
    rerender(<ChecksSettingsForm draft={draft} onChange={onChange} />);
    expect(draft.bannedWords).toEqual(["bedava", "garanti"]);
    expect(screen.getByRole("button", { name: "bedava kaldır" })).toBeTruthy();
  });

  it("saves changes as you go", async () => {
    const user = userEvent.setup();
    const put = vi.fn(async (_brandId: string, input: unknown) => ({
      brandId: "brand_1",
      ...(input as object),
      updatedAt: T,
    }));
    providers(
      <ChecksSettingsSection brand={{ id: "brand_1" }} />,
      { brandCheckSettings: { put } },
      (q) =>
        q.setQueryData(checkKeys.settings("brand_1"), {
          brandId: "brand_1",
          disabledChecks: [],
          bannedWords: [],
          strictness: "standard",
          autoFix: true,
          updatedAt: null,
        } satisfies BrandCheckSettings),
    );
    await user.click(screen.getByRole("radio", { name: "Sıkı" }));
    await waitFor(() => expect(put).toHaveBeenCalled(), { timeout: 2_000 });
    expect(put.mock.calls[0]?.[1]).toMatchObject({ strictness: "strict" });
    await act(async () => {});
    expect(await screen.findByText("Kaydedildi")).toBeTruthy();
  });
});
