# Things That Do Not Exist — Anti-Hallucination Inventory

This file mirrors `SKILL.md` Section 2. Loaded on demand by tools that read reference files but not the skill body. Always cross-check before writing imports or env-var references.

---

## Removed Dependencies

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

---

## Why This File Exists

Training data for current LLMs predates several intentional removals from this codebase. Common autocompletion failures:

- Importing `web-push` because the agent saw a notification helper and pattern-matched on Web Push tutorials.
- Writing `import { Serwist } from '@serwist/next'` because the agent inferred PWA support from the Capacitor presence.
- Referencing `process.env.VAPID_PUBLIC_KEY` because the agent assumed Web Push must be configured.
- Reading from `pages/api/...` because the agent's training cutoff predates App Router maturity.

Every entry above produces a runtime failure or a bundle that won't compile. Stop the moment you find yourself typing one.

---

## Cross-References

- `SKILL.md` Section 2 — same table, mirrored for the skill-loading path
- `AGENTS.md` Section 2 — high-level reminder
- `references/deployment.md` — env var list (no `VAPID_*`)
- `references/redis-schema.md` — key list (no `push:subscription:*`)
