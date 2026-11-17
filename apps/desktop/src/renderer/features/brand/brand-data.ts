// Server data of the brand card and the brand profile page: kit, profiles, the running
// `brand.analyze` job, brand create / update.
import {
  type Brand,
  type BrandKit,
  type BrandKitPut,
  type BrandProfile,
  emptyBrandKit,
  isTerminalJobStatus,
  type Job,
} from "@studio/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useApi } from "../../lib/api.ts";
import { fetchAllPages } from "../../lib/paging.ts";
import { isHostUp, queryKeys, useHost, useJobs } from "../../state/studio.tsx";
import { useRefreshOnJobs } from "../job-refresh.ts";

export const brandKeys = {
  kit: (brandId: string | null) => ["brand", "kit", brandId] as const,
  profiles: (brandId: string | null) => ["brand", "profiles", brandId] as const,
};

export function useBrandKit(brandId: string | null) {
  const api = useApi();
  const up = isHostUp(useHost());
  return useQuery({
    queryKey: brandKeys.kit(brandId),
    queryFn: async (): Promise<BrandKit> => {
      try {
        return await api.brandKits.get(brandId as string);
      } catch (error) {
        if ((error as { status?: number }).status === 404) return emptyBrandKit(brandId as string);
        throw error;
      }
    },
    enabled: up && brandId !== null,
    staleTime: 30_000,
  });
}

/** Every profile version, newest first. */
export function useBrandProfiles(brandId: string | null) {
  const api = useApi();
  const up = isHostUp(useHost());
  useRefreshOnJobs(["brand.analyze"], brandId, [
    brandKeys.profiles(brandId),
    brandKeys.kit(brandId),
  ]);
  return useQuery({
    queryKey: brandKeys.profiles(brandId),
    queryFn: async (): Promise<BrandProfile[]> => {
      const items = await fetchAllPages(
        (cursor) =>
          api.brandProfiles.list(brandId as string, { limit: 100, ...(cursor ? { cursor } : {}) }),
        3,
      );
      return items.sort((a, b) => b.version - a.version);
    },
    enabled: up && brandId !== null,
    staleTime: 30_000,
  });
}

/** The profile the card shows: the current (approved) one, else the newest draft. */
export function cardProfile(profiles: readonly BrandProfile[] | undefined): BrandProfile | null {
  if (!profiles || profiles.length === 0) return null;
  return profiles.find((p) => p.isCurrent) ?? profiles[0] ?? null;
}

/** The brand's running `brand.analyze` job (from the live job feed). */
export function useAnalysisJob(brandId: string | null): Job | null {
  const { jobs } = useJobs();
  return (
    jobs.find(
      (j) => j.type === "brand.analyze" && j.brandId === brandId && !isTerminalJobStatus(j.status),
    ) ?? null
  );
}

export function useWorkerOnline(): boolean {
  const { presence } = useJobs();
  return presence?.online === true;
}

export function useBrandActions() {
  const api = useApi();
  const queryClient = useQueryClient();
  const setBrand = useCallback(
    (brand: Brand) =>
      queryClient.setQueryData<Brand[]>(queryKeys.brands, (list) => {
        if (!list) return list;
        return list.some((b) => b.id === brand.id)
          ? list.map((b) => (b.id === brand.id ? brand : b))
          : [...list, brand];
      }),
    [queryClient],
  );
  return {
    create: async (input: { name: string; slug: string; defaultLanguage: string }) => {
      const brand = await api.brands.create(input);
      setBrand(brand);
      void queryClient.invalidateQueries({ queryKey: queryKeys.brands });
      return brand;
    },
    update: async (id: string, input: Parameters<typeof api.brands.update>[1]) => {
      const brand = await api.brands.update(id, input);
      setBrand(brand);
      return brand;
    },
    analyze: (brandId: string) => api.jobs.create({ type: "brand.analyze", brandId, payload: {} }),
    putKit: async (brandId: string, kit: BrandKitPut) => {
      const saved = await api.brandKits.put(brandId, kit);
      queryClient.setQueryData(brandKeys.kit(brandId), saved);
      return saved;
    },
    profiles: {
      create: async (brandId: string, input: Parameters<typeof api.brandProfiles.create>[1]) => {
        const profile = await api.brandProfiles.create(brandId, input);
        void queryClient.invalidateQueries({ queryKey: brandKeys.profiles(brandId) });
        return profile;
      },
      update: async (
        brandId: string,
        version: number,
        input: Parameters<typeof api.brandProfiles.update>[2],
      ) => {
        const profile = await api.brandProfiles.update(brandId, version, input);
        queryClient.setQueryData<BrandProfile[]>(brandKeys.profiles(brandId), (list) =>
          list?.map((p) => (p.version === profile.version ? profile : p)),
        );
        return profile;
      },
      approve: async (brandId: string, version: number) => {
        const profile = await api.brandProfiles.approve(brandId, version);
        void queryClient.invalidateQueries({ queryKey: brandKeys.profiles(brandId) });
        return profile;
      },
    },
    upload: (brandId: string, file: File, kind: "image" | "logo" | "font") =>
      api.assets.upload({ file, brandId, kind, source: "upload" }),
  };
}
