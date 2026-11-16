import {
  type Platform,
  Platform as PlatformEnum,
  type SocialAccount,
  type SocialAccountStatus,
} from "@studio/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { fetchAllPages, useApi } from "../../api.ts";
import { Dialog } from "../../components/dialog.tsx";
import { IconEdit, IconPlatform, IconPlus } from "../../components/icons.tsx";
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
  Button,
  Card,
  cx,
  Field,
  IconButton,
  Input,
  SectionTitle,
  Segmented,
  Select,
} from "../../components/ui.tsx";
import { ACCOUNT_STATUS, PLATFORM_LABELS } from "../../lib/labels.ts";
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

      {query.isPending ? (
        <SkeletonRows rows={2} />
      ) : query.error ? (
        <ErrorState error={query.error} compact onRetry={() => void query.refetch()} />
      ) : accounts.length === 0 ? (
        <EmptyState title="Hesap eklenmemiş" compact>
          Zamanlama için en az bir Instagram, Facebook ya da LinkedIn hesabı ekleyin.
        </EmptyState>
      ) : (
        <ul className="flex flex-col gap-2">
          {accounts.map((account) => {
            const disabled = account.status === "disabled";
            return (
              <li
                key={account.id}
                className={cx(
                  "flex items-center gap-3 rounded-xl p-3 ring-1 ring-line ring-inset",
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
                  <StatusBadge meta={ACCOUNT_STATUS[account.status]} className="mt-1.5" />
                </div>
                {!readOnly && (
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <IconButton
                      label={`${account.handle} hesabını düzenle`}
                      onClick={() => setDialog({ account })}
                    >
                      <IconEdit size={18} />
                    </IconButton>
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
        Hesap yetkilendirmesi (Meta / LinkedIn girişi) Faz 3'te gelecek. Şimdilik hesaplar kayıt
        olarak tutulur; hiçbir şey paylaşılmaz.
      </Notice>

      <AccountDialog
        brandId={brandId}
        open={dialog !== null}
        {...(dialog?.account ? { account: dialog.account } : {})}
        onClose={() => setDialog(null)}
      />
    </Card>
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
