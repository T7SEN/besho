<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version (Next.js 16) has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices. `cookies()` and `headers()` return promises. Server Components are the default. Route handlers run on Edge or Node depending on `runtime` exports.

<!-- END:nextjs-agent-rules -->

---

# Our Space — Agent Instructions

Canonical agent guide for `github.com/t7sen/our-space` (deployed at `https://t7senlovesbesho.me`, Android package `me.t7senlovesbesho`). Applies to **every AI coding agent** operating in this repository.

This file is the entry point — short, dense, with pointers. Detailed guidance lives in `references/` and is loaded on demand. The capability-scoped skill specification lives in `SKILL.md` (pre-flight checklist + anti-hallucination inventory).

---

## 1. Product Context

| Attribute       | Value                                                |
| --------------- | ---------------------------------------------------- |
| Repository      | `github.com/t7sen/our-space`                         |
| Production URL  | `https://t7senlovesbesho.me`                         |
| Android package | `me.t7senlovesbesho` (do not change)                 |
| Hosting         | Vercel **Hobby tier** (web), Capacitor APK (Android) |
| Architecture    | **Hosted-webapp Capacitor shell** — see Section 3.7  |
| Package manager | `pnpm` — never npm or yarn                           |
| Users           | Exactly two: `T7SEN` (dom), `Besho` (sub/kitten)     |
| Devices         | T7SEN: Samsung Android. Besho: Honor phone + tablet. |

**Banned features.** Never suggest, scaffold, or reference: `gallery`, `bucket list`, or **Telegram / WhatsApp / Signal / any third-party messenger as a notification channel**. Reject any framing that implies them and propose alternatives using `/notes`, `/timeline`, `/tasks`, `/rules`, or `/ledger`. The third-party-messenger ban exists because FCM is the sole sanctioned push transport (see § 3.2 + `references/push-routing.md`); reintroducing a parallel out-of-band messenger duplicates the channel and adds an unlocked third-party dependency.

---

## 2. Tech Stack (Locked Versions)

Pinned by `package.json`. Do not upgrade as part of feature work.

- **Runtime:** Next.js `16.2.4`, React `19.2.4`, TypeScript `^5`
- **Styling:** Tailwind CSS `^4` (CSS-first via `globals.css`, no `tailwind.config.*`), `tw-animate-css`, `tailwind-merge`
- **UI:** shadcn/ui (style: `radix-nova`, base: `zinc`, icons: `lucide`), `radix-ui`, `motion` (Framer Motion v12), `next-themes`
- **State / Forms:** native React 19 (`useActionState`, `useTransition`), Zod, no Redux
- **Data:** Upstash Redis (`@upstash/redis`) — sole datastore
- **Auth:** `jose` JWT in HTTP-only `session` cookie (HS256, 30-day)
- **Native:** Capacitor `^8.3.1` + plugins (biometric, push, preferences, haptics, clipboard, app, keyboard, network, status-bar, splash, badge, device, geolocation)
- **Push:** `firebase-admin` (FCM) for Android. **No Web Push. No PWA.**
- **Observability:** Sentry (`@sentry/nextjs`), Vercel Analytics + Speed Insights
- **Build/lint:** ESLint `^9` flat config, `concurrently`, `esbuild`

**Anti-hallucination:** before writing any import or env-var reference, consult `SKILL.md` Section 2.1 (also cached in `references/anti-hallucination.md`). Common drift: `serwist`, `web-push`, `VAPID_*`, `offline-notes`, `/api/notes/sync`, `push:subscription:*`, `prisma`, `tailwind.config.*`, `pages/`. None of these exist. Also non-obvious: `@capacitor/geolocation` and `@capacitor/device` ARE in use (DistanceCard + SentryUserProvider) — see `references/anti-hallucination.md` § "Easy mistakes that aren't on the removed list" before assuming a plugin is dormant.

---

## 3. Architectural Pillars (Summary)

Each pillar below is a one-paragraph summary. Full treatment lives in the linked reference. Do not paraphrase from memory — load the reference when the work touches that pillar.

### 3.1 Role-Based Dynamics (dom/sub)

Every state-mutating server action **must** check `session.author` server-side, even if the UI hides the button. T7SEN (Sir) creates rules, marks rules complete, reopens rules, creates tasks, logs ledger entries, views safe-word history, decides permission requests, sets quotas, authors auto-decide rules. Besho (kitten) acknowledges rules, completes tasks, sends safe-word, submits permission requests, withdraws her own pending requests. Both write notes, react, set mood, send hugs. **Auto-decide rules are Sir-private** — `getAutoRules` returns `[]` for Besho; her cards show only an "Auto" chip with no rule details. User copy uses `Sir` / `kitten` via `TITLE_BY_AUTHOR` in `src/lib/constants.ts`. Never hard-code. Full permission matrix and canonical role-check shape: `references/auth-and-security.md`. Permissions surface specifics: `references/permissions.md`.

### 3.2 Presence-Aware Push Routing (FCM-Only)

Algorithm: (1) `pushNotificationToHistory(target, payload)` first, (2) read `presence:{author}` (TTL 6s), (3) if recipient is on the target page → skip push (SSE handles UI), (4) else FCM — foreground (presence exists, different page) gets a **data-only** payload (in-app `PushToast`); background/closed gets a full `notification` payload (OS heads-up banner). The `notification` field MUST NOT be set in the foreground payload, or Android double-notifies. **No Web Push fallback.** Full algorithm and failure modes: `references/push-routing.md`.

### 3.3 FCM Registration Defensive Handling

Both devices register an FCM token on app launch. Registration can still fail for ordinary reasons — permissions denied, network unavailable, OEM quirks. `FCMProvider` (`src/components/fcm-provider.tsx`) catches `registrationError` and logs without throwing. Server-side push code therefore treats `push:fcm:{author}` (a SET — multi-device per author, see § 3.6 + `references/push-routing.md`) as possibly-empty: if `readFcmTokens` returns `[]`, the send returns silently and the `notifications:{author}` history record is the durable artifact, surfaced via `NotificationDrawer` and `useNavBadges`. Sends fan out via `getMessaging().sendEachForMulticast` and per-token failures with `messaging/registration-token-not-registered` / `messaging/invalid-registration-token` / `messaging/invalid-argument` trigger `pruneStaleFcmTokens` so the SET self-cleans after token rotation. Do not reintroduce PWA/Web Push as a fallback — rationale in Section 3.7 and `references/capacitor-native.md`.

### 3.4 BiometricGate

`src/components/biometric-gate.tsx` is the primary unlock. Renders a fullscreen overlay above all routes except `UNGUARDED_ROUTES`. Each ref is load-bearing: `lastAuthEndedAtRef` (2-second debounce against the **Knox/Honor double-prompt loop**), `last_unlocked_at` Preference (cold-start grace period), `LOCK_AFTER_MS` (re-lock threshold on `appStateChange`). Web/desktop falls through (`isNative()` → false). Do not "simplify." Full state machine: `references/capacitor-native.md`.

### 3.5 Real-Time via SSE

`/notes` uses Server-Sent Events at `src/app/api/notes/stream/route.ts` (Edge runtime, 45s max stream age, 10s poll, 10s keepalive). The client `EventSource` reconnects automatically. Do not introduce websockets without first removing SSE.

### 3.6 Redis (Upstash) Data Model

Single Redis instance. Flat colon-namespaced keys: `note:{id}`, `notes:index` (ZSET), `reactions:{noteId}` (HASH), `rule:{id}`, `task:{id}`, `ledger:{id}` (with optional `ruleId` / `ruleSnapshot` / `severity` for `type === "violation"` entries; with optional `linkedPunishmentId` for entries auto-created by the punishment timer), `ledger:violations:by-rule:{ruleId}` (ZSET — per-rule violation index, NOT preserved on restore from trash), `directive:{id}`, `directives:index` (ZSET), `directive:active:Besho` (STRING — single-slot sentinel; TTL = `durationSec` or 24h fallback), `punishment:{id}`, `punishments:index` (ZSET), `punishment:active:Besho` (STRING — single-slot sentinel; TTL = `durationSec + PUNISHMENT_ACTIVE_TTL_BUFFER_SEC`), `permission:{id}`, `permissions:index` (ZSET), `permissions:auto-rules` (Sir-only JSON array), `permissions:quotas` (JSON), `mood:{YYYY-MM-DD}:{author}`, `presence:{author}` (TTL 6s), `push:fcm:{author}` (SET — one member per registered device), `notifications:{author}` (LIST capped at 50). Permissions has additional sub-keys for re-ask blocking, audit history, and denied-hash detection — see the reference. Always pipeline dependent writes. Use `MY_TZ` (Cairo) from `src/lib/constants.ts` for date-derived keys — never the server's local time. Full schema and anti-patterns: `references/redis-schema.md`. Permissions feature spec: `references/permissions.md`.

### 3.7 Hosted-Webapp Capacitor Architecture

**Unusual and intentional.** `capacitor.config.ts` sets `server: { url: 'https://t7senlovesbesho.me', cleartext: false }`. The APK is a **thin native shell** — no bundled web build; the WebView navigates to the deployed Vercel site on launch. Server actions, SSE, route handlers all work because the page is served live. **Deploys are instant** (Vercel push → next app launch sees the change, no APK rebuild). **No offline support.** Mid-session network drops degrade via the `useNetwork`-driven offline banner and disabled submit buttons. **Do not propose removing `server.url`** — full rationale in `references/capacitor-native.md`. This pillar is the architectural reason Web Push reintroduction is refused.

---

## 4. Critical Coding Patterns

These compile and lint clean but break at runtime, in SSR, or in React 19 strict mode if violated. Full examples and rationale in `references/coding-patterns.md`.

- **Browser globals via inline cast:** `(globalThis as unknown as { navigator?: { ... } }).navigator?.vibrate?.(50)`. No `typeof window` guards in new code.
- **Deferred setState in effects:** `setTimeout(() => setState(value), 0)` for state updates inside Capacitor callbacks or post-mount listeners.
- **`vibrate()` is fire-and-forget:** always prefix with `void`. `void vibrate(30, 'light')`.
- **`Date.now()` lazy in render:** `useState(() => Date.now())`, never `useState(Date.now())`.
- **`"use server"` files export only async functions.** Move constants to `src/lib/*-constants.ts`.
- **`cookies()` and `headers()` are async:** `const cookieStore = await cookies()`.
- **`useSearchParams()` requires a `<Suspense>` boundary** — Next 16 prerender bails the whole route otherwise. Default-export wraps the inner component in `<Suspense fallback={...}><Inner /></Suspense>`.
- **Optimistic UI uses snapshot-then-rollback** — `references/coding-patterns.md` § "Optimistic UI with Snapshot Rollback". Don't apply to create-paths.
- **Unused params:** prefix with `_` and add `// eslint-disable-next-line @typescript-eslint/no-unused-vars` above the signature.
- **`<TabsContent>` that holds form-bearing children must `forceMount`.** Radix unmounts inactive tabs by default; an unmounted `<input>`/`<textarea>` is missing from `FormData` on submit. The `RichTextEditor` Write tab uses `forceMount` for exactly this reason.
- **Localized 1Hz tick.** Cards that need second-resolution time (`CounterCard`) own their `setInterval` internally. Never tick the dashboard parent — that re-renders the whole tree every second. Cards that need minute resolution (`TimezoneCard`) tick at 60s; cards that don't auto-update (Header, Birthday, Moon) call `new Date()` inline at render and rely on `refreshKey` re-renders for freshness.
- **Active-press feedback on custom interactive surfaces.** Non-`<Button>` interactive elements (raw `<button>`, `<Link>`, navbar tiles) use `active:scale-[0.95]`. The shadcn `<Button>` primitive already has `active:translate-y-px` baked into its cva config — don't add scale on top.
- **Every page subscribes to `useRefreshListener` — `/login` is the only exception.** The global `<PullToRefresh />` mounted in `src/app/layout.tsx` dispatches a `ourspace:refresh` custom event when the user pulls down. Each page must subscribe so the gesture actually re-fetches. For Client Component pages, wire `useRefreshListener(yourFetchCallback)` directly — that lets you control exactly what re-fetches. For Client Component pages with no displayed server state (forms, write-only surfaces), use `useRefreshListener(() => router.refresh())` — re-renders any RSC dependencies. For Server Component pages, drop `<RefreshListenerForServerPage />` (from `@/components/refresh-listener`) inside the `<main>` — it calls `router.refresh()` on receipt. **New pages must include this from the first commit.** The only file allowed to omit the subscription is `src/app/login/page.tsx` — it's an unauth gate with no parent state to refresh.
- **Every page has a back link in its header.** Top-level routes (`/notes`, `/tasks`, `/rules`, `/ledger`, `/timeline`, `/permissions`, `/protocol`, `/rituals`, `/review`, `/rewards`, `/admin`) link `href="/"` with the label "Back". Sub-routes under `/admin/*` link `href="/admin"` with the label "Admin". The link uses the canonical shape — `ArrowLeft` icon + group-hover translate — so the affordance reads identically across pages: `<Link href="..." className="group flex items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"><ArrowLeft className="h-4 w-4 transition-transform group-hover:-translate-x-1" />{label}</Link>`. The two pages that intentionally omit the back link are `src/app/page.tsx` (home — there's nowhere to go back to) and `src/app/login/page.tsx` (unauth gate). Any new page goes in with the back link from the first commit.
- **Never animate `filter: blur()` in hot paths.** Android WebView (the APK) does NOT composite `filter` — it repaints the whole layer on every frame, which collapses framerate when stacked behind glass cards. Stick to GPU-composited properties: `opacity`, `transform` (`x`/`y`/`scale`/`rotate`). Same rule for `mode="popLayout"` on `<AnimatePresence>` — it forces per-frame layout measurement; use `mode="wait"` (or default) instead. The lone exception in the repo is `src/app/login/page.tsx`, which fires once per session and is fine. Page transitions, per-second tick animations, and AnimatePresence around frequently-toggled elements must stay blur-free.
- **Glass cards use `backdrop-blur-md` + `shadow-xl shadow-black/30`, not `xl` / `2xl`.** S21 Ultra (and Honor / Samsung mid-range) tank framerate when animations have to composite over heavier glass. The current treatment is the perf-vs-aesthetic compromise; don't bump back to `backdrop-blur-xl` or `shadow-2xl` on cards or page-form wrappers. Floating navbar uses `backdrop-blur-md shadow-xl shadow-black/40`. Modals/dropdowns that appear briefly (push-toast, notification drawer, permission dialog) keep their heavier `shadow-2xl shadow-black/60` because they're not animated-over.
- **`will-change-transform` on elements that animate transforms repeatedly.** Promotes them to their own composited layer so transform animations don't repaint parents. Currently applied to: the page-transition `motion.div` in `src/app/template.tsx`, both `layoutId="navbar-active-indicator"` pills in the floating navbar, the CounterCard hero + anniversary AnimatePresence spans, the More-sheet drawer in the floating navbar, the gift-box + reward-card + reward-emoji elements in `RewardUnlockOverlay`, and the banner card inside `TierCrossCelebration` (mid-week tier-reach overlay on `/rewards`). Don't sprinkle this on every motion element — overuse explodes GPU layer count and degrades perf. Rule of thumb: add it where the same element transforms ≥ once per second OR on every navigation; otherwise leave it off.
- **Mobile-first page padding.** Page wrappers `p-4 md:p-12`, card grids `gap-4 md:gap-6`, floating-navbar clearance `pb-28 md:pb-32` (dashboard + `/review`).
- **Tap-target sizes ≥24dp; no `opacity-0 group-hover` for primary mobile actions.** Icon-only buttons get `p-1.5` minimum (`p-2` for panel close / drawer dismiss / push-toast dismiss). Buttons that hover-reveal with `opacity-0` must gate the hidden state behind `md:` so mobile sees them at a muted color (e.g. `opacity-100 md:opacity-0 md:group-hover:opacity-100`).
- **`void hideKeyboard()` after form-submit success.** Every `useEffect(() => { if (state?.success) ... }, [state])` block calls `void hideKeyboard()` from `@/lib/keyboard.ts` so the soft keyboard dismisses with the form. Native-only; web is a no-op.
- **Mobile-friendly form inputs.** Set `inputMode`, `enterKeyHint`, `autoComplete`, `autoCorrect`, `autoCapitalize`, `spellCheck` deliberately per field. `<input type="search">` for search; `autoComplete="current-password"` for the login passcode. Don't blanket-disable autocorrect on prose textareas — that hurts notes/rules writing.
- **Every text-bearing element gets `dir="auto"`.** Both authors are bilingual (Arabic + English); content auto-flips RTL/LTR based on the first strong directional character. Applies to BOTH inputs (where the user is typing) AND display surfaces (where user-entered text is being shown). The shadcn `<Textarea>` primitive defaults to `dir="auto"`; `<MarkdownRenderer>` has it on its outer div. Anything else — raw `<input>` (text/search/email/url/tel/password/no-type), raw `<textarea>`, `<select>`, and any `<p>`/`<span>`/`<div>` rendering a user-entered field (title, body, description, reason, reply, terms, notes, message, label, feedback, etc.) — must include `dir="auto"` as the first attribute. **Skip:** `<input type="checkbox">`/`radio`/`hidden`/`datetime-local`/`date`/`time`/`number`/`range`/`color`/`file` (browser chrome), static UI labels, `<label>` text, status pills, timestamps, counts, IDs, hashes, `TITLE_BY_AUTHOR` names, anything from a static constants catalog. **Why first attribute:** keeps the diff readable and signals intent across the codebase. New components rendering user text MUST include this from the first commit. New input primitives MUST default to `dir="auto"` like `<Textarea>` does.
- **`<body>` carries `suppressHydrationWarning`.** Browser extensions (Grammarly, tab managers, etc.) inject attributes on `<body>` between SSR delivery and React hydration. The suppression is one-level only — children still hydrate strictly. Don't remove it unless every two-user device confirms no extension is touching `<body>`.
- **Sir-only destructive admin tooling.** Per-page purge buttons and the new per-item delete UIs (notes / permissions / review weeks) are gated client-side on `currentAuthor === "T7SEN"` AND server-side via the canonical role check. The reusable `<PurgeButton>` (`src/components/admin/purge-button.tsx`) handles two-step confirmation + 5s auto-cancel + heavy-haptic commit. Existing per-item delete mechanisms on tasks/rules/ledger/timeline/rituals are untouched; new wiring only added where missing.
- **Soft-delete is the boundary, not `del`.** Every `delete*` and `purgeAll*` server action calls `moveToTrash` / `moveManyToTrash` from `@/lib/trash` BEFORE the deletion pipeline. Records land in `trash:{feature}:{id}` with a 7-day TTL plus per-feature + global ZSET indexes. Restore re-hydrates the original record key + index ZSET entry with the captured score. Auxiliary state (reactions, audits, occurrences, streaks, pin-set membership, count keys) is intentionally **not** preserved — `references/coding-patterns.md` § "Soft-Delete via Trash Helper" lists what each feature loses on restore.
- **Activity feed is a logger side-effect.** `logger.interaction` / `warn` / `error` / `fatal` fire `recordActivity()` from `@/lib/activity` after the existing dev-console / Sentry path. Cap is 500 entries trimmed via `zremrangebyrank`. Never call `recordActivity` directly from feature code — let the logger drive it. Sir reads via `getActivityFeed()` on `/admin/activity`.
- **Force-logout via per-author session epoch.** `revokeAuthorSessions(author)` writes `Date.now()` to `session:epoch:{author}`. `decrypt()` reads the epoch (5s in-process cache) and rejects any JWT whose `iat` predates it. Existing JWTs without bumped epoch remain valid until first revoke. `/admin/sessions` is the UI; the action is `forceLogoutAuthor()`.
- **`/admin` is a Sir-only sub-tree.** `src/app/admin/layout.tsx` redirects non-Sir to `/`. The floating-navbar More sheet appends an Admin entry only when `getCurrentAuthor()` resolves to T7SEN. Every admin server action duplicates the role check via `requireSir()` in `src/app/actions/admin.ts` — the layout is convenience, not the boundary.
- **Summon mirrors safeword in reverse.** `summonKitten()` in `src/app/actions/admin.ts` is the only server action that fires Sir → Besho with the same delivery shape as safeword: `bypassPresence: true` + Android `channelId: "safeword"` + `priority: "max"` + `sound: "default"`. Possessive/dominant copy lives in the action body, not in constants — it's a single fixed message. Surfaced via `<SummonButton>` on the `/admin` landing using the two-step heavy-haptic shape. No cooldown — Sir initiates.
- **Per-device session tracking lives in `<DeviceTracker />`.** Mounted once in the root layout, owns every `device:*` write. On mount: device id (`@capacitor/device.getId()` native, localStorage UUID web), full info (`@capacitor/device` + `@capacitor/app`), coarse coords (native-only via `@capacitor/geolocation`). Heartbeats every 60s with the current pathname. Author claim is sticky — `pingDevice` rejects writes from the other author. The Sir-only viewer at `/admin/devices` polls every 10s; offline devices retain their last-known fingerprint + location. Don't call `pingDevice` from feature code; don't merge with `usePresence` (they're orthogonal — presence is per-author, devices are per-install).
- **Restraint mode is the Sir-only read-only flag for Besho.** `mode:restraint:Besho` STRING; checked via `assertWriteAllowed(author)` from `@/lib/restraint` at the top of every Besho-writable server action (Sir is never restrained). The helper has a 5s in-process cache to bound the per-request Redis hit. New Besho-writable actions MUST add the guard — there is no shared middleware. Toggled from the `<RestraintToggle>` on the `/admin` landing (two-step confirm to engage; single tap to lift). Safeword is intentionally exempt and stays callable.
- **Failed-login log is a side-channel from `login()`.** Every bad-passcode submission writes to `auth:failures` ZSET (capped at 100) with `{ ts, ip, ua, passcodeLen }` — never the passcode itself. Sir reads at `/admin/auth-log`. Successful logins still flow through `logger.interaction` and land in `/admin/activity`. Don't reuse `auth:failures` for general security events — keep it scoped to login failures.
- **Ritual window-open FCM is cron-driven from outside Vercel.** `/api/cron/ritual-windows` walks active rituals, fires `sendNotification(owner, ..., { bypassPresence: true })` when the window-open instant is within the last 5 minutes, and dedups via `ritual:fcm:sent:{ritualId}:{owningDateKey}` (`SET NX EX 36h`). Auth: `Authorization: Bearer ${CRON_SECRET}` — endpoint refuses to run if the env var is unset. **Single trigger: cron-job.org**, configured out-of-band in the operator's account, hits the URL every minute. There is intentionally no `vercel.json` in the repo — Vercel Hobby caps cron at once-per-day and rejects the build for any more-frequent schedule. Local notifications still fire on-device in parallel — different channels, no dedup needed.
- **Review submission window-open FCM is cron-driven.** `/api/cron/review-window-open` runs daily, short-circuits on non-Saturdays in Cairo TZ. On Saturday it fires "🪞 Review window open" to both authors and dedups via `review:fcm:opener:{weekDate}` (`SET NX EX 25h`). Same bearer-auth shape as the other crons. Don't fire the opener from any other code path — only the cron writes the dedup key.
- **`/admin/redis` is the read-only key inspector.** Sir-only. Returns type, TTL, and a capped preview of any single key. Never set/del/expire — strictly diagnostic. The action `inspectRedisKey(key)` truncates large values and caps collection previews at 200 entries. Don't propose adding a mutating button; the per-feature admin actions are the boundary for mutation.
- **`trash:retention-days` (1-90, default 7) sets the trash TTL.** Sir-tunable from `/admin/trash`. Read on every `moveToTrash` / `moveManyToTrash` via a 5s in-process cache. Changing the value applies only to future deletions — Redis TTLs are SET at write time and not retroactively recomputed. The `trash:` namespace also retains the existing 7-day-at-write semantics for already-trashed entries.
- **Deploy info on `/admin` landing.** `getDeployInfo()` returns `{ version, commitSha, commitShaShort, branch, env, deployId, serverTime }`. Sourced from `process.env.VERCEL_GIT_*` (build-time injected) + `package.json` version. Local dev shows nulls. Don't shell out for the SHA — Vercel runtime doesn't have git.
- **Obedience event log = `obedience:audit:{author}:{weekKey}` ZSET.** Score = emit ts, member = `{type}:{eventId}` matching the events ZSET so a join recovers points. Written by every `recordObedienceEvent` / `recordObedienceEventForWeek` in the same pipeline as the events ZADD. Read via `getEventLog(author, weekKey, limit)`. Surfaced as the "Event log" section on `/admin/rewards`.
- **Real-time directive overlay** — `<DirectiveDialog>` mounts in the root layout, self-gates on `getCurrentAuthor() === "Besho"` AND active-directive presence. Single-slot — `directive:active:Besho` STRING is the sentinel; reissuing while active refuses (Sir cancels first via `cancelDirective`). State machine: `issued` (forced full-screen modal blocking app interaction) → `acknowledged` (non-modal pinned strip with countdown + Complete button; app remains usable) → `completed` (brief confirm, auto-dismiss after 2s). Optional countdown 1–60 min via `durationSec`; open-ended directives ride a 24h sentinel TTL fallback. FCM payload uses `data.kind === "directive"` + `data.directiveId`; `<FCMProvider>` foreground listener branches on `kind` and dispatches `ourspace:directive-arrived` instead of the standard PushToast — `<DirectiveDialog>` listens for it and refetches. Background path uses the standard notification banner. Obedience emit: `directive_completed` (+5) on completion, `directive_missed` (−10) on cron-driven expiration. **Cron-only expiration** via `/api/cron/timer-expire` (minute cadence, cron-job.org) — page reads MUST NOT mutate state. The combined `timer-expire` cron is shared with the punishment-timer. Soft-delete via `moveToTrash` for terminal states; refuses to delete a still-active directive. The `extraData` parameter on `sendNotification` is the sanctioned way to pipe non-standard FCM `data` fields — values must be strings. **Suppression rule:** when an active punishment exists, `<DirectiveDialog>` self-suppresses (renders null); `<PunishmentOverlay>` dispatches `ourspace:punishment-cleared` on terminal transitions so the dialog refetches and surfaces any queued directive.
- **Punishment timer** — `<PunishmentOverlay>` mounts in the root layout BEFORE `<DirectiveDialog>` (precedence). Self-gates on Besho + active-punishment presence. Single-slot via `punishment:active:Besho` STRING with TTL = `durationSec + PUNISHMENT_ACTIVE_TTL_BUFFER_SEC` (10min buffer past `endsAt` for the cron). State machine: `issued` (full-screen modal with Begin button — clock paused until kitten consents) → `running` (full-screen kneel-timer view; countdown + progress bar + bail button with two-tap delay) → `completed` (after `endsAt`, kitten taps Complete) OR `bailed` (manual bail, app-background past 60s grace, or cron sweep past `endsAt + grace`). The Complete button is locked until `now >= endsAt`. **Background-grace** — when running and `appStateChange.isActive === false`, a 60s timer starts; returning to foreground cancels it; expiry calls `bailPunishment` with `reasonTag: "background-grace"`. **Bail-confirm** is two-tap with `BAIL_CONFIRM_DELAY_MS = 1500` auto-revert (mirrors PurgeButton). FCM uses `data.kind === "punishment"` with `bypassPresence: true` and `priority: "high"` — the timer must engage immediately regardless of which page kitten is on. **Channel is `default`, NOT `safeword`** — the safeword channel is reserved for Besho→Sir distress + summon. Auto-creates a `ledger:{id}` `punishment` entry on completion AND on bail, with `linkedPunishmentId` back-reference and `category: "Other"`. The auto-ledger write is **inline** in `punishment.ts` — NOT via `createLedgerEntry` — so the standard `ledger_punishment` emit is intentionally suppressed; the typed `punishment_completed` (+2) / `punishment_bailed` (−20) events are the canonical obedience signal. Cron-only timeout sweep via `/api/cron/timer-expire` — `expireDuePunishments` walks `running` records past `endsAt + BACKGROUND_GRACE_SEC` and bails them with `reasonTag: "timeout"`. Bail is terminal — no re-start. Soft-delete via `moveToTrash` for terminal states; refuses to delete an active punishment.
- **`ourspace` desktop CLI is bearer-authed via `ADMIN_CLI_TOKEN`, not the session cookie.** Lives at `packages/cli/` as a pnpm-workspace package; invoked from the repo root via `pnpm cli <command>`. Five commands: `summon`, `restrain <on|off|status>`, `push <to> <body…>`, `logout <author>`, `status`. Calls the `/api/admin/cli/*` route group — each route validates `Authorization: Bearer ${ADMIN_CLI_TOKEN}` via `src/lib/admin-cli-auth.ts::requireCliAuth` (timing-safe compare; min 32 chars enforced). Routes do NOT call `requireSir()` — the CLI has no session cookie. They replicate the underlying primitives directly (`sendNotification`, `setRestraintRaw`, `revokeAuthorSessions`, etc.) and log with a `by: "T7SEN (cli)"` marker so `/admin/logs` Activity tab distinguishes CLI ops from browser /admin clicks. The token is the entire security boundary for this surface — treat it as Sir-level credentials, rotate via Vercel env + Sir's shell profile, never log it. Don't add a cookie-auth fallback path; bearer-only is intentional.
- **Rule-violation ledger entries snapshot the rule body at write time.** Mirrors the reward/tier emoji snapshot pattern — future rule edits or deletes do NOT rewrite a logged violation's history. Schema: `LedgerEntry.type === "violation"` carries optional `ruleId`, `ruleSnapshot: { title, body? }` (body truncated to `MAX_VIOLATION_RULE_SNAPSHOT_BODY_LEN = 1000`), and `severity: "minor" | "moderate" | "major"`. The `category` field stores the capitalized severity label so the existing render pipeline (which displays `entry.category` as a chip) "just works." Per-rule lookup index: `ledger:violations:by-rule:{ruleId}` ZSET, score = `createdAt`, member = ledger entry id. Pipelined alongside `ZADD ledger:index` on create. Auxiliary index is intentionally NOT preserved on restore from trash (mirrors the reactions/occurrences pattern); a restored violation will not re-appear in `getViolationsByRule` until manually reconciled. Sir-only "Log violation" affordance lives on each `<RuleItem>` action row in `/rules` — links to `/ledger?prefill=violation:${rule.id}` which reads the param via `useSearchParams()` (Suspense-wrapped) and pre-selects the rule + opens the form. Per-rule "N violations logged" line surfaces on every rule card for both authors. Active rules only — completed rules can't have new violations logged (Sir reopens before logging). Obedience emit: severity-scaled `rule_violation_minor` / `_moderate` / `_major` typed events (defaults −3 / −8 / −20, Sir-tunable). The standard `ledger_punishment` emit is intentionally suppressed for violation entries so the score isn't double-counted.
- **Obedience score / `/rewards` is a separate axis from `/ledger`.** `/ledger` stays as Sir's manual log. `/rewards` is the automatic-tier surface driven by an obedience score per Besho-week (Sun→Sat Cairo, aligned with `/review`). Score events are emitted via `recordObedienceEvent` from `@/lib/obedience` at the natural action sites: `tasks.approveTask`, `rules.acknowledgeRule`, `rituals.submitOccurrence`, `permissions.createPermission` (auto-decide path) + `decidePermission` (manual approval path) + the re-ask penalty in `createPermission`, `mood.submitMood` only (state is unscored), `admin.setRestraintState` engage transition, and `ledger.createLedgerEntry` (when `type === "punishment"` it emits `ledger_punishment`; when `type === "violation"` it emits the severity-scaled `rule_violation_${severity}` typed event INSTEAD of `ledger_punishment` — never both; reward entries do NOT emit — the ledger reward path is purely a manual log). Plus the Sir-only `manual_adjust` event from `admin.adminAdjustScore` for ad-hoc points outside the canonical types (reason text logged via `logger.interaction`, never stored on the ZSET member). Idempotent via `{eventType}:{eventId}` ZSET member dedup. The Sir-tunable knobs (`obedience:weights`, `rewards:tiers`, `obedience:streak-threshold`, `obedience:multipliers`) live behind admin actions and are validated server-side. Tier count is fixed at 5. Reward catalog items AND tiers each carry an optional `emoji` field, both snapshotted onto each claim (`RewardClaim.rewardEmoji` / `RewardClaim.tierEmoji`) at claim time so renames/deletes don't rewrite history. Default tier seeds use 🥉 🥈 🥇 🏆 👑. Reward claims are append-only — no soft-delete pathway. **`ClaimStatus` has FIVE values** — `pending`, `delivered`, `denied`, `revoked`, `rerolled`. Only `revoked` is FULLY terminal. `rerolled` accepts a re-decide flip to `delivered` or `denied` (Sir reversing his own reroll — either honors the originally-claimed reward, or hardens the refusal into a denial) but CANNOT be re-rerolled or revoked directly (Sir delivers/denies first then revokes if needed). `rerollClaim` (Sir-only) is allowed ONLY on `pending` claims; it DELs `rewards:claims:by-week:{author}:{weekKey}` so kitten can immediately claim a different reward in the same week — distinct from `deny` (which consumes her slot) and `revoke` (which annuls a prior decision). Reroll itself fires no obedience event; a follow-up rerolled → delivered/denied flip rides the standard `deliverClaim` / `denyClaim` paths and emits no extra event either (those are pure status decisions, not behavior). The per-week slot is intentionally NOT re-set when transitioning out of `rerolled` — kitten may have already claimed something else for that week; Sir manages double-claim cases via revoke on the newer record if needed. The "History N×" pill (formerly "Changed N×") renders whenever `auditCount > 0` and counts every transition that wrote to `reward:claim:audit:{id}` (re-decides, revokes, rerolls); first decisions (pending → delivered/denied) write no audit so a freshly delivered claim shows no pill. The audit-row `note` captures the prior state's reason: `sirNote` for delivered/denied prior states, `rerollReason` for rerolled prior states — so the History list shows Sir's prior reasoning even across reroll reversals. Daily cron `/api/cron/obedience-sweep` (cron-job.org, no `vercel.json`) emits the negative missed-event side (`task_missed`, `ritual_missed`, `rule_unacked`) and finalizes prior weeks; lazy `catchUpFinalizations` runs on `/rewards` reads as a robustness fallback. Two automatic FCM hooks: (1) `recordObedienceEvent` fires a tier-unlock push to Besho once per tier-threshold per week (gated by `obedience:tier-notified:{author}:{weekKey}` sentinel); (2) `finalizeWeek` fires a recap push to **both authors** with the wrapped score, gated to **only the immediately prior week** AND non-empty weeks — older catch-up finalizations (after a deploy or long absence) and empty weeks finalize silently to avoid spam on first `/rewards` load. **Test mode** (`obedience:test-mode` Sir-only flag) opens current-week claims so the claim → deliver flow can be verified without ending the week — the week itself stays unfinalized; streak and multiplier are unaffected. Both are best-effort — FCM failure does not roll back the underlying state change. **Finalization is cron-only** — `/api/cron/obedience-sweep` is the sole `finalizeWeek` / `catchUpFinalizations` caller. Page reads (`getRewardsBundle`) MUST NOT finalize; doing so triggers recap FCMs as a side-effect. Until the cron runs, prior weeks read unfinalized — `computeWeekScore` handles that path by computing live multiplier from the stored streak.

---

## 5. Code Style, Naming, React, TypeScript, UI, State

Tabs, single quotes, no semicolons (except ASI), strict equality always, 80-col lines, trailing commas. Functional components only, default to Server Components, `'use client'` only when needed. `interface` over `type` for object shapes. Tailwind v4, dark theme forced. Full rules and examples: `references/code-style.md`.

---

## 6. Error Handling, Auth, Security, Accessibility, Documentation

Logger in `src/lib/logger.ts`. Sentry via `next.config.ts` + `src/instrumentation.ts`, tunnel route `/monitoring`. JWT via `jose`, HS256, 30-day expiry, HTTP-only `session` cookie. Server-side role checks always. Sanitize rich-text via `MarkdownRenderer` — never `dangerouslySetInnerHTML` raw user content. Full keyboard navigation, AA contrast, one `h1` per route. Full guidance: `references/auth-and-security.md`.

---

## 7. Capacitor / Native (Summary)

`isNative()` from `src/lib/native.ts` is the only sanctioned platform check. Plugin imports are dynamic to keep web bundles slim. Hosted-webapp via `server.url` (Section 3.7). Notification channel `default` created with `vibration: true` and importance 4 to suppress heads-up banners while foregrounded. Web is built via Vercel; APK is rebuilt only when Capacitor config or plugins change. Keystore: `C:\Users\T7SEN\keys\ourspace.jks`. **Never change `appId`** (`me.t7senlovesbesho`). Display name `appName: 'Our Space'` is what the user reads. `@capacitor/device` + `@capacitor/app` feed Sentry context (model, OS, app version) via `SentryUserProvider`. `@capacitor/geolocation` powers live distance in `DistanceCard` (coarse fix, Haversine to `PARTNER_COORDS`). `@capacitor/keyboard` exposes `hideKeyboard()` via `src/lib/keyboard.ts` for form-submit-success effects. Full plugin matrix, plugin-add checklist, and BiometricGate state machine: `references/capacitor-native.md`.

---

## 8. Deployment (Summary)

Vercel auto-deploys on push to `main`. Required env vars: `AUTH_SECRET_KEY`, `KV_REST_API_URL`, `KV_REST_API_TOKEN`, `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`, `SENTRY_AUTH_TOKEN`, `CRON_SECRET`, `ADMIN_CLI_TOKEN` (64+ char high-entropy random string — bearer auth for the `ourspace` desktop CLI; min 32 chars enforced server-side; never log it). **No `VAPID_*` env vars** — Web Push is removed. `FIREBASE_PRIVATE_KEY` `\n` literals are intentional — `replace(/\\n/g, '\n')` runs at runtime. Sentry org `t7sen-c0`, project `our-space`. Bump `versionCode` in `android/app/build.gradle` for every Android release. Adding a Capacitor plugin requires `pnpm add` → `npx cap sync android` → manifest perms (if any) → `versionCode` bump → APK rebuild; until sync + reinstall, the JS layer loads but native calls fall back silently. `pnpm-lock.yaml` is committed. Full pipeline, smoke tests, troubleshooting: `references/deployment.md`.

---

## 9. GitHub & Commits

- Pull and review every push before responding to a session that follows new commits.
- Imperative subject, ≤72 chars, scoped: `notes:`, `rules:`, `push:`, `biometric:`, `ci:`.
- Never `git push --force` on `main`.

---

## 10. Working Agreements

- **Begin every non-trivial response with a plan or architectural overview**, then implementation.
- **Push back on bad ideas.** If asked for `==`, an inline `<style>`, a global Redux store, a Gallery page, a PWA migration, or anything that violates this guide — refuse and explain. Don't sugar-coat.
- **No bugs.** Re-read every block of generated code before presenting.
- Cite the file path and the function/symbol you're editing.
- Prefer React 19 / Next.js 16 idioms over older patterns even if older "still work."
- Tone: formal, direct, technical.
- **Skip the `tsc` + `eslint` + `next build` verification triple when the turn touched ONLY documentation** — `AGENTS.md`, `SKILL.md`, `CLAUDE.md`, `GEMINI.md`, `README.md`, anything under `references/`. Markdown changes can't affect compilation. Any code touch — including a single-line comment edit inside a `.ts` / `.tsx` / `.mjs` / config file — still gets the full triple. The default for code-touching turns remains: verify before reporting done.

---

## 11. File Map

```
packages/
└── cli/                            # `ourspace` desktop CLI — Sir-only, bearer-authed via ADMIN_CLI_TOKEN
    ├── package.json                # tsx-based, zero runtime deps beyond tsx
    ├── tsconfig.json
    └── src/
        ├── index.ts                # Entry + dispatcher, top-level error handler (ApiError → friendly message)
        ├── lib/
        │   ├── config.ts           # Reads OURSPACE_BASE_URL + OURSPACE_CLI_TOKEN
        │   ├── api.ts              # fetch wrapper, ApiError class, get/post helpers
        │   └── format.ts           # ANSI color helpers (auto-off on non-TTY)
        └── commands/
            ├── summon.ts
            ├── restrain.ts         # on / off / status
            ├── push.ts             # --title --url --bypass flags
            ├── logout.ts
            └── status.ts           # presence, cron, restraint, FCM token counts

src/
├── app/
│   ├── layout.tsx              # Providers, BiometricGate, navbars, FCMProvider, NavigationProgress
│   ├── template.tsx            # Per-route enter animation with directional slide (ROUTE_ORDER)
│   ├── globals.css             # Tailwind v4 tokens (incl. --author-daddy / --author-kitten)
│   ├── page.tsx                # Dashboard
│   ├── notes/                  # Notes feature + SSE consumer
│   ├── rules/                  # Rules lifecycle
│   ├── tasks/                  # Tasks
│   ├── ledger/                 # Rewards / Punishments
│   ├── timeline/               # Shared timeline
│   ├── permissions/            # Two-author negotiation surface (see references/permissions.md)
│   ├── protocol/               # Shared protocol + version history; supports ?focus= deep links
│   ├── rituals/                # Recurring obligations + LocalNotifications reminders
│   ├── review/                 # Weekly retrospective — independent reflections, atomic reveal
│   ├── rewards/                # Obedience score + tier ladder + claim/deliver flow (Besho score, Sir delivers)
│   ├── admin/                  # Sir-only sub-tree (layout redirects non-Sir). Landing carries an at-a-glance dashboard strip (pending perms / pending claims / cron freshness / errors-24h) plus a recent-admin-actions timeline. Routes: trash (with multi-select bulk ops), export, push-test (12 tap-to-fill presets — 8 to Sir, 3 to Both, 1 to kitten — with a Daddy/Kitten/Both recipient selector that fans out to both authors when "Both" is picked), directive (Sir-only real-time directive issuance — title, body, duration preset chips, single-slot active panel with cancel, last-50 history with terminal-state delete), punishment-timer (Sir-only duration-bounded corrective timer — reason, duration preset chips, single-slot active panel with cancel + countdown chip, auto-creates linked ledger entry on completion or bail), devices (presence + FCM tokens + force-logout sessions + per-install records — old /admin/inspector and /admin/sessions merged in), stats, health (tabbed: Health [Redis/FCM/cron/time-integrity/repair] / Cooldowns / Time [snapshot + Cairo↔Tabuk converter] — old /admin/cooldowns, /admin/time, /admin/timezone merged in), logs (tabbed: Activity [level filter] / Outbound / Restraint / Auth failures [IP filter] — old /admin/activity, /admin/notifications, /admin/restraint-history, /admin/auth-log merged in), mood, dates, rewards (Status tab carries a pure-client score simulator), permissions (Simulate tab runs auto-rules against a fake request), redis
│   ├── actions/                # Server actions ('use server')
│   │   ├── admin.ts            # Slimmed orchestration core (~1.4k lines): activity feed, JSON export, auth-log, dates editor, mood/state overrides, stats + heatmap, trash, landing summary widgets. Re-exports every bucket symbol so `@/app/actions/admin` imports keep resolving (Turbopack rejects `export {...} from` in 'use server' files; uses one-line wrapper functions).
│   │   ├── admin/              # Sir-only domain buckets, all 'use server'
│   │   │   ├── _shared.ts      # NON-server helper module: Upstash redis singleton, getSession, requireSir, PRESENCE_FRESH_MS. `import "server-only"` keeps it off the client bundle.
│   │   │   ├── permissions.ts  # Auto-rules JSON, quotas, bulk-decide, simulator
│   │   │   ├── rewards.ts      # Tiers, weights, streak, snapshot, recompute, manual adjust, event log, test mode, claim purge, per-event delete
│   │   │   ├── health.ts       # Cooldowns, health snapshot, repair indexes, cron telemetry, drift repair, bucket-shift migration, deploy info, redis inspector
│   │   │   ├── notifications.ts # Summon, test push, outbound audit, resend
│   │   │   └── devices.ts      # Inspector, sessions, devices, restraint state + history
│   │   ├── rewards.ts          # Both-author bundle, claim/deliver/deny, claim history
│   │   └── devices.ts          # pingDevice (any authenticated user, own device), forgetDevice (Sir-only)
│   └── api/
│       ├── presence/route.ts
│       ├── notes/stream/                    # Edge SSE
│       ├── push/subscribe-fcm/              # FCM token registration
│       ├── cron/                            # cron-job.org-driven (Bearer ${CRON_SECRET})
│       │   ├── obedience-sweep/             # Daily — finalize weeks, emit missed-event penalties, stale-claim nudge
│       │   ├── ritual-windows/              # Minute cadence — fire window-open FCM with sentinel dedup
│       │   ├── review-window-open/          # Daily, short-circuits non-Saturdays Cairo
│       │   ├── timer-expire/                # Minute cadence — sweeps directive timers (emits directive_missed) AND punishment timers (bails past endsAt + grace, emits punishment_bailed, auto-creates ledger entry)
│       │   └── heartbeat-watch/             # Watches the others; FCMs Sir if any go stale
│       └── admin/cli/                       # Bearer-authed via ${ADMIN_CLI_TOKEN} — consumed by packages/cli
│           ├── summon/                      # POST — fire Sir → Besho summon push
│           ├── restrain/                    # POST {on, note?} / GET — toggle / read Besho's restraint
│           ├── push/                        # POST — generic FCM ({to: besho/sir/both, title, body, url?, bypassPresence?})
│           ├── logout/                      # POST {author} — bump session epoch
│           ├── status/                      # GET — presence, cron telemetry, restraint, FCM token counts
│           ├── directive/                   # POST {title, body?, durationSec?} — issue directive (single-slot); GET — active + recent
│           │   └── cancel/                  # POST {id?} — cancel active (or specified) directive
│           ├── punish/                      # POST {reason, durationSec} — issue punishment timer; GET — active + recent
│           │   └── cancel/                  # POST {id?} — cancel active (or specified) punishment
│           ├── rules/                       # GET ?status=active|pending|completed — list rules with UUIDs (lookup for violation)
│           └── violation/                   # POST {ruleId, severity, title, description?} — log rule-violation ledger entry (severity ∈ minor/moderate/major)
├── components/
│   ├── biometric-gate.tsx
│   ├── fcm-provider.tsx
│   ├── sentry-user-provider.tsx
│   ├── device-tracker.tsx       # Mount-once tracker, drives device:* writes via pingDevice
│   ├── push-toast.tsx
│   ├── pull-to-refresh.tsx
│   ├── navigation-progress.tsx # Top progress bar that fires on internal link clicks
│   ├── capacitor-init.tsx
│   ├── theme-provider.tsx
│   ├── global-logger.tsx
│   ├── navigation/             # top-navbar (Heart icon mobile, wordmark md:+), floating-navbar (5 primary tabs + More sheet)
│   ├── dashboard/              # Cards: Mood, Counter (with anniversary countdown), Weather, Moon, Distance, Quote, SafeWord, Birthday, TodayStrip
│   ├── review/                 # Form, reveal card, summary panel, history drawer (Sir-only per-week delete)
│   ├── admin/                  # PurgeButton + SummonButton + RestraintToggle — Sir-only controls (caller gates render on isT7SEN)
│   │   └── logs/               # CopyButton, ClearTabButton, LiveToggle, SearchBar, LogEntryShell — shared building blocks for /admin/logs
│   │                           # /admin pages live under src/app/admin/, not here
│   └── ui/                     # shadcn primitives + RichTextEditor, MarkdownRenderer, ErrorBoundary, Sheet
├── hooks/                      # use-presence, use-refresh-listener, use-local-notifications, use-keyboard, use-network, use-nav-badges, use-pull-to-refresh
├── lib/                        # auth-utils (+ session-epoch revoke), cairo-time, native, haptic, keyboard, clipboard, logger, activity (Sir-only feed), trash (soft-delete helper), restraint (Besho read-only flag), obedience (score + tiers + streak math, 5s cache), reward-types (defaults + bounds), device-id + device-types (DeviceTracker plumbing), constants (Author, AUTHOR_COLORS, partnerOf, TITLE_BY_AUTHOR), *-constants
└── instrumentation.ts          # Sentry
```

---

## 12. Decision Heuristics

When in doubt:

1. Does this require offline support? → Refuse. Architecture doesn't allow it (Section 3.7).
2. Will this cause hydration mismatch? → Lazy `useState`, defer `setState`, wrap browser globals.
3. Server-only secret? → Env var, never shipped to client.
4. Respects dom/sub permissions? → Re-check `session.author` server-side.
5. Will this fire a duplicate notification? → Add a presence check.
6. PWA / Web Push reintroduction proposal? → Refuse (Section 3.7).
7. Banned (gallery, bucket list, Telegram / third-party messenger as push channel)? → Refuse.
8. Violates any rule above? → Refuse and explain.

### Decisions deliberately deferred

These were considered and rejected on merits — not banned, but revisit only if observed evidence justifies the cost. Don't re-propose without new information.

- **Notification dedup / per-author cooldown.** Banner pile-up is by design — every event surfaces. Adding cooldown would mute the signal the user wants. Revisit only if a specific scenario produces unwanted spam.
- **Rate-limiting safeword + permission submissions.** Already protected: safeword by 5min cooldown, permissions by re-ask block + max-pending cap + body-length cap + body-hash dedupe. Adding rate limits would protect against scenarios that don't realistically occur.
- **Server-action return-shape lint or type guard.** The `{ success?, error? }` convention has held by hand-copy with no observed drift. Adding `MutationResult` everywhere is a ~30-file mechanical pass for preventive value only. Revisit when drift is observed.
- **SSE generalization beyond `/notes`.** The 15s `useRefreshListener` poll covers permissions / rules / ledger / etc. adequately. SSE on Edge has CPU cost and per-feature poll-detector work that outweighs the sub-15s update gain on pages where 15s is fine.
- **Reactive-bundle pattern across all pages.** Most pages already do the right thing via `Promise.all`. The remaining gaps are too small to justify a refactor pass.
- **Background reveal-watcher cron for `/review`.** History-record-on-next-open recovery already exists. Cron adds a moving part for paranoia.
- **Per-feature filter chips on the `/admin/logs` Activity tab.** The activity feed is intentionally cross-feature (every `logger.interaction` / `warn` / `error` / `fatal` lands here). Adding feature-specific chips ("Violations only", "Rules only", "Ledger only") would be a third filter dimension on top of the existing level filter for marginal value. Feature-specific surfaces already exist: `/ledger?filter=violation` for violation entries with rule snapshot; `/admin/rewards` Event Log filter for `rule_violation_*` obedience emits; per-feature pages for everything else. Re-evaluate only if Sir hits a real "I'm hunting through the activity feed for X-type events" workflow.

---

## 13. References

Load on demand. Do not load preemptively.

| Task involves...                                         | Load                               |
| -------------------------------------------------------- | ---------------------------------- |
| Push notifications, FCM, presence routing                | `references/push-routing.md`       |
| Redis keys, data shape, pagination, TTLs                 | `references/redis-schema.md`       |
| Capacitor plugins, hosted-webapp, BiometricGate          | `references/capacitor-native.md`   |
| Cairo TZ date math, DST-safe windows, day-key arithmetic | `references/cairo-time.md`         |
| Vercel env vars, APK builds, smoke tests                 | `references/deployment.md`         |
| Runtime-critical coding patterns with examples           | `references/coding-patterns.md`    |
| Code style, naming, React, TypeScript, UI, state         | `references/code-style.md`         |
| Auth, error handling, security, accessibility            | `references/auth-and-security.md`  |
| Sir-only `/admin` tools, soft-delete, force-logout       | `references/auth-and-security.md` § "Sir-Only Admin Tier" |
| `/permissions` feature — schema, validation, auto-rules  | `references/permissions.md`        |
| `/review` feature — schema, state machine, reveal race   | `references/review.md`             |
| `/rewards` + obedience score — keys, model, finalization | `references/redis-schema.md` § "Rewards & obedience" |
| Anti-hallucination inventory (also in `SKILL.md`)        | `references/anti-hallucination.md` |
| Full refusal catalog (also abridged in `SKILL.md`)       | `references/refusal-catalog.md`    |

If a task touches multiple areas, load multiple references. Trust the routing table.
