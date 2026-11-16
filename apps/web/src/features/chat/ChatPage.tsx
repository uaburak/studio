import {
  type AgentEffort,
  type AgentModel,
  aliasBaseFor,
  applyConversationStreamMessage,
  autoAlias,
  type Conversation,
  type ConversationAlias,
  type ConversationState,
  isValidAlias,
  type JobWatchStatus,
  type Message,
  type Plan,
} from "@studio/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useApi } from "../../api.ts";
import {
  IconArchive,
  IconChat,
  IconClose,
  IconEdit,
  IconPlus,
  IconSend,
  IconStop,
  IconUpload,
} from "../../components/icons.tsx";
import { BrandMark, PageHeader } from "../../components/page.tsx";
import { EmptyState, ErrorState, InlineError, SkeletonRows } from "../../components/states.tsx";
import { useToast } from "../../components/toast.tsx";
import {
  Badge,
  Button,
  Card,
  cx,
  FilterSelect,
  IconButton,
  Input,
  KeyValue,
  Mono,
  Progress,
  Spinner,
  Textarea,
} from "../../components/ui.tsx";
import { useBrandName, useBrands } from "../../lib/brand-context.tsx";
import { formatDateTime, formatRelative } from "../../lib/datetime.ts";
import { formatDuration } from "../../lib/format.ts";
import { AGENT_EFFORT_OPTIONS, AGENT_MODEL_OPTIONS } from "../../lib/labels.ts";
import { useLiveJobs } from "../../lib/live-jobs.tsx";
import { queryKeys } from "../../lib/query-keys.ts";
import { checkFile, readMediaMetadata, withMimeType } from "../media/upload.ts";
import { MessageBubble } from "./MessageParts.tsx";

interface StagedAttachment {
  assetId: string;
  filename: string;
  mimeType: string;
  alias: string;
}

export function ChatPage() {
  const { conversationId: routeConvId } = useParams();
  const navigate = useNavigate();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const { brandId, activeBrands } = useBrands();
  const brandName = useBrandName();
  const { presence, summary } = useLiveJobs();

  const [statusFilter, setStatusFilter] = useState<"active" | "archived">("active");
  const [model, setModel] = useState<AgentModel | "">("");
  const [effort, setEffort] = useState<AgentEffort | "">("");
  const [text, setText] = useState("");
  const [staged, setStaged] = useState<StagedAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [showUsage, setShowUsage] = useState(false);
  const [renamingConv, setRenamingConv] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [renamingAliasId, setRenamingAliasId] = useState<string | null>(null);
  const [aliasDraft, setAliasDraft] = useState("");

  const fileInputRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const listFilters = { brandId: brandId ?? undefined, status: statusFilter };
  const convList = useQuery({
    queryKey: queryKeys.conversations.list(listFilters),
    queryFn: ({ signal }) => api.conversations.list({ ...listFilters, limit: 50 }, { signal }),
  });

  const conversations = convList.data?.items ?? [];
  const activeId = routeConvId ?? conversations[0]?.id ?? null;

  const createConv = useMutation({
    mutationFn: (targetBrandId?: string) =>
      api.conversations.create({
        ...(targetBrandId ? { brandId: targetBrandId } : brandId ? { brandId } : {}),
      }),
    onSuccess: (created) => {
      void qc.invalidateQueries({ queryKey: queryKeys.conversations.all });
      navigate(`/chat/${created.id}`);
    },
    onError: (e) => toast.error(e, "Sohbet oluşturulamadı"),
  });

  // Live stream state via applyConversationStreamMessage
  const [streamState, setStreamState] = useState<ConversationState | null>(null);
  const [wsStatus, setWsStatus] = useState<JobWatchStatus>("closed");

  useEffect(() => {
    setStreamState(null);
    if (!activeId) {
      setWsStatus("closed");
      return;
    }
    const watchFn = api.conversations?.watch;
    if (typeof watchFn !== "function") {
      setWsStatus("closed");
      return;
    }
    let watch: { close(): void } | undefined;
    try {
      watch = watchFn(activeId, {
        onStatus: setWsStatus,
        onMessage: (msg) => {
          setStreamState((prev) => applyConversationStreamMessage(prev, msg));
        },
      });
    } catch {
      setWsStatus("closed");
    }
    return () => {
      watch?.close();
    };
  }, [api, activeId]);

  // REST fallback queries when stream snapshot hasn't arrived yet
  const restConv = useQuery({
    queryKey: queryKeys.conversations.one(activeId ?? ""),
    queryFn: ({ signal }) => api.conversations.get(activeId ?? "", { signal }),
    enabled: Boolean(activeId) && streamState === null,
  });

  const restMessages = useQuery({
    queryKey: queryKeys.conversations.messages(activeId ?? ""),
    queryFn: ({ signal }) =>
      api.conversations.messages.list(activeId ?? "", { limit: 50 }, { signal }),
    enabled: Boolean(activeId) && streamState === null,
    refetchInterval: wsStatus !== "open" && restConv.data?.activeRunId ? 2500 : false,
  });

  const restAliases = useQuery({
    queryKey: queryKeys.conversations.aliases(activeId ?? ""),
    queryFn: ({ signal }) => api.conversations.aliases.list(activeId ?? "", { signal }),
    enabled: Boolean(activeId) && streamState === null,
  });

  const restPlans = useQuery({
    queryKey: queryKeys.plans.list({ conversationId: activeId ?? "" }),
    queryFn: ({ signal }) =>
      api.plans.list({ conversationId: activeId ?? "", limit: 20 }, { signal }),
    enabled: Boolean(activeId) && streamState === null,
  });

  const runsQuery = useQuery({
    queryKey: queryKeys.conversations.runs(activeId ?? ""),
    queryFn: ({ signal }) => api.conversations.runs(activeId ?? "", { limit: 20 }, { signal }),
    enabled: Boolean(activeId) && showUsage,
  });

  const conversation: Conversation | null = streamState?.conversation ?? restConv.data ?? null;

  // Local overrides when mutations return updated Message/Plan before WS frame arrives
  const [localMessages, setLocalMessages] = useState<Map<string, Message>>(() => new Map());
  const [localPlans, setLocalPlans] = useState<Map<string, Plan>>(() => new Map());
  const [olderMessages, setOlderMessages] = useState<Message[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);

  useEffect(() => {
    setLocalMessages(new Map());
    setLocalPlans(new Map());
    setOlderMessages([]);
    setOlderCursor(null);
    setRenamingConv(false);
  }, [activeId]);

  useEffect(() => {
    if (restMessages.data?.nextCursor && olderCursor === null && olderMessages.length === 0) {
      setOlderCursor(restMessages.data.nextCursor);
    }
  }, [restMessages.data?.nextCursor, olderCursor, olderMessages.length]);

  const messages = useMemo(() => {
    const base = streamState
      ? streamState.messages
      : [...(restMessages.data?.items ?? [])].reverse();
    const combined = [...olderMessages, ...base];
    const seen = new Set<string>();
    const deduped: Message[] = [];
    for (const m of combined) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      deduped.push(localMessages.get(m.id) ?? m);
    }
    return deduped;
  }, [streamState, restMessages.data, olderMessages, localMessages]);

  const aliases: ConversationAlias[] = useMemo(
    () => streamState?.aliases ?? restAliases.data?.items ?? [],
    [streamState?.aliases, restAliases.data],
  );

  const plans: Plan[] = useMemo(() => {
    const base = streamState?.plans ?? restPlans.data?.items ?? [];
    const map = new Map<string, Plan>();
    for (const p of base) map.set(p.id, p);
    for (const [id, p] of localPlans) map.set(id, p);
    return [...map.values()];
  }, [streamState?.plans, restPlans.data, localPlans]);

  const activeRunId = streamState?.activeRun?.id ?? conversation?.activeRunId ?? null;

  const loadOlder = useMutation({
    mutationFn: async () => {
      if (!activeId) return null;
      const cursor = olderCursor ?? restMessages.data?.nextCursor ?? undefined;
      return api.conversations.messages.list(activeId, {
        limit: 30,
        ...(cursor ? { cursor } : {}),
      });
    },
    onSuccess: (res) => {
      if (!res) return;
      const chron = [...res.items].reverse();
      setOlderMessages((prev) => [...chron, ...prev]);
      setOlderCursor(res.nextCursor);
    },
  });

  const cancelRun = useMutation({
    mutationFn: (runId: string) => api.agentRuns.cancel(runId),
    onSuccess: () => {
      toast.success("Tur durduruldu");
      if (activeId) {
        void qc.invalidateQueries({ queryKey: queryKeys.conversations.one(activeId) });
        void qc.invalidateQueries({ queryKey: queryKeys.conversations.messages(activeId) });
      }
    },
    onError: (e) => toast.error(e, "Tur durdurulamadı"),
  });

  const updateConv = useMutation({
    mutationFn: (patch: { title?: string; status?: "active" | "archived"; brandId?: string }) => {
      if (!activeId) throw new Error("Sohbet seçili değil");
      return api.conversations.update(activeId, patch);
    },
    onSuccess: (updated) => {
      if (activeId) qc.setQueryData(queryKeys.conversations.one(activeId), updated);
      void qc.invalidateQueries({ queryKey: queryKeys.conversations.all });
      setRenamingConv(false);
      toast.success("Sohbet güncellendi");
    },
    onError: (e) => toast.error(e),
  });

  const renameAlias = useMutation({
    mutationFn: ({ aliasId, alias }: { aliasId: string; alias: string }) => {
      if (!activeId) throw new Error("Sohbet seçili değil");
      return api.conversations.aliases.rename(activeId, aliasId, { alias });
    },
    onSuccess: () => {
      if (activeId) {
        void qc.invalidateQueries({ queryKey: queryKeys.conversations.aliases(activeId) });
      }
      setRenamingAliasId(null);
      toast.success("Takma ad güncellendi");
    },
    onError: (e) => toast.error(e, "Takma ad değiştirilemedi"),
  });

  const sendMessage = useMutation({
    mutationFn: async () => {
      const trimmed = text.trim();
      let targetId = activeId;
      if (!targetId) {
        const created = await api.conversations.create({
          ...(brandId ? { brandId } : {}),
        });
        targetId = created.id;
        void qc.invalidateQueries({ queryKey: queryKeys.conversations.all });
        navigate(`/chat/${created.id}`);
      }
      const res = await api.conversations.messages.send(targetId, {
        ...(trimmed ? { text: trimmed } : {}),
        ...(staged.length > 0
          ? {
              attachments: staged.map((s) => ({
                assetId: s.assetId,
                ...(s.alias.trim() && isValidAlias(s.alias.trim().toLowerCase())
                  ? { alias: s.alias.trim().toLowerCase() }
                  : {}),
              })),
            }
          : {}),
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        clientMessageId: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      });
      return { targetId, res };
    },
    onSuccess: ({ targetId, res }) => {
      setText("");
      setStaged([]);
      setLocalMessages((prev) => {
        const next = new Map(prev);
        next.set(res.message.id, res.message);
        return next;
      });
      void qc.invalidateQueries({ queryKey: queryKeys.conversations.messages(targetId) });
      void qc.invalidateQueries({ queryKey: queryKeys.conversations.aliases(targetId) });
      void qc.invalidateQueries({ queryKey: queryKeys.conversations.one(targetId) });
      void qc.invalidateQueries({ queryKey: queryKeys.conversations.all });
      endRef.current?.scrollIntoView?.({ behavior: "smooth" });
    },
  });

  const effectiveBrandId = conversation?.brandId ?? brandId ?? activeBrands[0]?.id ?? null;

  const handleUploadFiles = async (files: File[]) => {
    if (files.length === 0) return;
    if (!effectiveBrandId) {
      toast.error(new Error("Dosya yüklemek için önce bir marka seçin."));
      return;
    }
    setUploading(true);
    try {
      const takenNames = new Set([
        ...aliases.flatMap((a) => [a.alias, ...a.previousAliases]),
        ...staged.map((s) => s.alias),
      ]);
      for (const file of files) {
        const check = checkFile(file);
        if (!check.ok) {
          toast.error(new Error(check.error));
          continue;
        }
        const meta = await readMediaMetadata(file, check.mimeType);
        const uploaded = await api.assets.upload({
          brandId: effectiveBrandId,
          file: withMimeType(file, check.mimeType),
          ...meta,
        });
        const base = aliasBaseFor(check.mimeType);
        let n = 0;
        while (takenNames.has(autoAlias(base, n))) n++;
        const nextAlias = autoAlias(base, n);
        takenNames.add(nextAlias);
        setStaged((prev) => [
          ...prev,
          {
            assetId: uploaded.id,
            filename: file.name,
            mimeType: check.mimeType,
            alias: nextAlias,
          },
        ]);
      }
      void qc.invalidateQueries({ queryKey: queryKeys.assets.all });
    } catch (error) {
      toast.error(error, "Dosya yüklenemedi");
    } finally {
      setUploading(false);
    }
  };

  const insertMention = (aliasName: string) => {
    setText((prev) => {
      const sep = prev.length > 0 && !prev.endsWith(" ") && !prev.endsWith("\n") ? " " : "";
      return `${prev}${sep}@${aliasName} `;
    });
  };

  // Mention autocomplete suggestions when typing `@...` at end of input
  const mentionSuggestions = useMemo(() => {
    const match = /(?:^|\s)@([a-z0-9-]*)$/i.exec(text);
    if (!match) return [];
    const q = (match[1] ?? "").toLowerCase();
    const candidates = [
      ...aliases.map((a) => a.alias),
      ...staged.map((s) => s.alias).filter(Boolean),
    ];
    return [...new Set(candidates)].filter((name) => name.startsWith(q)).slice(0, 6);
  }, [text, aliases, staged]);

  const applyMentionSuggestion = (name: string) => {
    setText((prev) =>
      prev.replace(/(?:^|\s)@[a-z0-9-]*$/i, (m) => `${m.startsWith(" ") ? " " : ""}@${name} `),
    );
  };

  const handleSubmit = (e?: FormEvent) => {
    e?.preventDefault();
    const trimmed = text.trim();
    if (trimmed.toLowerCase() === "/usage") {
      setShowUsage(true);
      setText("");
      return;
    }
    if (!trimmed && staged.length === 0) return;
    if (activeRunId || sendMessage.isPending) return;
    sendMessage.mutate();
  };

  const onComposerKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const runs = runsQuery.data?.items ?? [];
  const totalInputTokens = runs.reduce((acc, r) => acc + (r.usage?.inputTokens ?? 0), 0);
  const totalOutputTokens = runs.reduce((acc, r) => acc + (r.usage?.outputTokens ?? 0), 0);
  const totalCostUsd = runs.reduce((acc, r) => acc + (r.usage?.costUsd ?? 0), 0);
  const totalDurationMs = runs.reduce((acc, r) => acc + (r.usage?.durationMs ?? 0), 0);

  return (
    <>
      <PageHeader
        title="Sohbet"
        description="Aylık içerik planı iste, @alias ile görsel bağla, onay ver ve üretime geç."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant={showUsage ? "primary" : "secondary"}
              onClick={() => setShowUsage((v) => !v)}
            >
              Kullanım (/usage)
            </Button>
            <Button
              variant="primary"
              icon={<IconPlus size={18} />}
              loading={createConv.isPending}
              onClick={() => createConv.mutate(undefined)}
            >
              Yeni sohbet
            </Button>
          </div>
        }
      />

      {showUsage && (
        <Card className="mb-6 border border-line-strong p-5">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-display text-2xl text-ink">Kullanım ve AI Durumu (/usage)</h2>
            <IconButton label="Kullanım panelini kapat" onClick={() => setShowUsage(false)}>
              <IconClose size={16} />
            </IconButton>
          </div>
          <div className="mt-4 grid gap-5 md:grid-cols-2">
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap gap-2">
                <Badge tone={summary.macTone}>{summary.macLabel}</Badge>
                <Badge tone={summary.claudeTone}>{summary.claudeLabel}</Badge>
                <Badge tone={summary.geminiTone}>{summary.geminiLabel}</Badge>
              </div>
              {(presence?.usage?.windows ?? []).length > 0 ? (
                (presence?.usage?.windows ?? []).map((w, idx) => (
                  <div key={`${w.kind}-${idx}`} className="rounded-xl bg-surface-2 p-3">
                    <div className="mb-1 flex items-center justify-between text-xs">
                      <span className="font-medium text-ink">
                        {w.kind === "five_hour"
                          ? "Claude 5 saatlik pencere"
                          : w.kind === "weekly"
                            ? "Claude haftalık pencere"
                            : "Kota penceresi"}
                      </span>
                      <Mono>
                        {w.usedPercent !== undefined ? `%${Math.round(w.usedPercent)}` : "—"}
                      </Mono>
                    </div>
                    {w.usedPercent !== undefined && (
                      <Progress value={w.usedPercent / 100} label="Claude kota kullanımı" />
                    )}
                    {w.resetsAt && (
                      <p className="mt-1 text-[11px] text-ink-3">
                        Sıfırlanma: {formatDateTime(w.resetsAt)}
                      </p>
                    )}
                  </div>
                ))
              ) : (
                <p className="text-sm text-ink-3">
                  Henüz abonelik kullanım raporu gelmedi (Mac worker bağlandığında güncellenir).
                </p>
              )}
            </div>
            <div className="rounded-xl bg-surface-2 p-4">
              <h3 className="mb-2 text-xs font-semibold tracking-wide text-ink-2 uppercase">
                Bu sohbetteki turlar ({runs.length})
              </h3>
              <KeyValue
                items={[
                  {
                    label: "Girdi / Çıktı token",
                    value: `${totalInputTokens.toLocaleString("tr-TR")} / ${totalOutputTokens.toLocaleString("tr-TR")}`,
                  },
                  {
                    label: "Tahmini maliyet",
                    value: totalCostUsd > 0 ? `$${totalCostUsd.toFixed(4)}` : "Abonelik / $0",
                  },
                  {
                    label: "Toplam süre",
                    value: totalDurationMs > 0 ? formatDuration(totalDurationMs) : "—",
                  },
                ]}
              />
            </div>
          </div>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
        {/* Conversations sidebar */}
        <Card className="flex max-h-[75dvh] flex-col gap-3 p-4">
          <div className="flex items-center justify-between gap-2">
            <FilterSelect
              label="Sohbet durumu"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as "active" | "archived")}
              className="flex-1"
            >
              <option value="active">Aktif sohbetler</option>
              <option value="archived">Arşiv</option>
            </FilterSelect>
          </div>

          {convList.isPending ? (
            <SkeletonRows rows={4} />
          ) : convList.error ? (
            <ErrorState error={convList.error} compact onRetry={() => void convList.refetch()} />
          ) : conversations.length === 0 ? (
            <EmptyState title="Sohbet yok" compact glyph={<IconChat size={20} />}>
              İlk mesajınızı yazarak yeni bir sohbet başlatabilirsiniz.
            </EmptyState>
          ) : (
            <ul className="flex flex-1 flex-col gap-1 overflow-y-auto">
              {conversations.map((c) => {
                const selected = c.id === activeId;
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => navigate(`/chat/${c.id}`)}
                      className={cx(
                        "flex w-full flex-col gap-1 rounded-xl px-3 py-2.5 text-left transition-colors",
                        selected ? "bg-ink text-bg" : "hover:bg-surface-2 text-ink",
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-medium">
                          {c.title || "Yeni sohbet"}
                        </span>
                        {c.activeRunId && (
                          <span
                            className="size-2 shrink-0 animate-pulse rounded-full bg-accent"
                            title="Çalışıyor"
                          />
                        )}
                      </div>
                      <span
                        className={cx(
                          "flex items-center gap-1.5 truncate text-[11px]",
                          selected ? "opacity-75" : "text-ink-3",
                        )}
                      >
                        {c.brandId ? brandName(c.brandId) : "Markasız"} ·{" "}
                        {formatRelative(c.lastActivityAt)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        {/* Conversation main pane */}
        <div className="flex min-h-[68dvh] min-w-0 flex-col gap-4">
          {conversation && (
            <Card className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="flex min-w-0 flex-1 items-center gap-2.5">
                {conversation.brandId ? (
                  <BrandMark
                    id={conversation.brandId}
                    name={brandName(conversation.brandId)}
                    size={26}
                  />
                ) : activeBrands.length > 0 ? (
                  <FilterSelect
                    label="Sohbete marka ata"
                    value=""
                    onChange={(e) => {
                      if (e.target.value) updateConv.mutate({ brandId: e.target.value });
                    }}
                  >
                    <option value="">Marka bağla…</option>
                    {activeBrands.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </FilterSelect>
                ) : null}

                {renamingConv ? (
                  <form
                    className="flex flex-1 items-center gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      updateConv.mutate({ title: titleDraft.trim() });
                    }}
                  >
                    <Input
                      aria-label="Sohbet başlığı"
                      value={titleDraft}
                      onChange={(e) => setTitleDraft(e.target.value)}
                      className="h-8 text-sm"
                    />
                    <Button
                      type="submit"
                      size="sm"
                      variant="primary"
                      loading={updateConv.isPending}
                    >
                      Kaydet
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setRenamingConv(false)}>
                      Vazgeç
                    </Button>
                  </form>
                ) : (
                  <div className="min-w-0">
                    <h2 className="truncate text-base font-semibold text-ink">
                      {conversation.title || "Yeni sohbet"}
                    </h2>
                  </div>
                )}
              </div>

              <div className="flex items-center gap-1.5">
                <Badge tone={wsStatus === "open" ? "good" : "neutral"} dot={false}>
                  {wsStatus === "open" ? "Canlı" : "Senkron"}
                </Badge>
                {!renamingConv && (
                  <IconButton
                    label="Sohbet adını düzenle"
                    onClick={() => {
                      setTitleDraft(conversation.title);
                      setRenamingConv(true);
                    }}
                  >
                    <IconEdit size={16} />
                  </IconButton>
                )}
                <IconButton
                  label={conversation.status === "archived" ? "Arşivden çıkar" : "Sohbeti arşivle"}
                  onClick={() =>
                    updateConv.mutate({
                      status: conversation.status === "archived" ? "active" : "archived",
                    })
                  }
                >
                  <IconArchive size={16} />
                </IconButton>
              </div>
            </Card>
          )}

          {/* Alias strip */}
          {aliases.length > 0 && (
            <section
              aria-label="Sohbet görsel takma adları"
              className="flex flex-wrap items-center gap-2 rounded-2xl bg-surface px-3.5 py-2.5 ring-1 ring-line/70"
            >
              <span className="text-xs font-medium text-ink-3">Ekler:</span>
              {aliases.map((a) =>
                renamingAliasId === a.id ? (
                  <form
                    key={a.id}
                    className="inline-flex items-center gap-1"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const cleaned = aliasDraft.trim().toLowerCase();
                      if (isValidAlias(cleaned)) {
                        renameAlias.mutate({ aliasId: a.id, alias: cleaned });
                      }
                    }}
                  >
                    <Input
                      aria-label="Yeni takma ad"
                      value={aliasDraft}
                      onChange={(e) => setAliasDraft(e.target.value.toLowerCase())}
                      className="h-7 w-28 px-2 font-mono text-xs"
                    />
                    <Button
                      type="submit"
                      size="sm"
                      variant="primary"
                      loading={renameAlias.isPending}
                    >
                      Tamam
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setRenamingAliasId(null)}>
                      İptal
                    </Button>
                  </form>
                ) : (
                  <div
                    key={a.id}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-surface-2 px-2 py-1 text-xs ring-1 ring-line"
                  >
                    <button
                      type="button"
                      onClick={() => insertMention(a.alias)}
                      className="font-mono font-medium text-accent hover:underline"
                      title="Mesaja @bahsetme ekle"
                    >
                      @{a.alias}
                    </button>
                    <button
                      type="button"
                      aria-label={`@${a.alias} adını değiştir`}
                      onClick={() => {
                        setRenamingAliasId(a.id);
                        setAliasDraft(a.alias);
                      }}
                      className="text-ink-3 hover:text-ink"
                    >
                      <IconEdit size={12} />
                    </button>
                  </div>
                ),
              )}
            </section>
          )}

          {/* Message stream */}
          <div className="flex flex-1 flex-col gap-4 overflow-y-auto py-1">
            {(streamState?.hasMoreMessages || olderCursor) && (
              <div className="flex justify-center">
                <Button
                  size="sm"
                  variant="ghost"
                  loading={loadOlder.isPending}
                  onClick={() => loadOlder.mutate()}
                >
                  Daha eski mesajları yükle
                </Button>
              </div>
            )}

            {messages.length === 0 ? (
              <EmptyState title="Ne üretelim?" glyph={<IconChat size={24} />}>
                “Bu ay için 8 postluk Instagram ve LinkedIn içerik planı hazırla” yazabilir, ürün
                fotoğrafı yükleyip <Mono>@image</Mono> ile referans verebilirsiniz.
              </EmptyState>
            ) : (
              messages.map((m) => (
                <MessageBubble
                  key={m.id}
                  message={m}
                  conversationId={activeId ?? m.conversationId}
                  aliases={aliases}
                  plans={plans}
                  selectedModel={model || undefined}
                  selectedEffort={effort || undefined}
                  onMessageUpdated={(updated) =>
                    setLocalMessages((prev) => {
                      const next = new Map(prev);
                      next.set(updated.id, updated);
                      return next;
                    })
                  }
                  onPlanUpdated={(updated) =>
                    setLocalPlans((prev) => {
                      const next = new Map(prev);
                      next.set(updated.id, updated);
                      return next;
                    })
                  }
                />
              ))
            )}
            <div ref={endRef} />
          </div>

          {activeRunId && (
            <div className="flex items-center justify-between gap-3 rounded-2xl bg-surface-2 px-4 py-2.5 text-sm ring-1 ring-line">
              <span className="inline-flex items-center gap-2 text-ink">
                <Spinner size={15} className="text-accent" />
                Ajan çalışıyor…
              </span>
              <Button
                size="sm"
                variant="danger"
                icon={<IconStop size={14} />}
                loading={cancelRun.isPending}
                onClick={() => cancelRun.mutate(activeRunId)}
              >
                Durdur
              </Button>
            </div>
          )}

          {/* Composer */}
          <Card as="div" className="p-3 sm:p-4">
            <form onSubmit={handleSubmit} className="flex flex-col gap-3">
              {staged.length > 0 && (
                <ul className="flex flex-wrap gap-2" aria-label="Eklenecek dosyalar">
                  {staged.map((s) => (
                    <li
                      key={s.assetId}
                      className="flex items-center gap-2 rounded-xl bg-surface-2 px-2.5 py-1.5 text-xs ring-1 ring-line"
                    >
                      <img
                        src={api.assets.contentUrl(s.assetId)}
                        alt={s.filename}
                        className="size-8 rounded object-cover"
                      />
                      <div className="flex flex-col gap-0.5">
                        <span className="max-w-32 truncate text-ink">{s.filename}</span>
                        <label className="flex items-center gap-1 font-mono text-[11px] text-accent">
                          @
                          <input
                            aria-label={`${s.filename} takma adı`}
                            value={s.alias}
                            onChange={(e) => {
                              const val = e.target.value.toLowerCase();
                              setStaged((list) =>
                                list.map((x) =>
                                  x.assetId === s.assetId ? { ...x, alias: val } : x,
                                ),
                              );
                            }}
                            className="w-20 rounded bg-surface px-1 py-0.5 text-ink ring-1 ring-line"
                          />
                        </label>
                      </div>
                      <button
                        type="button"
                        aria-label={`${s.filename} ekini kaldır`}
                        onClick={() =>
                          setStaged((list) => list.filter((x) => x.assetId !== s.assetId))
                        }
                        className="text-ink-3 hover:text-bad"
                      >
                        <IconClose size={14} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {mentionSuggestions.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                  <span className="text-ink-3">@bahset:</span>
                  {mentionSuggestions.map((name) => (
                    <button
                      key={name}
                      type="button"
                      onClick={() => applyMentionSuggestion(name)}
                      className="rounded-md bg-surface-2 px-2 py-0.5 font-mono font-medium text-accent ring-1 ring-line hover:bg-surface-3"
                    >
                      @{name}
                    </button>
                  ))}
                </div>
              )}

              <Textarea
                aria-label="Mesaj"
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={onComposerKeyDown}
                rows={3}
                placeholder="Mesaj yazın, @image ile ekli görsele atıf yapın veya /usage yazın…"
                className="text-[15px]"
              />

              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<IconUpload size={15} />}
                    loading={uploading}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    Görsel ekle
                  </Button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,application/pdf"
                    multiple
                    className="sr-only"
                    aria-label="Sohbete dosya yükle"
                    onChange={(e) => {
                      void handleUploadFiles(Array.from(e.target.files ?? []));
                      e.target.value = "";
                    }}
                  />

                  <FilterSelect
                    label="Model seç"
                    value={model}
                    onChange={(e) => setModel(e.target.value as AgentModel | "")}
                  >
                    <option value="">Varsayılan model</option>
                    {AGENT_MODEL_OPTIONS.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </FilterSelect>

                  <FilterSelect
                    label="Çaba düzeyi"
                    value={effort}
                    onChange={(e) => setEffort(e.target.value as AgentEffort | "")}
                  >
                    <option value="">Varsayılan çaba</option>
                    {AGENT_EFFORT_OPTIONS.map((ef) => (
                      <option key={ef.value} value={ef.value}>
                        {ef.label}
                      </option>
                    ))}
                  </FilterSelect>
                </div>

                <Button
                  type="submit"
                  variant="primary"
                  icon={<IconSend size={16} />}
                  loading={sendMessage.isPending}
                  disabled={
                    Boolean(activeRunId) || (!text.trim() && staged.length === 0) || uploading
                  }
                >
                  Gönder
                </Button>
              </div>
              <InlineError error={sendMessage.error} />
            </form>
          </Card>
        </div>
      </div>
    </>
  );
}
