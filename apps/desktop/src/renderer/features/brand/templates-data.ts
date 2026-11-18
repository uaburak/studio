// Server data of brand templates (N9) and conversions (N10): the brand's templates in the
// react-query cache, saving a post as a template, using one, converting posts.
import type {
  Content,
  ContentRepurposeManyResult,
  ContentTemplate,
  ContentTemplateUpdate,
  RepurposeTarget,
  TemplateUse,
  TemplateUseResult,
} from "@studio/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useApi } from "../../lib/api.ts";
import { fetchAllPages } from "../../lib/paging.ts";
import { isHostUp, useHost } from "../../state/studio.tsx";
import { useRefreshOnJobs } from "../job-refresh.ts";
import { invalidatePosts, postKeys } from "../posts/data.ts";

export const templateKeys = {
  list: (brandId: string | null) => ["brand", "templates", brandId] as const,
  derived: (contentId: string) => ["posts", "derived", contentId] as const,
};

/** Every template of the brand, newest first (refreshed as posts are made from them). */
export function useBrandTemplates(brandId: string | null) {
  // A post made from a template counts as a use.
  useRefreshOnJobs(["content.generate"], brandId, [templateKeys.list(brandId)]);
  return useTemplateList(brandId);
}

/** The brand's templates without following the jobs (a post's links). */
export function useTemplateList(brandId: string | null) {
  const api = useApi();
  const up = isHostUp(useHost());
  return useQuery({
    queryKey: templateKeys.list(brandId),
    queryFn: (): Promise<ContentTemplate[]> =>
      fetchAllPages(
        (cursor) =>
          api.templates.list(brandId as string, { limit: 100, ...(cursor ? { cursor } : {}) }),
        5,
      ),
    enabled: up && brandId !== null,
    staleTime: 30_000,
  });
}

/** Posts converted from `contentId` (its stories and Reels). */
export function useDerivedPosts(contentId: string | null) {
  const api = useApi();
  const up = isHostUp(useHost());
  return useQuery({
    queryKey: templateKeys.derived(contentId ?? ""),
    queryFn: async (): Promise<Content[]> =>
      (await api.contents.list({ sourceContentId: contentId as string, limit: 50 })).items,
    enabled: up && !!contentId,
    staleTime: 15_000,
  });
}

export function useTemplateActions() {
  const api = useApi();
  const queryClient = useQueryClient();
  const refreshList = (brandId: string) =>
    queryClient.invalidateQueries({ queryKey: templateKeys.list(brandId) });
  return {
    /** Save an approved / published post as a template of its brand. */
    create: async (content: Content, name?: string): Promise<ContentTemplate> => {
      const made = await api.templates.create({
        contentId: content.id,
        ...(name?.trim() ? { name: name.trim() } : {}),
      });
      await refreshList(content.brandId);
      return made;
    },
    update: async (t: ContentTemplate, input: ContentTemplateUpdate): Promise<ContentTemplate> => {
      const next = await api.templates.update(t.id, input);
      queryClient.setQueryData<ContentTemplate[]>(templateKeys.list(t.brandId), (list) =>
        list?.map((x) => (x.id === next.id ? next : x)),
      );
      return next;
    },
    remove: async (t: ContentTemplate): Promise<void> => {
      await api.templates.delete(t.id);
      queryClient.setQueryData<ContentTemplate[]>(templateKeys.list(t.brandId), (list) =>
        list?.filter((x) => x.id !== t.id),
      );
    },
    /** A new draft post from the template; its job fills it. */
    use: async (t: ContentTemplate, input: TemplateUse): Promise<TemplateUseResult> => {
      const res = await api.templates.use(t.id, input);
      queryClient.setQueryData(postKeys.content(res.content.id), res.content);
      await Promise.all([invalidatePosts(queryClient), refreshList(t.brandId)]);
      return res;
    },
    /** One post into a story or a Reels. */
    convert: async (content: Content, target: RepurposeTarget) => {
      const res = await api.contents.repurpose(content.id, { target });
      queryClient.setQueryData(postKeys.content(res.content.id), res.content);
      await Promise.all([
        invalidatePosts(queryClient),
        queryClient.invalidateQueries({ queryKey: templateKeys.derived(content.id) }),
      ]);
      return res;
    },
    /** Many posts at once (Postlar's "Dönüştür"). */
    convertMany: async (
      ids: string[],
      target: RepurposeTarget,
    ): Promise<ContentRepurposeManyResult> => {
      const res = await api.contents.repurposeMany({ contentIds: ids, target });
      await invalidatePosts(queryClient);
      return res;
    },
  };
}
