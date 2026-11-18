import type { ApiClient } from "@studio/contract";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StepLine, WorkingLine } from "../../src/renderer/components/chat/blocks.tsx";
import { Composer } from "../../src/renderer/components/chat/composer.tsx";
import { Lightbox } from "../../src/renderer/components/chat/lightbox.tsx";
import {
  isRunInHeading,
  Markdown,
  parseMarkdown,
} from "../../src/renderer/components/chat/markdown.tsx";
import { modelMenu, StatusLine } from "../../src/renderer/components/chat/status-line.tsx";
import {
  ConversationRow,
  SidebarBody,
  SidebarRow,
  WindowControls,
} from "../../src/renderer/components/shell/sidebar.tsx";
import {
  Button,
  Checkbox,
  IconButton,
  SegmentedControl,
  Switch,
  TagPill,
  TextField,
  UsageRing,
} from "../../src/renderer/components/ui/controls.tsx";
import { Menu, MenuButton, type MenuEntry } from "../../src/renderer/components/ui/menu.tsx";
import { InSlot } from "../../src/renderer/features/post-editor/slots.tsx";
import { useWorkspaceStore } from "../../src/renderer/features/post-editor/workspace-store.ts";
import { ApiContext } from "../../src/renderer/lib/api.ts";
import { createFallbackBridge, setBridge } from "../../src/renderer/lib/bridge.ts";
import { useAppStore } from "../../src/renderer/state/app-store.ts";
import { alias, conversation, presence } from "./fixtures.ts";

afterEach(() => {
  setBridge(undefined);
  useAppStore.setState({ lightbox: null, toasts: [] });
});

function withApi(ui: ReactNode, api: Partial<ApiClient> = {}) {
  return render(<ApiContext.Provider value={api as ApiClient}>{ui}</ApiContext.Provider>);
}

describe("controls", () => {
  it("buttons are capsules with variant, disabled and click", async () => {
    const onClick = vi.fn();
    render(
      <>
        <Button variant="primary" onClick={onClick}>
          Kaydet
        </Button>
        <Button variant="danger" disabled>
          Sil
        </Button>
      </>,
    );
    const save = screen.getByRole("button", { name: "Kaydet" });
    expect(save).toHaveClass("rounded-full", "bg-accent");
    expect(save).toHaveStyle({ height: "28px" });
    await userEvent.click(save);
    expect(onClick).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Sil" })).toBeDisabled();
  });

  it("icon buttons expose their label and selected state", () => {
    render(<IconButton icon={<span />} label="Ayrıntılar" selected tooltip={false} size={32} />);
    const b = screen.getByRole("button", { name: "Ayrıntılar" });
    expect(b).toHaveAttribute("aria-pressed", "true");
    expect(b).toHaveStyle({ width: "32px", height: "32px" });
  });

  it("segmented control changes with clicks and arrow keys", async () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl
        label="Mod"
        value="chat"
        onChange={onChange}
        options={[
          { value: "chat", label: "Sohbet" },
          { value: "posts", label: "Postlar" },
        ]}
      />,
    );
    expect(screen.getByRole("radio", { name: "Sohbet" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByRole("radio", { name: "Postlar" }));
    expect(onChange).toHaveBeenLastCalledWith("posts");
    fireEvent.keyDown(screen.getByRole("radio", { name: "Sohbet" }), { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("posts");
  });

  it("switch, checkbox, text field, tag pill and usage ring", async () => {
    const toggle = vi.fn();
    const check = vi.fn();
    render(
      <>
        <Switch label="Bildirimler" checked={false} onChange={toggle} />
        <Checkbox label="Seç" checked onChange={check} />
        <TextField placeholder="Örn. MTM Agro" disabled />
        <TagPill tone="success">Bağlı</TagPill>
        <UsageRing percent={95} warning />
      </>,
    );
    await userEvent.click(screen.getByRole("switch", { name: "Bildirimler" }));
    expect(toggle).toHaveBeenCalledWith(true);
    await userEvent.click(screen.getByRole("checkbox", { name: "Seç" }));
    expect(check).toHaveBeenCalledWith(false);
    expect(screen.getByPlaceholderText("Örn. MTM Agro")).toBeDisabled();
    expect(screen.getByText("Bağlı")).toHaveClass("text-success");
  });
});

describe("menus", () => {
  const picked: string[] = [];
  const entries: MenuEntry[] = [
    {
      id: "rename",
      label: "Yeniden adlandır",
      shortcut: "R",
      onSelect: () => picked.push("rename"),
    },
    { id: "fork", label: "Çatalla", shortcut: "F", disabled: true },
    { type: "separator" },
    {
      id: "more",
      label: "Farklı aç",
      submenu: [{ id: "window", label: "Yeni pencere", onSelect: () => picked.push("window") }],
    },
    {
      id: "delete",
      label: "Sil",
      shortcut: "D",
      danger: true,
      onSelect: () => picked.push("delete"),
    },
  ];

  function renderMenu() {
    return render(
      <MenuButton entries={entries} label="Sohbet">
        {({ ref, onClick, onKeyDown, open: _open, ...aria }) => (
          <button ref={ref} type="button" onClick={onClick} onKeyDown={onKeyDown} {...aria}>
            Başlık
          </button>
        )}
      </MenuButton>,
    );
  }

  it("opens from the keyboard, skips disabled items and picks with Enter", async () => {
    picked.length = 0;
    renderMenu();
    const trigger = screen.getByRole("button", { name: "Başlık" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const menu = await screen.findByRole("menu");
    const items = within(menu).getAllByRole("menuitem");
    expect(items[0]).toHaveAttribute("data-active");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(items[2]).toHaveAttribute("data-active"); // "Çatalla" is disabled
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    fireEvent.keyDown(menu, { key: "Enter" });
    expect(picked).toEqual(["delete"]);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("shortcut letters pick items; Escape closes", async () => {
    picked.length = 0;
    renderMenu();
    await userEvent.click(screen.getByRole("button", { name: "Başlık" }));
    fireEvent.keyDown(screen.getByRole("menu"), { key: "r" });
    expect(picked).toEqual(["rename"]);
    await userEvent.click(screen.getByRole("button", { name: "Başlık" }));
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("submenus open with ArrowRight and close with ArrowLeft", async () => {
    picked.length = 0;
    renderMenu();
    fireEvent.keyDown(screen.getByRole("button", { name: "Başlık" }), { key: "Enter" });
    const menu = await screen.findByRole("menu");
    fireEvent.keyDown(menu, { key: "End" });
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    fireEvent.keyDown(menu, { key: "ArrowRight" });
    const menus = screen.getAllByRole("menu");
    expect(menus).toHaveLength(2);
    fireEvent.keyDown(menus[1] as HTMLElement, { key: "ArrowLeft" });
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    fireEvent.keyDown(menu, { key: "ArrowRight" });
    fireEvent.keyDown(screen.getAllByRole("menu")[1] as HTMLElement, { key: "Enter" });
    expect(picked).toEqual(["window"]);
  });

  it("the model menu checks the current model and effort", () => {
    const entries = modelMenu({ model: "sonnet", effort: "high" }, () => undefined);
    render(<Menu inline open anchor={null} entries={entries} onClose={() => undefined} />);
    const sonnet = screen.getByRole("menuitem", { name: /Sonnet 5/ });
    expect(sonnet.querySelector("svg")).not.toBeNull();
    const effort = screen
      .getAllByRole("menuitem")
      .find((m) => m.textContent?.includes("Efor · Yüksek"));
    expect(effort).toHaveAttribute("aria-haspopup", "menu");
  });
});

describe("composer", () => {
  it("sends with Enter, keeps Shift+Enter as a new line and clears", async () => {
    const onSend = vi.fn(async () => true);
    withApi(<Composer placeholder="Bir şey sor…" working={false} brandId="b1" onSend={onSend} />);
    const box = screen.getByRole("textbox", { name: "Mesaj" });
    expect(screen.getByRole("button", { name: "Gönder" })).toBeDisabled();
    await userEvent.type(box, "merhaba{Shift>}{Enter}{/Shift}dünya");
    expect(box).toHaveValue("merhaba\ndünya");
    expect(screen.getByRole("button", { name: "Gönder" })).toBeEnabled();
    await userEvent.type(box, "{Enter}");
    expect(onSend).toHaveBeenCalledWith(
      expect.objectContaining({ text: "merhaba\ndünya", attachments: [] }),
      { queue: false },
    );
    expect(box).toHaveValue("");
  });

  it("keeps the text when the send failed", async () => {
    const onSend = vi.fn(async () => false);
    withApi(<Composer placeholder="x" working={false} brandId="b1" onSend={onSend} />);
    const box = screen.getByRole("textbox", { name: "Mesaj" });
    await userEvent.type(box, "kaybolmasın{Enter}");
    expect(box).toHaveValue("kaybolmasın");
  });

  it("shows stop while a reply runs and queues with ⌘↩", async () => {
    const onSend = vi.fn(async () => true);
    const onStop = vi.fn();
    withApi(
      <Composer
        placeholder="x"
        workingPlaceholder="↩ gönder, ⌘↩ sıraya al"
        working
        brandId="b1"
        onSend={onSend}
        onStop={onStop}
      />,
    );
    expect(screen.getByPlaceholderText("↩ gönder, ⌘↩ sıraya al")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Durdur" }));
    expect(onStop).toHaveBeenCalledOnce();
    await userEvent.type(screen.getByRole("textbox"), "sonra{Meta>}{Enter}{/Meta}");
    expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ text: "sonra" }), {
      queue: true,
    });
  });

  it("suggests @aliases and inserts the picked one", async () => {
    withApi(
      <Composer
        placeholder="x"
        working={false}
        brandId="b1"
        aliases={[alias("image"), alias("logo")]}
        onSend={async () => true}
      />,
    );
    const box = screen.getByRole("textbox");
    await userEvent.type(box, "şuna bak @im");
    const list = await screen.findByRole("listbox", { name: "Görseller" });
    expect(
      within(list)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["@image"]);
    await userEvent.keyboard("{Enter}");
    expect(box).toHaveValue("şuna bak @image ");
  });

  it("uploads attached images and sends them with their alias", async () => {
    const upload = vi.fn(async () => ({ id: "asset-1" }));
    const onSend = vi.fn(async () => true);
    withApi(<Composer placeholder="x" working={false} brandId="b1" onSend={onSend} />, {
      assets: { upload } as unknown as ApiClient["assets"],
    });
    const file = new File(["png"], "foto.png", { type: "image/png" });
    fireEvent.paste(screen.getByRole("textbox"), { clipboardData: { files: [file] } });
    expect(await screen.findByText("@image")).toBeInTheDocument();
    expect(upload).toHaveBeenCalledWith(expect.objectContaining({ brandId: "b1", kind: "image" }));
    await act(async () => undefined);
    await userEvent.click(screen.getByRole("button", { name: "Gönder" }));
    expect(onSend).toHaveBeenCalledWith(
      expect.objectContaining({ attachments: [{ assetId: "asset-1", alias: "image" }] }),
      { queue: false },
    );
  });

  it("refuses attachments without a brand", () => {
    withApi(
      <Composer
        placeholder="x"
        working={false}
        brandId={null}
        attachDisabledReason="Önce bir marka seç."
        onSend={async () => true}
      />,
    );
    expect(screen.getByRole("button", { name: "Önce bir marka seç." })).toBeDisabled();
  });
});

describe("markdown", () => {
  const source = `**Kasım planı hazır**

# Başlık

- Instagram: \`kaydırmalı\`
  - 18 Kasım
1. bir

| Gün | Post |
| --- | --- |
| 18 Kas | Hasat |

\`\`\`json
{"a": 1}
\`\`\`

[Rehber](https://example.com) ve @image`;

  it("renders headings, nested lists, inline code, tables, code blocks and links", async () => {
    const openExternal = vi.fn(async () => undefined);
    setBridge({ ...createFallbackBridge(), openExternal });
    const onMention = vi.fn();
    const { container } = render(
      <Markdown source={source} env={{ aliases: [alias("image")], onMention }} />,
    );
    expect(screen.getByText("Kasım planı hazır").tagName).toBe("STRONG");
    expect(screen.getByRole("heading", { name: "Başlık" })).toBeInTheDocument();
    expect(container.querySelectorAll("ul ul li")).toHaveLength(1);
    expect(container.querySelector("ul ul li span span")).toHaveClass("border");
    expect(screen.getByText("kaydırmalı").tagName).toBe("CODE");
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Gün", "Post"]);
    expect(screen.getByText('{"a": 1}')).toBeInTheDocument();
    await userEvent.click(screen.getByText("Rehber"));
    expect(openExternal).toHaveBeenCalledWith("https://example.com");
    await userEvent.click(screen.getByRole("button", { name: "@image" }));
    expect(onMention).toHaveBeenCalledWith("a-image");
  });

  it("copies code blocks", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<Markdown source={"```\nnpm test\n```"} />);
    await userEvent.click(screen.getByRole("button", { name: /Kopyala/ }));
    expect(writeText).toHaveBeenCalledWith("npm test");
    expect(screen.getByRole("button", { name: /Kopyalandı/ })).toBeInTheDocument();
  });

  it("treats a bold-only paragraph as a heading and survives partial input", () => {
    const [first] = parseMarkdown("**Plan:**\n\nmetin");
    expect(first && isRunInHeading(first)).toBe(true);
    expect(() => render(<Markdown source={"- yarım **kalın\n```js\nconst a"} />)).not.toThrow();
  });
});

describe("chat lines", () => {
  it("working line shows the step and the elapsed time", () => {
    render(
      <WorkingLine
        working={{
          phase: { kind: "step", label: "Görseller üretiliyor" },
          since: Date.now() - 69_000,
          cancellable: false,
          groupKey: null,
        }}
      />,
    );
    expect(screen.getByText("Görseller üretiliyor")).toHaveClass("text-fg");
    expect(screen.getByText(/1dk 9sn|1dk 10sn/)).toBeInTheDocument();
    expect(screen.getByTestId("working-dots")).toHaveClass("text-accent");
  });

  it("step line toggles its list", async () => {
    const onToggle = vi.fn();
    render(
      <StepLine
        group={{
          key: "g",
          steps: [],
          isExpanded: false,
          thumbnails: [],
          isLive: false,
          summary: "2 görsel üretti",
          hasErrors: false,
        }}
        onToggle={onToggle}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /2 görsel üretti/ }));
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("status line shows model + effort and opens the usage card", async () => {
    const usage = {
      source: "x",
      observedAt: "2026-11-17T10:00:00.000Z",
      windows: [{ kind: "five_hour" as const, usedPercent: 45, limited: false }],
    };
    render(
      <StatusLine
        choice={{ model: "opus", effort: "medium" }}
        onChoice={() => undefined}
        presence={{ ...presence, usage }}
      />,
    );
    expect(screen.getByText("Opus 5.5")).toBeInTheDocument();
    expect(screen.getByText("Orta")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Kullanım %45" }));
    expect(await screen.findByText("5 saatlik limit")).toBeInTheDocument();
    expect(screen.getByText("%45")).toBeInTheDocument();
  });
});

describe("sidebar rows", () => {
  it("a conversation row shows its menu button and running dots", async () => {
    const onOpen = vi.fn();
    render(
      <ConversationRow
        conversation={conversation({ activeRunId: "r1" })}
        selected
        running
        onOpen={onOpen}
        menu={[{ id: "x", label: "Arşivle" }]}
      />,
    );
    const row = screen.getByRole("button", { name: /Kasım kampanya postları/ });
    expect(row).toHaveAttribute("aria-current", "page");
    expect(screen.getByTestId("working-dots")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Sohbet seçenekleri" }));
    expect(onOpen).not.toHaveBeenCalled();
    expect(await screen.findByRole("menuitem", { name: "Arşivle" })).toBeInTheDocument();
    render(<SidebarRow label="Ara" onClick={onOpen} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "Ara" }), { key: "Enter" });
    expect(onOpen).toHaveBeenCalledOnce();
  });
});

describe("sidebar", () => {
  afterEach(() => {
    useWorkspaceStore.setState({ active: null });
    useAppStore.setState({ back: [], forward: [] });
  });

  it("puts back / forward at the right edge of its top-bar segment; together when hidden", async () => {
    useAppStore.setState({ back: [{ route: { kind: "posts" }, post: null }], forward: [] });
    const { unmount } = render(<WindowControls inset placement="sidebar" />);
    const row = document.querySelector('[data-window-controls="sidebar"]') as HTMLElement;
    const toggle = within(row).getByRole("button", { name: "Kenar çubuğu" });
    const nav = row.querySelector("[data-history-nav]") as HTMLElement;
    // Toggle first (after the traffic lights), then a spacer that pushes ‹ › to the right edge.
    expect(row.firstElementChild).toBe(toggle);
    expect(row.lastElementChild).toBe(nav);
    expect(toggle.nextElementSibling).toHaveClass("flex-1");
    expect(row).toHaveClass("pr-2");
    expect(row).toHaveStyle({ paddingLeft: "94px" });
    expect(within(nav).getByRole("button", { name: "Geri" })).toBeEnabled();
    expect(within(nav).getByRole("button", { name: "İleri" })).toBeDisabled();
    unmount();

    // The sidebar hidden: the three together in the top bar (as before).
    render(<WindowControls inset={false} />);
    const bar = document.querySelector('[data-window-controls="top-bar"]') as HTMLElement;
    expect(bar.querySelector(".flex-1")).toBeNull();
    expect(
      within(bar)
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Kenar çubuğu", "Geri", "İleri"]);
  });

  it("shows the open post's layers where the conversations are, and gives them back", () => {
    render(
      <>
        <SidebarBody>
          <section aria-label="Kasım Ajans">Sohbetler</section>
        </SidebarBody>
        <InSlot name="sidebar">
          <section aria-label="Katmanlar">Kare 1</section>
        </InSlot>
      </>,
    );
    expect(screen.getByRole("region", { name: "Kasım Ajans" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Katmanlar" })).toBeNull();

    act(() => useWorkspaceStore.getState().setActive("p1"));
    expect(screen.queryByRole("region", { name: "Kasım Ajans" })).toBeNull();
    const slot = document.querySelector('[data-workspace-slot="sidebar"]') as HTMLElement;
    expect(within(slot).getByRole("region", { name: "Katmanlar" })).toBeInTheDocument();

    act(() => useWorkspaceStore.getState().setActive(null));
    expect(screen.getByRole("region", { name: "Kasım Ajans" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Katmanlar" })).toBeNull();
  });
});

describe("lightbox", () => {
  it("pages with the arrow keys and closes with Escape", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    useAppStore.getState().openLightbox({
      images: [
        { assetId: "a", url: "data:,a", caption: "@bir" },
        { assetId: "b", url: "data:,b", caption: "@iki" },
        { assetId: "c", url: "data:,c", caption: "@üç" },
      ],
      index: 1,
    });
    render(<Lightbox />);
    expect(screen.getByText("2 / 3")).toBeInTheDocument();
    expect(screen.getByText("@iki")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByText("3 / 3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sonraki" })).toBeDisabled();
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(screen.getByText("1 / 3")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(useAppStore.getState().lightbox).toBeNull();
    vi.useRealTimers();
  });
});
