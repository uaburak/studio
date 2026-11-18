// Whether Wecra's editor is vendored on this checkout (it is gitignored: Wecra is closed
// source and Studio's repository is public), and what to do when it is not.
const versions = import.meta.glob("../../../vendor/wecra-editor/VERSION.json", { eager: true });

export const wecraVendored = Object.keys(versions).length > 0;

export const WECRA_MISSING =
  "Wecra düzenleyicisi bu kopyada yok (apps/desktop/src/renderer/vendor/wecra-editor). " +
  "DesignerV2 bu klasörün yanındayken çalıştırın: node apps/desktop/scripts/vendor-wecra.mjs " +
  "(başka bir yerdeyse --repo <DesignerV2> ya da WECRA_REPO). Wecra kapalı kaynaktır; " +
  "bu klasör git'e girmez.";
