<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version (Next.js 16) has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices. `cookies()` and `headers()` return promises. Server Components are the default. Route handlers run on Edge or Node depending on `runtime` exports.

<!-- END:nextjs-agent-rules -->

---

# Our Space — Agent Instructions

This is the canonical agent guide for `github.com/t7sen/our-space` (deployed at `https://t7senlovesbesho.me`, Android package `me.t7senlovesbesho`). It applies to **every AI coding agent** operating in this repository: ChatGPT/Codex, Claude (Claude Code, Claude.ai), Gemini CLI, GitHub Copilot, Cursor, or any other.

The full Skill specification with YAML frontmatter lives in `SKILL.md`. This file is the working summary. Detailed references live in `references/` and are loaded on demand.

---

## 1. Product Context

| Attribute           | Value                                                |
| ------------------- | ---------------------------------------------------- |
| Repository          | `github.com/t7sen/our-space`                         |
| Production URL      | `https://t7senlovesbesho.me`                         |
| Android package     | `me.t7senlovesbesho` (do not change)                 |
| Hosting             | Vercel (web), Capacitor APK (Android)                |
| Architecture        | **Hosted-webapp Capacitor shell** — see Section 3.7  |
| Package manager     | `pnpm` — never npm or yarn                           |
| Users               | Exactly two: `T7SEN` (dom), `Besho` (sub/kitten)     |
| Devices             | T7SEN: Samsung Android. Besho: Honor phone + tablet. |
| Critical constraint | Besho's devices have **no Google Mobile Services**   |

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
- **Native:** Capacitor `^8.3.1` + `@aparajita/capacitor-biometric-auth`, `@capacitor/preferences`, `@capacitor/push-notifications`, `@capacitor/local-notifications`, `@capacitor/haptics`, `@capacitor/clipboard`, `@capacitor/app`, `@capacitor/keyboard`, `@capacitor/network`, `@capacitor/status-bar`, `@capacitor/splash-screen`, `@capawesome/capacitor-badge`
- **Push:** `firebase-admin` (FCM) for Android. **No Web Push. No PWA.**
- **Observability:** Sentry (`@sentry/nextjs`), Vercel Analytics + Speed Insights
- **Build/lint:** ESLint `^9` flat config, `concurrently`, `esbuild`

---

## 3. Architectural Pillars (Summary)

### 3.1 Role-Based Dynamics

Every state-mutating server action **must** check `session.author` server-side, even if the UI hides the button.

- `T7SEN` (Sir): creates rules, marks rules complete, reopens rules, creates tasks, logs ledger entries, views safe-word history.
- `Besho` (kitten): acknowledges rules, completes tasks, sends safe-word.
- Both: write notes, react to notes, set mood/state, send hugs.

User copy uses `Sir` / `kitten` via `TITLE_BY_AUTHOR` in `src/lib/constants.ts`. Never hard-code.

### 3.2 Presence-Aware Push Routing (FCM-Only)

Full algorithm in [`references/push-routing.md`](./references/push-routing.md). Summary:

1. Always `pushNotificationToHistory(target, payload)` first.
2. Read `presence:{author}` (TTL 6s).
3. If recipient is on the target page → **skip push** (SSE handles UI).
4. Otherwise → send via FCM:
   - Foreground (presence exists, different page): data-only payload → in-app `PushToast`.
   - Background/closed: full `notification` payload → OS heads-up banner.

**No Web Push fallback.** If FCM fails (Honor device), notification is logged to history only.

### 3.3 No-GMS Handling

Besho's Honor device has no Google Play Services. `@capacitor/push-notifications` registration **will fail** there. `FCMProvider` (`src/components/fcm-provider.tsx`) catches `registrationError` and logs without throwing.

**Accepted regression:** Besho gets zero background notifications on Honor. The notification is logged to `notifications:Besho` and surfaces via the in-app `NotificationDrawer`, `useNavBadges` red dot, and SSE updates when she's actively in `/notes`. **This is intentional — do not "fix" it by reintroducing PWA/Web Push.** See [`references/capacitor-native.md`](./references/capacitor-native.md).

### 3.4 BiometricGate

`src/components/biometric-gate.tsx` is the primary unlock. Renders a fullscreen overlay above all routes except `UNGUARDED_ROUTES`. Uses `@aparajita/capacitor-biometric-auth` + `@capacitor/preferences`. Cold-start grace period prevents the **Knox/Honor double-prompt loop**. Re-locks after `LOCK_AFTER_MS` background time. Web/desktop falls through (`isNative()` → false).

Do not "simplify" this component. Each ref is load-bearing.

### 3.5 Real-Time via SSE

`/notes` uses Server-Sent Events at `src/app/api/notes/stream/route.ts` (Edge runtime, 45s max stream age, 10s poll, 10s keepalive). The `EventSource` reconnects automatically. Do not introduce websockets without removing SSE first.

### 3.6 Redis (Upstash) Data Model

Single Redis instance. Flat colon-namespaced keys. Full schema in [`references/redis-schema.md`](./references/redis-schema.md). Key conventions:

- `note:{id}`, `notes:index` (ZSET), `notes:count:{author}`, `reactions:{noteId}` (HASH)
- `rule:{id}`, `rules:index` (ZSET)
- `task:{id}`, `tasks:index` (ZSET)
- `ledger:{id}`, `ledger:index` (ZSET)
- `mood:{YYYY-MM-DD}:{author}` (TTL 7d), `state:{YYYY-MM-DD}:{author}`
- `presence:{author}` (TTL 6s)
- `push:fcm:{author}` (FCM token; **no `push:subscription:*`**)
- `notifications:{author}` (LIST, capped at 50)

Always pipeline dependent writes. Use `MY_TZ` (Cairo) from `src/lib/constants.ts` for date-derived keys — never the server's local time.

### 3.7 Hosted-Webapp Capacitor Architecture

**Unusual and intentional.** `capacitor.config.ts` sets:

```ts
server: {
	url: 'https://t7senlovesbesho.me',
	cleartext: false,
}
```

Implications:

- The APK is a **thin native shell**. No bundled web build. On launch, the WebView navigates to the deployed Vercel site.
- All server actions, SSE, route handlers work because the page is served live from Next.js.
- **Deploys are instant.** Push to `main` → both phones see the update on next launch with no APK rebuild.
- **No offline support.** App needs connectivity to load. Mid-session drops degrade via the `useNetwork`-driven offline banner and disabled submit buttons.
- Capacitor plugins still work because they're injected into the WebView regardless of where the page loaded from.

**Do not propose removing `server.url`** to add offline support. The cost (Next.js static export, separate API hosting, dropping SSE) isn't justified for a two-user app. See [`references/capacitor-native.md`](./references/capacitor-native.md) for full rationale.

---

## 4. Critical Coding Patterns

These compile and lint clean but break at runtime, in SSR, or in React 19 strict mode if violated. Detailed examples in [`references/coding-patterns.md`](./references/coding-patterns.md).

- **Browser globals via inline cast:** `(globalThis as unknown as { navigator?: { ... } }).navigator?.vibrate?.(50)`. No `typeof window` guards in new code.
- **Deferred setState in effects:** `setTimeout(() => setState(value), 0)` for state updates inside Capacitor callbacks or post-mount listeners.
- **`vibrate()` is fire-and-forget:** always prefix with `void`. `void vibrate(30, 'light')`.
- **`Date.now()` lazy in render:** `useState(() => Date.now())`, never `useState(Date.now())`.
- **`"use server"` files export only async functions.** Move constants to `src/lib/*-constants.ts`.
- **`cookies()` and `headers()` are async:** `const cookieStore = await cookies()`.
- **Unused params:** prefix with `_` and add `// eslint-disable-next-line @typescript-eslint/no-unused-vars` above the signature.

---

## 5. Code Style

- Tabs. Single quotes. No semicolons (except ASI disambiguation).
- Strict equality (`===` / `!==`) always. Refuse `==` requests.
- 80-column lines. Trailing commas in multiline literals.
- Spaces around infix operators, after keywords, after commas, before function parens.
- `else` on the same line as the closing brace.
- Multiline `if` / `for` always uses braces.
- Always handle `err` in callbacks. No silent swallows except the documented `try { ... } catch { /* proceed */ }` pattern (presence reads).
- No unused variables, no dead code.

---

## 6. Naming Conventions

| Case          | Use for                                         |
| ------------- | ----------------------------------------------- |
| `PascalCase`  | Components, type aliases, interfaces            |
| `kebab-case`  | Directory names, file names                     |
| `camelCase`   | Variables, functions, methods, hooks, props     |
| `UPPER_SNAKE` | Env vars, module-level constants, global config |

- Event handlers: `handleClick`, `handleSubmit`.
- Booleans: `isLoading`, `hasError`, `canSubmit`, `isT7SEN`, `isBesho`, `isNative`, `isOffline`.
- Hooks: `useAuth`, `usePresence`, `useKeyboardHeight`, `useNavBadges`, `useNetwork`.
- Acceptable abbreviations: `err`, `req`, `res`, `props`, `ref`. Spell everything else out.

---

## 7. React + Next.js 16

- Functional components only. Use the `function` keyword for default exports.
- **Default to Server Components.** Add `'use client'` only for: event handlers, browser APIs, local state, effects, Capacitor plugins.
- Compose with shadcn primitives. Don't re-implement Radix.
- Cleanup every `useEffect` that subscribes (Capacitor listeners, EventSource, intervals, timeouts).
- `useCallback` / `useMemo` only when justified.
- Code-split heavy client modules with dynamic `await import('...')` inside async handlers.
- Stable `key` props use entity `id`, never array index.
- `useActionState(action, null)` is the canonical form-submission hook.
- Server actions handle mutations; pair with `revalidatePath` after writes.
- Edge runtime for SSE and lightweight syncs.

---

## 8. TypeScript

- `strict: true`. Don't fight it.
- Prefer `interface` for object shapes. Reach for `Partial`, `Pick`, `Omit`, `Readonly`, `Record`.
- Generics where they earn their keep.
- Type guards (`is X`) for narrowing, not casts.
- `as unknown as { ... }` is reserved for `globalThis` access. Casting application data with `as` is a code smell.

---

## 9. UI & Styling

- **Tailwind v4.** Tokens in `src/app/globals.css` as CSS variables.
- **Dark theme is forced** (`forcedTheme="dark"`). No light-mode variants.
- **Mobile-first.** `FloatingNavbar` is fixed; account for `pb-24` on long pages.
- WCAG AA contrast minimum.
- **Motion:** `motion/react`. Standard entry: `initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}`.

---

## 10. State & Forms

- Local: `useState`, `useReducer` (≥3 related fields), `useContext` (tree-scoped).
- Server: server actions + `revalidatePath`. No SWR, no React Query. `useOptimistic` for optimistic updates.
- Realtime: SSE for `/notes`, polling for badge counts, presence heartbeat for `usePresence`, network status for `useNetwork`.
- **No global store.**
- Forms: uncontrolled `<form action={action}>` + `useActionState`.
- Validation: Zod at every trust boundary.
- Server actions return `{ success?: true; error?: string }`.
- **Submit buttons disable when `isOffline`** so users can't trigger doomed actions.

---

## 11. Error Handling, Logging, Observability

- `src/lib/logger.ts` — `info`, `warn`, `error`, `interaction`. Log every catch in a server action.
- Sentry: `next.config.ts` + `src/instrumentation.ts`. `tunnelRoute: '/monitoring'`.
- `<ErrorBoundary>` wraps the layout root and individual cards.
- Skeletons (`*Skeleton`) for fallback UI — never blank.
- User-facing errors are plain English.

---

## 12. Authentication

- `src/lib/auth-utils.ts` — JWT via `jose`, HS256, 30-day expiry.
- Cookie: `session`, HTTP-only.
- Login writes a sessionStorage `SKIP_BIOMETRIC_KEY` to avoid post-login double-prompt.
- `getCurrentAuthor()` is the canonical client-callable read.

---

## 13. Capacitor / Native

Detailed in [`references/capacitor-native.md`](./references/capacitor-native.md). Summary:

- `isNative()` (`src/lib/native.ts`) is the only sanctioned platform check.
- Plugin imports are dynamic to keep web bundles slim.
- **Hosted-webapp architecture** via `server.url` — Section 3.7.
- Notification channel `default` is created with `vibration: true` and importance 4 to suppress heads-up banners while foregrounded.
- Web is built via Vercel; APK is rebuilt only when Capacitor config or plugins change.
- Keystore: `C:\Users\T7SEN\keys\ourspace.jks`. Never commit.
- **Never change `appId`** (`me.t7senlovesbesho`). Display name (`appName: 'Our Space'`) is what the user reads.

---

## 14. Deployment

Detailed in [`references/deployment.md`](./references/deployment.md). Summary:

- Vercel auto-deploys on push to `main`.
- Required env vars: `AUTH_SECRET_KEY`, `KV_REST_API_URL`, `KV_REST_API_TOKEN`, `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`, `SENTRY_AUTH_TOKEN`.
- **No `VAPID_*` env vars.** Web Push is removed.
- `FIREBASE_PRIVATE_KEY` `\n` literals are intentional — `replace(/\\n/g, '\n')` runs at runtime.
- Sentry org `t7sen-c0`, project `our-space`.
- Bump `versionCode` in `android/app/build.gradle` for every Android release.
- `pnpm-lock.yaml` is committed.

---

## 15. Accessibility

- Full keyboard navigation. Every interactive element is a `button` or `Link`, not a styled `div`.
- `focus-visible:` for keyboard-only focus rings.
- One `h1` per route. Card titles are `h2`/`h3`.
- Respect `prefers-reduced-motion` — Motion's `MotionConfig` reads it; don't override.
- Errors announced with `role="alert"` or visible inline copy near the field.

---

## 16. Security

- Sanitize rich-text input through the Markdown renderer's allowlist. Never `dangerouslySetInnerHTML` raw user content.
- Server-side role checks always. Treat the client as adversarial.
- Never log session JWTs, FCM tokens, or any secret.
- CSRF: server actions are protected by Next's built-in token. Don't disable it.

---

## 17. Documentation

- JSDoc every exported function, hook, type, component prop interface.
- Complete sentences, proper punctuation.
- Code blocks use language hints.
- Update this file and `SKILL.md` when a structural pattern changes.

---

## 18. GitHub & Commits

- Pull and review every push before responding to a session that follows new commits.
- Imperative subject, ≤72 chars, scoped: `notes:`, `rules:`, `push:`, `biometric:`, `ci:`.
- Never `git push --force` on `main`.

---

## 19. Working Agreements

- **Begin every non-trivial response with a plan or architectural overview**, then implementation.
- **Push back on bad ideas.** If asked for `==`, an inline `<style>`, a global Redux store, a Gallery page, a PWA migration, or anything that violates this guide — refuse and explain. Don't sugar-coat.
- **No bugs.** Re-read every block of generated code before presenting.
- Cite the file path and the function/symbol you're editing.
- Prefer React 19 / Next.js 16 idioms over older patterns even if older "still work."
- Tone: formal, direct, technical.

---

## 20. File Map

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

## 21. Decision Heuristics

When in doubt:

1. Does this require offline support? → Refuse. Architecture doesn't allow it (Section 3.7).
2. Will this cause hydration mismatch? → Lazy `useState`, defer `setState`, wrap browser globals.
3. Server-only secret? → Env var, never shipped to client.
4. Respects dom/sub permissions? → Re-check `session.author` server-side.
5. Will this fire a duplicate notification? → Add a presence check.
6. Honor device push delivery? → Accepted regression (Section 3.3); refuse PWA/Web Push reintroduction.
7. Banned (gallery, bucket list)? → Refuse.
8. Violates any rule above? → Refuse and explain.

---

## 22. References

Load on demand:

- [`references/push-routing.md`](./references/push-routing.md) — full FCM routing algorithm
- [`references/redis-schema.md`](./references/redis-schema.md) — every Redis key, type, TTL, access pattern
- [`references/capacitor-native.md`](./references/capacitor-native.md) — Capacitor plugins, hosted-webapp architecture, BiometricGate, no-GMS handling
- [`references/deployment.md`](./references/deployment.md) — Vercel + Android pipelines, env vars, secrets
- [`references/coding-patterns.md`](./references/coding-patterns.md) — runtime-critical patterns with examples
