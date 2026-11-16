import {
  type ContentStatus,
  ContentStatus as ContentStatusEnum,
  type ContentType,
  ContentType as ContentTypeEnum,
} from "@studio/contract";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useApi } from "../../api.ts";
import { IconContents, IconPlatform, IconPlus } from "../../components/icons.tsx";
import { BrandMark, FilterBar, PageHeader, StatusBadge } from "../../components/page.tsx";
import { EmptyState, ErrorState, SkeletonGrid } from "../../components/states.tsx";
import { Button, FilterSelect } from "../../components/ui.tsx";
import { useBrandName, useBrands } from "../../lib/brand-context.tsx";
import { CONTENT_STATUS } from "../../lib/content-status.ts";
import { formatRelative } from "../../lib/datetime.ts";
import { CONTENT_TYPE_LABELS, PLATFORM_LABELS } from "../../lib/labels.ts";
import { queryKeys } from "../../lib/query-keys.ts";
import { ContentCreateDialog } from "./ContentCreateDialog.tsx";
import { ContentThumb } from "./ContentThumb.tsx";

const PAGE = 24;

export function ContentsPage() {
  const api = useApi();
  const navigate = useNavigate();
  const { brandId, setBrandId, activeBrands } = useBrands();
  const brandName = useBrandName();
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(params.get("yeni") === "1");

  const typeParam = params.get("tur");
  const statusParam = params.get("durum");
  const type = ContentTypeEnum.safeParse(typeParam).success
    ? (typeParam as ContentType)
    : undefined;
  const status = ContentStatusEnum.safeParse(statusParam).success
    ? (statusParam as ContentStatus)
    : undefined;

  const filters = { brandId: brandId ?? undefined, type, status };
  const query = useInfiniteQuery({
    queryKey: queryKeys.contents.list(filters),
    queryFn: ({ pageParam, signal }) =>
      api.contents.list(
        { ...filters, limit: PAGE, ...(pageParam ? { cursor: pageParam } : {}) },
        { signal },
      ),
    initialPageParam: "",
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  const filtered = Boolean(type || status);

  return (
    <>
      <PageHeader
        title="İçerikler"
        description="Brif ver, üretilen sürümleri incele, onayla ve zamanla."
        actions={
          <Button variant="primary" icon={<IconPlus size={18} />} onClick={() => setCreating(true)}>
            Yeni içerik
          </Button>
        }
      />

      <FilterBar>
        <FilterSelect
          label="Marka"
          value={brandId ?? ""}
          onChange={(e) => setBrandId(e.target.value || null)}
        >
          <option value="">Tüm markalar</option>
          {activeBrands.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect
          label="Tür"
          value={type ?? ""}
          onChange={(e) => setParam("tur", e.target.value)}
        >
          <option value="">Tüm türler</option>
          {ContentTypeEnum.options.map((t) => (
            <option key={t} value={t}>
              {CONTENT_TYPE_LABELS[t]}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect
          label="Durum"
          value={status ?? ""}
          onChange={(e) => setParam("durum", e.target.value)}
        >
          <option value="">Tüm durumlar</option>
          {ContentStatusEnum.options.map((s) => (
            <option key={s} value={s}>
              {CONTENT_STATUS[s].label}
            </option>
          ))}
        </FilterSelect>
        {filtered && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setParams(new URLSearchParams(), { replace: true })}
          >
            Filtreleri temizle
          </Button>
        )}
      </FilterBar>

      {query.isPending ? (
        <SkeletonGrid />
      ) : query.error ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          title={filtered ? "Bu filtrelerle içerik yok" : "Henüz içerik yok"}
          glyph={<IconContents size={24} />}
          action={
            !filtered && (
              <Button
                variant="primary"
                icon={<IconPlus size={18} />}
                onClick={() => setCreating(true)}
              >
                İlk içeriği oluştur
              </Button>
            )
          }
        >
          {!filtered &&
            "Bir brif yaz; üretim hattı bağlandığında tasarımlar burada sürüm olarak görünecek."}
        </EmptyState>
      ) : (
        <>
          <ul className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3 xl:grid-cols-4">
            {items.map((content) => (
              <li key={content.id}>
                <Link
                  to={`/icerikler/${content.id}`}
                  className="group flex h-full flex-col overflow-hidden rounded-2xl bg-surface shadow-card ring-1 ring-line/70 transition-[box-shadow,transform] hover:-translate-y-0.5 hover:ring-line-strong"
                >
                  <ContentThumb content={content} />
                  <div className="flex flex-1 flex-col gap-2 p-3 sm:p-4">
                    <div className="flex items-center justify-between gap-2">
                      <StatusBadge meta={CONTENT_STATUS[content.status]} />
                      <span className="flex gap-1 text-ink-3">
                        {content.targetPlatforms.map((p) => (
                          <IconPlatform key={p} platform={p} size={15} />
                        ))}
                        <span className="sr-only">
                          {content.targetPlatforms.map((p) => PLATFORM_LABELS[p]).join(", ")}
                        </span>
                      </span>
                    </div>
                    <h2 className="line-clamp-2 text-[15px] leading-snug font-medium text-ink group-hover:text-accent">
                      {content.title}
                    </h2>
                    <div className="mt-auto flex items-center gap-2 text-[12px] text-ink-3">
                      {!brandId && (
                        <BrandMark
                          id={content.brandId}
                          name={brandName(content.brandId)}
                          size={18}
                        />
                      )}
                      <span className="truncate">
                        {CONTENT_TYPE_LABELS[content.type]}
                        {content.currentVersion && ` · v${content.currentVersion.version}`} ·{" "}
                        {formatRelative(content.updatedAt)}
                      </span>
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
          {query.hasNextPage && (
            <div className="mt-6 flex justify-center">
              <Button onClick={() => void query.fetchNextPage()} loading={query.isFetchingNextPage}>
                Daha fazla yükle
              </Button>
            </div>
          )}
        </>
      )}

      <ContentCreateDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(content) => {
          setCreating(false);
          navigate(`/icerikler/${content.id}`);
        }}
      />
    </>
  );
}
