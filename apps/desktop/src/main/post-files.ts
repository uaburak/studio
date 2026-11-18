// Post export on this Mac (shared/post-files.ts): asks where to save, downloads the assets from
// the local API with the owner secret, writes them (never over an existing file: "ad 2.jpg"),
// opens the macOS share menu, and reveals only files it wrote itself. Electron's dialogs, share
// menu and Finder are injected (tests use fakes).
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import {
  FORMAT_EXTENSION,
  FORMAT_LABEL,
  type PostFile,
  type PostFileFormat,
  type PostFilesRequest,
  type PostFilesResult,
  requestProblem,
  safeFileName,
} from "../shared/post-files.ts";

export const OWNER_HEADER = "X-Studio-Owner";

export interface PostFilesDeps {
  /** The local API (null while the host is down). */
  target(): { port: number; ownerSecret: string } | null;
  /** Save dialog for one file; the chosen path or null. */
  chooseFile(suggestedName: string, format: PostFileFormat): Promise<string | null>;
  /** Folder dialog for several files; the chosen folder or null. */
  chooseFolder(count: number): Promise<string | null>;
  /** Where shared files are put before the share menu opens. */
  shareDir: string;
  /** The macOS share menu (Electron `ShareMenu`). */
  showShareMenu(paths: string[]): void;
  /** Finder (Electron `shell.showItemInFolder`). */
  showInFolder(path: string): void;
  fetch?: typeof fetch;
}

/** `name 2.ext`, `name 3.ext`… until one is free in `folder`. */
export function uniquePath(
  folder: string,
  name: string,
  exists: (path: string) => boolean = existsSync,
): string {
  const first = join(folder, name);
  if (!exists(first)) return first;
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 2; n < 1000; n++) {
    const candidate = join(folder, `${stem} ${n}${ext}`);
    if (!exists(candidate)) return candidate;
  }
  return first;
}

function message(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text || "Dosya yazılamadı.";
}

export class PostFiles {
  /** Files written by `save` this session: the only ones `reveal` shows. */
  private readonly written = new Set<string>();
  private readonly fetchFn: typeof fetch;

  constructor(private readonly deps: PostFilesDeps) {
    this.fetchFn = deps.fetch ?? fetch;
  }

  private async download(file: PostFile): Promise<Uint8Array> {
    const target = this.deps.target();
    if (!target) throw new Error("Studio sunucusu hazır değil.");
    const res = await this.fetchFn(
      `http://127.0.0.1:${target.port}/api/assets/${encodeURIComponent(file.assetId)}/content`,
      { headers: { [OWNER_HEADER]: target.ownerSecret } },
    );
    if (!res.ok) throw new Error(`${file.name} indirilemedi (HTTP ${res.status}).`);
    return new Uint8Array(await res.arrayBuffer());
  }

  private names(request: PostFilesRequest): string[] {
    return request.files.map(
      (f) => safeFileName(f.name, request.format) ?? `post.${FORMAT_EXTENSION[request.format]}`,
    );
  }

  async save(request: PostFilesRequest): Promise<PostFilesResult> {
    const problem = requestProblem(request);
    if (problem) return { ok: false, message: problem };
    const names = this.names(request);
    try {
      let targets: string[];
      if (request.files.length === 1) {
        const chosen = await this.deps.chooseFile(names[0] as string, request.format);
        if (!chosen) return { ok: false, canceled: true };
        targets = [chosen];
      } else {
        const folder = await this.deps.chooseFolder(request.files.length);
        if (!folder) return { ok: false, canceled: true };
        // Names unique among themselves and against the folder.
        const taken = new Set<string>();
        targets = names.map((name) => {
          const path = uniquePath(folder, name, (p) => taken.has(p) || existsSync(p));
          taken.add(path);
          return path;
        });
      }
      const paths: string[] = [];
      for (const [i, file] of request.files.entries()) {
        const bytes = await this.download(file);
        const path = targets[i] as string;
        await writeFile(path, bytes);
        this.written.add(path);
        paths.push(path);
      }
      return { ok: true, paths };
    } catch (error) {
      return { ok: false, message: message(error) };
    }
  }

  async share(request: PostFilesRequest): Promise<PostFilesResult> {
    const problem = requestProblem(request);
    if (problem) return { ok: false, message: problem };
    const names = this.names(request);
    try {
      // The previous share's files go; each share gets its own folder.
      await rm(this.deps.shareDir, { recursive: true, force: true });
      const folder = join(this.deps.shareDir, randomUUID());
      await mkdir(folder, { recursive: true });
      const taken = new Set<string>();
      const paths: string[] = [];
      for (const [i, file] of request.files.entries()) {
        const path = uniquePath(folder, names[i] as string, (p) => taken.has(p));
        taken.add(path);
        await writeFile(path, await this.download(file));
        paths.push(path);
      }
      this.deps.showShareMenu(paths);
      return { ok: true, paths };
    } catch (error) {
      return { ok: false, message: message(error) };
    }
  }

  reveal(paths: unknown): void {
    if (!Array.isArray(paths)) return;
    const known = paths.filter((p): p is string => typeof p === "string" && this.written.has(p));
    // Finder selects one item; the first written file shows the folder.
    const first = known[0];
    if (first) this.deps.showInFolder(first);
  }
}

/** Save dialog filter for a format. */
export function dialogFilter(format: PostFileFormat): { name: string; extensions: string[] } {
  return { name: FORMAT_LABEL[format], extensions: [FORMAT_EXTENSION[format]] };
}
