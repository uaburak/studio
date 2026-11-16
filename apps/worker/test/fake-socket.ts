import { decodeMessage, encodeMessage, type ProtocolMessage } from "@studio/contract";
import type { SocketEvents, SocketFactory, SocketLike, SocketOptions } from "../src/socket.ts";

/** In-memory socket that records what the worker sends and lets tests drive events. */
export class FakeSocket implements SocketLike {
  open = false;
  closed = false;
  readonly sent: ProtocolMessage[] = [];

  constructor(
    readonly url: string,
    private readonly events: SocketEvents,
    readonly headers?: SocketOptions["headers"],
  ) {}

  send(data: string): void {
    if (!this.open) throw new Error("send on a closed socket");
    const decoded = decodeMessage(data);
    if (!decoded.ok) throw new Error(`worker sent an invalid frame: ${decoded.error}`);
    this.sent.push(decoded.message);
  }

  close(): void {
    this.open = false;
    this.closed = true;
  }

  isOpen(): boolean {
    return this.open;
  }

  // --- test controls ---
  simulateOpen(): void {
    this.open = true;
    this.events.onOpen();
  }
  simulateMessage(message: ProtocolMessage): void {
    this.events.onMessage(encodeMessage(message));
  }
  simulateRaw(data: unknown): void {
    this.events.onMessage(data);
  }
  simulateClose(code = 1006, reason = ""): void {
    this.open = false;
    this.events.onClose(code, reason);
  }
}

export function fakeSocketFactory() {
  const sockets: FakeSocket[] = [];
  const factory: SocketFactory = (url, events, options) => {
    const socket = new FakeSocket(url, events, options?.headers);
    sockets.push(socket);
    return socket;
  };
  return { factory, sockets, last: () => sockets.at(-1) };
}
