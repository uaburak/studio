// Hashes of the canvas document: what "unchanged" means for the save model (E19). The engine's
// snapshot (`encodeDocumentKiwi`) is the same bytes for the same document within an editor, but
// its header carries the editor's session (each open gets its own, session.ts), so the hash is
// taken over the message with the session and ack ids cleared: an undo back to the saved state,
// or a draft that equals its base, hashes the same.
import { decodeMessage, encodeMessage } from "@shared/schema/codec";

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The document's hash, the same whichever editor session wrote the snapshot. */
export async function documentHash(kiwi: Uint8Array): Promise<string> {
  const message = decodeMessage(kiwi) as { sessionID?: number; ackID?: number };
  return sha256Hex(encodeMessage({ ...message, sessionID: 0, ackID: 0 } as never));
}
