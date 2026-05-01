---
name: our-space
description: Engineering guide for "Our Space" — a private two-user couples app at github.com/t7sen/our-space (deployed t7senlovesbesho.me, Android me.t7senlovesbesho). Use for any work in this repo: features, refactors, bug fixes, code review, deployment, push routing, biometric gate, role-based permissions (T7SEN/dom, Besho/sub), Capacitor/Android builds, Upstash Redis data, server actions, presence/SSE, FCM + Web Push, PWA/Serwist. Trigger on OurSpace, t7senlovesbesho, t7sen/our-space, Tasks/Rules/Ledger/Notes/Mood/SafeWord, FloatingNavbar, BiometricGate, FCMProvider, PushToast, the Honor/no-GMS fallback, or any Next.js 16 + React 19 + Capacitor 8 + Upstash Redis + Firebase Admin + shadcn/ui + Tailwind v4 task. Repo enforces non-obvious patterns: globalThis casts for browser globals, deferred setState in effects, void vibrate, "use server" hygiene, server-side dom/sub role checks, presence-aware push routing. Skipping this skill produces code that breaks on Android, leaks state, or violates the permission model.
---

# Our Space — Engineering Skill

You are operating on **Our Space**, a private, two-user web + Android application with strict role-based dynamics. Every contribution must respect the constraints below. There is no tolerance for "close enough" — the production user base is two people who notice every regression.

---

## 1. Product Context

| Attribute           | Value                                                |
| ------------------- | ---------------------------------------------------- |
| Repository          | `github.com/t7sen/our-space`                         |
| Production URL      | `https://t7senlovesbesho.me`                         |
| Android package     | `me.t7senlovesbesho`                                 |
| Hosting             | Vercel (web), Capacitor APK (Android)                |
| Package manager     | `pnpm` — never npm or yarn                           |
| Users               | Exactly two: `T7SEN` (dom), `Besho` (sub/kitten)     |
| Devices             | T7SEN: Samsung Android. Besho: Honor phone + tablet. |
| Critical constraint | Besho's devices have **no Google Mobile Services**   |

**Banned feature surface.** The following pages/features must **never** be suggested, scaffolded, or referenced in any new work: `gallery`, `bucket list`. If a request implies them, reject the framing and propose an alternative that uses existing surfaces (`/notes`, `/timeline`, `/tasks`, `/rules`, `/ledger`).

---

## 2. Tech Stack (Locked Versions)

These versions are pinned by `package.json`. Do not "upgrade as part of a feature" without an explicit ticket.

- **Runtime:** Next.js `16.2.4`, React `19.2.4`, TypeScript `^5`
- **Styling:** Tailwind CSS `^4` (no `tailwind.config.*`; CSS-first via `globals.css`), `tw-animate-css`, `tailwind-merge`
- **UI:** shadcn/ui (style: `radix-nova`, base color `zinc`, icon library `lucide`), `radix-ui`, `motion` (Framer Motion v12), `next-themes`
- **State / Forms:** native React 19 (`useActionState`, `useTransition`), Zod for validation, no Redux
- **Data:** Upstash Redis (`@upstash/redis`) — sole datastore. There is **no** SQL/Prisma despite a stale `/src/generated/prisma` ignore entry.
- **Auth:** `jose` JWT in an HTTP-only `session` cookie, 30-day expiry, HS256
- **Native shell:** Capacitor `^8.3.1` with `@aparajita/capacitor-biometric-auth`, `@capacitor/preferences`, `@capacitor/push-notifications`, `@capacitor/local-notifications`, `@capacitor/haptics`, `@capacitor/clipboard`, `@capacitor/app`, `@capacitor/keyboard`, `@capacitor/network`, `@capacitor/status-bar`, `@capacitor/splash-screen`, `@capawesome/capacitor-badge`
- **Push:** `firebase-admin` (FCM) for Android, `web-push` (VAPID) as PWA fallback
- **PWA:** Serwist (service worker output to `public/sw*`)
- **Observability:** Sentry (`@sentry/nextjs`, tunnelRoute `/monitoring`), Vercel Analytics + Speed Insights
- **Build/lint:** ESLint `^9` with `eslint-config-next` flat config, `concurrently`, `esbuild`

> **Next.js 16 has breaking changes from your training data.** Before using any Next.js API, confirm against `node_modules/next/dist/docs/` or the official Next.js 16 docs. Do not assume `pages/`, do not assume the old `metadata` shape, do not assume `headers()`/`cookies()` are sync — they return promises. Heed deprecation notices.

---

## 3. Architectural Pillars

### 3.1 Role-Based Dynamics (dom/sub)

Every server action that mutates state **must** check `session.author` and gate on role:

- `T7SEN` is the only author who can: create rules, mark rules completed, reopen rules, create tasks, log ledger entries, view safe-word history.
- `Besho` is the only author who can: acknowledge rules, complete tasks, send safe-word.
- Either can: write notes, react to notes, set mood/state, send hugs.

Gate semantics (canonical):

```ts
const session = await getSession();
if (!session?.author) return { error: "Not authenticated." };
if (session.author !== "T7SEN") {
  return { error: "Only Sir can set rules." };
}
```

User-facing copy uses the relational vocabulary: `Sir` for T7SEN, `kitten` for Besho. These map through `TITLE_BY_AUTHOR` in `src/lib/constants.ts` — never hard-code them.

### 3.2 Presence-Aware Push Routing

The notification path is **non-trivial** and must be preserved across all features that send pushes:

1. **Always** call `pushNotificationToHistory(targetAuthor, payload)` first — history is the source of truth even if delivery fails.
2. Read `presence:{author}` from Redis (TTL 6s, written via `POST /api/presence`).
3. If the recipient's current page **equals** the target URL → **skip the push entirely** (in-app SSE handles UI updates; a push would double-notify).
4. If presence exists but `currentPage !== payload.url` → app is foregrounded → send a **data-only** FCM message; `FCMProvider` intercepts and dispatches an in-app `PushToast`.
5. If no presence → app is backgrounded/closed → send a full FCM `notification` payload so the OS draws the heads-up.
6. If the recipient has no FCM token → fall back to Web Push via VAPID `subscription`.

This is implemented in `src/app/actions/notes.ts::sendPushToUser`, `src/app/actions/rules.ts::sendRuleNotification`, `src/app/actions/mood.ts::sendHugPush`. Every new push path **must** copy this exact shape.

### 3.3 No-GMS Graceful Degradation (Besho's Honor Device)

`@capacitor/push-notifications` will **fail to register** on devices without Google Play Services. `FCMProvider` (`src/components/fcm-provider.tsx`) catches `registrationError` and logs without throwing. **Never** assume an FCM token exists. Always:

1. Try FCM first (Android with GMS, T7SEN's Samsung).
2. Fall back to Web Push via VAPID (Honor + PWA path).
3. Local notifications (`@capacitor/local-notifications`) are used for offline reminders (deadlines), not as a replacement for push.

### 3.4 BiometricGate

`src/components/biometric-gate.tsx` is the primary unlock. Key invariants:

- Renders a fullscreen overlay above all routes except `UNGUARDED_ROUTES`.
- Uses `@aparajita/capacitor-biometric-auth` + `@capacitor/preferences` (key `biometric_enrolled`, `last_unlocked_at`).
- Cold-start grace period prevents the **Knox/Honor double-prompt loop**. `lastAuthEndedAtRef` debounces the prompt for 2s after dismissal.
- Re-locks on `appStateChange` after `LOCK_AFTER_MS` background time.
- Web/desktop falls through immediately (`isNative()` → false → `unavailable`).

Do not "simplify" this component. Each ref is load-bearing.

### 3.5 Real-Time via SSE

`/notes` uses Server-Sent Events at `src/app/api/notes/stream/route.ts` (edge runtime, 45s max stream age, 10s poll, 10s keepalive). The client `EventSource` reconnects automatically. Do **not** introduce websockets without removing SSE first.

### 3.6 Redis (Upstash) Data Model

Single Redis instance. Keys are flat, namespaced by colon:

| Pattern                        | Type      | Purpose                                    |
| ------------------------------ | --------- | ------------------------------------------ |
| `note:{id}`                    | JSON      | Single note                                |
| `notes:index`                  | ZSET      | Note IDs by `createdAt` for pagination     |
| `notes:count:{author}`         | INT       | Per-author counter                         |
| `notes:pinned`                 | SET       | Pinned note IDs                            |
| `reactions:{noteId}`           | HASH      | `{ author: emojiLabel }`                   |
| `rule:{id}`                    | JSON      | Single rule                                |
| `rules:index`                  | ZSET      | Rule IDs by `createdAt`                    |
| `task:{id}` / `tasks:index`    | JSON/ZSET | Tasks                                      |
| `ledger:{id}` / `ledger:index` | JSON/ZSET | Reward/punishment entries                  |
| `mood:{YYYY-MM-DD}:{author}`   | STRING    | Daily mood (TTL 7d)                        |
| `state:{YYYY-MM-DD}:{author}`  | STRING    | Daily dom/sub state (TTL 7d)               |
| `mood:hug:{date}:{from}`       | STRING    | Hug-sent flag                              |
| `presence:{author}`            | STRING    | `{ page, ts }` JSON, TTL 6s                |
| `push:fcm:{author}`            | STRING    | FCM device token                           |
| `push:subscription:{author}`   | JSON      | Web Push subscription                      |
| `notifications:{author}`       | LIST      | Last 50 notification records (LPUSH/LTRIM) |

**Always pipeline** dependent writes:

```ts
const pipeline = redis.pipeline();
pipeline.set(noteKey(note.id), note);
pipeline.zadd(INDEX_KEY, { score: note.createdAt, member: note.id });
pipeline.incr(countKey(author));
await pipeline.exec();
```

Use `MY_TZ` (Cairo) from `src/lib/constants.ts` for any date-derived key. Never use the server's local timezone.

---

## 4. Critical Coding Patterns (Non-Negotiable)

These compile and lint clean but break at runtime, in SSR, or in React 19 strict mode if violated. They are **enforced** — point them out in code review.

### 4.1 Browser globals via inline cast

Direct `window` / `document` / `navigator` references break SSR and Edge runtime. Always:

```ts
const nav = (
  globalThis as unknown as {
    navigator?: { vibrate?: (p: number | number[]) => boolean };
  }
).navigator;
nav?.vibrate?.(50);
```

```ts
(globalThis as unknown as { location: { href: string } }).location.href = url;
```

No `typeof window !== 'undefined'` guards in new code — they're noise next to the typed cast.

### 4.2 Deferred setState in effects

Any `setState` invoked synchronously inside `useEffect` (especially from listeners or Capacitor callbacks) must be wrapped:

```ts
useEffect(() => {
  if (!isNative()) {
    setTimeout(() => setGateState("unavailable"), 0);
    return;
  }
  // ...
}, []);
```

This avoids React 19's "cannot update during render" warnings in concurrent scenarios.

### 4.3 `vibrate()` is fire-and-forget

`vibrate()` returns a promise but callers never `await`. Always prefix with `void`:

```ts
void vibrate(30, "light");
void vibrate([50, 100, 50], "heavy");
```

### 4.4 `Date.now()` in render needs lazy init

Server-rendered timestamps cause hydration mismatches. Use:

```ts
const [now, setNow] = useState(() => Date.now());
```

Not `useState(Date.now())`.

### 4.5 `"use server"` files export only async functions

Adding a non-async export to a `"use server"` module breaks the build. Constants live in plain `lib/*-constants.ts` files. Examples that already exist:

- `src/lib/notes-constants.ts` — `MAX_CONTENT_LENGTH`, `PAGE_SIZE`
- `src/lib/mood-constants.ts` — mood/state option arrays
- `src/lib/reaction-constants.ts` — labeled emoji set
- `src/lib/ledger-constants.ts` — reward/punishment categories

If you find yourself wanting to put a constant in a server-action file, move it to `src/lib/`.

### 4.6 Cookies and headers are async

Next.js 16:

```ts
const cookieStore = await cookies();
const value = cookieStore.get("session")?.value;
```

Never destructure synchronously.

### 4.7 No `_unused` parameters via underscore convention

Use the ESLint disable comment Next's config respects:

```ts
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function DELETE(_req: NextRequest) { ... }
```

Or destructure-rename:

```ts
const { completedAt: _removed, ...rest } = existing;
```

---

## 5. Code Style

- **Indentation:** tabs.
- **Quotes:** single (`'…'`), except when escaping would be worse.
- **Semicolons:** omit unless required for ASI disambiguation.
- **Equality:** strict (`===` / `!==`) **always**. If a user requests `==`, refuse and explain that `==` performs coercion that masks bugs.
- **Trailing commas:** yes, in multiline literals.
- **Line length:** 80 columns.
- **Operator spacing:** spaces around infix operators, after keywords, after commas, before function parens.
- **`else`** stays on the same line as the closing brace.
- Multiline `if` / `for` always uses braces.
- Always handle the `err` parameter in callbacks — never swallow silently except inside the documented `try { ... } catch { /* proceed */ }` pattern (presence reads, etc.).
- No unused variables. No dead code.

---

## 6. Naming Conventions

| Case          | Use for                                                 |
| ------------- | ------------------------------------------------------- |
| `PascalCase`  | Components, type aliases, interfaces                    |
| `kebab-case`  | Directory names, file names (`biometric-gate.tsx`)      |
| `camelCase`   | Variables, functions, methods, hooks, props, properties |
| `UPPER_SNAKE` | Env vars, module-level constants, global config         |

**Specific patterns:**

- Event handlers: `handleClick`, `handleSubmit`
- Booleans: `isLoading`, `hasError`, `canSubmit`, `isT7SEN`, `isBesho`, `isNative`
- Hooks: `useAuth`, `usePresence`, `useKeyboardHeight`, `useNavBadges`
- Acceptable abbreviations: `err`, `req`, `res`, `props`, `ref`. Spell everything else out.

---

## 7. React + Next.js 16 Practices

### 7.1 Components

- Functional only. Define with the `function` keyword, not arrow components for default exports.
- Default to **Server Components**. Add `'use client'` only when one of these is true:
  - Event handlers
  - Browser APIs (`globalThis as unknown as ...`)
  - Local state (`useState`, `useReducer`)
  - Effects (`useEffect`, `useLayoutEffect`)
  - Capacitor plugins (always client)
- Compose with shadcn primitives. Do not re-implement Radix.
- Cleanup every `useEffect` that subscribes (Capacitor listeners, EventSource, intervals, timeouts).

### 7.2 Performance

- `useCallback` for handlers passed to memoized children or used in `useEffect` dep arrays.
- `useMemo` for actually-expensive computation, not for every object literal.
- Avoid inline closures in hot lists (use stable refs).
- Code-split heavy client modules with `await import('...')` inside async handlers/effects (this is how Capacitor plugins are loaded).
- Stable `key` props — use the entity `id`, never the array index.

### 7.3 Data Fetching

- **Server actions** (`'use server'`) for mutations and most reads. Pair with `revalidatePath` after writes.
- Edge runtime route handlers for streaming (SSE) and lightweight syncs.
- Use URL search params for shareable server state.
- `useActionState(action, null)` is the canonical form-submission hook in this codebase.

### 7.4 Built-in Components

Use `next/image`, `next/link`, `next/script`, and the `metadata` / `viewport` exports from `app/*/page.tsx` and `layout.tsx`. Never roll a custom `<head>`.

---

## 8. TypeScript

- `strict: true` is on. Don't fight it.
- Prefer `interface` for object shapes, especially when extension is plausible.
- Reach for utility types (`Partial`, `Pick`, `Omit`, `Readonly`, `Record`).
- Generics where they earn their keep — typed `redis.get<T>` calls, action factories.
- Type guards (`is X`) for narrowing, not casts.
- `as unknown as { … }` is reserved for `globalThis` access. Casting application data with `as` is a code smell.

---

## 9. UI & Styling

- **Tailwind v4 only.** No `tailwind.config.ts`. Tokens live in `src/app/globals.css` as CSS variables; reference them with `bg-primary`, `text-muted-foreground`, etc.
- **Dark theme is forced** (`forcedTheme="dark"` in `ThemeProvider`). Don't add light-mode variants — they'll never run.
- **Mobile-first.** Base classes target mobile; use `md:` for tablet+. The `FloatingNavbar` is fixed and always visible; account for `pb-24` on long pages.
- **Color contrast** must clear WCAG AA. The `text-muted-foreground/40` pattern is widespread but only valid for non-essential metadata.
- **Spacing scale** is the Tailwind default. Don't invent half-step paddings.
- **Motion:** use `motion/react`. Standard entry: `initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}`. Use `layoutId` for filter pills and shared-element transitions.

---

## 10. State Management

- **Local:** `useState` for primitives, `useReducer` when you have ≥3 related fields, `useContext` for tree-scoped shared state (`TooltipProvider`).
- **Server state:** server actions + `revalidatePath`. There is no client cache layer (no SWR, no React Query). If you need optimistic updates, use `useOptimistic` (React 19).
- **Cross-page realtime:** SSE for `/notes`, polling for badge counts (`useNavBadges`), presence heartbeat (`usePresence`).
- **No global store.** Don't introduce Redux, Zustand, or Jotai. The app is small enough that prop drilling + context is correct.

---

## 11. Forms & Validation

- **Forms:** uncontrolled `<form action={action}>` paired with `useActionState`. The `formRef` reset pattern is in `/rules` and `/ledger`.
- **Validation:** Zod schemas for any input that crosses a trust boundary (server actions, route handlers).
- **Error returns:** server actions return `{ success?: true; error?: string }`. The client renders `state?.error` near the submit button.
- **RichTextEditor + MarkdownRenderer:** in-house, used for note/rule/task descriptions. Reuse them; don't pull in TipTap or Lexical.

---

## 12. Error Handling, Logging, Observability

- **Logger:** `src/lib/logger.ts` — methods are `info`, `warn`, `error`, `interaction`. Log every catch in a server action.
- **Sentry:** initialized via `next.config.ts` + `src/instrumentation.ts`. Edge and Node runtimes are wired separately. The `tunnelRoute: '/monitoring'` rewrite **must not** collide with middleware.
- **Error boundaries:** `<ErrorBoundary>` wraps the layout root and individual cards (`WeatherCard`, `QuoteCard`). Wrap any third-party-fed widget you add.
- **Fallback UIs:** never blank. Use the existing `*Skeleton` components (`RuleSkeleton`, `EntrySkeleton`, `WeatherSkeleton`) as templates.
- **User-facing errors:** plain English, not stack traces. The user is your partner, not a developer.

---

## 13. Authentication

- `src/lib/auth-utils.ts` — JWT via `jose`, HS256, 30-day expiry. Payload: `{ isAuthenticated, author, expiresAt }`.
- Cookie name: `session`. Always HTTP-only in production.
- Login flow writes a sessionStorage `SKIP_BIOMETRIC_KEY` so the BiometricGate doesn't double-prompt on the post-login navigation.
- `getCurrentAuthor()` is the canonical client-callable read. Use it everywhere, not direct cookie parsing.
- Logout clears the session cookie + revokes FCM/Web Push subscriptions for that author.

---

## 14. Capacitor / Native Concerns

- **`isNative()`** (`src/lib/native.ts`) is the only sanctioned platform check. Don't sniff user agents.
- **Plugin imports are dynamic** to keep PWA bundles slim:
  ```ts
  if (isNative()) {
    const { Haptics, ImpactStyle } = await import("@capacitor/haptics");
    // ...
  }
  ```
- **Notification channel `default`** is created with `vibration: true` and importance 4 to keep heads-up banners suppressed while the app is foregrounded — our custom `PushToast` is the in-app UI.
- **Android-only build pipeline.** Web is built via Vercel, then Capacitor wraps `android/` for the APK. The `android/` directory is **gitignored**; it's regenerated locally.
- **Keystore:** `C:\Users\T7SEN\keys\ourspace.jks`. Build via Android Studio. Do not check the keystore or its passwords into the repo or `.env*`.

---

## 15. Deployment

- **Web:** Vercel (auto-deploys on push to `main`). Check the deployment dashboard before declaring a feature shipped.
- **Required env vars** (Vercel + local `.env.local`):
  - `AUTH_SECRET_KEY`
  - `KV_REST_API_URL`, `KV_REST_API_TOKEN`
  - `VAPID_EMAIL`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`
  - `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` (the `\n` literals are intentional — `replace(/\\n/g, '\n')` is applied at runtime)
  - `SENTRY_AUTH_TOKEN`, Sentry org `t7sen-c0`, project `our-space`
- **Android:** signed APK, package `me.t7senlovesbesho`, version aligned with `package.json`. Bump `versionCode` in `android/app/build.gradle` for every release.
- **Service worker:** Serwist outputs to `public/sw*` — gitignored, regenerated each build. Never commit them.

---

## 16. Testing

- **Unit:** Jest + React Testing Library (when introduced — repo currently has no test runner wired). Arrange-Act-Assert. Mock Capacitor plugins via the `isNative()` boundary.
- **Integration:** test full user workflows, not implementation details. Prefer `screen.findByRole` over snapshots.
- **Manual smoke before every push:**
  1. Login as both authors.
  2. Verify FloatingNavbar badges update.
  3. Send a note, confirm SSE delivery to the partner tab and PushToast routing.
  4. Acknowledge a rule from Besho's account.
  5. Lock/unlock the BiometricGate from native.

---

## 17. Accessibility

- Full keyboard navigation. Every interactive element is a `button` or `Link`, never a styled `div`.
- Focus rings: don't suppress them globally; use `focus-visible:` for keyboard-only.
- Heading hierarchy: one `h1` per route (the page title). Card titles are `h2`/`h3`.
- Contrast: AA minimum. `text-muted-foreground/40` is acceptable only for non-essential metadata.
- Respect `prefers-reduced-motion` — Motion's `MotionConfig` reads it; don't override.
- Errors are announced with `role="alert"` or visible inline copy near the offending field.

---

## 18. Security

- Sanitize all rich-text input through the Markdown renderer's allowlist. Never `dangerouslySetInnerHTML` raw user content.
- Server actions enforce role checks **server-side**, even if the UI hides the button. Treat the client as adversarial.
- Never log session JWTs, FCM tokens, or VAPID private keys. The logger does not redact — you are responsible.
- Rate-limit safe-word and login endpoints if/when introduced (Upstash supports it natively).
- CSRF: server actions are protected by Next's built-in token. Don't disable it.

---

## 19. Documentation

- **JSDoc** every exported function, hook, type, and component prop interface. Existing examples: `useLocalNotifications`, `vibrate`, `BiometricGate`, `FCMProvider`.
- Complete sentences, proper punctuation.
- Code blocks use language hints (` ```ts `, ` ```tsx `, ` ```bash `).
- Update this `SKILL.md` whenever a structural pattern changes.

---

## 20. GitHub & Commit Hygiene

- Repo: `github.com/t7sen/our-space`. Pull and review every push before responding to a session that follows new commits.
- Commits: imperative subject, ≤72 chars, scoped (`notes:`, `rules:`, `push:`, `biometric:`, `ci:`).
- PRs: not used (solo workflow), but treat every push to `main` as if it were one — verify Vercel preview, run lint, smoke-test on Android.
- Never `git push --force` on `main`.

---

## 21. Working Agreements with the User

- **Begin every non-trivial response with a plan or architectural overview**, then implementation.
- **Push back on bad ideas.** If the user asks for `==`, an inline `<style>`, a global Redux store, a Gallery page, or anything that violates this skill, refuse and explain. Don't sugar-coat.
- **No bugs.** Re-read every block of generated code before presenting it. "Probably works" is a failure.
- **Cite the file.** When changing existing code, name the file path and the function/symbol you're editing.
- **Be forward-thinking.** Prefer React 19 / Next.js 16 idioms over patterns from older majors, even if older patterns "still work."
- **Tone:** formal, direct, technical. The user wants the answer, not warmth.

---

## 22. Quick Reference — Where Things Live

```
src/
├── app/
│   ├── layout.tsx              # Providers, BiometricGate, TopNavbar, FloatingNavbar
│   ├── globals.css             # Tailwind v4 tokens (CSS variables)
│   ├── page.tsx                # Dashboard (cards grid)
│   ├── notes/                  # Notes feature + SSE
│   ├── rules/                  # Rules lifecycle
│   ├── tasks/                  # Tasks
│   ├── ledger/                 # Rewards / Punishments
│   ├── timeline/               # Shared timeline
│   ├── actions/                # Server actions ("use server")
│   │   ├── auth.ts
│   │   ├── notes.ts
│   │   ├── rules.ts
│   │   ├── tasks.ts
│   │   ├── ledger.ts
│   │   ├── mood.ts
│   │   ├── reactions.ts
│   │   └── notifications.ts
│   └── api/
│       ├── presence/route.ts   # POST/DELETE presence heartbeat
│       ├── notes/stream/       # Edge SSE
│       ├── notes/sync/         # Offline-write reconciliation
│       └── push/subscribe-fcm/ # FCM token registration
├── components/
│   ├── biometric-gate.tsx
│   ├── fcm-provider.tsx
│   ├── push-toast.tsx
│   ├── pull-to-refresh.tsx
│   ├── capacitor-init.tsx
│   ├── theme-provider.tsx
│   ├── global-logger.tsx
│   ├── navigation/
│   │   ├── top-navbar.tsx
│   │   └── floating-navbar.tsx
│   ├── dashboard/              # Cards: Mood, Counter, Weather, Moon, Distance, Quote, SafeWord, Birthday
│   └── ui/                     # shadcn primitives + RichTextEditor, MarkdownRenderer, ErrorBoundary
├── hooks/
│   ├── use-presence.ts
│   ├── use-refresh-listener.ts
│   ├── use-local-notifications.ts
│   ├── use-keyboard.ts
│   └── use-nav-badges.ts
├── lib/
│   ├── auth-utils.ts
│   ├── native.ts
│   ├── haptic.ts
│   ├── clipboard.ts
│   ├── logger.ts
│   ├── constants.ts            # MY_TZ, TITLE_BY_AUTHOR
│   ├── notes-constants.ts
│   ├── mood-constants.ts
│   ├── reaction-constants.ts
│   └── ledger-constants.ts
└── instrumentation.ts          # Sentry wiring
```

---

## 23. Decision Heuristics

When in doubt:

1. Does this break Besho's Honor device? → If yes, redesign with Web Push fallback.
2. Will this cause a hydration mismatch? → Use lazy `useState`, defer `setState`, wrap browser globals.
3. Is this a server-only secret? → Env var, never shipped to the client.
4. Does this respect the dom/sub permission model? → Re-check `session.author` on the server.
5. Will this fire a duplicate notification? → Add a presence check.
6. Is this banned (gallery, bucket list)? → Refuse.
7. Does this violate any rule above? → Refuse and explain.

If the answer to (7) is "no" but the user pushes back, hold the line. The rules exist because this codebase has burned through their counterexamples already.
