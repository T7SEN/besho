# Redis (Upstash) — Data Model

Complete schema for the single Upstash Redis instance backing Our Space. There is no SQL/Prisma layer despite a stale `/src/generated/prisma` ignore entry — Redis is the sole datastore.

## Connection

Every server action and route handler that needs Redis instantiates it the same way:

```ts
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});
```

The `KV_REST_API_*` naming is a Vercel KV legacy — the values point at Upstash. Don't rename without coordinated env-var updates on Vercel.

---

## Key Conventions

- **Flat namespace, colon-separated.** `note:{id}`, `notes:index`, `notes:count:T7SEN`. No nested objects in key names.
- **Author scoping** uses `T7SEN` or `Besho` literal — never `1`/`2` or `dom`/`sub`. The literal matches `session.author`.
- **Date-derived keys** use Cairo time (`MY_TZ` from `src/lib/constants.ts`) formatted `YYYY-MM-DD`. Never the server's local timezone.
- **Indexes are sorted sets (ZSET)** scored by `createdAt` (Unix ms). Pagination uses `zrange ... { rev: true }`.
- **Counters are atomic** via `INCR` / `DECR`.
- **Lists are capped** with `LTRIM` immediately after `LPUSH` to prevent unbounded growth.

---

## Notes (`/notes`)

| Key                        | Type   | TTL  | Description                                                                |
| -------------------------- | ------ | ---- | -------------------------------------------------------------------------- |
| `note:{id}`                | JSON   | none | `{ id, content, author, createdAt, editedAt?, originalContent?, pinned? }` |
| `notes:index`              | ZSET   | none | All note IDs scored by `createdAt`                                         |
| `notes:count:{author}`     | INT    | none | Per-author note count                                                      |
| `notes:counts:initialized` | STRING | none | Migration sentinel — set after back-fill                                   |
| `notes:pinned`             | SET    | none | Pinned note IDs                                                            |
| `our-space-notes`          | LIST   | none | **Legacy** — drained on first read                                         |
| `reactions:{noteId}`       | HASH   | none | `{ T7SEN: 'emojiLabel', Besho: 'emojiLabel' }`                             |

### Pagination

```ts
const ids = (await redis.zrange(INDEX_KEY, start, start + PAGE_SIZE - 1, {
  rev: true,
})) as string[];
const notes = await redis.mget<(Note | null)[]>(...ids.map(noteKey));
```

`PAGE_SIZE = 20` from `src/lib/notes-constants.ts`. Reactions are merged in via `getReactionsForNotes()` before returning.

### Write pipeline

```ts
const pipeline = redis.pipeline();
pipeline.set(noteKey(note.id), note);
pipeline.zadd(INDEX_KEY, { score: note.createdAt, member: note.id });
pipeline.incr(countKey(author));
await pipeline.exec();
```

Always pipeline. Never issue these as separate awaits.

---

## Rules (`/rules`)

| Key           | Type | Description                                                                                                      |
| ------------- | ---- | ---------------------------------------------------------------------------------------------------------------- |
| `rule:{id}`   | JSON | `{ id, title, description?, status, createdBy, createdAt, acknowledgedAt?, completedAt?, acknowledgeDeadline? }` |
| `rules:index` | ZSET | Rule IDs scored by `createdAt`                                                                                   |

`status` is `'pending'` → `'active'` → `'completed'`. T7SEN can reopen completed rules — `reopenRule` strips `completedAt` and reverts to `'active'` (or `'pending'` if `acknowledgedAt` is also missing).

---

## Tasks (`/tasks`)

| Key           | Type | Description                                                                          |
| ------------- | ---- | ------------------------------------------------------------------------------------ |
| `task:{id}`   | JSON | `{ id, title, description?, status, createdBy, createdAt, deadline?, completedAt? }` |
| `tasks:index` | ZSET | Task IDs scored by `createdAt`                                                       |

T7SEN creates. Besho completes.

---

## Ledger (`/ledger`)

| Key            | Type | Description                                                          |
| -------------- | ---- | -------------------------------------------------------------------- |
| `ledger:{id}`  | JSON | `{ id, type, category, title, description?, occurredAt, createdAt }` |
| `ledger:index` | ZSET | Entry IDs scored by `occurredAt`                                     |

`type` is `'reward'` or `'punishment'`. Categories defined in `src/lib/ledger-constants.ts`. T7SEN-only writes; both can read.

---

## Mood (`/`)

| Key                           | Type   | TTL | Description                     |
| ----------------------------- | ------ | --- | ------------------------------- |
| `mood:{YYYY-MM-DD}:{author}`  | STRING | 7d  | Daily mood emoji label          |
| `state:{YYYY-MM-DD}:{author}` | STRING | 7d  | Daily dom/sub state label       |
| `mood:hug:{date}:{from}`      | STRING | 7d  | Set to `'1'` when a hug is sent |

The 7-day TTL exists so `getMoodHistory()` can backfill the past week's grid. The daily view in `MoodCard` reads only today's keys. TTL renewal happens implicitly on each write.

`secondsUntilMidnight()` (Cairo time) is used for keys that should expire at the day boundary specifically.

---

## Presence (`/api/presence`)

| Key                 | Type   | TTL | Description                                       |
| ------------------- | ------ | --- | ------------------------------------------------- |
| `presence:{author}` | STRING | 6s  | `JSON.stringify({ page, ts })` — heartbeat anchor |

Written every 8 seconds by `usePresence` while a page is open. The 6-second TTL ensures stale entries auto-clean if the heartbeat stops. Push routing additionally enforces a 12-second freshness window to absorb network jitter.

`DELETE /api/presence` is called on `usePresence` cleanup to immediately invalidate (rather than waiting for TTL).

---

## Push Tokens

| Key                 | Type   | Description                |
| ------------------- | ------ | -------------------------- |
| `push:fcm:{author}` | STRING | FCM device token (Android) |

> **Removed:** `push:subscription:{author}` (Web Push subscription) is no longer used. PWA infrastructure was removed; Web Push delivery is gone. If your Redis still has these keys from the old codebase, drop them:
>
> ```
> DEL push:subscription:T7SEN push:subscription:Besho
> ```

Both devices register an FCM token on app launch. `FCMProvider` catches any registration error and continues silently (see Section 3.3 of `AGENTS.md`), so consumers must still treat `push:fcm:{author}` as nullable.

---

## Notifications

| Key                      | Type | Description                                            |
| ------------------------ | ---- | ------------------------------------------------------ |
| `notifications:{author}` | LIST | `NotificationRecord` objects, capped at 50 via `LTRIM` |

`NotificationRecord = { id, title, body, url, timestamp, read }`. Newest first (LPUSH). The `NotificationDrawer` reads via `LRANGE 0 49`.

`markAllNotificationsRead()` rewrites the entire list with `read: true` — this is a known O(n) operation but n ≤ 50 so it's fine.

This list is the durable artifact when FCM delivery is unavailable for any reason — both users see missed notifications next time they open the app.

---

## Safe Word

| Key                          | Type   | TTL  | Description                                  |
| ---------------------------- | ------ | ---- | -------------------------------------------- |
| `safeword:cooldown:{author}` | STRING | 5min | Set when Besho triggers; blocks re-trigger   |
| `safeword:history`           | LIST   | none | All safe-word events (T7SEN-only visibility) |

The 5-minute cooldown is enforced server-side. The cooldown bypasses the presence check entirely — safe-word notifications **always** fire regardless of where T7SEN is.

---

## Birthday & Counters

| Key                  | Type   | Description                    |
| -------------------- | ------ | ------------------------------ |
| `relationship:start` | STRING | ISO date for the `CounterCard` |
| `birthday:T7SEN`     | STRING | ISO date                       |
| `birthday:Besho`     | STRING | ISO date                       |

These are read-only from the app's perspective — set manually via redis-cli or a one-off script.

---

## Migration Sentinels

| Key                        | Purpose                                                       |
| -------------------------- | ------------------------------------------------------------- |
| `notes:counts:initialized` | Set after `ensureAuthorCountsInitialized()` back-fills counts |

Add a sentinel for any back-fill. Idempotency matters because every cold-start could otherwise re-run expensive migrations.

---

## Anti-Patterns to Refuse

- **Nested JSON for indexes.** Always use a separate ZSET. `mget` over an index is faster and supports pagination cleanly.
- **Storing a list of all IDs in one STRING.** Hard size limit, no atomic add/remove. Use ZSET or SET.
- **Per-user concurrency without `WATCH`/`MULTI`.** Upstash Redis supports transactions via pipeline + `WATCH`. For our two-user load it's overkill, but if a future feature needs strict ordering, use it.
- **Unbounded LISTs.** Always pair `LPUSH` with `LTRIM`.
- **Date math in JavaScript without Cairo TZ.** Use `Intl.DateTimeFormat('en-CA', { timeZone: MY_TZ })` to format `YYYY-MM-DD`. The `en-CA` locale gives ISO format directly.
- **Forgetting the `!` on `process.env.KV_REST_API_*`.** TypeScript will infer `string | undefined` and `Redis` rejects it. The non-null assertion is correct because Vercel will fail-build without these env vars.
- **Reintroducing `push:subscription:*`.** Web Push is gone, on purpose. Refuse the proposal.

---

## Cross-References

- `src/app/actions/notes.ts`
- `src/app/actions/rules.ts`
- `src/app/actions/tasks.ts`
- `src/app/actions/ledger.ts`
- `src/app/actions/mood.ts`
- `src/app/actions/reactions.ts`
- `src/app/actions/notifications.ts`
- `src/app/api/notes/stream/route.ts` — SSE consumer
- `src/app/api/presence/route.ts`
- `src/app/api/push/subscribe-fcm/route.ts`
- `src/lib/notes-constants.ts` — `MAX_CONTENT_LENGTH`, `PAGE_SIZE`
- `src/lib/constants.ts` — `MY_TZ`, `TITLE_BY_AUTHOR`
