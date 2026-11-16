import {
  type MetaDiscoverResult,
  type Platform,
  Platform as PlatformEnum,
  type SocialAccount,
  type SocialAccountStatus,
} from "@studio/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { fetchAllPages, useApi } from "../../api.ts";
import { Dialog } from "../../components/dialog.tsx";
import { IconEdit, IconKey, IconPlatform, IconPlus, IconRefresh } from "../../components/icons.tsx";
import { StatusBadge } from "../../components/page.tsx";
import {
  EmptyState,
  ErrorState,
  InlineError,
  Notice,
  SkeletonRows,
} from "../../components/states.tsx";
import { useToast } from "../../components/toast.tsx";
import {
  Badge,
  Button,
  Card,
  Checkbox,
  cx,
  Field,
  IconButton,
  Input,
  Mono,
  SectionTitle,
  Segmented,
  Select,
} from "../../components/ui.tsx";
import { formatDate } from "../../lib/datetime.ts";
import { ACCOUNT_STATUS, PLATFORM_LABELS, TOKEN_HEALTH_STATUS } from "../../lib/labels.ts";
import { queryKeys } from "../../lib/query-keys.ts";

const PLATFORMS = PlatformEnum.options;

export function useBrandAccounts(brandId: string | null | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.accounts.byBrand(brandId ?? ""),
    queryFn: () =>
      fetchAllPages((cursor) =>
        api.socialAccounts.list({ brandId: brandId ?? "", limit: 100, cursor }),
      ),
    enabled: Boolean(brandId),
  });
}

export function AccountsPanel({ brandId, readOnly }: { brandId: string; readOnly?: boolean }) {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const query = useBrandAccounts(brandId);

  const [dialog, setDialog] = useState<{ account?: SocialAccount } | null>(null);
  const [tokenAccount, setTokenAccount] = useState<SocialAccount | null>(null);
  const [metaOpen, setMetaOpen] = useState(false);
  const [linkedInOpen, setLinkedInOpen] = useState(false);

  const toggle = useMutation({
    mutationFn: (account: SocialAccount) =>
      api.socialAccounts.update(account.id, {
        status: account.status === "disabled" ? "pending" : "disabled",
      }),
    onSuccess: (account) => {
      void qc.invalidateQueries({ queryKey: queryKeys.accounts.all });
      toast.success(
        account.status === "disabled" ? "Hesap devre dışı bırakıldı" : "Hesap yeniden etkin",
      );
    },
    onError: (e) => toast.error(e),
  });

  const checkToken = useMutation({
    mutationFn: (accountId: string) => api.socialAccounts.checkToken(accountId),
    onSuccess: (updated) => {
      void qc.invalidateQueries({ queryKey: queryKeys.accounts.all });
      const health = updated.tokenHealth
        ? TOKEN_HEALTH_STATUS[updated.tokenHealth].label
        : "Kontrol edildi";
      toast.success(`${updated.handle}: ${health}`);
    },
    onError: (e) => toast.error(e, "Token kontrolü başarısız"),
  });

  const accounts = query.data ?? [];

  return (
    <Card className="flex flex-col gap-4 self-start p-5 sm:p-6">
      <SectionTitle
        action={
          !readOnly && (
            <Button
              size="sm"
              variant="secondary"
              icon={<IconPlus size={16} />}
              onClick={() => setDialog({})}
            >
              Hesap ekle
            </Button>
          )
        }
      >
        Sosyal hesaplar
      </SectionTitle>

      {!readOnly && (
        <div className="grid grid-cols-2 gap-2">
          <Button
            size="sm"
            variant="secondary"
            icon={<IconPlatform platform="instagram" size={15} />}
            onClick={() => setMetaOpen(true)}
          >
            Meta bağla
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon={<IconPlatform platform="linkedin" size={15} />}
            onClick={() => setLinkedInOpen(true)}
          >
            LinkedIn bağla
          </Button>
        </div>
      )}

      {query.isPending ? (
        <SkeletonRows rows={2} />
      ) : query.error ? (
        <ErrorState error={query.error} compact onRetry={() => void query.refetch()} />
      ) : accounts.length === 0 ? (
        <EmptyState title="Hesap eklenmemiş" compact>
          Zamanlama ve yayın için Meta (Instagram / Facebook) ya da LinkedIn hesabını bağlayın.
        </EmptyState>
      ) : (
        <ul className="flex flex-col gap-2">
          {accounts.map((account) => {
            const disabled = account.status === "disabled";
            const healthMeta = account.tokenHealth
              ? TOKEN_HEALTH_STATUS[account.tokenHealth]
              : null;
            return (
              <li
                key={account.id}
                className={cx(
                  "flex items-start gap-3 rounded-xl p-3 ring-1 ring-line ring-inset",
                  disabled && "opacity-60",
                )}
              >
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-ink">
                  <IconPlatform platform={account.platform} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink">{account.handle}</p>
                  <p className="truncate text-[12px] text-ink-3">
                    {PLATFORM_LABELS[account.platform]}
                    {account.externalId && (
                      <span className="font-mono"> · {account.externalId}</span>
                    )}
                  </p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <StatusBadge meta={ACCOUNT_STATUS[account.status]} />
                    {healthMeta && <StatusBadge meta={healthMeta} />}
                    {!healthMeta && account.hasToken === false && (
                      <Badge tone="neutral" dot={false}>
                        Token yok
                      </Badge>
                    )}
                  </div>
                  {account.tokenExpiresAt && (
                    <p className="mt-1 text-[11px] text-ink-3">
                      Token bitişi: {formatDate(account.tokenExpiresAt)}
                    </p>
                  )}
                </div>
                {!readOnly && (
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <div className="flex items-center gap-0.5">
                      <IconButton
                        label={`${account.handle} token gir veya yenile`}
                        onClick={() => setTokenAccount(account)}
                        className="size-8"
                      >
                        <IconKey size={16} />
                      </IconButton>
                      {account.hasToken && (
                        <IconButton
                          label={`${account.handle} token sağlığını kontrol et`}
                          onClick={() => checkToken.mutate(account.id)}
                          disabled={checkToken.isPending}
                          className="size-8"
                        >
                          <IconRefresh size={16} />
                        </IconButton>
                      )}
                      <IconButton
                        label={`${account.handle} hesabını düzenle`}
                        onClick={() => setDialog({ account })}
                        className="size-8"
                      >
                        <IconEdit size={16} />
                      </IconButton>
                    </div>
                    <button
                      type="button"
                      onClick={() => toggle.mutate(account)}
                      disabled={toggle.isPending}
                      className="rounded-md px-1.5 py-0.5 text-[12px] font-medium text-ink-3 hover:text-ink"
                    >
                      {disabled ? "Etkinleştir" : "Devre dışı bırak"}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <Notice tone="neutral">
        Token'lar bulut kasasında şifreli saklanır; yayın zamanı geldiğinde Mac kapalıyken bile
        otomatik paylaşım çıkar.
      </Notice>

      <AccountDialog
        brandId={brandId}
        open={dialog !== null}
        {...(dialog?.account ? { account: dialog.account } : {})}
        onClose={() => setDialog(null)}
      />

      <TokenPutDialog account={tokenAccount} onClose={() => setTokenAccount(null)} />

      <MetaConnectDialog brandId={brandId} open={metaOpen} onClose={() => setMetaOpen(false)} />

      <LinkedInConnectDialog
        brandId={brandId}
        open={linkedInOpen}
        onClose={() => setLinkedInOpen(false)}
      />
    </Card>
  );
}

function TokenPutDialog({
  account,
  onClose,
}: {
  account: SocialAccount | null;
  onClose: () => void;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const [accessToken, setAccessToken] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [scopes, setScopes] = useState("");
  const [externalId, setExternalId] = useState("");

  useEffect(() => {
    if (!account) return;
    setAccessToken("");
    setExpiresAt(account.tokenExpiresAt ? account.tokenExpiresAt.slice(0, 10) : "");
    setScopes((account.tokenScopes ?? []).join(", "));
    setExternalId(account.externalId ?? "");
  }, [account]);

  const putToken = useMutation({
    mutationFn: () => {
      if (!account) throw new Error("Hesap yok");
      const scopeList = scopes
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      return api.socialAccounts.putToken(account.id, {
        accessToken: accessToken.trim(),
        ...(expiresAt ? { expiresAt: new Date(`${expiresAt}T23:59:59.000Z`).toISOString() } : {}),
        ...(scopeList.length > 0 ? { scopes: scopeList } : {}),
        ...(externalId.trim() ? { externalId: externalId.trim() } : {}),
      });
    },
    onSuccess: (updated) => {
      void qc.invalidateQueries({ queryKey: queryKeys.accounts.all });
      toast.success(`${updated.handle} için erişim token'ı kaydedildi`);
      onClose();
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (accessToken.trim().length >= 8) putToken.mutate();
  };

  return (
    <Dialog
      open={account !== null}
      onClose={() => {
        putToken.reset();
        onClose();
      }}
      title={account ? `${account.handle} — Token Kaydet` : "Token Kaydet"}
      description="Şifreli bulut kasasına (vault) erişim anahtarı kaydeder."
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Vazgeç
          </Button>
          <Button
            type="submit"
            form="put-token-form"
            variant="primary"
            loading={putToken.isPending}
            disabled={accessToken.trim().length < 8}
          >
            Token kaydet
          </Button>
        </>
      }
    >
      <form id="put-token-form" onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Erişim Token'ı (Access Token)">
          {(p) => (
            <Input
              {...p}
              type="password"
              value={accessToken}
              onChange={(e) => setAccessToken(e.target.value)}
              placeholder="EAAB... / AQV..."
              required
              autoFocus
            />
          )}
        </Field>
        <Field label="Platform kimliği (IG ID / Page ID / URN)" optional>
          {(p) => (
            <Input
              {...p}
              value={externalId}
              onChange={(e) => setExternalId(e.target.value)}
              className="font-mono"
            />
          )}
        </Field>
        <Field label="Son geçerlilik tarihi" optional>
          {(p) => (
            <Input
              {...p}
              type="date"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
            />
          )}
        </Field>
        <Field label="İzin kapsamları (scopes)" optional hint="Virgülle ayırın">
          {(p) => (
            <Input
              {...p}
              value={scopes}
              onChange={(e) => setScopes(e.target.value)}
              placeholder="instagram_basic, instagram_content_publish"
              className="font-mono text-xs"
            />
          )}
        </Field>
        <InlineError error={putToken.error} />
      </form>
    </Dialog>
  );
}

function MetaConnectDialog({
  brandId,
  open,
  onClose,
}: {
  brandId: string;
  open: boolean;
  onClose: () => void;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const [userAccessToken, setUserAccessToken] = useState("");
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [autoConnect, setAutoConnect] = useState(true);
  const [result, setResult] = useState<MetaDiscoverResult | null>(null);

  useEffect(() => {
    if (!open) return;
    setUserAccessToken("");
    setAppId("");
    setAppSecret("");
    setAutoConnect(true);
    setResult(null);
  }, [open]);

  const discover = useMutation({
    mutationFn: () =>
      api.socialAccounts.discoverMeta({
        brandId,
        userAccessToken: userAccessToken.trim(),
        ...(appId.trim() ? { appId: appId.trim() } : {}),
        ...(appSecret.trim() ? { appSecret: appSecret.trim() } : {}),
        autoConnect,
      }),
    onSuccess: (res) => {
      setResult(res);
      void qc.invalidateQueries({ queryKey: queryKeys.accounts.all });
      toast.success(
        `${res.pages.length} Sayfa bulundu`,
        res.connectedAccounts.length > 0
          ? `${res.connectedAccounts.length} hesap otomatik bağlandı.`
          : undefined,
      );
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (userAccessToken.trim().length >= 8) discover.mutate();
  };

  return (
    <Dialog
      open={open}
      onClose={() => {
        discover.reset();
        onClose();
      }}
      title="Meta (Instagram ve Facebook) Bağla"
      description="Facebook kullanıcı token'ı ile yönettiğiniz Sayfaları ve bağlı Instagram işletme hesaplarını keşfeder."
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Vazgeç
          </Button>
          <Button
            type="submit"
            form="meta-discover-form"
            variant="primary"
            loading={discover.isPending}
            disabled={userAccessToken.trim().length < 8}
          >
            Sayfaları keşfet ve bağla
          </Button>
        </>
      }
    >
      <form id="meta-discover-form" onSubmit={submit} className="flex flex-col gap-4">
        <Field
          label="Facebook Kullanıcı Erişim Token'ı"
          hint="Uzun ömürlü token için App ID ve App Secret da girebilirsiniz."
        >
          {(p) => (
            <Input
              {...p}
              type="password"
              value={userAccessToken}
              onChange={(e) => setUserAccessToken(e.target.value)}
              placeholder="EAAB..."
              required
              autoFocus
            />
          )}
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Meta App ID" optional>
            {(p) => (
              <Input
                {...p}
                value={appId}
                onChange={(e) => setAppId(e.target.value)}
                className="font-mono"
              />
            )}
          </Field>
          <Field label="Meta App Secret" optional>
            {(p) => (
              <Input
                {...p}
                type="password"
                value={appSecret}
                onChange={(e) => setAppSecret(e.target.value)}
              />
            )}
          </Field>
        </div>

        <Checkbox
          checked={autoConnect}
          onChange={setAutoConnect}
          description="Bulunan Facebook Sayfalarını ve bağlı Instagram hesaplarını şifreli kasaya kaydeder."
        >
          Bulunan hesapları bu markaya otomatik bağla
        </Checkbox>

        {result && (
          <div className="flex flex-col gap-2 rounded-2xl bg-surface-2 p-3.5">
            <p className="text-xs font-semibold tracking-wide text-ink-2 uppercase">
              Bulunan Sayfalar ({result.pages.length})
            </p>
            {result.pages.length === 0 ? (
              <p className="text-sm text-ink-3">Bu token ile erişilebilen Sayfa bulunamadı.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {result.pages.map((p) => (
                  <li key={p.pageId} className="rounded-xl bg-surface p-3 text-sm ring-1 ring-line">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-ink">{p.pageName}</span>
                      <Badge tone={p.canPublish ? "good" : "warn"}>
                        {p.canPublish ? "Yayın yetkisi var" : "Kısıtlı yetki"}
                      </Badge>
                    </div>
                    <Mono className="text-xs text-ink-3">Sayfa ID: {p.pageId}</Mono>
                    {p.instagram && (
                      <p className="mt-1 text-xs text-ink-2">
                        Instagram: <strong>@{p.instagram.username}</strong> (
                        <Mono>{p.instagram.igUserId}</Mono>)
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <InlineError error={discover.error} />
      </form>
    </Dialog>
  );
}

function LinkedInConnectDialog({
  brandId,
  open,
  onClose,
}: {
  brandId: string;
  open: boolean;
  onClose: () => void;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const [handle, setHandle] = useState("");
  const [personUrn, setPersonUrn] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [days, setDays] = useState("60");

  useEffect(() => {
    if (!open) return;
    setHandle("");
    setPersonUrn("");
    setAccessToken("");
    setDays("60");
  }, [open]);

  const connect = useMutation({
    mutationFn: () => {
      const expiresDays = Number(days);
      return api.socialAccounts.connectLinkedIn({
        brandId,
        handle: handle.trim(),
        personUrn: personUrn.trim(),
        accessToken: accessToken.trim(),
        ...(Number.isFinite(expiresDays) && expiresDays > 0
          ? { expiresInSeconds: Math.round(expiresDays * 86_400) }
          : {}),
      });
    },
    onSuccess: (account) => {
      void qc.invalidateQueries({ queryKey: queryKeys.accounts.all });
      toast.success(`LinkedIn hesabı bağlandı: ${account.handle}`);
      onClose();
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (handle.trim() && personUrn.trim() && accessToken.trim().length >= 8) {
      connect.mutate();
    }
  };

  return (
    <Dialog
      open={open}
      onClose={() => {
        connect.reset();
        onClose();
      }}
      title="LinkedIn Profilini Bağla"
      description="w_member_social yetkili kişisel profil token'ını kaydeder (standart süre 60 gündür)."
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Vazgeç
          </Button>
          <Button
            type="submit"
            form="linkedin-connect-form"
            variant="primary"
            loading={connect.isPending}
            disabled={!handle.trim() || !personUrn.trim() || accessToken.trim().length < 8}
          >
            LinkedIn bağla
          </Button>
        </>
      }
    >
      <form id="linkedin-connect-form" onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Profil adı" hint="ör. Burak Koç">
          {(p) => (
            <Input
              {...p}
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              placeholder="Burak Koç"
              required
              autoFocus
            />
          )}
        </Field>
        <Field label="Person URN / Üye Kimliği" hint="ör. urn:li:person:abc123">
          {(p) => (
            <Input
              {...p}
              value={personUrn}
              onChange={(e) => setPersonUrn(e.target.value)}
              placeholder="urn:li:person:..."
              className="font-mono"
              required
            />
          )}
        </Field>
        <Field label="Erişim Token'ı (w_member_social)">
          {(p) => (
            <Input
              {...p}
              type="password"
              value={accessToken}
              onChange={(e) => setAccessToken(e.target.value)}
              placeholder="AQV..."
              required
            />
          )}
        </Field>
        <Field label="Geçerlilik süresi (gün)" optional>
          {(p) => (
            <Input
              {...p}
              type="number"
              min={1}
              max={365}
              value={days}
              onChange={(e) => setDays(e.target.value)}
            />
          )}
        </Field>
        <InlineError error={connect.error} />
      </form>
    </Dialog>
  );
}

function AccountDialog({
  brandId,
  account,
  open,
  onClose,
}: {
  brandId: string;
  account?: SocialAccount;
  open: boolean;
  onClose: () => void;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const [platform, setPlatform] = useState<Platform>("instagram");
  const [handle, setHandle] = useState("");
  const [externalId, setExternalId] = useState("");
  const [status, setStatus] = useState<SocialAccountStatus>("pending");

  useEffect(() => {
    if (!open) return;
    setPlatform(account?.platform ?? "instagram");
    setHandle(account?.handle ?? "");
    setExternalId(account?.externalId ?? "");
    setStatus(account?.status ?? "pending");
  }, [open, account]);

  const save = useMutation({
    mutationFn: () => {
      const ext = externalId.trim() || null;
      return account
        ? api.socialAccounts.update(account.id, { handle: handle.trim(), externalId: ext, status })
        : api.socialAccounts.create({ brandId, platform, handle: handle.trim(), externalId: ext });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.accounts.all });
      toast.success(account ? "Hesap güncellendi" : "Hesap eklendi");
      onClose();
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (handle.trim()) save.mutate();
  };

  return (
    <Dialog
      open={open}
      onClose={() => {
        save.reset();
        onClose();
      }}
      title={account ? "Hesabı düzenle" : "Hesap ekle"}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Vazgeç
          </Button>
          <Button
            type="submit"
            form="account-form"
            variant="primary"
            loading={save.isPending}
            disabled={!handle.trim()}
          >
            {account ? "Kaydet" : "Ekle"}
          </Button>
        </>
      }
    >
      <form id="account-form" onSubmit={submit} className="flex flex-col gap-4">
        {account ? (
          <p className="flex items-center gap-2 text-sm text-ink-2">
            <IconPlatform platform={account.platform} size={18} />
            {PLATFORM_LABELS[account.platform]} hesabı (platform değiştirilemez)
          </p>
        ) : (
          <Segmented
            name="account-platform"
            label="Platform"
            value={platform}
            onChange={setPlatform}
            options={PLATFORMS.map((p) => ({
              value: p,
              label: (
                <>
                  <IconPlatform platform={p} size={16} />
                  {PLATFORM_LABELS[p]}
                </>
              ),
            }))}
          />
        )}
        <Field label="Görünen ad" hint="ör. @mtmagro ya da sayfa adı">
          {(p) => (
            <Input
              {...p}
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              maxLength={100}
              required
              autoFocus
            />
          )}
        </Field>
        <Field
          label="Platform kimliği"
          optional
          hint="IG kullanıcı kimliği, FB sayfa kimliği ya da LinkedIn URN"
        >
          {(p) => (
            <Input
              {...p}
              value={externalId}
              onChange={(e) => setExternalId(e.target.value)}
              maxLength={128}
              className="font-mono"
            />
          )}
        </Field>
        {account && (
          <Field label="Durum">
            {(p) => (
              <Select
                {...p}
                value={status}
                onChange={(e) => setStatus(e.target.value as SocialAccountStatus)}
              >
                {(Object.keys(ACCOUNT_STATUS) as SocialAccountStatus[]).map((s) => (
                  <option key={s} value={s}>
                    {ACCOUNT_STATUS[s].label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <InlineError error={save.error} />
      </form>
    </Dialog>
  );
}
