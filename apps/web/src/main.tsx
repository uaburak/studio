import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource/instrument-serif/400.css";
import "@fontsource/instrument-serif/400-italic.css";
import "./index.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import { AppProviders, createQueryClient, routes } from "./App.tsx";
import { api } from "./api.ts";

const root = document.getElementById("root");
if (!root) throw new Error("#root bulunamadı");

const router = createBrowserRouter(routes);
const queryClient = createQueryClient();

createRoot(root).render(
  <StrictMode>
    <AppProviders api={api} queryClient={queryClient}>
      <RouterProvider router={router} />
    </AppProviders>
  </StrictMode>,
);
