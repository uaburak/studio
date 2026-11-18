// The top bar's title on the Takvim / Medya / Markalar / Marka profili / Performans / Yorumlar
// pages: the page and its brand.
import type { Route } from "../state/app-store.ts";
import { useBrands } from "../state/studio.tsx";
import { usePanelBrand } from "./panel-brand.ts";

type PageRoute = Extract<
  Route,
  { kind: "calendar" | "media" | "brands" | "brand" | "performance" | "comments" }
>;

export function isPageRoute(route: Route): route is PageRoute {
  return (
    route.kind === "calendar" ||
    route.kind === "media" ||
    route.kind === "brands" ||
    route.kind === "brand" ||
    route.kind === "performance" ||
    route.kind === "comments"
  );
}

const TITLES: Record<PageRoute["kind"], string> = {
  calendar: "Takvim",
  media: "Medya",
  brands: "Markalar",
  brand: "Marka profili",
  performance: "Performans",
  comments: "Yorumlar",
};

export function PageTitle({ route }: { route: PageRoute }) {
  const brands = useBrands();
  const { brand } = usePanelBrand();
  const name =
    route.kind === "brand"
      ? brands.data?.find((b) => b.id === route.id)?.name
      : route.kind === "brands"
        ? undefined
        : brand?.name;
  return (
    <span className="flex min-w-0 items-center gap-1.5 px-2.5 text-body-lg text-fg">
      <span className="truncate">{TITLES[route.kind]}</span>
      {name && <span className="truncate text-fg-2">· {name}</span>}
    </span>
  );
}
