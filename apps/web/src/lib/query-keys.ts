/** TanStack Query keys. Prefixes are used for invalidation after mutations. */
export const queryKeys = {
  health: ["health"] as const,
  presence: ["workers", "presence"] as const,
  claude: ["workers", "claude"] as const,
  gemini: ["workers", "gemini"] as const,
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
  conversations: {
    all: ["conversations"] as const,
    list: (filters: object) => ["conversations", "list", filters] as const,
    one: (id: string) => ["conversations", "one", id] as const,
    messages: (id: string) => ["conversations", "messages", id] as const,
    aliases: (id: string) => ["conversations", "aliases", id] as const,
    runs: (id: string) => ["conversations", "runs", id] as const,
  },
  plans: {
    all: ["plans"] as const,
    list: (filters: object) => ["plans", "list", filters] as const,
    one: (id: string) => ["plans", "one", id] as const,
  },
};
