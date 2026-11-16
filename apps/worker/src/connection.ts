import {
  decodeMessage,
  encodeMessage,
  PROTOCOL_VERSION,
  type ProtocolMessage,
  type WorkerToHubMessage,
} from "@studio/contract";
import { type BackoffOptions, backoffDelay } from "./backoff.ts";
import { type Logger, silentLogger } from "./log.ts";
import type { SocketFactory, SocketLike } from "./socket.ts";

export type ConnectionState = "idle" | "connecting" | "connected" | "waiting" | "stopped";

export interface HubConnectionOptions {
  url: string;
  workerId: string;
  capabilities: string[];
  workerVersion?: string;
  backoff: BackoffOptions;
  /** Keepalive ping interval; 0 disables. */
  pingIntervalMs: number;
  socketFactory: SocketFactory;
  onMessage: (message: ProtocolMessage) => void | Promise<void>;
  onStateChange?: (state: ConnectionState) => void;
  logger?: Logger;
}

/**
 * Keeps one WebSocket to the hub alive: announces itself with `hello`,
 * sends keepalive pings, and reconnects with exponential backoff.
 */
export class HubConnection {
  private socket: SocketLike | undefined;
  private generation = 0;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private stopped = true;
  private readonly logger: Logger;
  state: ConnectionState = "idle";

  constructor(private readonly options: HubConnectionOptions) {
    this.logger = options.logger ?? silentLogger;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.pingTimer);
    this.socket?.close(1000, "worker stopping");
    this.socket = undefined;
    this.setState("stopped");
  }

  /** Send a message if connected. Returns false when it could not be sent. */
  send(message: WorkerToHubMessage): boolean {
    if (!this.socket?.isOpen()) return false;
    this.socket.send(encodeMessage(message));
    return true;
  }

  private connect(): void {
    const gen = ++this.generation;
    const isCurrent = () => gen === this.generation && !this.stopped;
    this.setState("connecting");
    this.logger.info(`connecting to ${this.options.url}`);

    try {
      this.socket = this.options.socketFactory(this.options.url, {
        onOpen: () => {
          if (!isCurrent()) return;
          this.attempt = 0;
          this.setState("connected");
          this.logger.info("connected to hub");
          this.send({
            type: "hello",
            protocolVersion: PROTOCOL_VERSION,
            workerId: this.options.workerId,
            capabilities: this.options.capabilities,
            ...(this.options.workerVersion ? { workerVersion: this.options.workerVersion } : {}),
          });
          this.startPing();
        },
        onMessage: (data) => {
          if (!isCurrent()) return;
          const decoded = decodeMessage(data);
          if (!decoded.ok) {
            this.logger.warn(`dropped malformed frame from hub: ${decoded.error}`);
            return;
          }
          Promise.resolve(this.options.onMessage(decoded.message)).catch((error: unknown) =>
            this.logger.error("message handler failed", error),
          );
        },
        onClose: (code, reason) => {
          if (!isCurrent()) return;
          this.logger.warn(`hub connection closed (${code}${reason ? `: ${reason}` : ""})`);
          this.scheduleReconnect();
        },
        onError: (error) => {
          if (!isCurrent()) return;
          this.logger.debug("socket error", error);
          // A close event follows an error; reconnect is handled there.
        },
      });
    } catch (error) {
      this.logger.error("could not create socket", error);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    clearInterval(this.pingTimer);
    this.socket = undefined;
    if (this.stopped) return;
    const delay = backoffDelay(this.attempt, this.options.backoff);
    this.attempt++;
    this.setState("waiting");
    this.logger.info(`reconnecting in ${delay} ms (attempt ${this.attempt})`);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private startPing(): void {
    clearInterval(this.pingTimer);
    if (this.options.pingIntervalMs <= 0) return;
    this.pingTimer = setInterval(
      () => this.send({ type: "ping", ts: Date.now() }),
      this.options.pingIntervalMs,
    );
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.options.onStateChange?.(state);
  }
}
