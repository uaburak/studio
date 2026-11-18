import path from "node:path";

/** `<stateDir>/chat/<conversationId>`: the conversation's own folder (its Claude sessions live per folder). */
export function conversationWorkDir(stateDir: string, conversationId: string): string {
  return path.join(stateDir, "chat", conversationId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 100));
}
