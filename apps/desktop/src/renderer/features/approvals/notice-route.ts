// A click on an approval request's macOS notification (posted by the main process): the chat at
// the request's card, or — for a request without a conversation — the brand's "Onay bekleyenler"
// in the details panel.
import { APPROVALS_ROUTE_PREFIX, parseMessageRoute } from "../../../shared/notices.ts";
import { useAppStore } from "../../state/app-store.ts";
import { focusMessage } from "../../state/focus-requests.ts";

/** Opens an approval notice's route; false for other routes. */
export function openApprovalNoticeRoute(route: string): boolean {
  const message = parseMessageRoute(route);
  if (message) {
    focusMessage(message.conversationId, message.messageId);
    return true;
  }
  if (route.startsWith(APPROVALS_ROUTE_PREFIX) && route.length > APPROVALS_ROUTE_PREFIX.length) {
    const brandId = route.slice(APPROVALS_ROUTE_PREFIX.length);
    const store = useAppStore.getState();
    store.setCurrentBrand(brandId);
    // The details panel lists the open conversation's brand: leave it for a new chat.
    if (store.route.kind === "conversation") store.navigate({ kind: "new" });
    const { panelPresented, panelPane } = useAppStore.getState();
    if (!panelPresented || panelPane !== "details") useAppStore.getState().togglePanel("details");
    return true;
  }
  return false;
}
