// Server data of approval requests: one request (the chat card), a brand's pending list (the
// details panel, the panel tool's badge), a conversation's and a post's requests. Decisions and
// `approval.updated` on the job stream go through `storeApproval`, which updates every cached
// copy and refreshes what a decision changed (the post's "Onay bekliyor", its picture).
import type { ApprovalActionResult, ApprovalRegenerate, ApprovalRequest } from "@studio/contract";
import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { describeError, useApi } from "../../lib/api.ts";
import { useAppStore } from "../../state/app-store.ts";
import { focusMessage } from "../../state/focus-requests.ts";
import { isHostUp, useHost, useJobs } from "../../state/studio.tsx";
import { productKeys } from "../brand/products-data.ts";
import { mentionKeys } from "../mentions/mentions-data.ts";
import { invalidatePosts, storeContent } from "../posts/data.ts";
import { openPostDetail } from "../posts/store.ts";
import { reducePending, upsertApproval } from "./approvals-model.ts";

export const approvalKeys = {
  all: ["approvals"] as const,
  one: (id: string) => ["approvals", "one", id] as const,
  pending: (brandId: string) => ["approvals", "pending", brandId] as const,
  conversation: (id: string) => ["approvals", "conversation", id] as const,
  content: (id: string) => ["approvals", "content", id] as const,
};

/** Put a changed request into every cached copy and refresh what it changed. */
export function storeApproval(queryClient: QueryClient, approval: ApprovalRequest): void {
  const previous = queryClient.getQueryData<ApprovalRequest>(approvalKeys.one(approval.id));
  queryClient.setQueryData(approvalKeys.one(approval.id), approval);
  queryClient.setQueriesData<ApprovalRequest[]>(
    { queryKey: approvalKeys.pending(approval.brandId) },
    (list) => (list ? reducePending(list, approval, approval.brandId) : list),
  );
  if (approval.conversationId) {
    queryClient.setQueryData<ApprovalRequest[]>(
      approvalKeys.conversation(approval.conversationId),
      (list) => (list ? upsertApproval(list, approval) : list),
    );
  }
  if (approval.contentId) {
    queryClient.setQueryData<ApprovalRequest[]>(approvalKeys.content(approval.contentId), (list) =>
      list ? reducePending(list, approval, null) : list,
    );
  }
  // A new request or a decision changes the post's pending count (and an approval its picture).
  if (
    !previous ||
    previous.status !== approval.status ||
    previous.updatedAt !== approval.updatedAt
  ) {
    if (approval.contentId) void invalidatePosts(queryClient, approval.contentId);
    void queryClient.invalidateQueries({ queryKey: mentionKeys.candidates(approval.brandId) });
  }
}

/** Keeps every cached request live from `approval.updated` (mounted once, in the app shell). */
export function useApprovalStream(): void {
  const { controller } = useJobs();
  const queryClient = useQueryClient();
  useEffect(
    () => controller.onApproval((approval) => storeApproval(queryClient, approval)),
    [controller, queryClient],
  );
}

function storeResult(queryClient: QueryClient, result: ApprovalActionResult): void {
  storeApproval(queryClient, result.approval);
  if (result.content) storeContent(queryClient, result.content);
  if (result.product) {
    void queryClient.invalidateQueries({ queryKey: productKeys.list(result.product.brandId) });
  }
}

function useUp(): boolean {
  return isHostUp(useHost());
}

export function useApproval(id: string) {
  const api = useApi();
  return useQuery({
    queryKey: approvalKeys.one(id),
    queryFn: () => api.approvals.get(id),
    enabled: useUp(),
    staleTime: 60_000,
  });
}

/** The brand's pending requests, newest first. */
export function usePendingApprovals(brandId: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: approvalKeys.pending(brandId ?? ""),
    queryFn: async () => {
      const list = await api.approvals.list({
        brandId: brandId ?? "",
        status: "pending",
        limit: 100,
      });
      return list.items;
    },
    enabled: useUp() && brandId !== null,
    staleTime: 30_000,
  });
}

/** Every request of a conversation (a regenerated card finds the request that replaced it). */
export function useConversationApprovals(conversationId: string | null, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: approvalKeys.conversation(conversationId ?? ""),
    queryFn: async () =>
      (
        await api.approvals.list({
          conversationId: conversationId ?? "",
          status: "all",
          limit: 100,
        })
      ).items,
    enabled: useUp() && enabled && conversationId !== null,
    staleTime: 30_000,
  });
}

/** A post's pending requests (the post detail's "Onaya git"). */
export function useContentApprovals(contentId: string | null, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: approvalKeys.content(contentId ?? ""),
    queryFn: async () =>
      (await api.approvals.list({ contentId: contentId ?? "", status: "pending", limit: 20 }))
        .items,
    enabled: useUp() && enabled && contentId !== null,
    staleTime: 30_000,
  });
}

export type ApprovalAction = "approve" | "reject" | "regenerate";

/** Onayla / Reddet / Yeniden üret; failures become a toast. `busy` names the running one. */
export function useApprovalActions(approval: ApprovalRequest | undefined) {
  const api = useApi();
  const queryClient = useQueryClient();
  const showToast = useAppStore((s) => s.showToast);
  const [busy, setBusy] = useState<ApprovalAction | null>(null);
  const run = async (
    action: ApprovalAction,
    call: (id: string) => Promise<ApprovalActionResult>,
    done: string,
  ): Promise<boolean> => {
    if (!approval || busy) return false;
    setBusy(action);
    try {
      storeResult(queryClient, await call(approval.id));
      showToast({ message: done });
      return true;
    } catch (error) {
      showToast({ message: describeError(error), tone: "danger" });
      // The request may have been decided elsewhere meanwhile (the iPhone): show its state.
      void queryClient.invalidateQueries({ queryKey: approvalKeys.one(approval.id) });
      return false;
    } finally {
      setBusy(null);
    }
  };
  return {
    busy,
    approve: (assetId: string | null) =>
      run(
        "approve",
        (id) => api.approvals.approve(id, assetId ? { assetId } : {}),
        approval?.kind === "product_photo_upgrade"
          ? "Onaylandı; ürünün fotoğrafı güncelleniyor."
          : "Onaylandı; görsel posta yerleşiyor.",
      ),
    reject: (note?: string) =>
      run(
        "reject",
        (id) => api.approvals.reject(id, note?.trim() ? { note: note.trim() } : {}),
        "Reddedildi.",
      ),
    regenerate: (input: ApprovalRegenerate) =>
      run("regenerate", (id) => api.approvals.regenerate(id, input), "Yeniden üretiliyor…"),
  };
}

/** Where a request is shown: its chat message, else its post. */
export function goToApproval(approval: ApprovalRequest): void {
  if (approval.conversationId) {
    focusMessage(approval.conversationId, approval.messageId);
    return;
  }
  if (approval.contentId) {
    openPostDetail(approval.contentId);
    return;
  }
  useAppStore.getState().showToast({ message: "Bu onayın bir sohbeti yok." });
}
