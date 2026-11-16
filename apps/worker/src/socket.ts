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

export interface SocketOptions {
  /** Extra HTTP headers for the upgrade request (e.g. Authorization). */
  headers?: Record<string, string>;
}

export type SocketFactory = (
  url: string,
  events: SocketEvents,
  options?: SocketOptions,
) => SocketLike;

/**
 * Default factory: Node's built-in WebSocket client (undici). Node's client
 * accepts `{ headers }` as the second argument (an undici extension that the
 * DOM typings do not describe), which is how the Authorization header is sent.
 */
export const nodeSocketFactory: SocketFactory = (url, events, options) => {
  const NodeWebSocket = WebSocket as unknown as new (
    url: string,
    init?: { headers?: Record<string, string> },
  ) => WebSocket;
  const ws = new NodeWebSocket(url, options?.headers ? { headers: options.headers } : undefined);
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
