// Advertises the LAN gateway as `_studio._tcp` (TXT: name, api, pairing, id, addr, port) so
// phones on the same network find the Mac (StudioKit `StudioBrowser`). Uses macOS's own
// `dns-sd -R`, which registers with mDNSResponder for as long as it runs — the same
// registration the AppKit app makes with DNSServiceRegister.
import { type ChildProcess, spawn } from "node:child_process";

export const SERVICE_TYPE = "_studio._tcp";
/** TXT `api`: must match `LAN_API_VERSION` (contract) / `StudioBrowser.supportedAPIVersion`. */
export const LAN_API_VERSION = "1";

export interface AdvertiseInput {
  name: string;
  port: number;
  macId: string | null;
  addresses: string[];
}

/** TXT entries in a stable order (values cut to 255 bytes like the Swift version). */
export function txtRecord(input: AdvertiseInput): string[] {
  const entries: [string, string][] = [
    ["name", input.name],
    ["api", LAN_API_VERSION],
    ["pairing", "required"],
    ["addr", input.addresses.slice(0, 4).join(",")],
    ["port", String(input.port)],
  ];
  if (input.macId) entries.push(["id", input.macId]);
  return entries.map(([key, value]) => {
    const bytes = Buffer.from(value, "utf8").subarray(0, 255).toString("utf8");
    return `${key}=${bytes}`;
  });
}

export function dnsSdArguments(input: AdvertiseInput): string[] {
  return [
    "-R",
    input.name.slice(0, 63),
    SERVICE_TYPE,
    "local",
    String(input.port),
    ...txtRecord(input),
  ];
}

export interface Advertiser {
  readonly isAdvertising: boolean;
  start(input: AdvertiseInput): void;
  stop(): void;
}

export class DnsSdAdvertiser implements Advertiser {
  private child: ChildProcess | undefined;

  get isAdvertising(): boolean {
    return this.child !== undefined && this.child.exitCode === null;
  }

  start(input: AdvertiseInput): void {
    this.stop();
    try {
      const child = spawn("/usr/bin/dns-sd", dnsSdArguments(input), { stdio: "ignore" });
      child.once("exit", () => {
        if (this.child === child) this.child = undefined;
      });
      child.once("error", () => {
        if (this.child === child) this.child = undefined;
      });
      this.child = child;
    } catch {
      this.child = undefined;
    }
  }

  stop(): void {
    const child = this.child;
    this.child = undefined;
    if (child && child.exitCode === null) child.kill("SIGTERM");
  }
}
