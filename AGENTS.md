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
| Hosting         | Vercel (web), Capacitor APK (Android)                |
| Architecture    | **Hosted-webapp Capacitor shell** — see Section 3.7  |
| Package manager | `pnpm` — never npm or yarn                           |
| Users           | Exactly two: `T7SEN` (dom), `Besho` (sub/kitten)     |
| Devices         | T7SEN: Samsung Android. Besho: Honor phone + tablet. |

**Banned features.** Never suggest, scaffold, or reference: `gallery`, `bucket list`. Reject any framing that implies them and propose alternatives using `/notes`, `/timeline`, `/tasks`, `/rules`, or `/ledger`.

---

## 2. Tech Stack (Locked Versions)

Pinned by `package.json`. Do not upgrade as part of feature work.

- **Runtime:** Next.js `16.2.4`, React `19.2.4`, TypeScript `^5`
- **Styling:** Tailwind CSS `^4` (CSS-first via `globals.css`, no `tailwind.config.*`), `tw-animate-css`, `tailwind-merge`
- **UI:** shadcn/ui (style: `radix-nova`, base: `zinc`, icons: `lucide`), `radix-ui`, `motion` (Framer Motion v12), `next-themes`
- **State / Forms:** native React 19 (`useActionState`, `useTransition`), Zod, no Redux
- **Data:** Upstash Redis (`@upstash/redis`) — sole datastore
- **Auth:** `jose` JWT in HTTP-only `session` cookie (HS256, 30-day)
- **Native:** Capacitor `^8.3.1` + plugins (biometric, push, preferences, haptics, clipboard, app, keyboard, network, status-bar, splash, badge)
- **Push:** `firebase-admin` (FCM) for Android. **No Web Push. No PWA.**
- **Observability:** Sentry (`@sentry/nextjs`), Vercel Analytics + Speed Insights
- **Build/lint:** ESLint `^9` flat config, `concurrently`, `esbuild`

**Anti-hallucination:** before writing any import or env-var reference, consult `SKILL.md` Section 2.1 (also cached in `references/anti-hallucination.md`). Common drift: `serwist`, `web-push`, `VAPID_*`, `offline-notes`, `/api/notes/sync`, `push:subscription:*`, `prisma`, `tailwind.config.*`, `pages/`. None of these exist.

---

## 3. Architectural Pillars (Summary)

Each pillar below is a one-paragraph summary. Full treatment lives in the linked reference. Do not paraphrase from memory — load the reference when the work touches that pillar.

### 3.1 Role-Based Dynamics (dom/sub)

Every state-mutating server action **must** check `session.author` server-side, even if the UI hides the button. T7SEN (Sir) creates rules, marks rules complete, reopens rules, creates tasks, logs ledger entries, views safe-word history, decides permission requests, sets quotas, authors auto-decide rules. Besho (kitten) acknowledges rules, completes tasks, sends safe-word, submits permission requests, withdraws her own pending requests. Both write notes, react, set mood, send hugs. **Auto-decide rules are Sir-private** — `getAutoRules` returns `[]` for Besho; her cards show only an "Auto" chip with no rule details. User copy uses `Sir` / `kitten` via `TITLE_BY_AUTHOR` in `src/lib/constants.ts`. Never hard-code. Full permission matrix and canonical role-check shape: `references/auth-and-security.md`. Permissions surface specifics: `references/permissions.md`.

### 3.2 Presence-Aware Push Routing (FCM-Only)

Algorithm: (1) `pushNotificationToHistory(target, payload)` first, (2) read `presence:{author}` (TTL 6s), (3) if recipient is on the target page → skip push (SSE handles UI), (4) else FCM — foreground (presence exists, different page) gets a **data-only** payload (in-app `PushToast`); background/closed gets a full `notification` payload (OS heads-up banner). The `notification` field MUST NOT be set in the foreground payload, or Android double-notifies. **No Web Push fallback.** Full algorithm and failure modes: `references/push-routing.md`.

### 3.3 FCM Registration Defensive Handling

Both devices register an FCM token on app launch. Registration can still fail for ordinary reasons — permissions denied, network unavailable, OEM quirks. `FCMProvider` (`src/components/fcm-provider.tsx`) catches `registrationError` and logs without throwing. Server-side push code must therefore treat `push:fcm:{author}` as nullable: if absent, return silently; the `notifications:{author}` history record is the durable artifact, surfaced via `NotificationDrawer` and `useNavBadges`. Do not reintroduce PWA/Web Push as a fallback — rationale in Section 3.7 and `references/capacitor-native.md`.

### 3.4 BiometricGate

`src/components/biometric-gate.tsx` is the primary unlock. Renders a fullscreen overlay above all routes except `UNGUARDED_ROUTES`. Each ref is load-bearing: `lastAuthEndedAtRef` (2-second debounce against the **Knox/Honor double-prompt loop**), `last_unlocked_at` Preference (cold-start grace period), `LOCK_AFTER_MS` (re-lock threshold on `appStateChange`). Web/desktop falls through (`isNative()` → false). Do not "simplify." Full state machine: `references/capacitor-native.md`.

### 3.5 Real-Time via SSE

`/notes` uses Server-Sent Events at `src/app/api/notes/stream/route.ts` (Edge runtime, 45s max stream age, 10s poll, 10s keepalive). The client `EventSource` reconnects automatically. Do not introduce websockets without first removing SSE.

### 3.6 Redis (Upstash) Data Model

Single Redis instance. Flat colon-namespaced keys: `note:{id}`, `notes:index` (ZSET), `reactions:{noteId}` (HASH), `rule:{id}`, `task:{id}`, `ledger:{id}`, `permission:{id}`, `permissions:index` (ZSET), `permissions:auto-rules` (Sir-only JSON array), `permissions:quotas` (JSON), `mood:{YYYY-MM-DD}:{author}`, `presence:{author}` (TTL 6s), `push:fcm:{author}`, `notifications:{author}` (LIST capped at 50). Permissions has additional sub-keys for re-ask blocking, audit history, and denied-hash detection — see the reference. Always pipeline dependent writes. Use `MY_TZ` (Cairo) from `src/lib/constants.ts` for date-derived keys — never the server's local time. Full schema and anti-patterns: `references/redis-schema.md`. Permissions feature spec: `references/permissions.md`.

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

---

## 5. Code Style, Naming, React, TypeScript, UI, State

Tabs, single quotes, no semicolons (except ASI), strict equality always, 80-col lines, trailing commas. Functional components only, default to Server Components, `'use client'` only when needed. `interface` over `type` for object shapes. Tailwind v4, dark theme forced. Full rules and examples: `references/code-style.md`.

---

## 6. Error Handling, Auth, Security, Accessibility, Documentation

Logger in `src/lib/logger.ts`. Sentry via `next.config.ts` + `src/instrumentation.ts`, tunnel route `/monitoring`. JWT via `jose`, HS256, 30-day expiry, HTTP-only `session` cookie. Server-side role checks always. Sanitize rich-text via `MarkdownRenderer` — never `dangerouslySetInnerHTML` raw user content. Full keyboard navigation, AA contrast, one `h1` per route. Full guidance: `references/auth-and-security.md`.

---

## 7. Capacitor / Native (Summary)

`isNative()` from `src/lib/native.ts` is the only sanctioned platform check. Plugin imports are dynamic to keep web bundles slim. Hosted-webapp via `server.url` (Section 3.7). Notification channel `default` created with `vibration: true` and importance 4 to suppress heads-up banners while foregrounded. Web is built via Vercel; APK is rebuilt only when Capacitor config or plugins change. Keystore: `C:\Users\T7SEN\keys\ourspace.jks`. **Never change `appId`** (`me.t7senlovesbesho`). Display name `appName: 'Our Space'` is what the user reads. Full plugin matrix and BiometricGate state machine: `references/capacitor-native.md`.

---

## 8. Deployment (Summary)

Vercel auto-deploys on push to `main`. Required env vars: `AUTH_SECRET_KEY`, `KV_REST_API_URL`, `KV_REST_API_TOKEN`, `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`, `SENTRY_AUTH_TOKEN`. **No `VAPID_*` env vars** — Web Push is removed. `FIREBASE_PRIVATE_KEY` `\n` literals are intentional — `replace(/\\n/g, '\n')` runs at runtime. Sentry org `t7sen-c0`, project `our-space`. Bump `versionCode` in `android/app/build.gradle` for every Android release. `pnpm-lock.yaml` is committed. Full pipeline, smoke tests, troubleshooting: `references/deployment.md`.

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

---

## 11. File Map

```
src/
├── app/
│   ├── layout.tsx              # Providers, BiometricGate, navbars, FCMProvider
│   ├── globals.css             # Tailwind v4 tokens
│   ├── page.tsx                # Dashboard
│   ├── notes/                  # Notes feature + SSE consumer
│   ├── rules/                  # Rules lifecycle
│   ├── tasks/                  # Tasks
│   ├── ledger/                 # Rewards / Punishments
│   ├── timeline/               # Shared timeline
│   ├── permissions/            # Two-author negotiation surface (see references/permissions.md)
│   ├── protocol/               # Shared protocol + version history; supports ?focus= deep links
│   ├── rituals/                # Recurring obligations + LocalNotifications reminders
│   ├── actions/                # Server actions ('use server')
│   └── api/
│       ├── presence/route.ts
│       ├── notes/stream/       # Edge SSE
│       └── push/subscribe-fcm/ # FCM token registration
├── components/
│   ├── biometric-gate.tsx
│   ├── fcm-provider.tsx
│   ├── push-toast.tsx
│   ├── pull-to-refresh.tsx
│   ├── capacitor-init.tsx
│   ├── theme-provider.tsx
│   ├── global-logger.tsx
│   ├── navigation/             # top-navbar, floating-navbar
│   ├── dashboard/              # Cards: Mood, Counter, Weather, Moon, Distance, Quote, SafeWord, Birthday
│   └── ui/                     # shadcn primitives + RichTextEditor, MarkdownRenderer, ErrorBoundary
├── hooks/                      # use-presence, use-refresh-listener, use-local-notifications, use-keyboard, use-network, use-nav-badges
├── lib/                        # auth-utils, native, haptic, clipboard, logger, constants, *-constants
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
7. Banned (gallery, bucket list)? → Refuse.
8. Violates any rule above? → Refuse and explain.

---

## 13. References

Load on demand. Do not load preemptively.

| Task involves...                                        | Load                               |
| ------------------------------------------------------- | ---------------------------------- |
| Push notifications, FCM, presence routing               | `references/push-routing.md`       |
| Redis keys, data shape, pagination, TTLs                | `references/redis-schema.md`       |
| Capacitor plugins, hosted-webapp, BiometricGate         | `references/capacitor-native.md`   |
| Vercel env vars, APK builds, smoke tests                | `references/deployment.md`         |
| Runtime-critical coding patterns with examples          | `references/coding-patterns.md`    |
| Code style, naming, React, TypeScript, UI, state        | `references/code-style.md`         |
| Auth, error handling, security, accessibility           | `references/auth-and-security.md`  |
| `/permissions` feature — schema, validation, auto-rules | `references/permissions.md`        |
| Anti-hallucination inventory (also in `SKILL.md`)       | `references/anti-hallucination.md` |
| Full refusal catalog (also abridged in `SKILL.md`)      | `references/refusal-catalog.md`    |

If a task touches multiple areas, load multiple references. Trust the routing table.
