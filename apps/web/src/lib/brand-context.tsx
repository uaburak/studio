import type { Brand } from "@studio/contract";
import { useQuery } from "@tanstack/react-query";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { fetchAllPages, useApi } from "../api.ts";
import { queryKeys } from "./query-keys.ts";
import { storage } from "./storage.ts";

const KEY = "studio.brand";

interface BrandState {
  /** Selected brand id, or null for "Tüm markalar". */
  brandId: string | null;
  brand: Brand | null;
  setBrandId: (id: string | null) => void;
  /** All brands (active and archived), newest first. */
  brands: Brand[];
  activeBrands: Brand[];
  isLoading: boolean;
  error: unknown;
}

const BrandContext = createContext<BrandState | null>(null);

/**
 * The persistent brand switcher. The choice survives reloads (localStorage)
 * and pre-filters İçerikler, Takvim, Medya and İşler.
 */
export function BrandProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const [brandId, setBrandIdState] = useState<string | null>(() => storage.get(KEY));

  const query = useQuery({
    queryKey: queryKeys.brands.all,
    queryFn: () => fetchAllPages((cursor) => api.brands.list({ limit: 100, cursor })),
  });

  const setBrandId = useCallback((id: string | null) => {
    storage.set(KEY, id);
    setBrandIdState(id);
  }, []);

  const value = useMemo<BrandState>(() => {
    const brands = query.data ?? [];
    const brand = brands.find((b) => b.id === brandId) ?? null;
    return {
      // A stale id (brand gone) falls back to "all" once the list is known.
      brandId: query.data && !brand ? null : brandId,
      brand,
      setBrandId,
      brands,
      activeBrands: brands.filter((b) => b.status === "active"),
      isLoading: query.isLoading,
      error: query.error,
    };
  }, [query.data, query.isLoading, query.error, brandId, setBrandId]);

  return <BrandContext.Provider value={value}>{children}</BrandContext.Provider>;
}

export function useBrands(): BrandState {
  const ctx = useContext(BrandContext);
  if (!ctx) throw new Error("useBrands outside BrandProvider");
  return ctx;
}

export function useBrandName(): (id: string | null | undefined) => string {
  const { brands } = useBrands();
  return useCallback(
    (id) => (id ? (brands.find((b) => b.id === id)?.name ?? "Bilinmeyen marka") : "—"),
    [brands],
  );
}
