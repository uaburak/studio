// Server data of the media library: a brand's assets, uploads and AI image requests.
import type { Asset, Job } from "@studio/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { describeError, useApi } from "../../lib/api.ts";
import { fetchAllPages } from "../../lib/paging.ts";
import { useAppStore } from "../../state/app-store.ts";
import { isHostUp, useHost } from "../../state/studio.tsx";
import { useRefreshOnJobs } from "../job-refresh.ts";
import { type ImageRequestForm, imageRequestPayload } from "./media-model.ts";

export const mediaKeys = {
  assets: (brandId: string | null) => ["media", "assets", brandId] as const,
  similar: (assetId: string | null) => ["media", "similar", assetId] as const,
};

export function useBrandAssets(brandId: string | null) {
  const api = useApi();
  const up = isHostUp(useHost());
  // A finished image generation (or render) adds assets.
  useRefreshOnJobs(["image.generate", "content.render"], brandId, [mediaKeys.assets(brandId)]);
  // Tagging (N12) adds what Vision read; a backfill job has no brand, so any of them counts.
  useRefreshOnJobs(["media.analyze"], null, [mediaKeys.assets(brandId)]);
  return useQuery({
    queryKey: mediaKeys.assets(brandId),
    queryFn: (): Promise<Asset[]> =>
      fetchAllPages((cursor) =>
        api.assets.list({ brandId: brandId as string, limit: 100, ...(cursor ? { cursor } : {}) }),
      ),
    enabled: up && brandId !== null,
    staleTime: 15_000,
  });
}

/** "Benzerleri" (N12): the brand's pictures that look like `assetId`, nearest first. */
export function useSimilarAssets(assetId: string | null) {
  const api = useApi();
  const up = isHostUp(useHost());
  return useQuery({
    queryKey: mediaKeys.similar(assetId),
    queryFn: () => api.assets.similar(assetId as string, { limit: 24 }),
    enabled: up && assetId !== null,
    staleTime: 30_000,
  });
}

/** Upload files into the brand's library; `uploading` counts the files still on their way. */
export function useUploadAssets(brandId: string | null) {
  const api = useApi();
  const queryClient = useQueryClient();
  const showToast = useAppStore((s) => s.showToast);
  const [uploading, setUploading] = useState(0);
  const upload = useCallback(
    async (files: File[]) => {
      if (!brandId || files.length === 0) return;
      setUploading((n) => n + files.length);
      let failed = 0;
      for (const file of files) {
        try {
          const asset = await api.assets.upload({ file, brandId, source: "upload" });
          queryClient.setQueryData<Asset[]>(mediaKeys.assets(brandId), (list) =>
            list ? [asset, ...list.filter((a) => a.id !== asset.id)] : list,
          );
        } catch (error) {
          failed += 1;
          showToast({ message: `${file.name}: ${describeError(error)}`, tone: "danger" });
        } finally {
          setUploading((n) => n - 1);
        }
      }
      if (failed < files.length) {
        void queryClient.invalidateQueries({ queryKey: mediaKeys.assets(brandId) });
      }
    },
    [api, brandId, queryClient, showToast],
  );
  return { upload, uploading };
}

/** Start an `image.generate` job; resolves to the job, or throws a Turkish reason. */
export function useGenerateImage(brandId: string | null) {
  const api = useApi();
  return useCallback(
    async (form: ImageRequestForm): Promise<Job> => {
      if (!brandId) throw new Error("Önce bir marka seç.");
      const request = imageRequestPayload(form);
      if (!request.ok) throw new Error(request.reason);
      return api.jobs.create({ type: "image.generate", brandId, payload: request.payload });
    },
    [api, brandId],
  );
}
