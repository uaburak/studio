// Server data of the brand's products (Ürünler): the list and create / update / delete, kept
// in the react-query cache. Photos are ordinary brand `image` assets (POST /api/assets).
import type { BrandProduct, BrandProductCreate, BrandProductUpdate } from "@studio/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useApi } from "../../lib/api.ts";
import { fetchAllPages } from "../../lib/paging.ts";
import { isHostUp, useHost } from "../../state/studio.tsx";

export const productKeys = {
  list: (brandId: string | null) => ["brand", "products", brandId] as const,
};

/** Every product of the brand, oldest first. */
export function useBrandProducts(brandId: string | null) {
  const api = useApi();
  const up = isHostUp(useHost());
  return useQuery({
    queryKey: productKeys.list(brandId),
    queryFn: (): Promise<BrandProduct[]> =>
      fetchAllPages(
        (cursor) =>
          api.brandProducts.list(brandId as string, { limit: 100, ...(cursor ? { cursor } : {}) }),
        5,
      ),
    enabled: up && brandId !== null,
    staleTime: 30_000,
  });
}

export function useProductActions(brandId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  const key = productKeys.list(brandId);
  const put = (product: BrandProduct) =>
    queryClient.setQueryData<BrandProduct[]>(key, (list) => {
      if (!list) return [product];
      return list.some((p) => p.id === product.id)
        ? list.map((p) => (p.id === product.id ? product : p))
        : [...list, product];
    });
  return {
    create: async (input: BrandProductCreate) => {
      const product = await api.brandProducts.create(brandId, input);
      put(product);
      return product;
    },
    update: async (productId: string, input: BrandProductUpdate) => {
      const product = await api.brandProducts.update(brandId, productId, input);
      put(product);
      return product;
    },
    remove: async (productId: string) => {
      await api.brandProducts.delete(brandId, productId);
      queryClient.setQueryData<BrandProduct[]>(key, (list) =>
        list?.filter((p) => p.id !== productId),
      );
    },
    uploadPhoto: (file: File) =>
      api.assets.upload({ file, brandId, kind: "image", source: "upload" }),
  };
}
