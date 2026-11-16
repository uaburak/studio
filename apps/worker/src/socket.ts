/** The few socket operations the connection needs; lets tests use a fake. */
export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  isOpen(): boolean;
}

export interface SocketEvents {
  onOpen(): void;
  onMessage(data: unknown): void;
  onClose(code: number, reason: string): void;
  onError(error: unknown): void;
}

export type SocketFactory = (url: string, events: SocketEvents) => SocketLike;

/** Default factory: Node's built-in WebSocket client (stable since Node 22). */
export const nodeSocketFactory: SocketFactory = (url, events) => {
  const ws = new WebSocket(url);
  ws.addEventListener("open", () => events.onOpen());
  ws.addEventListener("message", (event) => events.onMessage(event.data));
  ws.addEventListener("close", (event) => events.onClose(event.code, event.reason));
  ws.addEventListener("error", (event) => events.onError(event));
  return {
    send: (data) => ws.send(data),
    close: (code, reason) => ws.close(code, reason),
    isOpen: () => ws.readyState === WebSocket.OPEN,
  };
};
