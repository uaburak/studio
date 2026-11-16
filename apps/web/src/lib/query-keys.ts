/** TanStack Query keys. Prefixes are used for invalidation after mutations. */
export const queryKeys = {
  health: ["health"] as const,
  brands: {
    all: ["brands"] as const,
    one: (id: string) => ["brands", "one", id] as const,
  },
  profiles: {
    all: (brandId: string) => ["profiles", brandId] as const,
  },
  accounts: {
    all: ["accounts"] as const,
    byBrand: (brandId: string) => ["accounts", brandId] as const,
  },
  assets: {
    all: ["assets"] as const,
    list: (filters: object) => ["assets", "list", filters] as const,
  },
  contents: {
    all: ["contents"] as const,
    list: (filters: object) => ["contents", "list", filters] as const,
    one: (id: string) => ["contents", "one", id] as const,
    versions: (id: string) => ["contents", "versions", id] as const,
    version: (id: string, version: number) => ["contents", "version", id, version] as const,
  },
  jobs: {
    all: ["jobs"] as const,
    list: (filters: object) => ["jobs", "list", filters] as const,
    one: (id: string) => ["jobs", "one", id] as const,
  },
  schedules: {
    all: ["schedules"] as const,
    list: (filters: object) => ["schedules", "list", filters] as const,
    logs: (id: string) => ["schedules", "logs", id] as const,
  },
};
