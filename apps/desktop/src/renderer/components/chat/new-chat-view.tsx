// The empty chat (Wecra "Chat – Boş"): Studio mark, greeting, one status line and suggestion
// pills in the middle; the composer at the bottom. The first send creates the conversation
// (with the brand picked in the title menu), sends the message and opens it.
import { useLayoutEffect, useRef, useState } from "react";
import { describeError, useApi } from "../../lib/api.ts";
import { saveChoicePatch } from "../../lib/models.ts";
import type { OutgoingMessage } from "../../lib/transcript.ts";
import { useAppStore } from "../../state/app-store.ts";
import {
  isHostUp,
  useAccounts,
  useAgentChoice,
  useBrands,
  useConversationUpdater,
  useHost,
  useJobs,
  useSettings,
} from "../../state/studio.tsx";
import { Button } from "../ui/controls.tsx";
import { StudioMark } from "../ui/icons.tsx";
import { COLUMN } from "./chat-view.tsx";
import { Composer, type ComposerHandle } from "./composer.tsx";
import { StatusLine } from "./status-line.tsx";

const SUGGESTIONS = ["Bu ayın postlarını planla", "Reels fikri üret", "Haftalık raporu hazırla"];

export function NewChatView() {
  const api = useApi();
  const host = useHost();
  const { settings, update } = useSettings();
  const brands = useBrands();
  const accounts = useAccounts();
  const { presence } = useJobs();
  const currentBrandId = useAppStore((s) => s.currentBrandId);
  const setCurrentBrand = useAppStore((s) => s.setCurrentBrand);
  const navigate = useAppStore((s) => s.navigate);
  const focusSignal = useAppStore((s) => s.focusComposer);
  const updateCached = useConversationUpdater();
  const [choice, setChoice] = useAgentChoice(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const composer = useRef<ComposerHandle | null>(null);
  /** A first send that failed after the conversation was made reuses it. */
  const created = useRef<{ id: string; brandId: string | null } | null>(null);

  useLayoutEffect(() => {
    composer.current?.focus();
  }, [focusSignal]);

  const active = (brands.data ?? []).filter((b) => b.status === "active");
  // Default brand: the last one used, else the first.
  useLayoutEffect(() => {
    if (!brands.data) return;
    if (!currentBrandId || !active.some((b) => b.id === currentBrandId))
      setCurrentBrand(active[0]?.id ?? null);
  }, [brands.data, currentBrandId, active, setCurrentBrand]);

  const brand = active.find((b) => b.id === currentBrandId);
  const connected = (accounts.data ?? []).filter(
    (a) => a.brandId === currentBrandId && a.status === "connected",
  ).length;
  const name = settings.ownerName.trim() || presence?.claude?.displayName || "Burak";
  const up = isHostUp(host);
  const statusParts = [
    brand ? `${brand.name} seçili` : "Marka seçilmedi",
    brand ? `${connected} hesap bağlı` : null,
    presence ? (presence.online ? "Mac hazır" : "Mac çevrimdışı") : null,
  ].filter(Boolean);

  const send = async (message: OutgoingMessage): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    setError(null);
    try {
      let id: string;
      if (created.current && created.current.brandId === currentBrandId) {
        id = created.current.id;
      } else {
        const title = message.text.trim().slice(0, 60);
        const conversation = await api.conversations.create({
          ...(currentBrandId ? { brandId: currentBrandId } : {}),
          ...(title ? { title } : {}),
        });
        updateCached(conversation);
        update(saveChoicePatch(choice, conversation.id));
        created.current = { id: conversation.id, brandId: currentBrandId };
        id = conversation.id;
      }
      await api.conversations.messages.send(id, {
        ...(message.text ? { text: message.text } : {}),
        ...(message.attachments.length ? { attachments: message.attachments } : {}),
        clientMessageId: message.clientMessageId,
        model: choice.model,
        effort: choice.effort,
      });
      created.current = null;
      navigate({ kind: "conversation", id });
      return true;
    } catch (e) {
      setError(describeError(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="flex flex-1 flex-col items-center justify-center px-6 pb-24">
        <StudioMark size={44} />
        <h1 className="mt-4 text-display font-semibold text-fg">Bugün ne üretelim, {name}?</h1>
        <p className="mt-2.5 text-body text-fg-2">
          {up
            ? statusParts.join(" · ")
            : host?.status.kind === "error"
              ? "Studio sunucusu başlatılamadı"
              : "Studio sunucusu hazırlanıyor…"}
        </p>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          {SUGGESTIONS.map((s) => (
            <Button key={s} variant="secondary" onClick={() => composer.current?.setText(s)}>
              {s}
            </Button>
          ))}
        </div>
      </div>
      <div className={`${COLUMN} pb-2.5`}>
        {error && (
          <div className="mb-2 px-3 text-footnote text-danger" role="alert">
            {error}
          </div>
        )}
        <Composer
          ref={composer}
          placeholder="Bir şey sor…"
          working={false}
          disabled={!up}
          brandId={currentBrandId}
          attachDisabledReason={
            currentBrandId ? null : "Görsel eklemek için önce başlıktaki menüden bir marka seç."
          }
          onSend={(message) => send(message)}
        />
        <div className="mt-1.5">
          <StatusLine choice={choice} onChoice={setChoice} presence={presence} />
        </div>
      </div>
    </div>
  );
}
