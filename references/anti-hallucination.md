# Things That Do Not Exist — Anti-Hallucination Inventory

This file mirrors `SKILL.md` Section 2. Loaded on demand by tools that read reference files but not the skill body. Always cross-check before writing imports or env-var references.

---

## Removed Dependencies

| Removed / nonexistent                                                                                                                                         | Replacement                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `@serwist/next`, `@serwist/sw`, `serwist`, `workbox-*`                                                                                                        | None — PWA removed                                                                      |
| `web-push` package, `VAPID_*` env vars                                                                                                                        | None — Web Push removed                                                                 |
| `navigator.serviceWorker`, `sw.register()`, `public/sw.js`, `public/manifest.json`                                                                            | None                                                                                    |
| `src/lib/offline-notes.ts`, `storePendingNote`, `getPendingNotes`, `removePendingNote`, `PendingNote`                                                         | None — IndexedDB queue removed                                                          |
| `/api/notes/sync` endpoint                                                                                                                                    | None — only `/api/notes/stream` (SSE) exists in `notes/api/`                            |
| `push:subscription:{author}` Redis key                                                                                                                        | `push:fcm:{author}` only                                                                |
| `prisma`, `@prisma/client`, SQL migrations                                                                                                                    | Upstash Redis is the sole datastore; `/src/generated/prisma` is a stale gitignore entry |
| Light-mode Tailwind variants                                                                                                                                  | Dark theme is forced via `forcedTheme="dark"`                                           |
| `tailwind.config.ts` / `tailwind.config.js`                                                                                                                   | Tailwind v4 is CSS-first; tokens live in `src/app/globals.css`                          |
| `pages/` directory, `getServerSideProps`, `getStaticProps`                                                                                                    | App Router only                                                                         |
| `VoiceNote` type, `voiceNote` field on `PermissionRequest`, `MediaRecorder` usage in permissions, `RECORD_AUDIO` Android permission, `VOICE_NOTE_*` constants | None — voice notes were prototyped on permissions and explicitly removed                |

---

## Why This File Exists

Training data for current LLMs predates several intentional removals from this codebase. Common autocompletion failures:

- Importing `web-push` because the agent saw a notification helper and pattern-matched on Web Push tutorials.
- Writing `import { Serwist } from '@serwist/next'` because the agent inferred PWA support from the Capacitor presence.
- Referencing `process.env.VAPID_PUBLIC_KEY` because the agent assumed Web Push must be configured.
- Reading from `pages/api/...` because the agent's training cutoff predates App Router maturity.
- Re-suggesting voice notes for `/permissions` because audio attachments seem like a natural fit for emotional context. They were prototyped and removed — don't re-propose without explicit user instruction.

Every entry above produces a runtime failure, a bundle that won't compile, or a refused PR. Stop the moment you find yourself typing one.

---

## Easy mistakes that aren't on the removed list

These are not removed — they exist and are wired up. Listed because their existence is non-obvious and an agent might assume the wrong thing:

- **`@capacitor/geolocation`** is in use, not dormant. `DistanceCard` consumes it for live distance to `PARTNER_COORDS`. The `ACCESS_COARSE_LOCATION` / `ACCESS_FINE_LOCATION` perms in `AndroidManifest.xml` are real, not stale.
- **`@capacitor/device`** is in use for Sentry device context inside `SentryUserProvider`. Don't propose adding device-info plugins; one already runs.
- **`@capacitor/screen-orientation`** IS still installed but currently unused — flagging here so an agent doesn't mistake it for a future-use plugin already wired up. Either propose a real use or removal.
- **`/admin`** is a real Sir-only sub-tree (not a stub). Routes: `/admin`, `/admin/trash`, `/admin/export`, `/admin/inspector`, `/admin/push-test`, `/admin/activity`, `/admin/sessions`. Layout guard at `src/app/admin/layout.tsx` redirects non-Sir; every action in `src/app/actions/admin.ts` repeats the role check via `requireSir()`.
- **`moveToTrash` / `moveManyToTrash`** are real and wired into every `delete*` / `purgeAll*` action. Don't propose "adding a trash window" as future work — it exists. Don't bypass via a raw `del` either.
- **`session:epoch:{author}`** is the live force-logout mechanism. `decrypt()` reads it on every JWT verify (5s in-process cache). Don't reinvent revocation via deny-lists or jti-tracking.
- **`activity:log`** is the Sir-only feed. Driven automatically from `logger.interaction` / `warn` / `error` / `fatal` via `recordActivity` in `src/lib/activity.ts`. Don't call `recordActivity` directly from feature code.
- **`summonKitten()`** is real and lives in `src/app/actions/admin.ts`. It is the only Sir → Besho push that bypasses presence and uses the safeword channel. Surfaced via `<SummonButton>` on the `/admin` landing. Don't propose adding a cooldown, history list, or configurable copy without explicit instruction — those were all considered and rejected.
- **`<DeviceTracker />`** is mounted once in the root layout and owns every `device:*` write. `pingDevice` is the only writer. Don't propose calling `pingDevice` from feature code, adding presence-style polling, or merging it into `usePresence` — they're orthogonal: presence is per-author, devices are per-install. Web devices intentionally have no location (no permission prompt).
- **`assertWriteAllowed(author)`** in `src/lib/restraint.ts` is real and gates every Besho-writable server action. There is no middleware — the per-action guard is the model. Don't propose centralizing it into a wrapper or skipping it on "low-risk" actions; the wholepoint is uniform application.
- **`auth:failures`** is the failed-login ZSET. Written by `login()` only. Don't reuse it for unrelated security events; don't store the passcode value (only its length). The export tool dumps every key — keeping the value out is a privacy boundary.
- **`/api/cron/ritual-windows`** is the only cron endpoint and the only place writing `ritual:fcm:sent:*`. Triggered exclusively by cron-job.org (minute cadence, configured out-of-band in the operator's account). Don't propose calling it from feature code, adding a `vercel.json` cron, or removing the `CRON_SECRET` bearer check.
- **Vercel tier is Hobby; there is intentionally NO `vercel.json` in the repo.** Hobby rejects build with any cron more frequent than once-per-day, and a daily-only fire was deemed not worth keeping. Adding a `vercel.json` with crons WILL break the next deploy. Cron-job.org is the sole trigger source.
- **`filter: blur()` was deliberately stripped from page transitions, the CounterCard, the Quote card, the BiometricGate exit, and the note-reactions list.** It tanks framerate on Android WebView (S21 Ultra etc. — verified user complaint). `popLayout` was downgraded to `wait` in the same pass. Don't re-add either to hot-path animations. The lone surviving blur is in `src/app/login/page.tsx` (one-time first-paint).
- **`backdrop-blur-xl` and `shadow-2xl` were swept across the whole codebase down to `backdrop-blur-md` and `shadow-xl shadow-black/30` (or `/40` on the floating navbar).** This is intentional perf work, not a stylistic accident. Don't bump them back up "for the premium feel" — they were tested on the S21 Ultra and the heavier values were what was breaking framerate. Modals (push-toast, notification drawer, permission dialog) that appear briefly and aren't animated over kept `shadow-2xl shadow-black/60`.
- **`will-change-transform` is applied only to**: `src/app/template.tsx` page-transition motion.div, the two `layoutId="navbar-active-indicator"` pills in the floating navbar, the CounterCard hero/anniversary AnimatePresence spans, and the More-sheet drawer in the floating navbar. Don't add it elsewhere without a measured perf reason — it eats GPU memory and overuse degrades performance.
- **The More-sheet drawer in the floating navbar runs WITHOUT `backdrop-filter`.** Earlier version had `backdrop-blur-md` on the drawer + `backdrop-blur-xs` on the overlay; that combination tanked open/close framerate on Android WebView (verified S21 Ultra). The drawer is now `bg-neutral-950` (fully opaque, no readback needed) and the overlay is plain `bg-black/60` (no blur). The visual difference is negligible because the overlay's opacity already darkens the page; don't re-add backdrop-filter without measuring on hardware.
- **`/rewards` is a real top-level route, separate from `/ledger`.** `/ledger` stays as Sir's manual log. `/rewards` is the automatic-tier surface driven by an obedience score. They're orthogonal — don't conflate. Tier count is fixed at 5. The score lives in `obedience:events:{author}:{weekKey}` ZSETs; the tier catalog in `rewards:tiers`; claims in `reward:claim:{id}`. Sir-only editor at `/admin/rewards`. Don't propose a parallel score system.
- **`recordObedienceEvent` from `src/lib/obedience.ts` is the only sanctioned emit.** Wired into `tasks.approveTask`, `rules.acknowledgeRule`, `rituals.submitOccurrence`, `permissions.createPermission` + `decidePermission`, `mood.submitMood`, `admin.setRestraintState`. The daily cron `/api/cron/obedience-sweep` owns the negative missed-event emissions (`task_missed`, `ritual_missed`, `rule_unacked`) — don't duplicate that logic in feature code. Member-key `{eventType}:{eventId}` makes retries idempotent.
- **State submissions are NOT scored.** Only `mood.submitMood` emits `mood_checkin` (+1 daily). `mood.submitState` is intentionally a free expressive surface — don't add a `state_checkin` event. The user explicitly removed that path.
- **Reward claims are append-only audit history.** No `deleteClaim` exists. Don't add one. Soft-delete is for first-class records (notes/rules/tasks/ledger/etc.), not for claim audit.
- **`/api/cron/obedience-sweep` is the second cron endpoint.** Same bearer-auth shape as `/api/cron/ritual-windows`. Triggered by cron-job.org once per day. Don't propose merging the two — different cadences (minute vs daily), different jobs.
- **Tier-unlock + week-close FCM are wired into `recordObedienceEvent` + `finalizeWeek`.** The unlock notification fires once per tier-threshold per week (sentinel: `obedience:tier-notified:{author}:{weekKey}`). The week-close recap fires from inside `finalizeWeek` to **both authors**. Don't add a separate cron or feature-action call to fire these — they're already wired at the right boundaries.
- **`manual_adjust` is a real `ObedienceEventType`.** Don't add a parallel "Sir-bonus" pathway. The reason text is logged via `logger.interaction` and lands in `/admin/activity`; do not store it on the ZSET member or invent a `obedience:reasons:*` key.
- **`RewardItem.emoji` is optional and snapshotted on the claim** (`RewardClaim.rewardEmoji`). Don't rehydrate from the live tier catalog at display time — the snapshot is intentional so renames/deletes don't rewrite history.
- **Every `recordObedienceEvent` writes TWO ZADDs** — `obedience:events:{author}:{weekKey}` (score=points, drives the score math) and `obedience:audit:{author}:{weekKey}` (score=ts, drives the event log). Both are in the same pipeline. Don't refactor to skip the audit write — `/admin/rewards` event log joins the two.
- **`/admin/redis` is read-only by design.** The action `inspectRedisKey` does not expose `set`, `del`, `expire`, or any mutating call. Don't propose a "delete key" button or "edit value" affordance — that bypasses the trash + soft-delete boundary. If admins need to mutate, the existing per-feature admin actions are the boundary.
- **`trash:retention-days` is read at every trash write** through a 5s in-process cache in `@/lib/trash`. Changing the value applies only to future deletions — Redis TTLs are set at SET time. Don't propose a retroactive recompute; existing trash entries keep their original TTL.
- **Deploy info comes from `process.env.VERCEL_GIT_*`** plus `package.json` version (lazy-imported). On local dev these env vars are absent and the footer shows nulls — that's by design; don't fall back to git commands or shell-out for the SHA, that wouldn't work inside the Vercel runtime anyway.

---

## Cross-References

- `SKILL.md` Section 2 — same table, mirrored for the skill-loading path
- `AGENTS.md` Section 2 — high-level reminder
- `references/deployment.md` — env var list (no `VAPID_*`)
- `references/redis-schema.md` — key list (no `push:subscription:*`)
