// Ayarlar → Hesaplar (Claude's tabs + table): "Hesaplar | Uygulamalar" tabs, search and
// "+ Hesap ekle" on top; a table of every brand's Instagram / Facebook / LinkedIn accounts with
// their health and Bağla / Yeniden bağla / Denetle / Bağlantıyı kes; the running connect flow
// (browser wait, Meta Page picker, result) above it. "Uygulamalar": the owner's Meta and
// LinkedIn apps. Secrets are typed into uncontrolled fields and handed to the main process once.
import type { Brand, Platform } from "@studio/contract";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  type AccountsPhase,
  type MetaPageSelectionValue,
  type PublishingApps,
  SETUP_GUIDE,
} from "../../../shared/accounts-ipc.ts";
import {
  Button,
  Checkbox,
  cn,
  IconButton,
  SegmentedControl,
  Spinner,
  TextField,
} from "../../components/ui/controls.tsx";
import { IconCheck, IconEllipsis, IconPlus, PlatformIcon } from "../../components/ui/icons.tsx";
import { MenuButton, type MenuEntry } from "../../components/ui/menu.tsx";
import { useAccounts, useBrands } from "../../state/studio.tsx";
import { ITEMS } from "../settings/catalog.ts";
import {
  FormFooter,
  Pane,
  Row,
  Table,
  type TableRow,
  TitleCell,
  Toolbar,
  useConfirm,
  useSettingsFilter,
} from "../settings/parts.tsx";
import {
  type AccountsTableRow,
  accountRows,
  appConfigured,
  flowBusy,
  numbered,
  phaseLine,
  pickedCount,
  platformKind,
} from "./model.ts";
import { accountsBridge, appsKey, useAccountsFlow, usePublishingApps } from "./use-accounts.ts";

type Tab = "accounts" | "apps";

export function AccountsSection() {
  const filter = useSettingsFilter();
  const [tab, setTab] = useState<Tab>("accounts");
  const [query, setQuery] = useState("");
  const brands = useBrands();
  const accounts = useAccounts();
  const apps = usePublishingApps();
  const flow = useAccountsFlow();
  const busy = flowBusy(flow.phase);
  const activeBrands = (brands.data ?? []).filter((b) => b.status === "active");
  const rows = useMemo(
    () =>
      accountRows({
        brands: activeBrands,
        accounts: accounts.data ?? [],
        apps: apps.data,
        busyIds: flow.busyAccountIds,
      }),
    [activeBrands, accounts.data, apps.data, flow.busyAccountIds],
  );
  const showAccounts = filter.searching || tab === "accounts";
  const showApps = filter.searching || tab === "apps";
  const toolbarHit =
    !filter.searching ||
    filter.visible(ITEMS.connectMeta.id) ||
    filter.visible(ITEMS.connectLinkedIn.id);

  return (
    <Pane title="Hesaplar" showTitle={false}>
      {toolbarHit && (
        <div data-settings-row={filter.searching ? ITEMS.connectMeta.id : undefined}>
          <Toolbar
            search={query}
            onSearch={filter.searching || tab !== "accounts" ? undefined : setQuery}
            placeholder="Hesaplarda ara"
            trailing={
              <ConnectMenu
                brands={activeBrands}
                apps={apps.data}
                disabled={busy}
                onApps={() => setTab("apps")}
              />
            }
          >
            {!filter.searching && (
              <SegmentedControl<Tab>
                label="Hesaplar sekmeleri"
                value={tab}
                onChange={setTab}
                options={[
                  { value: "accounts", label: "Hesaplar" },
                  { value: "apps", label: "Uygulamalar" },
                ]}
              />
            )}
          </Toolbar>
        </div>
      )}
      <FlowCard phase={flow.phase} brands={activeBrands} />
      {showAccounts && (
        <Table
          label="Hesaplar"
          columns={[
            { title: "Hesap" },
            { title: "Tür", width: 150 },
            { title: "Marka", width: 120 },
            { title: "Durum", width: 150 },
            { title: "", width: 136 },
          ]}
          rows={rows.map((row) => tableRow(row, busy))}
          localQuery={filter.searching ? "" : query}
          empty={
            activeBrands.length === 0
              ? "Önce bir marka oluştur."
              : accounts.isError
                ? "Hesaplar okunamadı."
                : "Bu markalara bağlı hesap yok."
          }
        />
      )}
      {showApps && <AppsRows apps={apps.data} />}
    </Pane>
  );
}

// --- table ------------------------------------------------------------------------------------------

function connect(platform: Platform | string, brandId: string) {
  const b = accountsBridge();
  void (platform === "linkedin" ? b.connectLinkedIn(brandId) : b.connectMeta(brandId));
}

function tableRow(row: AccountsTableRow, flowRunning: boolean): TableRow {
  const icon = <PlatformIcon platform={row.platform} size={16} />;
  if (row.kind === "missing") {
    return {
      id: row.id,
      searchText: row.searchText,
      cells: [
        <TitleCell key="t" icon={icon} title={row.title} muted />,
        <span key="k" className="truncate text-fg-2">
          {platformKind(row.platform)}
        </span>,
        <span key="b" className="truncate text-fg-2">
          {row.brandName}
        </span>,
        <span key="s" className="truncate text-fg-3">
          {row.status}
        </span>,
        <div key="a" className="flex justify-end">
          <Button
            size="sm"
            disabled={!row.configured || flowRunning}
            title={
              row.configured
                ? row.platform === "linkedin"
                  ? ITEMS.connectLinkedIn.detail
                  : ITEMS.connectMeta.detail
                : `Önce Uygulamalar sekmesinde ${row.platform === "linkedin" ? "LinkedIn" : "Meta"} uygulamasını kaydet.`
            }
            aria-label={`${row.title} · ${row.brandName}: bağla`}
            onClick={() => connect(row.platform, row.brandId)}
          >
            Bağla
          </Button>
        </div>,
      ],
    };
  }
  return {
    id: row.id,
    searchText: row.searchText,
    dimmed: row.dimmed,
    cells: [
      <TitleCell key="t" icon={icon} title={row.title} muted={row.dimmed} />,
      <span key="k" className="truncate text-fg-2">
        {platformKind(row.platform)}
      </span>,
      <span key="b" className="truncate text-fg-2">
        {row.brandName}
      </span>,
      <span key="s" className="flex min-w-0 flex-col">
        <span
          title={row.hint ?? undefined}
          className={cn(
            "flex min-w-0 items-center gap-1",
            row.needsOwner ? "text-accent-text" : row.healthy ? "text-success" : "text-fg-3",
          )}
        >
          {row.healthy && <IconCheck size={13} className="shrink-0" />}
          <span className="truncate">{row.status}</span>
        </span>
        {row.engagementHint && (
          <span
            className="truncate text-footnote text-accent-text"
            title="Yayın çalışmaya devam eder; istatistikleri ve yorumları okumak için Meta'nın yeni izinleri gerekiyor."
          >
            {row.engagementHint}
          </span>
        )}
      </span>,
      <AccountActions key="a" row={row} flowRunning={flowRunning} />,
    ],
  };
}

function AccountActions({
  row,
  flowRunning,
}: {
  row: Extract<AccountsTableRow, { kind: "account" }>;
  flowRunning: boolean;
}) {
  const confirm = useConfirm();
  const account = row.account;
  const disabled = account.status === "disabled";
  const canConnect = row.configured && !flowRunning;
  const entries: MenuEntry[] = [
    ...(!disabled
      ? [
          {
            id: "check",
            label: "Denetle",
            disabled: row.busy || flowRunning,
            onSelect: () =>
              void accountsBridge().check({ id: account.id, platform: account.platform }),
          },
        ]
      : []),
    {
      id: "reconnect",
      label: disabled ? "Bağla" : "Yeniden bağla",
      disabled: !canConnect,
      onSelect: () => connect(account.platform, account.brandId),
    },
    ...(!disabled
      ? ([
          { type: "separator", id: "sep" },
          {
            id: "disconnect",
            label: "Bağlantıyı kes…",
            danger: true,
            disabled: row.busy,
            onSelect: () =>
              confirm({
                title: `${row.title} bağlantısı kesilsin mi?`,
                message:
                  "Erişim anahtarı Studio'dan silinir ve bu hesaba yayın yapılmaz. Bekleyen zamanlamalar varsa önce onları iptal etmen istenir. Sonra yeniden bağlayabilirsin.",
                confirm: "Bağlantıyı kes",
                danger: true,
                onConfirm: () => void accountsBridge().disconnect(account.id),
              }),
          },
        ] satisfies MenuEntry[])
      : []),
  ];
  return (
    <div className="flex items-center justify-end gap-1.5">
      {row.busy ? (
        <span className="flex size-6 items-center justify-center text-fg-2">
          <Spinner size={14} />
        </span>
      ) : row.action !== "none" ? (
        <Button
          size="sm"
          variant={row.needsOwner ? "primary" : "secondary"}
          disabled={!canConnect}
          title={row.hint ?? undefined}
          onClick={() => connect(account.platform, account.brandId)}
        >
          {row.action === "connect" ? "Bağla" : "Yeniden bağla"}
        </Button>
      ) : null}
      <MenuButton entries={entries} width={190} label={`${row.title}: seçenekler`}>
        {({ open, ref, ...props }) => (
          <IconButton
            ref={ref}
            {...props}
            size={24}
            selected={open}
            tooltip={false}
            label={`${row.title}: seçenekler`}
            icon={<IconEllipsis size={14} />}
          />
        )}
      </MenuButton>
    </div>
  );
}

function ConnectMenu({
  brands,
  apps,
  disabled,
  onApps,
}: {
  brands: Brand[];
  apps: PublishingApps | undefined;
  disabled: boolean;
  onApps(): void;
}) {
  const metaReady = appConfigured("instagram", apps);
  const linkedInReady = appConfigured("linkedin", apps);
  const sorted = [...brands].sort((a, b) => a.name.localeCompare(b.name, "tr"));
  const forBrands = (platform: "meta" | "linkedin"): MenuEntry[] =>
    sorted.map((brand) => ({
      id: `${platform}-${brand.id}`,
      label: brand.name,
      onSelect: () => connect(platform === "linkedin" ? "linkedin" : "instagram", brand.id),
    }));
  const entry = (platform: "meta" | "linkedin", label: string, ready: boolean): MenuEntry => {
    const only = sorted.length === 1 ? sorted[0] : undefined;
    return {
      id: platform,
      label,
      disabled: !ready || sorted.length === 0,
      ...(only
        ? {
            onSelect: () => connect(platform === "linkedin" ? "linkedin" : "instagram", only.id),
          }
        : { submenu: forBrands(platform) }),
    };
  };
  const entries: MenuEntry[] = [
    { type: "label", label: sorted.length > 1 ? "Markayı seç" : "Bağla" },
    entry("meta", "Instagram ve Facebook…", metaReady),
    entry("linkedin", "LinkedIn…", linkedInReady),
    ...(!metaReady || !linkedInReady
      ? ([
          { type: "separator", id: "sep" },
          { id: "apps", label: "Uygulamaları ayarla…", onSelect: onApps },
        ] satisfies MenuEntry[])
      : []),
  ];
  return (
    <MenuButton entries={entries} width={220} label="Hesap ekle" placement="bottom-end">
      {({ open: _open, ref, ...props }) => (
        <Button
          ref={ref}
          {...props}
          variant="primary"
          disabled={disabled}
          icon={<IconPlus size={14} strokeWidth={2} />}
        >
          Hesap ekle
        </Button>
      )}
    </MenuButton>
  );
}

// --- flow -------------------------------------------------------------------------------------------

function FlowCard({ phase, brands }: { phase: AccountsPhase; brands: Brand[] }) {
  if (phase.kind === "idle") return null;
  const b = accountsBridge();
  const line = phaseLine(phase);
  return (
    <div
      role="status"
      aria-live="polite"
      className="mb-3 rounded-[12px] border border-border px-4 py-3 animate-fade-in"
    >
      {line && (
        <div className="flex items-center gap-3">
          <Spinner size={14} />
          <p className="min-w-0 flex-1 text-body text-fg">{line}</p>
          <Button size="sm" onClick={() => void b.cancel()}>
            Vazgeç
          </Button>
        </div>
      )}
      {phase.kind === "picking" && (
        <MetaPicker
          key={phase.pages.map((p) => p.pageId).join()}
          phase={phase}
          brandName={brands.find((x) => x.id === phase.brandId)?.name ?? "Marka"}
        />
      )}
      {(phase.kind === "finished" || phase.kind === "failed") && (
        <div className="flex items-center gap-3">
          <p
            className={cn(
              "selectable min-w-0 flex-1 text-body",
              phase.kind === "failed" ? "text-danger" : "text-fg",
            )}
          >
            {phase.message}
          </p>
          <Button size="sm" onClick={() => void b.dismiss()}>
            {phase.kind === "failed" ? "Kapat" : "Tamam"}
          </Button>
        </div>
      )}
    </div>
  );
}

export function MetaPicker({
  phase,
  brandName,
}: {
  phase: Extract<AccountsPhase, { kind: "picking" }>;
  brandName: string;
}) {
  const [selections, setSelections] = useState<MetaPageSelectionValue[]>(phase.initial);
  const toggle = (pageId: string, patch: Partial<MetaPageSelectionValue>) =>
    setSelections((list) => {
      const current = list.find((s) => s.pageId === pageId) ?? {
        pageId,
        facebook: false,
        instagram: false,
      };
      return [...list.filter((s) => s.pageId !== pageId), { ...current, ...patch }];
    });
  const count = pickedCount(selections);
  return (
    <div className="flex flex-col gap-2.5">
      <h4 className="text-heading font-semibold text-fg">
        {brandName} için bağlanacak hesapları seç
      </h4>
      {phase.missingScopes.length > 0 && (
        <p className="text-footnote text-accent-text">
          Verilmeyen izinler: {phase.missingScopes.join(", ")}. Yayın için gerekebilir; eksikse
          yeniden bağlarken onayla.
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {phase.pages.map((page) => {
          const s = selections.find((x) => x.pageId === page.pageId);
          return (
            <li key={page.pageId} className="flex flex-col gap-1.5">
              <Checkbox
                checked={s?.facebook === true}
                disabled={!page.canPublish}
                onChange={(on) => toggle(page.pageId, { facebook: on })}
              >
                Facebook Sayfası · {page.pageName}
              </Checkbox>
              {page.instagram && (
                <Checkbox
                  checked={s?.instagram === true}
                  disabled={!page.canPublish}
                  onChange={(on) => toggle(page.pageId, { instagram: on })}
                >
                  Instagram · @{page.instagram.username}{" "}
                  <span className="text-fg-3">({page.pageName} Sayfasına bağlı)</span>
                </Checkbox>
              )}
              {!page.canPublish && (
                <p className="pl-6 text-footnote text-fg-3">
                  Bu Sayfada içerik oluşturma yetkin yok (Sayfa rolü gerekir).
                </p>
              )}
            </li>
          );
        })}
      </ul>
      {!phase.longLived && (
        <p className="text-footnote text-fg-3">
          App Secret girilmediği için bağlantı yaklaşık bir saat geçerli olur.
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button size="sm" onClick={() => void accountsBridge().cancel()}>
          Vazgeç
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={count === 0}
          onClick={() =>
            void accountsBridge().confirmMeta(
              selections.filter((x) => phase.pages.some((p) => p.pageId === x.pageId)),
            )
          }
        >
          Seçilenleri bağla ({count})
        </Button>
      </div>
    </div>
  );
}

// --- apps ---------------------------------------------------------------------------------------------

function useSaveMessage() {
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  return { message, setMessage };
}

function AppsRows({ apps }: { apps: PublishingApps | undefined }) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const store = (value: PublishingApps) => queryClient.setQueryData(appsKey, value);
  return (
    <div className="flex flex-col">
      <MetaAppRow apps={apps} onSaved={store} />
      <LinkedInAppRow apps={apps} onSaved={store} />
      {apps?.meta.hasSecret && (
        <Row item={ITEMS.forgetMetaSecret}>
          <Button
            onClick={() =>
              confirm({
                title: "Meta App Secret silinsin mi?",
                message:
                  "Bağlı hesaplar çalışmaya devam eder; bundan sonraki bağlantılar yaklaşık bir saat geçerli olur.",
                confirm: "Sil",
                danger: true,
                onConfirm: () => void accountsBridge().forgetMetaSecret().then(store),
              })
            }
          >
            Sil
          </Button>
        </Row>
      )}
    </div>
  );
}

function MetaAppRow({
  apps,
  onSaved,
}: {
  apps: PublishingApps | undefined;
  onSaved(value: PublishingApps): void;
}) {
  const [appId, setAppId] = useState(apps?.meta.appId ?? "");
  const secret = useRef<HTMLInputElement | null>(null);
  const [steps, setSteps] = useState(false);
  const [saving, setSaving] = useState(false);
  const { message, setMessage } = useSaveMessage();
  useEffect(() => setAppId(apps?.meta.appId ?? ""), [apps?.meta.appId]);
  const configured = (apps?.meta.appId ?? "").length > 0;
  const detail = configured
    ? `Uygulama Kimliği: ${apps?.meta.appId} · App Secret: ${apps?.meta.hasSecret ? "bu Mac'te şifreli" : "yok (bağlantılar ~1 saat geçerli olur)"}`
    : "Hesap bağlamak için kendi Meta uygulaman gerekir.";
  const save = async () => {
    setSaving(true);
    const result = await accountsBridge().saveMetaApp({
      appId,
      secret: secret.current?.value ?? "",
    });
    setSaving(false);
    if (result.ok) {
      if (secret.current) secret.current.value = "";
      onSaved(result.value);
      setMessage({ text: "Kaydedildi.", error: false });
    } else {
      setMessage({ text: result.message, error: true });
    }
  };
  return (
    <Row
      item={ITEMS.metaApp}
      detail={detail}
      footer={
        <FormFooter
          fields={
            <>
              {(!configured || steps) && (
                <p className="selectable text-footnote whitespace-pre-line text-fg-2">
                  {`Yapılacaklar:\n${numbered(SETUP_GUIDE.meta)}`}
                </p>
              )}
              <TextField
                aria-label="Meta Uygulama Kimliği"
                placeholder="Uygulama Kimliği (App ID)"
                value={appId}
                inputMode="numeric"
                onChange={(e) => setAppId(e.target.value)}
              />
              <TextField
                ref={secret}
                aria-label="Meta App Secret"
                type="password"
                autoComplete="off"
                placeholder={
                  apps?.meta.hasSecret
                    ? "App Secret (kayıtlı; değiştirmek için yaz)"
                    : "App Secret (isteğe bağlı)"
                }
              />
            </>
          }
          buttons={
            <>
              {configured && (
                <Button onClick={() => setSteps((s) => !s)}>
                  {steps ? "Adımları gizle" : "Kurulum adımları"}
                </Button>
              )}
              <Button disabled={saving} onClick={() => void save()}>
                Kaydet
              </Button>
            </>
          }
          message={message?.text ?? null}
          messageTone={message?.error ? "danger" : "default"}
        />
      }
    />
  );
}

function LinkedInAppRow({
  apps,
  onSaved,
}: {
  apps: PublishingApps | undefined;
  onSaved(value: PublishingApps): void;
}) {
  const [clientId, setClientId] = useState(apps?.linkedIn.clientId ?? "");
  const secret = useRef<HTMLInputElement | null>(null);
  const [steps, setSteps] = useState(false);
  const [saving, setSaving] = useState(false);
  const { message, setMessage } = useSaveMessage();
  useEffect(() => setClientId(apps?.linkedIn.clientId ?? ""), [apps?.linkedIn.clientId]);
  const configured = appConfigured("linkedin", apps);
  const detail = configured
    ? `Client ID: ${apps?.linkedIn.clientId} · Client Secret bu Mac'te şifreli.`
    : "LinkedIn'e yayın için kendi LinkedIn uygulaman gerekir.";
  const save = async () => {
    setSaving(true);
    const result = await accountsBridge().saveLinkedInApp({
      clientId,
      secret: secret.current?.value ?? "",
    });
    setSaving(false);
    if (result.ok) {
      if (secret.current) secret.current.value = "";
      onSaved(result.value);
      setMessage({ text: "Kaydedildi.", error: false });
    } else {
      setMessage({ text: result.message, error: true });
    }
  };
  return (
    <Row
      item={ITEMS.linkedInApp}
      detail={detail}
      footer={
        <FormFooter
          fields={
            <>
              {(!configured || steps) && (
                <p className="selectable text-footnote whitespace-pre-line text-fg-2">
                  {`Yapılacaklar:\n${numbered(SETUP_GUIDE.linkedIn)}`}
                </p>
              )}
              <TextField
                aria-label="LinkedIn Client ID"
                placeholder="Client ID"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
              />
              <TextField
                ref={secret}
                aria-label="LinkedIn Client Secret"
                type="password"
                autoComplete="off"
                placeholder={
                  apps?.linkedIn.hasSecret
                    ? "Client Secret (kayıtlı; değiştirmek için yaz)"
                    : "Client Secret"
                }
              />
            </>
          }
          buttons={
            <>
              {configured && (
                <Button onClick={() => setSteps((s) => !s)}>
                  {steps ? "Adımları gizle" : "Kurulum adımları"}
                </Button>
              )}
              <Button disabled={saving} onClick={() => void save()}>
                Kaydet
              </Button>
            </>
          }
          message={message?.text ?? null}
          messageTone={message?.error ? "danger" : "default"}
        />
      }
    />
  );
}
