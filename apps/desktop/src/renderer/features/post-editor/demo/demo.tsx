// `?demo=post-editor` (and `&format=story`): the post workspace on a demo post with an
// in-memory API, inside the app's layout (a stand-in sidebar, the app's own top bar and right
// panel) — for headless checks and for trying the editor without a running host. Its Sohbet
// talks to an in-memory conversation (demo/chat-fixtures.ts).
import type { ApiClient } from "@studio/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState, useSyncExternalStore } from "react";
import { RightPanel } from "../../../components/panels/right-panel.tsx";
import { ResizeHandle } from "../../../components/shell/resize-handle.tsx";
import { SidebarRow, WindowControls } from "../../../components/shell/sidebar.tsx";
import { TopBar } from "../../../components/shell/top-bar.tsx";
import {
  IconCalendar,
  IconGrid,
  IconImage,
  IconPlus,
  IconSearch,
  IconTag,
} from "../../../components/ui/icons.tsx";
import { ToastHost } from "../../../components/ui/popover.tsx";
import { ApiContext } from "../../../lib/api.ts";
import {
  PANEL_MAX_WIDTH,
  PANEL_MIN_WIDTH,
  PANEL_WIDTH,
  panelWidthOf,
  useAppStore,
} from "../../../state/app-store.ts";
import { type EditorApi, PostEditor } from "../../post-detail/editor.ts";
import { WorkspaceSlot } from "../slots.tsx";
import { PostWorkspace } from "../workspace.tsx";
import { DemoChat } from "./chat-fixtures.ts";
import { DemoApi, demoPost } from "./fixtures.ts";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

export function PostEditorDemo() {
  const format =
    new URLSearchParams(window.location.search).get("format") === "story" ? "story" : "carousel";
  const [state, setState] = useState<{
    api: DemoApi;
    chat: DemoChat;
    editor: PostEditor;
  } | null>(null);
  useEffect(() => {
    let alive = true;
    // The demo stands where the board would be: the posts screen, nothing in the right panel.
    useAppStore.setState({ route: { kind: "posts" }, panelPresented: false });
    void demoPost(format).then(({ content, version }) => {
      if (!alive) return;
      const api = new DemoApi(content, version);
      const chat = new DemoChat();
      const editor = new PostEditor(api.client as unknown as EditorApi, content, version, {
        pollMs: 150,
      });
      (window as unknown as { __postEditorDemo: unknown }).__postEditorDemo = {
        api,
        chat,
        editor,
      };
      setState({ api, chat, editor });
      void editor.load();
    });
    return () => {
      alive = false;
    };
  }, [format]);
  if (!state) return null;
  const client = {
    ...state.api.client,
    conversations: state.chat.conversations,
    agentRuns: state.chat.agentRuns,
  };
  return (
    <QueryClientProvider client={queryClient}>
      <ApiContext.Provider value={client as unknown as ApiClient}>
        <DemoShell editor={state.editor} />
      </ApiContext.Provider>
    </QueryClientProvider>
  );
}

function DemoShell({ editor }: { editor: PostEditor }) {
  const snapshot = useSyncExternalStore(editor.subscribe, editor.getSnapshot);
  const panelPresented = useAppStore((s) => s.panelPresented);
  const panelWidth = useAppStore(panelWidthOf);
  const width = panelPresented ? panelWidth : null;
  return (
    <div className="flex h-full w-full overflow-hidden">
      <aside className="sidebar-surface flex h-full w-[265px] shrink-0 flex-col border-r border-hairline">
        <div className="drag">
          <WindowControls inset={false} placement="sidebar" />
        </div>
        <nav className="flex shrink-0 flex-col pt-0.5 pb-1">
          <SidebarRow icon={<IconPlus size={16} strokeWidth={1.5} />} label="Yeni sohbet" />
          <SidebarRow icon={<IconSearch size={16} strokeWidth={1.5} />} label="Ara" />
          <SidebarRow icon={<IconGrid size={16} strokeWidth={1.5} />} label="Postlar" selected />
          <SidebarRow icon={<IconCalendar size={16} strokeWidth={1.5} />} label="Takvim" />
          <SidebarRow icon={<IconImage size={16} strokeWidth={1.5} />} label="Medya" />
          <SidebarRow icon={<IconTag size={16} strokeWidth={1.5} />} label="Markalar" />
        </nav>
        {/* The open post's layers, where the app's sidebar has its conversations. */}
        <WorkspaceSlot name="sidebar" className="flex min-h-0 flex-1 flex-col" />
        <footer className="flex h-[52px] shrink-0 items-center border-t border-hairline px-4 text-footnote text-fg-3">
          Demo: sunucusuz düzenleyici
        </footer>
      </aside>
      <main className="relative flex min-w-0 flex-1 flex-col bg-page">
        {width !== null && (
          <ResizeHandle
            edge="left"
            label="Sağ paneli boyutlandır"
            width={width}
            min={PANEL_MIN_WIDTH}
            max={PANEL_MAX_WIDTH}
            style={{ right: width - 4, left: "auto" }}
            onResize={(w) => useAppStore.getState().setPanelWidth(w)}
            onReset={() => useAppStore.getState().setPanelWidth(PANEL_WIDTH)}
          />
        )}
        <TopBar panelWidth={width} />
        <div className="flex min-h-0 flex-1">
          <div className="relative flex min-w-0 flex-1 flex-col">
            <PostWorkspace
              editor={editor}
              snapshot={snapshot}
              brandName="Demo Agro"
              status={{
                label: snapshot.content.status === "approved" ? "Onaylandı" : "Taslak",
                tone: snapshot.content.status === "approved" ? "success" : "neutral",
              }}
              approvalFirst={snapshot.content.status !== "approved"}
              schedule={{
                label: "Zamanla",
                disabled: "Demo: zamanlama sunucu ister.",
                open: () => undefined,
              }}
              menu={[{ id: "demo", label: "Demo: post işlemleri sunucu ister", disabled: true }]}
              onClose={() =>
                useAppStore
                  .getState()
                  .showToast({ message: "Demo: geri dönülecek bir Postlar ekranı yok." })
              }
              onPreview={() => undefined}
            />
          </div>
          {width !== null && <RightPanel width={width} />}
        </div>
      </main>
      <ToastHost />
    </div>
  );
}
