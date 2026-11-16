// Minimal typing for Vite's `import.meta.glob`, used by runtime-imports.test.ts.
declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { query?: string; import?: string; eager?: boolean },
    ): Record<string, unknown>;
  }
}

export {};
