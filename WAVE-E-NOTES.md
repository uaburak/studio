# Wave E (iPhone Faz 6: M5–M7, M9 + new server states) — progress notes

Branch: worktree-agent-a50895c07dfa95b99. Delete this file when the wave is merged.

## Findings (verified in apps/api)
- `GET /api/assets/{id}/thumbnail?w=` exists (WebP; w rounded up to 160/240/320/480/640/960/1280; 415 for non-images; original bytes with `x-studio-thumbnail: original` on failure).
- `/api/assets/{id}/content` supports `Range` (206) → AVPlayer resource loader can stream.
- Lists already hide trash (`deleted` query); `POST /api/contents/{id}/restore` and `/api/assets/{id}/restore` exist.
- `POST /api/jobs/{id}/retry` → 201 Job.
- `PlanGenerateResult.skipped: [{itemId, reason}]`, reasons generating|generated|edited|approved|published|no_content.
- `GET /api/ai/spend?tzOffset=`, `GET /api/ai/preferences` are open to devices.
- `POST /api/ai/claude-limit/decision` is **Mac only** (`requireLocal`, there is an API test for it) → phone gets 403. Phone shows the banner and tries; on 403 tells the user to decide on the Mac. Open item for the owner/manager.

## Plan / status
- [x] M5 image cache (NSCache + memory warning + ImageIO downsample + thumbnail endpoint), reels streaming
- [x] New server states (deletedAt, Üretilemedi + Yeniden dene, plan skipped, Claude limit banner, spend in usage sheet)
- [x] M6 targeted post refresh + debounce
- [x] M7 background check: LAN then tunnel, waiting conversations, Claude limit notification
- [x] M9 TARGETED_DEVICE_FAMILY = 1
- [x] Background upload with retry (StudioKit APIClient.uploadAsset keeps its API)
- [x] StudioKit tests, builds, final commit

## State
All items done and committed; StudioKit 173 tests pass; StudioIOS build-for-testing and StudioMac build succeed.
Not verified on a device or simulator (not allowed in this wave): image memory under load, AVPlayer streaming through
the resource loader, background session uploads after leaving the app, BGAppRefresh notices.
Open: phone's Claude-limit decision is refused by the API (Mac only) until the API allows paired devices.
