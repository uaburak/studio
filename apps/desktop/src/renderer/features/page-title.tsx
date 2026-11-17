// The top bar's title on the Takvim / Medya / Marka profili pages: the page and its brand.
import type { Route } from "../state/app-store.ts";
import { useBrands } from "../state/studio.tsx";
import { usePanelBrand } from "./panel-brand.ts";

type PageRoute = Extract<Route, { kind: "calendar" | "media" | "brand" }>;

export function isPageRoute(route: Route): route is PageRoute {
  return route.kind === "calendar" || route.kind === "media" || route.kind === "brand";
}

const TITLES: Record<PageRoute["kind"], string> = {
  calendar: "Takvim",
  media: "Medya",
  brand: "Marka profili",
};

export function PageTitle({ route }: { route: PageRoute }) {
  const brands = useBrands();
  const { brand } = usePanelBrand();
  const name =
    route.kind === "brand" ? brands.data?.find((b) => b.id === route.id)?.name : brand?.name;
  return (
    <span className="flex min-w-0 items-center gap-1.5 px-2.5 text-body-lg text-fg">
      <span className="truncate">{TITLES[route.kind]}</span>
      {name && <span className="truncate text-fg-2">· {name}</span>}
    </span>
  );
}
