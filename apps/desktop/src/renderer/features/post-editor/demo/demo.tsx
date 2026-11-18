// `?demo=post-editor` (and `&format=story`): the canvas editor on a demo post with an in-memory
// API — for headless checks and for trying the editor without a running host.
import type { ApiClient } from "@studio/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState, useSyncExternalStore } from "react";
import { ApiContext } from "../../../lib/api.ts";
import { type EditorApi, PostEditor } from "../../post-detail/editor.ts";
import { PostEditorWorkspace } from "../workspace.tsx";
import { DemoApi, demoPost } from "./fixtures.ts";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

export function PostEditorDemo() {
  const format =
    new URLSearchParams(window.location.search).get("format") === "story" ? "story" : "carousel";
  const [state, setState] = useState<{ api: DemoApi; editor: PostEditor } | null>(null);
  useEffect(() => {
    let alive = true;
    void demoPost(format).then(({ content, version }) => {
      if (!alive) return;
      const api = new DemoApi(content, version);
      const editor = new PostEditor(api.client as unknown as EditorApi, content, version, {
        pollMs: 150,
      });
      (window as unknown as { __postEditorDemo: unknown }).__postEditorDemo = { api, editor };
      setState({ api, editor });
      void editor.load();
    });
    return () => {
      alive = false;
    };
  }, [format]);
  if (!state) return null;
  return (
    <QueryClientProvider client={queryClient}>
      <ApiContext.Provider value={state.api.client as unknown as ApiClient}>
        <DemoWorkspace editor={state.editor} />
      </ApiContext.Provider>
    </QueryClientProvider>
  );
}

function DemoWorkspace({ editor }: { editor: PostEditor }) {
  const snapshot = useSyncExternalStore(editor.subscribe, editor.getSnapshot);
  return (
    <PostEditorWorkspace
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
      onClose={() => undefined}
      onPreview={() => undefined}
    />
  );
}
