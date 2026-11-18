// The post editor's working drafts on disk (shared/drafts.ts): `<stateDir>/drafts/<contentId>.draft`,
// one file per post, readable only by this user (0600, the folder 0700), replaced atomically (a
// temporary file, fsync, rename) so a crash or a quit mid-write leaves the previous draft.
//
// File: "SDRF" + format byte (1) + header length (uint32 BE) + header JSON (DraftMeta) + the bundle.
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { DRAFT_ID, type Draft, type DraftMeta, MAX_DRAFT_BYTES } from "../shared/drafts.ts";

const MAGIC = [0x53, 0x44, 0x52, 0x46]; // "SDRF"
const FORMAT = 1;
const HEAD = MAGIC.length + 1 + 4;

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** A draft the page sent, checked (null: not a draft). */
export function validDraft(value: unknown): Draft | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.contentId !== "string" || !DRAFT_ID.test(v.contentId)) return null;
  if (!isNumber(v.baseVersion) || v.baseVersion < 0 || !isNumber(v.savedAt)) return null;
  const bundle = v.bundle;
  if (!(bundle instanceof Uint8Array) || bundle.byteLength === 0) return null;
  if (bundle.byteLength > MAX_DRAFT_BYTES) return null;
  return {
    contentId: v.contentId,
    baseVersion: Math.trunc(v.baseVersion),
    baseVersionId: strOrNull(v.baseVersionId),
    savedAt: v.savedAt,
    baseHash: strOrNull(v.baseHash),
    docHash: strOrNull(v.docHash),
    bundle,
  };
}

export class DraftStore {
  constructor(private readonly dir: string) {}

  private file(contentId: string): string {
    if (!DRAFT_ID.test(contentId)) throw new Error("Geçersiz post kimliği.");
    return join(this.dir, `${contentId}.draft`);
  }

  save(input: unknown): DraftMeta {
    const draft = validDraft(input);
    if (!draft) throw new Error("Taslak geçersiz ya da çok büyük.");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const { bundle, ...meta } = draft;
    const header = Buffer.from(JSON.stringify(meta), "utf8");
    const head = Buffer.alloc(HEAD);
    head.set(MAGIC, 0);
    head[MAGIC.length] = FORMAT;
    head.writeUInt32BE(header.byteLength, MAGIC.length + 1);
    const file = this.file(draft.contentId);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, head);
      writeSync(fd, header);
      writeSync(fd, bundle);
      fsyncSync(fd);
    } catch (e) {
      closeSync(fd);
      rmSync(tmp, { force: true });
      throw e;
    }
    closeSync(fd);
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
    return meta;
  }

  load(contentId: string): Draft | null {
    if (typeof contentId !== "string" || !DRAFT_ID.test(contentId)) return null;
    const file = this.file(contentId);
    if (!existsSync(file)) return null;
    try {
      const bytes = readFileSync(file);
      if (bytes.byteLength < HEAD || MAGIC.some((b, i) => bytes[i] !== b)) return null;
      if (bytes[MAGIC.length] !== FORMAT) return null;
      const length = bytes.readUInt32BE(MAGIC.length + 1);
      const meta = JSON.parse(bytes.subarray(HEAD, HEAD + length).toString("utf8")) as unknown;
      const bundle = new Uint8Array(bytes.subarray(HEAD + length));
      const draft = validDraft({ ...(meta as object), bundle });
      return draft && draft.contentId === contentId ? draft : null;
    } catch {
      // A broken file is no draft (the next save replaces it).
      return null;
    }
  }

  remove(contentId: string): void {
    if (typeof contentId !== "string" || !DRAFT_ID.test(contentId)) return;
    rmSync(this.file(contentId), { force: true });
  }
}
