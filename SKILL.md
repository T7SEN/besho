---
name: our-space
description: Engineering guide for Our Space — a private two-user couples app at github.com/t7sen/our-space (deployed t7senlovesbesho.me, Android me.t7senlovesbesho). LOAD for ANY task in this repo: features, fixes, review, deployment, push routing, biometric gate, dom/sub permissions, Capacitor, Redis, server actions, presence, SSE. Triggers: OurSpace, t7senlovesbesho, Tasks/Rules/Ledger/Notes/Mood/SafeWord, FloatingNavbar, BiometricGate, FCMProvider, PushToast, Honor device, no-GMS, dom/sub, T7SEN, Besho, Sir, kitten. Stack: Next.js 16, React 19, Capacitor 8, Upstash Redis, Firebase Admin, shadcn/ui, Tailwind v4. Hosted-webapp Capacitor shell — server.url loads t7senlovesbesho.me, NOT bundled (no offline, no PWA). Enforces patterns invisible to training: globalThis casts, deferred setState, void vibrate, server-side role checks, FCM-only push, Cairo TZ keys. Skipping produces code that breaks on Android, leaks state, hallucinates removed deps (Serwist, VAPID, web-push), or violates the dom/sub model.
---

# Our Space — Engineering Skill

You are operating on **Our Space**, a private two-user web + Android application with strict role-based dynamics. The production user base is two people (T7SEN and Besho) who notice every regression. There is no tolerance for "close enough."

---

## 0. Agent Pre-Flight (Run Every Request)

Before writing code or proposing changes, complete this checklist:

1. **Banned scope check** → Does the request mention `gallery` or `bucket list`? If yes → refuse, propose `/notes`/`/timeline`/`/tasks`/`/rules`/`/ledger` instead.
2. **Architecture conflict check** → Does the request imply offline support, PWA features, service workers, web push, or removing `server.url`? If yes → refuse with rationale from Section 3.7. Do not implement.
3. **Anti-hallucination check** → Read Section 2.1 ("Things That Do Not Exist") before writing imports or env-var references.
4. **Role-context identification** → Does this involve a state mutation? If yes → identify which author (`T7SEN`/`Besho`) is allowed and ensure server-side role check (Section 3.1).
5. **Reference routing** → Use the table in Section 6 to decide which `references/*.md` file to load. Don't skim the body when a reference has the answer.
6. **Honor-device implication check** → Does this affect push delivery? If yes → confirm Section 3.3 — Besho's Honor regression is **accepted, not a bug**.

When unsure, ask the user one targeted question rather than guessing. Guessing on this codebase produces runtime failures.

---

## 1. Refusal Catalog

Refuse these immediately with a one-line rationale. Do not implement, do not ask for clarification, do not "try a workaround."

| Request pattern                                   | Why refuse                                                       | Alternative to offer                                           |
| ------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------- |
| Add a gallery / photo feature                     | Banned feature surface                                           | Use `/notes` with image embeds (when added)                    |
| Add a bucket list                                 | Banned feature surface                                           | Use `/timeline` for milestones                                 |
| Re-add PWA / Serwist / service worker             | Removed intentionally; conflicts with `server.url` (Section 3.7) | None — accept the architectural decision                       |
| Re-add Web Push / VAPID / `web-push` package      | Removed with PWA; would not deliver to Honor device anyway       | None — see `references/push-routing.md`                        |
| Use `==` / `!=` instead of `===` / `!==`          | Coercion masks bugs in this strict-mode codebase                 | Always use strict equality                                     |
| Use `localStorage` directly                       | Doesn't survive native app updates reliably                      | `@capacitor/preferences`                                       |
| Use `window` / `document` / `navigator` directly  | Breaks SSR/Edge runtime                                          | `globalThis as unknown as { ... }` cast (Section 4.1)          |
| Add Redux / Zustand / Jotai / SWR / React Query   | Two-user app; unnecessary complexity                             | `useState` / `useReducer` / `useContext` / `useOptimistic`     |
| Remove `server.url` to "make it work offline"     | Would break SSE, server actions, instant deploys                 | Refuse; document the request                                   |
| Hardcode `Sir`/`kitten` strings in JSX            | Vocabulary lives in `TITLE_BY_AUTHOR`                            | Import from `src/lib/constants.ts`                             |
| Skip role check because "the UI hides the button" | Server actions are public endpoints; client is adversarial       | Add `if (session.author !== 'T7SEN')` server-side              |
| `dangerouslySetInnerHTML` user content            | XSS vector                                                       | Use `MarkdownRenderer`                                         |
| Top-level import of `@capacitor/*` plugin         | Inflates web bundle                                              | Dynamic `await import('...')` inside `if (isNative()) { ... }` |
| Top-level import of `firebase-admin`              | Inflates Edge bundle                                             | Dynamic import inside the function that uses it                |
| Bump dependency versions in feature work          | Stack is locked                                                  | Separate ticket / commit                                       |

---

## 2. Tech Stack (Locked Versions)

These versions are pinned by `package.json`. Do not "upgrade as part of a feature."

- **Runtime:** Next.js `16.2.4`, React `19.2.4`, TypeScript `^5`
- **Styling:** Tailwind CSS `^4` (no `tailwind.config.*`; CSS-first via `globals.css`), `tw-animate-css`, `tailwind-merge`
- **UI:** shadcn/ui (style: `radix-nova`, base: `zinc`, icons: `lucide`), `radix-ui`, `motion` (Framer Motion v12), `next-themes`
- **State / Forms:** native React 19 (`useActionState`, `useTransition`, `useOptimistic`), Zod for validation. No Redux, no SWR, no React Query.
- **Data:** Upstash Redis (`@upstash/redis`) — sole datastore.
- **Auth:** `jose` JWT in HTTP-only `session` cookie, HS256, 30-day.
- **Native shell:** Capacitor `^8.3.1` + `@aparajita/capacitor-biometric-auth`, `@capacitor/preferences`, `@capacitor/push-notifications`, `@capacitor/local-notifications`, `@capacitor/haptics`, `@capacitor/clipboard`, `@capacitor/app`, `@capacitor/keyboard`, `@capacitor/network`, `@capacitor/status-bar`, `@capacitor/splash-screen`, `@capawesome/capacitor-badge`
- **Push:** `firebase-admin` (FCM) only. **No Web Push. No PWA. No Serwist.**
- **Observability:** Sentry (`@sentry/nextjs`, tunnelRoute `/monitoring`), Vercel Analytics + Speed Insights
- **Build/lint:** ESLint `^9` flat config, `concurrently`, `esbuild`

> **Next.js 16 deviates from older training data.** `cookies()` and `headers()` return promises. Server Components are the default. Heed deprecation notices.

### 2.1 Things That Do Not Exist (Anti-Hallucination Inventory)

These were removed or never existed. Do not import them, reference them, or write code that uses them. If you find yourself typing one of these, **stop**.

| Removed / nonexistent                                                                                 | Replacement                                                                             |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `@serwist/next`, `@serwist/sw`, `serwist`, `workbox-*`                                                | None — PWA removed                                                                      |
| `web-push` package, `VAPID_*` env vars                                                                | None — Web Push removed                                                                 |
| `navigator.serviceWorker`, `sw.register()`, `public/sw.js`, `public/manifest.json`                    | None                                                                                    |
| `src/lib/offline-notes.ts`, `storePendingNote`, `getPendingNotes`, `removePendingNote`, `PendingNote` | None — IndexedDB queue removed                                                          |
| `/api/notes/sync` endpoint                                                                            | None — only `/api/notes/stream` (SSE) exists in `notes/api/`                            |
| `push:subscription:{author}` Redis key                                                                | `push:fcm:{author}` only                                                                |
| `prisma`, `@prisma/client`, SQL migrations                                                            | Upstash Redis is the sole datastore; `/src/generated/prisma` is a stale gitignore entry |
| Light-mode Tailwind variants                                                                          | Dark theme is forced via `forcedTheme="dark"`                                           |
| `tailwind.config.ts` / `tailwind.config.js`                                                           | Tailwind v4 is CSS-first; tokens live in `src/app/globals.css`                          |
| `pages/` directory, `getServerSideProps`, `getStaticProps`                                            | App Router only                                                                         |

If a search result, training memory, or autocomplete suggests one of these — it is wrong for this codebase.

---

## 3. Architectural Pillars

### 3.1 Role-Based Dynamics (dom/sub)

User-facing copy uses `Sir` for T7SEN and `kitten` for Besho via `TITLE_BY_AUTHOR` in `src/lib/constants.ts`. Never hard-code.

**Permission matrix:**

| Action                                    | T7SEN (Sir) | Besho (kitten) |
| ----------------------------------------- | ----------- | -------------- |
| Create/complete/reopen rules              | ✓           | ✗              |
| Acknowledge rule                          | ✗           | ✓              |
| Create task                               | ✓           | ✗              |
| Complete task                             | ✗           | ✓              |
| Log ledger entry                          | ✓           | ✗              |
| View safe-word history                    | ✓           | ✗              |
| Send safe-word                            | ✗           | ✓              |
| Write notes / react / set mood / send hug | ✓           | ✓              |

**Why server-side checks matter:** the UI hides buttons but server-action endpoints are public. Anyone with a session cookie can POST to them.

**Canonical role check (copy this shape):**

```ts
// Input: a server action that mutates state
// Output: action with role gate

"use server";
export async function createRule(prevState: unknown, formData: FormData) {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };
  if (session.author !== "T7SEN") {
    return { error: "Only Sir can set rules." };
  }
  // ... mutation
  return { success: true };
}
```

### 3.2 Presence-Aware Push Routing (FCM-Only)

**Algorithm summary** (full version: `references/push-routing.md`):

1. Always `pushNotificationToHistory(target, payload)` first — history is source of truth.
2. Read `presence:{author}` (TTL 6s).
3. If recipient is on the target page → **skip push** (SSE handles UI).
4. Otherwise → FCM:
   - Foreground (presence exists, different page): **data-only** payload → `FCMProvider` dispatches in-app `PushToast`.
   - Background/closed: full `notification` payload → OS heads-up banner.

**Critical:** the `notification` field MUST NOT be set in the foreground payload, or Android draws a banner _and_ the in-app toast (double-notify).

### 3.3 No-GMS Handling — Accepted Regression

Besho's Honor device has no Google Mobile Services. `@capacitor/push-notifications` registration **fails there**, and `FCMProvider` catches the error silently. Result: **she receives zero background notifications.**

Surfaces that mitigate this in-app:

- `NotificationDrawer` (bell icon in `TopNavbar`) — reads `notifications:{author}` LIST
- `useNavBadges` red dot on `FloatingNavbar`
- SSE real-time updates when she's actively in `/notes`

This is **intentional and not a bug to fix.** Refuse PWA/Web Push reintroduction proposals. See `references/capacitor-native.md` Section "Why No Web Push" for the full reasoning.

### 3.4 BiometricGate

`src/components/biometric-gate.tsx` is the primary unlock. Each ref is load-bearing:

- `lastAuthEndedAtRef` — 2-second debounce against the **Knox/Honor double-prompt loop**
- `last_unlocked_at` Preference — cold-start grace period
- `LOCK_AFTER_MS` constant — re-lock threshold on `appStateChange`

Do not "simplify" this component without reading `references/capacitor-native.md` Section "BiometricGate."

### 3.5 Real-Time via SSE

`/notes` uses Server-Sent Events at `src/app/api/notes/stream/route.ts` (Edge runtime, 45s max stream age, 10s poll, 10s keepalive). The client `EventSource` reconnects automatically. Do not introduce websockets without first removing SSE.

### 3.6 Redis (Upstash) — Key Patterns

Single Redis instance, flat colon-namespaced keys. Full schema: `references/redis-schema.md`.

```
note:{id}                        JSON
notes:index                      ZSET (score = createdAt)
notes:count:{author}             INT
reactions:{noteId}               HASH
rule:{id} / rules:index          JSON / ZSET
task:{id} / tasks:index          JSON / ZSET
ledger:{id} / ledger:index       JSON / ZSET
mood:{YYYY-MM-DD}:{author}       STRING (TTL 7d)
state:{YYYY-MM-DD}:{author}      STRING (TTL 7d)
presence:{author}                STRING (TTL 6s)
push:fcm:{author}                STRING (FCM token)
notifications:{author}           LIST (capped at 50)
```

**Always pipeline dependent writes.** Sequential awaits leave inconsistent state on partial failure.

```ts
// Input: a multi-step write to a feature
// Output: atomic pipeline

const pipeline = redis.pipeline();
pipeline.set(noteKey(note.id), note);
pipeline.zadd(INDEX_KEY, { score: note.createdAt, member: note.id });
pipeline.incr(countKey(author));
await pipeline.exec();
```

**Date keys use Cairo time** (`MY_TZ` from `src/lib/constants.ts`). Never the server's local timezone — Vercel runs in UTC, the user is in Cairo.

### 3.7 Hosted-Webapp Capacitor Architecture

**This is unusual and intentional.** `capacitor.config.ts`:

```ts
server: { url: 'https://t7senlovesbesho.me', cleartext: false }
```

Implications:

- APK is a **thin native shell**. WebView loads the live Vercel deployment on launch.
- All server actions / SSE / route handlers work because the page is served live.
- **Deploys are instant** — Vercel redeploy = next app launch sees the change. No APK rebuild.
- **No offline support.** Mid-session network drops degrade via the `useNetwork`-driven offline banner and disabled submit buttons.
- Capacitor plugins still work — they're injected into the WebView regardless of where the page loaded from.

**Do not propose removing `server.url`.** The cost (Next.js static export, separate API hosting, dropping SSE) is not justified for a two-user app. Full rationale: `references/capacitor-native.md` Section "Architecture."

---

## 4. Critical Coding Patterns (Examples)

These compile and lint clean but break at runtime, in SSR, or in React 19 strict mode if violated. Each pattern shows wrong → right transformations. Full rationale and 17 patterns total: `references/coding-patterns.md`.

### 4.1 Browser Globals via Inline Cast

```ts
// Input: code that uses navigator/window/document directly
// Output: SSR-safe globalThis cast

// Wrong — breaks in SSR / Edge runtime:
if (navigator.vibrate) navigator.vibrate(50);

// Right:
const nav = (
  globalThis as unknown as {
    navigator?: { vibrate?: (p: number | number[]) => boolean };
  }
).navigator;
nav?.vibrate?.(50);
```

### 4.2 Deferred setState in Effects

```ts
// Input: setState fires synchronously inside a useEffect or Capacitor callback
// Output: deferred via setTimeout(..., 0)

// Wrong — React 19 strict-mode warning:
useEffect(() => {
  if (!isNative()) {
    setGateState("unavailable");
    return;
  }
}, []);

// Right:
useEffect(() => {
  if (!isNative()) {
    setTimeout(() => setGateState("unavailable"), 0);
    return;
  }
}, []);
```

### 4.3 `vibrate()` is Fire-and-Forget

```ts
// Input: vibrate() call in a click handler
// Output: void-prefixed call

vibrate(30, "light"); // wrong — floating promise warning
await vibrate(30, "light"); // wrong — blocks user-visible action
void vibrate(30, "light"); // right
```

### 4.4 `Date.now()` Lazy in Render

```ts
// Input: client component reads Date.now() during render
// Output: lazy initializer

const [now, setNow] = useState(Date.now()); // wrong — hydration mismatch
const [now, setNow] = useState(() => Date.now()); // right
```

### 4.5 `"use server"` Files Export Only Async Functions

Constants belong in `src/lib/*-constants.ts`, not in server-action files. Existing constants files: `notes-constants.ts`, `mood-constants.ts`, `reaction-constants.ts`, `ledger-constants.ts`, `constants.ts`.

### 4.6 `cookies()` and `headers()` are Async (Next.js 16)

```ts
const cookieStore = cookies(); // wrong — Promise has no .get()
const cookieStore = await cookies(); // right
```

### 4.7 Server-Action Return Shape

Every server action consumed by `useActionState` returns `{ success?: true; error?: string }`. Never throw — `useActionState` cannot catch. Never return `null`/`undefined` — typing breaks.

### 4.8 Disable Submit When Offline

```tsx
const { connected } = useNetwork()
const isOffline = !connected
// ...
<Button disabled={isPending || !content.trim() || isOffline || undefined}>
	Save
</Button>
```

Pair with the `useNetwork`-driven offline banner. The banner is informational only — no queueing happens, the user just retries when online.

---

## 5. Code Style Quick Reference

- Tabs. Single quotes. No semicolons (except ASI disambiguation).
- Strict equality always (`===` / `!==`).
- 80-column lines, trailing commas in multiline literals.
- `else` on the same line as the closing brace.
- Multiline `if` / `for` always uses braces.
- No unused variables, no dead code.
- Always handle `err` in callbacks. Documented exception: `try { ... } catch { /* proceed */ }` for presence reads.

**Naming:**

| Case          | Use                                |
| ------------- | ---------------------------------- |
| `PascalCase`  | Components, types, interfaces      |
| `kebab-case`  | Filenames, directories             |
| `camelCase`   | Variables, functions, hooks, props |
| `UPPER_SNAKE` | Env vars, module-level constants   |

- Event handlers: `handleClick`, `handleSubmit`
- Booleans: `isLoading`, `hasError`, `canSubmit`, `isNative`, `isOffline`
- Hooks: `useAuth`, `usePresence`, `useNetwork`, `useNavBadges`
- Acceptable abbreviations: `err`, `req`, `res`, `props`, `ref`. Spell everything else out.

---

## 6. Reference Routing

Load only what the task needs. Each reference is structured for direct lookup.

| Task involves...                                        | Load                             |
| ------------------------------------------------------- | -------------------------------- |
| Push notifications, FCM, presence routing               | `references/push-routing.md`     |
| Redis keys, data shape, pagination, TTLs                | `references/redis-schema.md`     |
| Capacitor plugins, hosted-webapp, BiometricGate, no-GMS | `references/capacitor-native.md` |
| Vercel env vars, APK builds, smoke tests                | `references/deployment.md`       |
| Anything that touches the listed coding patterns        | `references/coding-patterns.md`  |

If a task touches multiple areas, load multiple references. If unsure which one applies, the routing table is right; trust it.

---

## 7. Implementation Quick Reference

Detailed treatment of each item lives in the references above. Key reminders:

- **Components:** functional only, default to Server Components. `'use client'` only for: event handlers, browser APIs, local state, effects, Capacitor plugins.
- **Server actions:** mutations + most reads. Pair with `revalidatePath` after writes.
- **Forms:** uncontrolled `<form action={action}>` with `useActionState`. Submit disables when `isOffline`.
- **Validation:** Zod at every trust boundary.
- **Error handling:** `<ErrorBoundary>` wraps cards. Use `*Skeleton` components for fallback UI — never blank.
- **Logging:** `src/lib/logger.ts` (`info`/`warn`/`error`/`interaction`). Never log JWTs, FCM tokens, or any secret.
- **Sentry:** wired via `next.config.ts` + `src/instrumentation.ts`. Tunnel route `/monitoring`.
- **Auth:** `getCurrentAuthor()` is the canonical client-callable read. JWT in `session` cookie.
- **Capacitor:** `isNative()` from `src/lib/native.ts` is the only sanctioned platform check. Plugin imports are dynamic.
- **A11y:** keyboard navigation, `focus-visible:`, one `h1` per route, AA contrast minimum, respect `prefers-reduced-motion`.
- **Security:** server-side role checks, sanitized rich-text via `MarkdownRenderer`, never `dangerouslySetInnerHTML` raw user content.

---

## 8. Agent Operating Procedure

When this skill triggers, follow this order:

1. **Run Section 0 pre-flight.** Refuse if banned or architecturally incompatible.
2. **State a plan before code** for any non-trivial change. The plan should name the file paths you'll touch and the function/symbol you'll edit.
3. **Load references on demand** per Section 6. Don't rely on memory of patterns when a reference is one tool call away.
4. **Apply Section 4 patterns** to every code change automatically. Re-check before submitting.
5. **Cite file paths** when proposing edits. Format: `src/app/notes/page.tsx::handleFormSubmit`.
6. **Push back on bad ideas, including from the user.** Refuse with rationale; offer alternatives. Do not sugar-coat. Examples:
   - User asks for `==` → refuse, explain coercion.
   - User asks to add Web Push → refuse, point to Section 3.3.
   - User asks to skip a server-side role check → refuse, explain client adversariality.
7. **Surface uncertainty.** If a request is ambiguous, ask one targeted question. Do not invent context.
8. **No bugs.** Re-read every block of generated code before presenting. "Probably works" is a failure mode.
9. **Tone:** formal, direct, technical. The user is solo-developing this. They want answers, not warmth.

When you finish a non-trivial change, suggest the relevant smoke-test step from `references/deployment.md`.

---

## 9. Decision Heuristics (Tie-Breakers)

When two valid approaches exist:

1. Will this require offline support? → Refuse, point to Section 3.7.
2. Will this cause a hydration mismatch? → Use lazy `useState`, defer `setState`, wrap browser globals (Section 4).
3. Server-only secret? → Env var, never shipped to client.
4. Does this respect dom/sub permissions? → Re-check `session.author` server-side (Section 3.1).
5. Will this fire a duplicate notification? → Add a presence check (Section 3.2).
6. Honor device push delivery? → Accepted regression (Section 3.3); refuse PWA reintroduction.
7. Banned (gallery, bucket list)? → Refuse (Section 1).
8. Multiple Redis writes? → Pipeline (Section 3.6).
9. Date-based key? → Cairo time, never UTC (Section 3.6).
10. Capacitor plugin? → Dynamic import, `try/catch`, `isNative()` guard.
11. Violates any rule? → Refuse and explain.

---

## 10. File Map

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
│   │   ├── auth.ts
│   │   ├── notes.ts
│   │   ├── rules.ts
│   │   ├── tasks.ts
│   │   ├── ledger.ts
│   │   ├── mood.ts
│   │   ├── reactions.ts
│   │   └── notifications.ts
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
├── hooks/
│   ├── use-presence.ts
│   ├── use-refresh-listener.ts
│   ├── use-local-notifications.ts
│   ├── use-keyboard.ts
│   ├── use-network.ts          # Drives offline banner
│   └── use-nav-badges.ts
├── lib/
│   ├── auth-utils.ts
│   ├── native.ts               # isNative()
│   ├── haptic.ts
│   ├── clipboard.ts
│   ├── logger.ts
│   ├── constants.ts            # MY_TZ, TITLE_BY_AUTHOR, START_DATE
│   ├── notes-constants.ts
│   ├── mood-constants.ts
│   ├── reaction-constants.ts
│   └── ledger-constants.ts
└── instrumentation.ts          # Sentry
```

---

## 11. References Index

- [`references/push-routing.md`](./references/push-routing.md) — full FCM routing algorithm, presence handshake, failure-mode table
- [`references/redis-schema.md`](./references/redis-schema.md) — every Redis key, type, TTL, access pattern, anti-patterns
- [`references/capacitor-native.md`](./references/capacitor-native.md) — hosted-webapp architecture, plugin matrix, BiometricGate state machine, "Why No Web Push"
- [`references/deployment.md`](./references/deployment.md) — Vercel + Android pipelines, env vars, secrets, smoke-test checklist
- [`references/coding-patterns.md`](./references/coding-patterns.md) — 17 runtime-critical patterns with wrong/right examples
