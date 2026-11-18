// Server data the canvas editor needs beyond the post: the brand's render kit (the approved
// profile's brand.css, as the worker builds it).
import type { BrandProfile } from "@studio/contract";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useApi } from "../../lib/api.ts";
import { buildRenderKit, type RenderKit } from "./model/brand-kit.ts";

export interface RenderKitState {
  /** The brand's kit; the neutral one while it loads or when it failed (never import with it). */
  kit: RenderKit;
  /**
   * `loading`: the profile is on its way; `ready`: the kit is the brand's (the neutral one only
   * for a brand without an approved profile, as the worker renders it); `error`: unreadable.
   */
  status: "loading" | "ready" | "error";
  error: unknown;
  retry(): void;
}

/** The brand's render kit and whether it is known yet (E10: nothing is imported before). */
export function useRenderKitState(brandId: string | null): RenderKitState {
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
  const kit = useMemo(() => buildRenderKit(profile.data ?? null), [profile.data]);
  // A kit read once stays (a failed refetch doesn't take it away).
  const status =
    brandId === null || profile.data !== undefined
      ? "ready"
      : profile.isError
        ? "error"
        : "loading";
  return { kit, status, error: profile.error, retry: () => void profile.refetch() };
}

/** The brand's render kit (the neutral one until it is known: see `useRenderKitState`). */
export function useRenderKit(brandId: string | null): RenderKit {
  return useRenderKitState(brandId).kit;
}
