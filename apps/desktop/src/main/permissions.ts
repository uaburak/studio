// Web permissions of the app's pages (G7). Electron grants every request by default (camera,
// microphone, location, notifications, …); Studio denies all of them except what its own pages
// really use, and only for its own origin:
//  - clipboard-sanitized-write: copy buttons (captions, code, images), Wecra's copy;
//  - clipboard-read: pasting into Wecra's canvas;
//  - pointerLock: dragging number fields in Wecra's panels;
//  - fullscreen: Wecra's presentation view.
// Notifications are shown by the main process and installed fonts come over IPC, so the
// renderer needs neither "notifications" nor "local-fonts".
import { originOf } from "./protocol-paths.ts";

export const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set([
  "clipboard-sanitized-write",
  "clipboard-read",
  "pointerLock",
  "fullscreen",
]);

/** Whether `permission` may be granted to a page at `url` (an origin or a full URL). */
export function permissionAllowed(
  permission: string,
  url: string | null | undefined,
  appOrigins: readonly string[],
): boolean {
  if (!ALLOWED_PERMISSIONS.has(permission) || !url) return false;
  const origin = originOf(url);
  return origin !== null && appOrigins.includes(origin);
}
