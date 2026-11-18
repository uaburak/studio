// Server data the canvas editor needs beyond the post: the brand's render kit (the approved
// profile's brand.css, as the worker builds it).
import type { BrandProfile } from "@studio/contract";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useApi } from "../../lib/api.ts";
import { buildRenderKit, type RenderKit } from "./model/brand-kit.ts";

export function useRenderKit(brandId: string | null): RenderKit {
  const api = useApi();
  const profile = useQuery({
    queryKey: ["brand", "profile-current", brandId],
    queryFn: async (): Promise<BrandProfile | null> => {
      try {
        return await api.brandProfiles.current(brandId as string);
      } catch (error) {
        if ((error as { status?: number }).status === 404) return null;
        throw error;
      }
    },
    enabled: brandId !== null,
    staleTime: 60_000,
    retry: 1,
  });
  return useMemo(() => buildRenderKit(profile.data ?? null), [profile.data]);
}
