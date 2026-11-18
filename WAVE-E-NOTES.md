# Wave E notes (StudioMac → desktop port) — temporary, drop before merging

Order: 1 Reels editor · 2 Export · 3 publishing sync on focus · 4 Git/Yardım menus · 5 small gaps.

## Done
- Setup: deps installed, wecra vendor symlink (gitignored).
- Read: StudioKit `Domain/Reels.swift` (ReelDraft, patch), `StudioMac/PostDetail/ReelEditorView.swift`,
  `PostEditing.swift` (PostExporter), `Posts/PostActions.swift` (export menu), contract `reel.ts`,
  worker `video/render-reel.ts` (`applyReelPatch`), `render/handler.ts` (png → `pngAssetIds`, pdf → `pdfAssetId`).

## Plan / next
1. `renderer/features/post-detail/reel-draft.ts` (pure port of ReelDraft: problems, patch, totalMs, addScene/addOverlay)
   + `reel-editor.tsx` (Düzenle tab for reels) + `PostEditor.renderReel(patch)` (content.render, format mp4, reel patch)
   + tests `test/renderer/reel-draft.test.ts`. Change `editBlocker` reel text.
2. Export: `main/post-files.ts` (IPC save dialog, write bytes, share menu, reveal) + preload + `shared/post-files.ts`;
   renderer `features/posts/export.ts` (PostExporter port) + "Dışa aktar" submenu in `postMenu`.
3. Publishing sync on focus: main `browser-window-focus` debounced POST /api/publishing/sync (owner header).
4. Menu: Git (Postlar, Takvim ⇧⌘K, Medya ⇧⌘M, Yeni marka ⇧⌘N, Marka ayarları ⇧⌘B), Yardım (kısayollar,
   başlangıç rehberi, logları göster). ⇧⌘K conflicts with Wecra place image on canvas → guard like ⌘[.
5. Estimate in chat plan card; claude.limit ask notice (presence frame in activity-notices); token notices to main.
