// The line under the composer (Wecra "Status line"), right-aligned like Claude Code's
// "Opus 5.5  Medium   Auto  ◌": model + effort (one menu, opens above), the approval mode and
// the usage ring (usage card above). A Mac problem shows on the left.
import type { WorkerPresence } from "@studio/contract";
import { useState } from "react";
import {
  type AgentChoice,
  EFFORTS,
  effortLabel,
  MODEL_GROUPS,
  modelLabel,
  modelNote,
  modelUnavailableReason,
} from "../../lib/models.ts";
import { budgetLine, formatUsd, useGeminiSpend, useSpendAvailable } from "../../lib/spend.ts";
import { canRunChat, macLine, ringMeter, usageMeters } from "../../lib/usage.ts";
import { useAppStore } from "../../state/app-store.ts";
import { cn, Meter, UsageRing } from "../ui/controls.tsx";
import { IconArrowRight } from "../ui/icons.tsx";
import { MenuButton, type MenuEntry } from "../ui/menu.tsx";
import { Popover } from "../ui/popover.tsx";
import { Tooltip } from "../ui/tooltip.tsx";

/**
 * Models grouped by provider (Claude, Gemini, OpenAI, Google Antigravity); a model whose
 * provider cannot answer on this Mac right now is greyed out with the reason.
 */
export function modelMenu(
  choice: AgentChoice,
  onChange: (choice: AgentChoice) => void,
  presence?: WorkerPresence | null,
): MenuEntry[] {
  let digit = 0;
  const groups: MenuEntry[] = MODEL_GROUPS.flatMap((group, gi) => [
    ...(gi > 0 ? [{ type: "separator" as const, id: `sep-${group.provider}` }] : []),
    { type: "label" as const, id: `label-${group.provider}`, label: group.title },
    ...group.models.map((m) => {
      const reason = modelUnavailableReason(m.id, presence);
      const note = reason ? null : modelNote(m.id, presence);
      digit++;
      return {
        id: m.id,
        label: m.label,
        ...(digit <= 9 ? { shortcut: String(digit) } : {}),
        checked: choice.model === m.id,
        ...(reason && choice.model !== m.id ? { disabled: true, detail: reason } : {}),
        ...(reason && choice.model === m.id ? { detail: reason } : {}),
        ...(note ? { detail: note } : {}),
        onSelect: () => onChange({ ...choice, model: m.id }),
      };
    }),
  ]);
  return [
    ...groups,
    { type: "separator" },
    {
      id: "effort",
      label: "Efor",
      detail: effortLabel(choice.effort),
      shortcut: "E",
      submenu: EFFORTS.map((e) => ({
        id: e.id,
        label: e.label,
        checked: choice.effort === e.id,
        onSelect: () => onChange({ ...choice, effort: e.id }),
      })),
    },
  ];
}

/** Gemini API spend under the Claude limits (hidden until something was spent). */
function GeminiSpendLine() {
  const spend = useGeminiSpend();
  const data = spend.data;
  if (!data || (data.month.calls === 0 && data.budget.monthlyUsd === null)) return null;
  const budget = budgetLine(data);
  return (
    <div className="mt-3.5 border-t border-hairline pt-3">
      <div className="flex items-baseline justify-between text-body">
        <span className="text-fg">Gemini API</span>
        <span className={data.budget.warning ? "text-accent-text" : "text-fg-2"}>
          {formatUsd(data.month.costUsd)} bu ay
        </span>
      </div>
      <div className="text-footnote text-fg-3">Bugün {formatUsd(data.today.costUsd)}</div>
      {budget && (
        <>
          <div className="mt-1 mb-1.5 text-footnote text-fg-3">{budget}</div>
          <Meter
            percent={Math.min(100, data.budget.usedPercent ?? 0)}
            tone={data.budget.warning ? "danger" : "info"}
          />
        </>
      )}
    </div>
  );
}

export function UsageCard({ presence }: { presence: WorkerPresence | null }) {
  const togglePanel = useAppStore((s) => s.togglePanel);
  const spendAvailable = useSpendAvailable();
  const meters = usageMeters(presence?.usage);
  const plan = presence?.claude?.plan;
  return (
    <div className="w-[272px]">
      <div className="mb-3 flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-body font-medium text-fg">
          Kullanım limitlerin{plan ? ` · ${plan}` : ""}
        </span>
        <button
          type="button"
          onClick={() => togglePanel("details")}
          className="flex items-center gap-1 text-footnote text-accent-text hover:underline"
        >
          Tümünü gör <IconArrowRight size={12} />
        </button>
      </div>
      {meters.length === 0 ? (
        <p className="text-footnote text-fg-2">Kullanım henüz bildirilmedi · {macLine(presence)}</p>
      ) : (
        <div className="flex flex-col gap-3.5">
          {meters.map((m) => (
            <div key={m.kind}>
              <div className="flex items-baseline justify-between text-body">
                <span className="text-fg">{m.title}</span>
                <span className={m.warning ? "text-accent-text" : "text-fg-2"}>
                  {m.percentText}
                </span>
              </div>
              {m.resetText && <div className="mb-1.5 text-footnote text-fg-3">{m.resetText}</div>}
              <Meter
                percent={m.percent}
                tone={m.kind === "weekly" ? "warning" : m.warning ? "danger" : "info"}
              />
            </div>
          ))}
        </div>
      )}
      {spendAvailable && <GeminiSpendLine />}
    </div>
  );
}

export function StatusLine({
  choice,
  onChoice,
  presence,
}: {
  choice: AgentChoice;
  onChoice(choice: AgentChoice): void;
  presence: WorkerPresence | null;
}) {
  const [ringAnchor, setRingAnchor] = useState<HTMLButtonElement | null>(null);
  const [usageOpen, setUsageOpen] = useState(false);
  const ring = ringMeter(presence?.usage);
  const problem =
    presence && (!presence.online || !canRunChat(presence)) ? macLine(presence) : null;
  return (
    <div className="flex h-6 items-center gap-3 px-2.5 text-footnote">
      {problem ? (
        <span className="flex items-center gap-1.5 text-fg-2">
          <span className="size-1.5 rounded-full bg-warning" />
          {presence?.online ? "Sohbet ajanı Mac'te hazır değil" : problem}
        </span>
      ) : (
        <span />
      )}
      <div className="flex-1" />
      <MenuButton
        entries={() => modelMenu(choice, onChoice, presence)}
        placement="top-end"
        label="Model ve efor"
        width={248}
      >
        {({ ref, onClick, onKeyDown, open, ...aria }) => (
          <button
            ref={ref}
            type="button"
            {...aria}
            onClick={onClick}
            onKeyDown={onKeyDown}
            className={cn(
              "no-drag flex h-6 items-center gap-1.5 rounded-full px-1.5 hover:bg-control",
              open && "bg-control",
            )}
          >
            <span className="text-fg">{modelLabel(choice.model)}</span>
            <span className="text-fg-2">{effortLabel(choice.effort)}</span>
          </button>
        )}
      </MenuButton>
      <Tooltip label="Zamanlama ve onay gibi işler için izin kartı çıkar">
        <span className="text-fg">Otomatik</span>
      </Tooltip>
      <button
        ref={setRingAnchor}
        type="button"
        aria-label={ring ? `Kullanım ${ring.percentText}` : "Kullanım"}
        aria-expanded={usageOpen}
        onClick={() => setUsageOpen((o) => !o)}
        className="no-drag flex size-6 items-center justify-center rounded-full hover:bg-control"
      >
        <UsageRing percent={ring?.percent ?? 0} warning={ring?.warning} />
      </button>
      <Popover
        anchor={ringAnchor}
        open={usageOpen}
        onClose={() => setUsageOpen(false)}
        placement="top-end"
        label="Kullanım"
      >
        <UsageCard presence={presence} />
      </Popover>
    </div>
  );
}
