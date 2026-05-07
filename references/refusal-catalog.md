# Refusal Catalog

The full table of request patterns that should be refused immediately with a one-line rationale. Do not implement, do not ask for clarification, do not "try a workaround." An abridged version (6 rows) lives in `SKILL.md` Section 3.

---

| Request pattern                                   | Why refuse                                                                          | Alternative to offer                                                      |
| ------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Add a gallery / photo feature                     | Banned feature surface                                                              | Use `/notes` with image embeds (when added)                               |
| Add a bucket list                                 | Banned feature surface                                                              | Use `/timeline` for milestones                                            |
| Re-add PWA / Serwist / service worker             | Removed intentionally; conflicts with `server.url` (`AGENTS.md` Section 3.7)        | None — accept the architectural decision                                  |
| Re-add Web Push / VAPID / `web-push` package      | Removed with PWA; conflicts with `server.url` (`AGENTS.md` Section 3.7)             | None — see `references/push-routing.md`                                   |
| Re-suggest voice notes on `/permissions`          | Prototyped and explicitly removed                                                   | None — text + markdown body covers expressive needs                       |
| Use `==` / `!=` instead of `===` / `!==`          | Coercion masks bugs in this strict-mode codebase                                    | Always use strict equality                                                |
| Use `localStorage` directly                       | Doesn't survive native app updates reliably                                         | `@capacitor/preferences`                                                  |
| Use `window` / `document` / `navigator` directly  | Breaks SSR/Edge runtime                                                             | `globalThis as unknown as { ... }` cast (`references/coding-patterns.md`) |
| Add Redux / Zustand / Jotai / SWR / React Query   | Two-user app; unnecessary complexity                                                | `useState` / `useReducer` / `useContext` / `useOptimistic`                |
| Remove `server.url` to "make it work offline"     | Would break SSE, server actions, instant deploys                                    | Refuse; document the request                                              |
| Hardcode `Sir`/`kitten` strings in JSX            | Vocabulary lives in `TITLE_BY_AUTHOR`                                               | Import from `src/lib/constants.ts`                                        |
| Skip role check because "the UI hides the button" | Server actions are public endpoints; client is adversarial                          | Add `if (session.author !== 'T7SEN')` server-side                         |
| `dangerouslySetInnerHTML` user content            | XSS vector                                                                          | Use `MarkdownRenderer`                                                    |
| Top-level import of `@capacitor/*` plugin         | Inflates web bundle                                                                 | Dynamic `await import('...')` inside `if (isNative()) { ... }`            |
| Top-level import of `firebase-admin`              | Inflates Edge bundle                                                                | Dynamic import inside the function that uses it                           |
| Bump dependency versions in feature work          | Stack is locked                                                                     | Separate ticket / commit                                                  |
| Expose `getAutoRules` to Besho                    | Auto-rules are Sir's private authoring artifacts                                    | Keep server-side `session.author !== "T7SEN"` → return `[]`               |
| Reorder validation in `createPermission`          | Auto-rule must run AFTER quota and BEFORE pending-cap (`references/permissions.md`) | Refuse; explain the UX implications                                       |
| Skip `moveToTrash` in a `delete*` / `purgeAll*` action for "performance" | Defeats the 7-day recovery window the admin trash UI depends on  | Keep the trash call; if hot-path matters, revisit after profiling, not before |
| Modify `decrypt()` to skip the session-epoch check                       | Bypass would silently break the Sessions section on `/admin/devices` force-logout | Keep the read; if perf matters extend the 5s in-process cache               |
| Call `recordActivity` directly from feature code                         | Activity feed is a logger side-channel; direct calls would double-write or skip the cap | Use `logger.interaction` / `warn` / `error` / `fatal` — they drive it    |
| Expose `/admin` routes or admin actions to non-Sir                       | Admin tooling is destructive; client is adversarial                              | Both layout-redirect AND `requireSir()` per action — keep both, never just one |
| Restore a trash entry to a feature's create-action path                  | Re-firing the create action triggers notifications, audit writes, validation     | Use `restoreFromTrash` — sets the record JSON + index ZSET entry directly, no side effects |
| Skip `assertWriteAllowed` on a new Besho-writable action "for performance"          | The per-action guard IS the model — middleware was rejected on purpose          | Add the guard; the helper has a 5s cache so the steady-state cost is negligible           |
| Centralize the restraint check into a single wrapper / decorator                    | Implicit gating hides the security boundary; explicit per-action is by design   | Refuse; keep it explicit                                                                    |
| Log the submitted passcode in `auth:failures` for "easier debugging"                | Export dumps every key; passcode would leak the moment the snapshot is shared   | Keep `passcodeLen` only                                                                     |
| Reuse `auth:failures` for general security events (e.g. CSRF, rate-limit hits)      | Mixed semantics; UI assumes the field shape is login-specific                    | New ZSET per event class                                                                    |
| Restraint should also block safeword                                                | Safeword is the user's safety lever; it must remain callable regardless of mode | Refuse; keep safeword exempt                                                                |

---

## Cross-References

- `SKILL.md` Section 3 — abridged version (top 6 rows)
- `AGENTS.md` Section 12 — decision heuristics that lead here
