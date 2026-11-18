// The owner's name in the greeting and the sidebar: "Adın" in Ayarlar, else the Claude
// account's name, else the Mac user's full name (never a name written into the code).
import { useQuery } from "@tanstack/react-query";
import { bridge } from "../lib/bridge.ts";
import { useJobsSnapshot, useSettings } from "./studio.tsx";

export function ownerName(input: {
  setting: string;
  claude?: string | null | undefined;
  mac?: string | null | undefined;
}): string {
  return input.setting.trim() || input.claude?.trim() || input.mac?.trim() || "";
}

export function useOwnerName(): string {
  const { settings } = useSettings();
  const { presence } = useJobsSnapshot();
  const mac = useQuery({
    queryKey: ["system", "user-name"],
    queryFn: async () => (await bridge().system?.info())?.userName ?? "",
    // The main process reads it in the background right after start: asked again later if empty.
    staleTime: 60_000,
    enabled: !settings.ownerName.trim() && !presence?.claude?.displayName,
  });
  return ownerName({
    setting: settings.ownerName,
    claude: presence?.claude?.displayName,
    mac: mac.data,
  });
}
