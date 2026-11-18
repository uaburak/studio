// The hidden canvas runner page (shared/canvas-runner.ts): takes the jobs the main process hands
// it, runs them with Wecra's engine drawing into an off-screen canvas of the page (real GPU
// renders, the same exporter as the post editor), answers with the job's output or its error.
// API calls go through the app's own origin like every page of the app (the main process adds the
// owner secret); fonts come from this Mac and the brand (wecra/fonts.ts).
import type { BrandProfile } from "@studio/contract";
import type { CanvasRunnerBridge } from "../../../shared/canvas-runner.ts";
import { createStudioClient } from "../../lib/api.ts";
import { buildRenderKit } from "../post-editor/model/brand-kit.ts";
import { WECRA_MISSING, wecraVendored } from "../post-editor/wecra/vendored.ts";

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function startCanvasRunnerPage(bridge: CanvasRunnerBridge): void {
  const api = createStudioClient(() => null);
  const controllers = new Map<number, AbortController>();

  const fetchAsset = async (assetId: string): Promise<Uint8Array> => {
    const res = await fetch(api.assets.contentUrl(assetId));
    if (!res.ok) throw new Error(`Varlık okunamadı (${res.status}).`);
    return new Uint8Array(await res.arrayBuffer());
  };

  bridge.onCancel((id) => controllers.get(id)?.abort());
  bridge.onJob(({ id, job }) => {
    const controller = new AbortController();
    controllers.set(id, controller);
    void (async () => {
      try {
        if (!wecraVendored) throw new Error(WECRA_MISSING);
        // Wecra's editor stack only when a job comes (the page itself stays light); what its
        // embedding patches read is set before any of Wecra's modules runs.
        await import("../post-editor/wecra/embed.ts");
        const [{ runCanvasJob }, engine] = await Promise.all([
          import("./run.ts"),
          import("./engine.ts"),
        ]);
        const output = await runCanvasJob(job, {
          api,
          fetchAsset,
          prepareFonts: async (brandId) => {
            let profile: BrandProfile | null = null;
            try {
              profile = await api.brandProfiles.current(brandId);
            } catch (error) {
              if ((error as { status?: number }).status !== 404) throw error;
            }
            engine.useBrandFonts(buildRenderKit(profile));
          },
          openEditor: engine.openEditor,
          settle: engine.settle,
          signal: controller.signal,
          progress: (value, message) => bridge.progress({ id, value, message }),
        });
        bridge.done({ id, ok: true, output });
      } catch (e) {
        bridge.done({ id, ok: false, error: describe(e).slice(0, 4_000) });
      } finally {
        controllers.delete(id);
      }
    })();
  });
  bridge.ready();
}
