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

1. **Banned scope check** → Does the request mention `gallery`, `bucket list`, or `voice notes`/audio recording on `/permissions`? If yes → refuse, propose `/notes`/`/timeline`/`/tasks`/`/rules`/`/ledger` for the first two, or text + markdown body for the third.
2. **Architecture conflict check** → Does the request imply offline support, PWA features, service workers, web push, or removing `server.url`? If yes → refuse with rationale from `AGENTS.md` Section 3.7. Do not implement.
3. **Anti-hallucination check** → Read Section 2 below before writing imports or env-var references.
4. **Role-context identification** → Does this involve a state mutation? If yes → identify which author (`T7SEN`/`Besho`) is allowed and ensure server-side role check (`AGENTS.md` Section 3.1; `references/auth-and-security.md`). For `/permissions` specifically, `getAutoRules` is Sir-only and must return `[]` for Besho — don't relax.
5. **Reference routing** → Use the table in `AGENTS.md` Section 13 to decide which `references/*.md` file to load. Don't skim the body when a reference has the answer. For any `/permissions` work, load `references/permissions.md`.
6. **FCM nullability check** → Does this touch push delivery? If yes → treat `push:fcm:{author}` as nullable per `AGENTS.md` Section 3.3, never as guaranteed-present.

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

---

## 2. Things That Do Not Exist (Anti-Hallucination Inventory)

These were removed or never existed. Do not import them, reference them, or write code that uses them. If you find yourself typing one of these — **stop**.

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
| `VoiceNote` type, `voiceNote` field, `MediaRecorder` + `RECORD_AUDIO` permission for `/permissions`   | None — voice notes prototyped on permissions and explicitly removed                     |

If a search result, training memory, or autocomplete suggests one of these — it is wrong for this codebase. This table is also mirrored in `references/anti-hallucination.md` for tools that load reference files but not this one.

---

## 3. Refusal Catalog (Abridged)

Refuse these immediately with a one-line rationale. Do not implement, do not ask for clarification, do not "try a workaround." Full table (14 rows) in `references/refusal-catalog.md`.

| Request pattern                                   | Why refuse                                                 |
| ------------------------------------------------- | ---------------------------------------------------------- |
| Add a gallery / photo feature, or bucket list     | Banned feature surface                                     |
| Re-add PWA / Serwist / service worker             | Removed intentionally; conflicts with `server.url`         |
| Re-add Web Push / VAPID / `web-push` package      | Removed with PWA; conflicts with `server.url`              |
| Re-suggest voice notes on `/permissions`          | Prototyped and explicitly removed                          |
| Use `==` / `!=` instead of `===` / `!==`          | Coercion masks bugs in this strict-mode codebase           |
| Skip role check because "the UI hides the button" | Server actions are public endpoints; client is adversarial |
| Expose `getAutoRules` to Besho                    | Sir-only authoring artifacts; gaming risk                  |
| `dangerouslySetInnerHTML` user content            | XSS vector — use `MarkdownRenderer`                        |

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
