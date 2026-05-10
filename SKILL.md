---
name: our-space
description: Engineering guide for Our Space — a private two-user couples app at github.com/t7sen/our-space (deployed t7senlovesbesho.me, Android me.t7senlovesbesho). LOAD for ANY task in this repo: features, fixes, review, deployment, push routing, biometric gate, dom/sub permissions, Capacitor, Redis, server actions, presence, SSE. Triggers: OurSpace, t7senlovesbesho, Tasks/Rules/Ledger/Notes/Mood/SafeWord, FloatingNavbar, BiometricGate, FCMProvider, PushToast, Honor device, no-GMS, dom/sub, T7SEN, Besho, Sir, kitten. Stack: Next.js 16, React 19, Capacitor 8, Upstash Redis, Firebase Admin, shadcn/ui, Tailwind v4. Hosted-webapp Capacitor shell — server.url loads t7senlovesbesho.me, NOT bundled (no offline, no PWA). Enforces patterns invisible to training: globalThis casts, deferred setState, void vibrate, server-side role checks, FCM-only push, Cairo TZ keys. Skipping produces code that breaks on Android, leaks state, hallucinates removed deps (Serwist, VAPID, web-push), or violates the dom/sub model.
---

# Our Space — Pre-Flight Skill

This skill complements `AGENTS.md` (the working summary and architectural overview). When this skill is loaded, run the pre-flight checklist below before any code or proposal. Heavy details live in `AGENTS.md` and `references/*.md` — load on demand.

The two highest-value sections are kept inline below: the **anti-hallucination inventory** (Section 2) and the **abridged refusal catalog** (Section 3). The full refusal catalog is in `references/refusal-catalog.md`.

---

## 0. Agent Pre-Flight (Run Every Request)

Before writing code or proposing changes, complete this checklist:

1. **Banned scope check** → Does the request mention `gallery`, `bucket list`, `voice notes`/audio recording on `/permissions`, or **Telegram / WhatsApp / Signal / any third-party messenger as a notification channel**? If yes → refuse, propose `/notes`/`/timeline`/`/tasks`/`/rules`/`/ledger` for the first two, text + markdown body for the third, and FCM-only (existing `pushNotificationToHistory` path) for the fourth — there is no sanctioned out-of-band messenger.
2. **Architecture conflict check** → Does the request imply offline support, PWA features, service workers, web push, or removing `server.url`? If yes → refuse with rationale from `AGENTS.md` Section 3.7. Do not implement.
3. **Anti-hallucination check** → Read Section 2 below before writing imports or env-var references.
4. **Role-context identification** → Does this involve a state mutation? If yes → identify which author (`T7SEN`/`Besho`) is allowed and ensure server-side role check (`AGENTS.md` Section 3.1; `references/auth-and-security.md`). For `/permissions` specifically, `getAutoRules` is Sir-only and must return `[]` for Besho — don't relax.
5. **Reference routing** → Use the table in `AGENTS.md` Section 13 to decide which `references/*.md` file to load. Don't skim the body when a reference has the answer. For any `/permissions` work, load `references/permissions.md`.
6. **Date math check** → Need a date key, day boundary, or windowing math? Import from `@/lib/cairo-time`. Never reinvent `Intl.DateTimeFormat` helpers at a callsite. Never hardcode `+02:00` — DST drift half the year.
7. **FCM nullability check** → Does this touch push delivery? If yes → treat `push:fcm:{author}` as nullable per `AGENTS.md` Section 3.3, never as guaranteed-present.

When unsure, ask the user one targeted question rather than guessing. Guessing on this codebase produces runtime failures.

---

## 1. Critical Patterns to Apply Automatically

Apply without prompting. Full examples in `references/coding-patterns.md`.

- Browser globals via `globalThis as unknown as { ... }` cast — never `window`/`document`/`navigator` directly.
- `setState` inside mount-time effects or Capacitor callbacks → wrap in `setTimeout(() => setState(...), 0)`.
- `vibrate()` always prefixed with `void`.
- `Date.now()` in render → `useState(() => Date.now())`.
- `'use server'` files export only async — constants live in `src/lib/*-constants.ts`.
- `cookies()` and `headers()` are async (Next.js 16) — `await` them.
- `useSearchParams()` requires a `<Suspense>` boundary at the page level (Next 16 prerender bailout).
- Optimistic UI mutations on existing records → snapshot, mutate, server, rollback-on-error, refresh-on-success. Skip for create-paths.
- Redis writes that depend on each other → `redis.pipeline()`.
- Date-derived keys → Cairo time via `MY_TZ`, never UTC.
- Mobile-first page padding: `p-4 md:p-12` on outer wrappers, `gap-4 md:gap-6` on grids, `pb-28 md:pb-32` for floating-navbar clearance.
- `<TabsContent>` that holds form-bearing children must `forceMount` — Radix unmounts inactive tabs and `FormData` ignores DOM-absent inputs.
- Cards needing 1Hz/60s ticks own their own `setInterval` — never tick the dashboard parent.
- Custom interactive surfaces (raw `<button>`, `<Link>`) get `active:scale-[0.95]`. The shadcn `<Button>` already has its own press feedback.
- **Every page subscribes to pull-to-refresh.** Wire `useRefreshListener(yourFetchCallback)` for client pages with state, `useRefreshListener(() => router.refresh())` for client pages without, or drop `<RefreshListenerForServerPage />` inside Server Component pages. Only `src/app/login/page.tsx` is exempt (unauth gate). New pages must include it from the first commit.
- Every page has a header back link. Top-level → `href="/"` "Back". `/admin/*` sub-pages → `href="/admin"` "Admin". Canonical shape: `ArrowLeft` + group-hover slide on the icon. Only `src/app/page.tsx` (home) and `src/app/login/page.tsx` (unauth) intentionally omit it — every other page must include it from the first commit. Full snippet in `AGENTS.md` § 4.
- Never animate `filter: blur()` and never use `mode="popLayout"` in hot paths. Android WebView doesn't composite `filter` — every frame is a full repaint. Stick to `opacity` + `transform`. Lone exception: `src/app/login/page.tsx` (once-per-session).
- Glass cards = `backdrop-blur-md` + `shadow-xl shadow-black/30`. Not `-xl` / `-2xl`. Heavier glass tanks framerate on Samsung/Honor mid-range. Use `will-change-transform` only on elements that transform every navigation or every second (page-transition wrapper, navbar pill, CounterCard spans). Overuse explodes GPU layer count.
- Icon-only buttons need ≥24dp effective hit area. Use `p-1.5` minimum for inline icons; `p-2` for primary actions like panel close. Never `opacity-0 group-hover:opacity-100` for actions a mobile user needs to reach — there is no hover.
- Form submit success effects call `void hideKeyboard()` from `@/lib/keyboard` so the soft keyboard dismisses with the form.
- Mobile-friendly form inputs: `inputMode`, `enterKeyHint`, `autoComplete`, `autoCorrect`, `autoCapitalize`, `spellCheck` — set them deliberately. `<input type="search">` for search; `autoComplete="current-password"` for the login passcode.
- **Every text-bearing element gets `dir="auto"`.** Both inputs (where user types) AND display surfaces (where user-entered fields render). Bilingual app — content auto-flips RTL/LTR by first strong directional character. `<Textarea>` primitive + `<MarkdownRenderer>` default to it; everything else — raw inputs/selects/textareas, plus `<p>`/`<span>`/`<div>` rendering `.title` / `.body` / `.description` / `.reason` / `.reply` / `.terms` / `.notes` / `.message` / `.label` / `.feedback` etc. — MUST include `dir="auto"` as the first attribute. Skip browser-chromed inputs (checkbox/radio/hidden/date/time/number/range/color/file), static labels, timestamps, IDs, status pills, and constants. New components rendering user text include this from the first commit.
- `<body>` carries `suppressHydrationWarning` to absorb browser-extension-injected attributes; don't remove.
- Per-page purge + per-item delete are Sir-only on both client (`currentAuthor === "T7SEN"` gate) and server (role check in the action). Use `<PurgeButton>` from `@/components/admin/purge-button` for purge UI; mirror the two-step / heavy-haptic pattern for new per-item destructive controls.
- Soft-delete is the boundary, not `del`. Every `delete*` / `purgeAll*` action calls `moveToTrash` / `moveManyToTrash` from `@/lib/trash` BEFORE the deletion pipeline. 7-day TTL, restorable from `/admin/trash`. Auxiliary state (reactions, audits, occurrences, streak/count keys, pin-set membership) is intentionally not preserved — only the primary record + index ZSET entry come back.
- Activity feed is logger-driven. `logger.interaction` / `warn` / `error` / `fatal` automatically write to the `activity:log` ZSET (capped at 500). Don't call `recordActivity` directly; let the logger do it. Sir reads at `/admin/activity`.
- Force-logout = bump `session:epoch:{author}`. `decrypt()` checks JWT `iat` against the epoch (5s in-process cache). All admin destructive actions go through the inspector / push-test / sessions / export / trash / activity surfaces under `/admin`, gated by `src/app/admin/layout.tsx` redirect + `requireSir()` in `src/app/actions/admin.ts`.
- `summonKitten()` is the only Sir → Besho push that mirrors safeword's bypass: `bypassPresence: true` + `channelId: "safeword"` + `priority: "max"` + `sound: "default"`. Possessive/dominant copy is fixed in-action. Surfaced as `<SummonButton>` on the `/admin` landing.
- `<DeviceTracker />` (root-layout-mounted) is the sole writer of `device:*`. `pingDevice` runs on mount + 60s heartbeat. Author claim is sticky. Sir reads at `/admin/devices`. Don't call `pingDevice` from feature code; don't conflate with `usePresence`.
- Restraint mode = `mode:restraint:Besho`. Every Besho-writable server action MUST call `assertWriteAllowed(session.author)` from `@/lib/restraint` and return its error if non-null. Sir is never restrained. Safeword is intentionally exempt. Toggled from `<RestraintToggle>` on `/admin` landing.
- `auth:failures` is the failed-login ZSET (capped 100). Written exclusively from `login()` in `actions/auth.ts`; read via `getAuthFailures()` (Sir-only). Don't reuse for unrelated security events.
- **Project is on Vercel Hobby; there is intentionally no `vercel.json`.** Hobby rejects builds with cron schedules more frequent than once-per-day. Every cron trigger goes through **cron-job.org** (configured in the operator's account, minute cadence) hitting `/api/cron/*` with `Authorization: Bearer ${CRON_SECRET}`. New cron-style features should add a new `/api/cron/*` route + an entry in cron-job.org — never via `vercel.json`.
- `/admin/redis` is read-only — `inspectRedisKey` exposes type, TTL, capped preview. No set/del/expire. Don't add mutation; per-feature admin actions are the boundary.
- **Finalization is cron-only.** `getRewardsBundle` and any other page-read path MUST NOT call `finalizeWeek` or `catchUpFinalizations` — they fire recap FCMs as a side-effect. The obedience-sweep cron is the sole trigger.
- **Four functional crons total** (plus `heartbeat-watch` meta-cron). `/api/cron/ritual-windows` (minute), `/api/cron/obedience-sweep` (daily), `/api/cron/review-window-open` (daily, internally gated to Saturday), `/api/cron/timer-expire` (minute — sweeps directive timers; future-shared with the punishment-timer in Plan #2). All bearer-authed via `CRON_SECRET`. All triggered from cron-job.org. The `heartbeat-watch` cron watches the others and FCMs Sir if any go stale.
- **Test mode** (`obedience:test-mode`, Sir-only) opens current-week claims for diagnostic flow verification. Week itself stays unfinalized; streak + multiplier untouched. Toggle: `/admin/rewards` Status tab.
- **Both `RewardItem` AND `RewardTier` carry optional `emoji`.** Both snapshot onto the claim at claim time. Default tier seeds use medal/trophy/crown progression.
- `trash:retention-days` is the Sir-tunable TTL (1-90, default 7). `@/lib/trash` reads via 5s cache; new TTL applies only to future deletions.
- **Obedience score = `recordObedienceEvent` from `@/lib/obedience` at the action site, never from UI/components/hooks.** Wired on: `tasks.approveTask` (on-time/late), `rules.acknowledgeRule` (within deadline only), `rituals.submitOccurrence` (Besho-owned, in-window), `permissions.createPermission` (auto-approve + re-ask penalty) + `decidePermission` (manual approve), `mood.submitMood` (state submissions intentionally NOT scored), `admin.setRestraintState` (off→on transition only), `ledger.createLedgerEntry` (punishment → `ledger_punishment` default −10; violation → severity-scaled `rule_violation_minor` / `_moderate` / `_major` defaults −3 / −8 / −20, with the standard `ledger_punishment` emit suppressed for violations to prevent double-counting; reward entries are pure log, no emit), `directive.completeDirective` (`directive_completed` default +5), `punishment.completePunishment` (`punishment_completed` default +2) + `punishment.bailPunishment` (`punishment_bailed` default −20 — also writes a "bailed" `ledger:{id}` entry inline, intentionally bypassing `createLedgerEntry` so the standard `ledger_punishment` emit does NOT fire), plus the Sir-only `manual_adjust` from `admin.adminAdjustScore`. Member key `{eventType}:{eventId}` makes retries idempotent. Negative missed-event emissions are owned by `/api/cron/obedience-sweep` (`task_missed`, `ritual_missed`, `rule_unacked`) and `/api/cron/timer-expire` (`directive_missed` + `punishment_bailed` from `expireDuePunishments`) — don't duplicate them in feature code. Tier-unlock + week-close FCM fire automatically from inside `recordObedienceEvent` and `finalizeWeek` respectively — don't wire FCM at the action site for these. Tier count is fixed at 5; reward catalog items carry optional `emoji` snapshotted onto claims; reward claims are append-only (no `delete*` exposed). `ClaimStatus` is five values (`pending`/`delivered`/`denied`/`revoked`/`rerolled`); only `revoked` is fully terminal — `rerolled` accepts a flip to `delivered` or `denied` via the normal `deliverClaim` / `denyClaim` paths (Sir reversing his reroll), but can't be re-rerolled or revoked directly. `rerollClaim` is Sir-only, pending-only, DELs the per-week slot so kitten can re-pick; the slot is NOT re-set on a subsequent rerolled → delivered/denied flip. No obedience emit on reroll. The history pill is labelled **"History N×"** (not "Changed N×"); audit row note captures `sirNote` (delivered/denied prior) or `rerollReason` (rerolled prior).
- **Rule-violation ledger entries snapshot the rule body at write time.** `LedgerEntry.type === "violation"` carries `ruleId` + `ruleSnapshot: { title, body? }` (body capped at `MAX_VIOLATION_RULE_SNAPSHOT_BODY_LEN = 1000`) + `severity`. Future rule edits/deletes do NOT rewrite the entry — same pattern as the reward/tier emoji snapshot. Per-rule index `ledger:violations:by-rule:{ruleId}` ZSET is pipelined with `ZADD ledger:index` on create. Sir-only "Log violation" affordance on `/rules` cards links to `/ledger?prefill=violation:${rule.id}` (Suspense-wrapped `useSearchParams()`). Violation count line surfaces on every rule card for both authors. Active rules only — completed rules can't have new violations logged. The auxiliary index is intentionally NOT preserved on restore from trash (orphan-on-restore matches the reactions/occurrences pattern).
- **Real-time directive overlay = `<DirectiveDialog>` mounted in root layout, self-gates on Besho.** Single-slot via `directive:active:Besho` STRING sentinel; reissue while active refuses. State machine: `issued` (forced full-screen modal) → `acknowledged` (non-modal pinned strip with countdown) → `completed` (auto-dismiss after 2s). FCM payload `data.kind === "directive"` + `data.directiveId`; `<FCMProvider>` foreground listener branches on kind and dispatches `ourspace:directive-arrived` instead of the standard PushToast. Cron-only expiration via `/api/cron/timer-expire` — page reads MUST NOT mutate state. Obedience: `directive_completed` (+5) at action site, `directive_missed` (−10) from cron only. The `extraData` parameter on `sendNotification` is the sanctioned way to pipe non-standard FCM `data` fields (string values only). **Suppression:** when an active punishment exists, the dialog renders null and re-checks on `ourspace:punishment-cleared`.
- **Punishment timer = `<PunishmentOverlay>` mounted in root layout BEFORE `<DirectiveDialog>` (precedence rule).** Single-slot via `punishment:active:Besho` STRING sentinel (TTL = `durationSec + PUNISHMENT_ACTIVE_TTL_BUFFER_SEC`). State machine: `issued` (full-screen modal with Begin button — clock paused) → `running` (full-screen kneel-timer; Complete button locked until `now >= endsAt`; Bail = two-tap with 1.5s auto-revert) → `completed` / `bailed` (brief confirm + dispatch `ourspace:punishment-cleared`). Background-grace: `appStateChange.isActive: false` while running starts a 60s timer; expiry calls `bailPunishment(reasonTag: "background-grace")`. FCM uses `data.kind === "punishment"` with `bypassPresence: true` + `priority: "high"` + channel `default` (NOT `safeword`). Cron-only timeout sweep via `/api/cron/timer-expire` — `expireDuePunishments` walks `running` records past `endsAt + 60s` and bails them with `reasonTag: "timeout"`. Auto-creates a `ledger:{id}` `punishment` entry on completion AND on bail with `linkedPunishmentId` back-reference — written **inline** in `punishment.ts`, NOT via `createLedgerEntry`, intentionally bypassing the standard `ledger_punishment` emit (the typed `punishment_completed` / `punishment_bailed` events are the canonical signal). Bail is terminal — no re-start.

---

## 2. Things That Do Not Exist (Anti-Hallucination Inventory)

These were removed or never existed. Do not import them, reference them, or write code that uses them. If you find yourself typing one of these — **stop**.

| Removed / nonexistent                                                                                                                         | Replacement                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `@serwist/next`, `@serwist/sw`, `serwist`, `workbox-*`                                                                                        | None — PWA removed                                                                         |
| `web-push` package, `VAPID_*` env vars                                                                                                        | None — Web Push removed                                                                    |
| `navigator.serviceWorker`, `sw.register()`, `public/sw.js`, `public/manifest.json`                                                            | None                                                                                       |
| `src/lib/offline-notes.ts`, `storePendingNote`, `getPendingNotes`, `removePendingNote`, `PendingNote`                                         | None — IndexedDB queue removed                                                             |
| `/api/notes/sync` endpoint                                                                                                                    | None — only `/api/notes/stream` (SSE) exists in `notes/api/`                               |
| `push:subscription:{author}` Redis key                                                                                                        | `push:fcm:{author}` only                                                                   |
| `prisma`, `@prisma/client`, SQL migrations                                                                                                    | Upstash Redis is the sole datastore; `/src/generated/prisma` is a stale gitignore entry    |
| Light-mode Tailwind variants                                                                                                                  | Dark theme is forced via `forcedTheme="dark"`                                              |
| `tailwind.config.ts` / `tailwind.config.js`                                                                                                   | Tailwind v4 is CSS-first; tokens live in `src/app/globals.css`                             |
| `pages/` directory, `getServerSideProps`, `getStaticProps`                                                                                    | App Router only                                                                            |
| `VoiceNote` type, `voiceNote` field, `MediaRecorder` + `RECORD_AUDIO` permission for `/permissions`                                           | None — voice notes prototyped on permissions and explicitly removed                        |
| Telegram bot, Telegram fallback push, `TELEGRAM_BOT_TOKEN` / `TELEGRAM_*_CHAT_ID` env vars, WhatsApp / Signal / any third-party messenger as a notification channel | None — FCM is the sole sanctioned push transport (§ 3.2). Out-of-band messenger fallbacks were considered and explicitly banned |
| TZ primitives in `@/lib/rituals` (`dateKeyInTz`, `todayKeyCairo`, `tzWallClockToUtcMs`, `previousDateKey`, `nextDateKey`, `weekdayOfDateKey`) | `@/lib/cairo-time` — the migration relocated all TZ math; importing from rituals will fail |
| Inline `todayInCairo()`, `secondsUntilMidnight()`, or per-callsite `Intl.DateTimeFormat` date-key helpers                                     | `@/lib/cairo-time` exports the canonical versions — never reinvent                         |
| Standalone routes `/admin/inspector`, `/admin/sessions`, `/admin/cooldowns`, `/admin/time`, `/admin/timezone`, `/admin/activity`, `/admin/notifications`, `/admin/restraint-history`, `/admin/auth-log` | `/admin/devices` (Right now + Sessions sections) for inspector + sessions; `/admin/health` (Cooldowns + Time tabs; Time tab also hosts the Cairo↔Tabuk converter) for the three time/cooldown routes; `/admin/logs` (Activity / Outbound / Restraint / Auth failures tabs) for the four append-only log routes |
| `currentReviewWeekDate` for rewards bucketing                                                                                                  | `currentWeekKey` in `@/lib/obedience` (containing-week semantic, NOT just-completed)       |
| `beforeSend` with stack-frame string check (`fetchServerAction` / `server-action-reducer`)                                                    | `ignoreErrors` in `Sentry.init` — message-based, invariant under Turbopack minification    |
| `void pingDevice(...)` (or any `void asyncCall()`) for unhandled-rejection-safe fetch                                                          | `someAsync(...).catch(() => {})` — `void` discards the return value but does NOT catch rejections |

If a search result, training memory, or autocomplete suggests one of these — it is wrong for this codebase. This table is also mirrored in `references/anti-hallucination.md` for tools that load reference files but not this one.

---

## 3. Refusal Catalog (Abridged)

Refuse these immediately with a one-line rationale. Do not implement, do not ask for clarification, do not "try a workaround." Full table (14 rows) in `references/refusal-catalog.md`.

| Request pattern                                         | Why refuse                                                      |
| ------------------------------------------------------- | --------------------------------------------------------------- |
| Add a gallery / photo feature, or bucket list           | Banned feature surface                                          |
| Add Telegram / WhatsApp / Signal / any third-party messenger as a push channel | Banned — FCM is the sole sanctioned push transport (§ 3.2)      |
| Re-add PWA / Serwist / service worker                   | Removed intentionally; conflicts with `server.url`              |
| Re-add Web Push / VAPID / `web-push` package            | Removed with PWA; conflicts with `server.url`                   |
| Re-suggest voice notes on `/permissions`                | Prototyped and explicitly removed                               |
| Use `==` / `!=` instead of `===` / `!==`                | Coercion masks bugs in this strict-mode codebase                |
| Skip role check because "the UI hides the button"       | Server actions are public endpoints; client is adversarial      |
| Expose `getAutoRules` to Besho                          | Sir-only authoring artifacts; gaming risk                       |
| `dangerouslySetInnerHTML` user content                  | XSS vector — use `MarkdownRenderer`                             |
| Notification dedup / per-author cooldown                | Banner pile-up is by design — every event surfaces              |
| Rate-limit safeword or permission submissions           | Already layered-protected; refuse without observed glitch       |
| Universal `MutationResult` typing of all server actions | Preventive refactor with no observed drift; refuse pre-evidence |

---

## 4. Agent Operating Procedure

When this skill triggers, follow this order:

1. **Run Section 0 pre-flight.** Refuse if banned or architecturally incompatible.
2. **State a plan before code** for any non-trivial change. Name the file paths you'll touch and the function/symbol you'll edit.
3. **Load references on demand** per `AGENTS.md` Section 13. Don't rely on memory of patterns when a reference is one tool call away.
4. **Apply Section 1 patterns** to every code change automatically. Re-check before submitting.
5. **Cite file paths** when proposing edits. Format: `src/app/notes/page.tsx::handleFormSubmit`.
6. **Push back on bad ideas, including from the user.** Refuse with rationale; offer alternatives. Do not sugar-coat. Examples: user asks for `==` → refuse, explain coercion. User asks to add Web Push → refuse, point to `AGENTS.md` Section 3.7. User asks to skip a server-side role check → refuse, explain client adversariality.
7. **Surface uncertainty.** If a request is ambiguous, ask one targeted question. Do not invent context.
8. **No bugs.** Re-read every block of generated code before presenting. "Probably works" is a failure mode.
9. **Tone:** formal, direct, technical. The user is solo-developing this. They want answers, not warmth.

When you finish a non-trivial change, suggest the relevant smoke-test step from `references/deployment.md`.

---

## 5. Where to Find Everything Else

- **Architectural pillars (3.1–3.7):** `AGENTS.md` Section 3
- **Code style, React, TypeScript, naming, UI:** `AGENTS.md` Section 5 + `references/code-style.md`
- **Auth, security, error handling, accessibility:** `AGENTS.md` Section 6 + `references/auth-and-security.md`
- **File map:** `AGENTS.md` Section 11
- **Decision heuristics:** `AGENTS.md` Section 12
- **Reference index:** `AGENTS.md` Section 13
