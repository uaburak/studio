import { type ApiClient, ApiError } from "@studio/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Navigate, type RouteObject, useRouteError } from "react-router";
import { ApiContext } from "./api.ts";
import { PageHeader } from "./components/page.tsx";
import { ErrorState } from "./components/states.tsx";
import { ToastProvider } from "./components/toast.tsx";
import { BrandDetailPage } from "./features/brands/BrandDetailPage.tsx";
import { BrandsPage } from "./features/brands/BrandsPage.tsx";
import { CalendarPage } from "./features/calendar/CalendarPage.tsx";
import { ContentDetailPage } from "./features/contents/ContentDetailPage.tsx";
import { ContentsPage } from "./features/contents/ContentsPage.tsx";
import { JobDetailPage } from "./features/jobs/JobDetailPage.tsx";
import { JobsPage } from "./features/jobs/JobsPage.tsx";
import { MediaPage } from "./features/media/MediaPage.tsx";
import { AppShell } from "./features/shell/AppShell.tsx";
import { BrandProvider } from "./lib/brand-context.tsx";
import { ThemeProvider } from "./lib/theme.tsx";

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 10_000,
        refetchOnWindowFocus: true,
        // 4xx answers are final; only retry network/5xx once.
        retry: (count, error) =>
          count < 1 && !(error instanceof ApiError && error.status && error.status < 500),
      },
    },
  });
}

export function AppProviders({
  api,
  queryClient,
  children,
}: {
  api: ApiClient;
  queryClient: QueryClient;
  children: ReactNode;
}) {
  return (
    <ApiContext.Provider value={api}>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <ToastProvider>
            <BrandProvider>{children}</BrandProvider>
          </ToastProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </ApiContext.Provider>
  );
}

function RouteError() {
  const error = useRouteError();
  return (
    <div className="mx-auto max-w-xl p-8">
      <PageHeader title="Bir şeyler ters gitti" />
      <ErrorState error={error} onRetry={() => window.location.reload()} />
    </div>
  );
}

function NotFound() {
  return (
    <PageHeader
      title="Sayfa bulunamadı"
      description="Aradığınız adres yok ya da taşındı."
      back={{ to: "/icerikler", label: "İçeriklere dön" }}
    />
  );
}

export const routes: RouteObject[] = [
  {
    path: "/",
    element: <AppShell />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <Navigate to="/icerikler" replace /> },
      { path: "icerikler", element: <ContentsPage /> },
      { path: "icerikler/:contentId", element: <ContentDetailPage /> },
      { path: "markalar", element: <BrandsPage /> },
      { path: "markalar/:brandId", element: <BrandDetailPage /> },
      { path: "takvim", element: <CalendarPage /> },
      { path: "medya", element: <MediaPage /> },
      { path: "isler", element: <JobsPage /> },
      { path: "isler/:jobId", element: <JobDetailPage /> },
      { path: "*", element: <NotFound /> },
    ],
  },
];
