// Server data of the special days (N5): the days of a range for a brand (its sector tags and
// switched-off categories applied by the API), the brand's settings and the bayram date
// corrections. Saving either refreshes every cached range.
import type {
  BrandPlanningSettings,
  BrandPlanningSettingsPut,
  ReligiousDayOverride,
  SpecialDay,
  SpecialDayOverrides,
} from "@studio/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useApi } from "../../lib/api.ts";
import { isHostUp, useHost } from "../../state/studio.tsx";

export const specialDayKeys = {
  all: ["special-days"] as const,
  range: (brandId: string | null, from: string, to: string) =>
    ["special-days", "range", brandId, from, to] as const,
  settings: (brandId: string | null) => ["special-days", "settings", brandId] as const,
  overrides: ["special-days", "overrides"] as const,
};

/** Special days between `from` and `to` (inclusive) for a brand; empty while loading. */
export function useSpecialDays(brandId: string | null, from: string, to: string) {
  const api = useApi();
  const up = isHostUp(useHost());
  const query = useQuery({
    queryKey: specialDayKeys.range(brandId, from, to),
    queryFn: async (): Promise<SpecialDay[]> =>
      (await api.planning.specialDays({ from, to, ...(brandId ? { brandId } : {}) })).days,
    enabled: up && from !== "" && to !== "" && from <= to,
    staleTime: 5 * 60_000,
  });
  return { days: query.data ?? [], error: query.error ?? null };
}

export function usePlanningSettings(brandId: string | null) {
  const api = useApi();
  const up = isHostUp(useHost());
  return useQuery({
    queryKey: specialDayKeys.settings(brandId),
    queryFn: (): Promise<BrandPlanningSettings> => api.planning.settings(brandId as string),
    enabled: up && brandId !== null,
    staleTime: 30_000,
  });
}

export function usePlanningSettingsActions(brandId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return {
    put: async (input: BrandPlanningSettingsPut) => {
      const saved = await api.planning.putSettings(brandId, input);
      queryClient.setQueryData(specialDayKeys.settings(brandId), saved);
      void queryClient.invalidateQueries({ queryKey: ["special-days", "range"] });
      return saved;
    },
  };
}

export function useSpecialDayOverrides() {
  const api = useApi();
  const up = isHostUp(useHost());
  return useQuery({
    queryKey: specialDayKeys.overrides,
    queryFn: (): Promise<SpecialDayOverrides> => api.planning.overrides(),
    enabled: up,
    staleTime: 60_000,
  });
}

export function useSpecialDayOverrideActions() {
  const api = useApi();
  const queryClient = useQueryClient();
  return {
    put: async (overrides: ReligiousDayOverride[]) => {
      const saved = await api.planning.putOverrides({ overrides });
      queryClient.setQueryData(specialDayKeys.overrides, saved);
      void queryClient.invalidateQueries({ queryKey: ["special-days", "range"] });
      return saved;
    },
  };
}
