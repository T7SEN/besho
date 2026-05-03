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

---

## Cross-References

- `SKILL.md` Section 3 — abridged version (top 6 rows)
- `AGENTS.md` Section 12 — decision heuristics that lead here
