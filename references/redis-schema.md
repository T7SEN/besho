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

| Key                        | Type   | TTL  | Description                                                                                |
| -------------------------- | ------ | ---- | ------------------------------------------------------------------------------------------ |
| `note:{id}`                | JSON   | none | `{ id, content, author, createdAt, editedAt?, originalContent?, pinned?, pinnedAt? }`       |
| `notes:index`              | ZSET   | none | All note IDs scored by `createdAt`                                                         |
| `notes:count:{author}`     | INT    | none | Per-author note count                                                                      |
| `notes:counts:initialized` | STRING | none | Migration sentinel — set after back-fill                                                   |
| `notes:pinned`             | SET    | none | Pinned note IDs (maintained for cleanup; `note.pinned`/`note.pinnedAt` are read-of-truth)  |
| `our-space-notes`          | LIST   | none | **Legacy** — drained on first read                                                         |
| `reactions:{noteId}`       | HASH   | none | `{ T7SEN: 'emojiLabel', Besho: 'emojiLabel' }`                                             |

### Pinning

- `MAX_PINS_PER_AUTHOR = 5` from `src/lib/notes-constants.ts`. Server enforces on the transition-to-pinned in `togglePinNote`: walks the index, counts the caller's currently-pinned notes via `mget`, refuses with `"You can pin up to 5 notes. Unpin one first."` if at cap.
- `pinnedAt` is set on pin and ignored when `pinned=false`. Used client-side for ordering within an author's pin group (newest pin first); falls back to `createdAt` for legacy records that pre-date the field.
- Render order on the client: T7SEN-pinned (newest pin first) → Besho-pinned (newest first) → unpinned (existing reverse-chronological).

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

## Permissions (`/permissions`)

| Key                                 | Type   | TTL    | Description                                                            |
| ----------------------------------- | ------ | ------ | ---------------------------------------------------------------------- |
| `permission:{id}`                   | JSON   | none   | `PermissionRequest` record (see `references/permissions.md` for shape) |
| `permissions:index`                 | ZSET   | none   | Permission IDs scored by `requestedAt`                                 |
| `permission:reask-block:{bodyHash}` | STRING | varies | Set on denial; cooldown TTL from `DENIAL_REASON_COOLDOWN_HOURS`        |
| `permission:audit:{id}`             | LIST   | none   | Prior decision states. LPUSH'd on re-decide. Capped 20 via `LTRIM`     |
| `permissions:denied-hashes`         | SET    | none   | Body hashes ever denied. Drives the ↺ chip ("Asked again")             |
| `permissions:quotas`                | JSON   | none   | `{ monthlyLimits: {...}, maxPending? }` — single key, Sir-only writes  |
| `permissions:auto-rules`            | JSON   | none   | Ordered array of `AutoDecideRule`. Sir-only readable AND writable      |

### Distinct re-ask mechanisms

The two re-ask keys do different jobs and shouldn't be conflated:

- `permission:reask-block:{bodyHash}` — TTL'd. **Rejects** new requests during cooldown.
- `permissions:denied-hashes` — no TTL. **Marks** new requests with `wasReasked: true` for the ↺ chip; never rejects.

Both are populated together when Sir denies a request (manual or auto). The block expires; the SET membership is forever.

### Body hash function

`bodyHashFor(body)` lowercases, trims, collapses whitespace, then runs FNV-style integer hash to base36. Trivial rewordings (case changes, extra spaces) collide deliberately. Semantic rewording bypasses both mechanisms.

### Quota window

`startOfCairoMonthMs()` uses `Intl.DateTimeFormat` with `Africa/Cairo`, fixed `+02:00` offset. DST-day drift is acceptable for monthly windows. Quota check is on-the-fly: ZRANGE month-window, pipelined GET, filter to approved + matching category. O(N) scan over month records — fine at this scale.

### Audit log

`permission:audit:{id}` captures the OLD state on every re-decide BEFORE overwrite. First decisions (pending → decided) don't log. `getPermissions` pipelines `LLEN` for each record alongside the `GET` to surface `auditCount` in one round-trip.

### Auto-rule privacy

`getAutoRules` returns `[]` for Besho. Rules are Sir's private authoring artifacts. The visible `decidedByRuleId` on Besho's cards renders only an "Auto" chip — no rule details exposed.

Full feature spec, validation order, and decision routing: `references/permissions.md`.

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

| Key                      | Type | Description                                                                                  |
| ------------------------ | ---- | -------------------------------------------------------------------------------------------- |
| `notifications:{author}` | LIST | `NotificationRecord` objects, capped at 50 via `LTRIM`. Per-user drawer; user-clearable      |
| `notifications:audit`    | ZSET | Forward-only send-time audit, capped at 200 via `ZREMRANGEBYRANK`. Sir-only read; not user-mutable |

`NotificationRecord = { id, title, body, url, timestamp, read }`. Newest first (LPUSH). The `NotificationDrawer` reads via `LRANGE 0 49`.

`markAllNotificationsRead()` rewrites the entire list with `read: true` — this is a known O(n) operation but n ≤ 50 so it's fine.

The drawer LIST is the durable artifact when FCM delivery is unavailable for any reason — both users see missed notifications next time they open the app.

### Audit ZSET

`notifications:audit` is a separate, Sir-private forward-only log. Score = `ts` (ms), member = JSON `{ id, to, title, body, url, ts }`. Written from `pushNotificationToHistory` in the same pipeline as the drawer LPUSH so both records share the same `id`. Independent of drawer state — `clearAllNotifications` and the 50-entry LTRIM never touch the audit. Cap of 200 applies via `ZREMRANGEBYRANK 0 -201` after every ZADD. Read via `admin.getOutboundNotificationAudit()`; surfaced on `/admin/notifications`. This is the source-of-truth for "did Sir actually fire push X" — the drawer is mutable user state and not authoritative.

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

## Sir-Only Admin Surfaces

Every namespace below is read or written exclusively by `src/app/actions/admin.ts` (Sir-only via `requireSir()`) plus the helpers in `src/lib/trash.ts`, `src/lib/activity.ts`, and `src/lib/auth-utils.ts`.

### Trash (soft-delete window)

| Key                       | Type   | TTL    | Description                                                          |
| ------------------------- | ------ | ------ | -------------------------------------------------------------------- |
| `trash:{feature}:{id}`    | STRING | 7 days | JSON `TrashEntry` — payload + indexScore + recordKey + indexKey      |
| `trash:index`             | ZSET   | none   | Global index, score = `deletedAt` ms, member = `{feature}::{id}`     |
| `trash:index:{feature}`   | ZSET   | none   | Per-feature index, score = `deletedAt` ms, member = `id`             |

`{feature}` is one of `notes` / `rules` / `tasks` / `ledger` / `permissions` / `rituals` / `timeline` / `reviews` (from `TrashFeature` in `src/lib/trash.ts`).

`TrashEntry` shape (also in `src/lib/trash.ts`):

```ts
interface TrashEntry {
  feature: TrashFeature
  id: string
  label: string          // human-readable preview shown on /admin/trash
  deletedAt: number
  deletedBy: Author
  payload: unknown       // original JSON of the primary record
  indexScore: number     // original score in the feature's index ZSET
  recordKey: string      // e.g. note:{id}
  indexKey: string       // e.g. notes:index
  extraRecords?: { key: string; value: unknown }[]  // additional records (used by reviews — Besho's record sits here)
}
```

**What restore re-creates:** the primary record JSON at `recordKey`, the `extraRecords` (if any), and the index ZSET entry at `(indexKey, indexScore, id)`.

**What restore does NOT re-create** (intentionally lost):

- Notes: reactions (`reactions:{id}`), pinned-set membership (`notes:pinned`), per-author counts (`notes:count:{author}`).
- Permissions: audit log (`permission:audit:{id}`), quotas, auto-rules, denied-hashes (only the `purgeAllPermissions` path nukes those).
- Rituals: occurrence index + per-date occurrence keys, current/longest streak.
- Reviews: only T7SEN's record is in `payload`; Besho's lives in `extraRecords[0]`. The composite trash entry restores both.

The 7-day TTL lives on the per-record JSON key. Index ZSET members are tombstones swept on read by `listTrash` (entries with `mget = null` get `zrem`'d in a best-effort pipeline).

For features with composite IDs, the `TrashEntry.id` joins parts with `:` (e.g. `2026-04-27` for a review week). The global `trash:index` member uses `::` between feature and id to avoid collision with `:`-containing ids.

### Activity feed

| Key            | Type | Cap                  | Description                                         |
| -------------- | ---- | -------------------- | --------------------------------------------------- |
| `activity:log` | ZSET | 500 entries          | score = `Date.now()`, member = JSON `ActivityRecord` |

`ActivityRecord = { at, level, message, context? }`. Levels written: `interaction`, `warn`, `error`, `fatal` (driven from `logger.ts`). Trimmed via `zremrangebyrank("activity:log", 0, -501)` after each write. Read newest-first via `zrange ... { rev: true }` in `getActivity()`.

### Session epoch (force-logout)

| Key                      | Type   | Description                                                              |
| ------------------------ | ------ | ------------------------------------------------------------------------ |
| `session:epoch:{author}` | STRING | Unix ms timestamp of last revoke. Absent / `0` means no revoke ever issued. |

`decrypt()` reads this on every JWT verify (5-second in-process cache per process). If JWT `iat * 1000 < epoch` → reject. Bumped via `revokeAuthorSessions(author)` which writes `Date.now()`. Existing JWTs without bumped epoch remain valid.

### Restraint mode (Besho read-only flag)

| Key                    | Type   | Description                                                  |
| ---------------------- | ------ | ------------------------------------------------------------ |
| `mode:restraint:Besho` | STRING | Present (`"on"`) when Besho is on read-only restraint. Absent otherwise. |
| `restraint:history`    | ZSET   | Capped 200. Score = `ts`, member = JSON `RestraintHistoryEntry` (`{ action, by, ts, reason? }`). Every engage AND lift becomes an entry; reason text persists only on engage |

Read via `assertWriteAllowed(author)` in `src/lib/restraint.ts` (5s in-process cache). Sir is never restrained — the helper short-circuits before the Redis read for `T7SEN`. Safeword is intentionally exempt and stays callable. Toggled from `setRestraintState(on, note?)` (Sir-only) in `src/app/actions/admin.ts`. Each toggle pipelines the flag write + a `ZADD` to `restraint:history` + `ZREMRANGEBYRANK` to keep the cap. Read via `getRestraintHistory(limit)` (Sir-only), surfaced on `/admin/restraint-history`.

**Per-action guard pattern** (every Besho-writable action):

```ts
const block = await assertWriteAllowed(author)
if (block) return block
```

There is no shared middleware. New Besho-writable actions must add the guard explicitly. The covered set today: `mood.submitMood/submitState/sendHug`, `notes.saveNote/editNote/togglePinNote`, `reactions.reactToNote`, `tasks.submitTask`, `rules.acknowledgeRule`, `permissions.createPermission/withdrawPermission`, `rituals.submitOccurrence`, `reviews.submitReview`.

### Failed login log

| Key             | Type | Cap | Description                                                            |
| --------------- | ---- | --- | ---------------------------------------------------------------------- |
| `auth:failures` | ZSET | 100 | Score = `Date.now()`, member = JSON `AuthFailureRecord` (no passcode!) |

`AuthFailureRecord = { ts: number, ip: string \| null, ua: string \| null, passcodeLen: number }`. Written exclusively from `login()` in `src/app/actions/auth.ts` on bad-passcode paths. Trimmed via `zremrangebyrank("auth:failures", 0, -101)` after each write. **Never write the submitted passcode** — only its length, useful for distinguishing fat-finger from bot probing. Read via `getAuthFailures()` (Sir-only); cleared via `clearAuthFailures()` (Sir-only).

### Ritual window-open dedup

| Key                                          | Type   | TTL  | Description                                                            |
| -------------------------------------------- | ------ | ---- | ---------------------------------------------------------------------- |
| `ritual:fcm:sent:{ritualId}:{owningDateKey}` | STRING | 36h  | Set with `SET NX` by the cron when the FCM has fired for this window   |

Written exclusively from `src/app/api/cron/ritual-windows/route.ts`. Hit by cron-job.org every minute (sole trigger; no `vercel.json` cron). The atomic `NX` set is what prevents duplicate fires across overlapping ticks. 36h TTL is comfortably longer than any realistic ritual window. If a tick fails after claiming the dedup key, that window won't retry — accept "no notification" over "two notifications".

### Devices (per-device session tracking)

| Key                        | Type   | Description                                                                            |
| -------------------------- | ------ | -------------------------------------------------------------------------------------- |
| `device:{deviceId}`        | STRING | JSON `DeviceRecord` — fingerprint, platform, model, OS, app version, last seen / page / location |
| `device:list:{author}`     | ZSET   | Per-author registry, score = `lastSeenAt`, member = `deviceId`                          |

`DeviceRecord` shape (from `src/lib/device-types.ts`):

```ts
interface DeviceRecord {
  id: string                   // "native:<Capacitor identifier>" or "web:<uuid>"
  author: Author               // owner (sticky — first author to ping wins)
  platform: "android" | "ios" | "web" | "unknown"
  manufacturer?: string
  model?: string
  osVersion?: string
  appVersion?: string
  fingerprint: string          // human-readable label, built once on first ping
  firstSeenAt: number          // ms
  lastSeenAt: number           // ms — driven by tracker heartbeat
  lastPage?: string            // most recent pathname seen by the tracker
  lastLat?: number             // native-only (no web prompt)
  lastLng?: number
  lastLocationAt?: number
}
```

**Writers:** `pingDevice` in `src/app/actions/devices.ts` is the only writer — called from `<DeviceTracker />` mounted once in the root layout. Initial mount sends full info + native coords; heartbeat (60s) sends just `id` + `page`. The action is idempotent: if a record exists for the id, fields are merged, `lastSeenAt` bumped, and the per-author ZSET re-scored.

**Author claim is sticky.** If a device id has already been seen under one author, `pingDevice` from another author refuses with `"Device claimed by another author."` This prevents account swap on a shared device from polluting the other author's list. `forgetDevice` (Sir-only) clears the claim.

**Online threshold:** `DEVICE_FRESH_MS = 90_000` (one missed heartbeat of grace beyond the 60s tick). The admin UI surfaces this as the `online` / `offline` chip on each row.

---

## Rewards & obedience (`/rewards`, `/admin/rewards`)

Score-based reward system on top of `/ledger` (which stays as Sir's manual log). Score lives per Besho-week, drives a 5-tier ladder Sir authors, claim-and-deliver flow gated on Sir.

| Key                                          | Type   | TTL  | Description                                                                          |
| -------------------------------------------- | ------ | ---- | ------------------------------------------------------------------------------------ |
| `obedience:weights`                          | JSON   | none | `Record<ObedienceEventType, number>` — Sir-tunable points per event. Defaults seeded |
| `obedience:streak-threshold`                 | INT    | none | Displayed-score floor for "high-score week"; default 80                              |
| `obedience:streak-risk-min-deficit`          | INT    | none | Minimum displayed-pts deficit before the Friday streak-at-risk FCM fires; default 1   |
| `obedience:multipliers`                      | JSON   | none | Number array — index = consecutive prior high-score weeks; default `[1, 1.1, 1.2, 1.3]` |
| `obedience:events:{author}:{weekKey}`        | ZSET   | none | Member `{eventType}:{eventId}`, score = points. Member dedup makes retries idempotent |
| `obedience:streak:{author}`                  | INT    | none | Consecutive prior high-score weeks (entering current week)                           |
| `obedience:multiplier:{author}:{weekKey}`    | FLOAT  | none | Frozen multiplier captured at finalize                                               |
| `obedience:finalized:{author}:{weekKey}`     | "1"    | none | Sentinel — set by `finalizeWeek` to make idempotent                                  |
| `obedience:tier-notified:{author}:{weekKey}` | INT    | none | Highest tier-threshold already FCM'd this week — prevents repeat unlock notifications |
| `obedience:audit:{author}:{weekKey}`         | ZSET   | none | Per-emit audit. Score = ms ts; member = `{type}:{eventId}` (matches the events ZSET so a join recovers points). Updated to latest ts on retry |
| `obedience:best-week:{author}`               | JSON   | none | Lifetime record — `{weekKey, displayedScore}` of best single-week ever. Updated at finalize when surpassed                                  |
| `obedience:longest-streak:{author}`          | INT    | none | Lifetime record — longest consecutive high-score streak ever. Updated at finalize when surpassed                                            |
| `obedience:weeks-tracked:{author}`           | INT    | none | Counter — incremented once per finalize. Reflects how many weeks the score system has been observing                                       |
| `obedience:test-mode`                        | "on"   | none | Sir-only flag. When present, `claimReward` accepts the current week (in addition to the immediately prior week) so the full claim → deliver flow can be exercised without ending the week |
| `obedience:bucket-shift-migration:done`      | STRING | none | One-time sentinel set by `migrateObedienceBucketShift`. Stores the `Date.now()` at migration time. Presence makes the migration a no-op on subsequent runs. |
| `review:fcm:opener:{weekDate}`               | "1"    | 25h  | Dedup sentinel for the Saturday review-window-open FCM. Set by `/api/cron/review-window-open` via `SET NX EX`                              |
| `rewards:tiers`                              | JSON   | none | Sir-authored tier catalog — fixed 5 entries, ascending thresholds                    |
| `reward:claim:{id}`                          | JSON   | none | One claim record (one per Besho-week)                                                |
| `rewards:claims:by-author:{author}`          | ZSET   | none | Claim ids scored by `requestedAt` — own history                                      |
| `rewards:claims:pending`                     | ZSET   | none | Pending claims awaiting Sir's deliver/deny                                           |
| `rewards:claims:by-week:{author}:{weekKey}`  | STRING | none | Single claim id per (author, weekKey) — enforces 1-claim-per-week                    |
| `reward:claim:audit:{id}`                    | LIST   | none | Per-claim state-change audit (capped 20 via LTRIM 0 19). Each entry is JSON `{status, changedAt, changedBy, note?}` capturing the prior state pre-mutation. Mirrors `permission:audit:{id}` |
| `reward:claim:nudge-sent:{id}`               | "1"    | 30d  | Sentinel — once the obedience-sweep cron fires the >24h stale-pending nudge for this claim, it sets this with `SET NX EX`. One nudge per claim ever, then the TTL ages it out |
| `streak-risk:fcm:sent:{author}:{weekKey}`    | "1"    | 30h  | Sentinel — once the Friday streak-at-risk FCM has fired for this (author, week), `SET NX EX 30h` is set. Covers the rest of Friday + all of Saturday so cron re-ticks are no-ops |

`weekKey` is the Sunday `YYYY-MM-DD` from `currentReviewWeekDate(now)`; `/rewards` aligns with `/review` weeks.

### Score model

| Default weight | Event                                            | Source                                                              |
| -------------- | ------------------------------------------------ | ------------------------------------------------------------------- |
| +10            | `task_on_time` — submitted on/before deadline    | `tasks.approveTask` (ts = `submittedAt`)                            |
| +4             | `task_late` — submitted after deadline           | same path; flag flipped when `submittedAt > deadline`               |
| −4             | `task_missed` — past deadline, never completed   | `/api/cron/obedience-sweep`                                         |
| +5             | `ritual_on_time` — Besho-owned ritual in window  | `rituals.submitOccurrence`                                          |
| −3             | `ritual_missed` — daily/weekly window closed     | `/api/cron/obedience-sweep` (every_n_days skipped, by design)       |
| +3             | `rule_acked` — within `acknowledgeDeadline`      | `rules.acknowledgeRule`                                             |
| −2             | `rule_unacked` — past deadline, still pending    | `/api/cron/obedience-sweep`                                         |
| +1             | `permission_approved` — manual or auto-approve   | `permissions.decidePermission`, `permissions.createPermission` (auto path) |
| −1             | `permission_reasked` — `denied-hashes` hit       | `permissions.createPermission`, fired per attempt                   |
| +1             | `mood_checkin` — once per day, Besho only        | `mood.submitMood`. State submission is intentionally NOT scored.    |
| −10            | `restraint_engaged` — off → on transition only   | `admin.setRestraintState`                                           |
| −10            | `ledger_punishment` — fires per `/ledger` punishment entry | `ledger.createLedgerEntry` (reward type does NOT emit)        |
| variable       | `manual_adjust` — Sir-supplied points + reason   | `admin.adminAdjustScore` (Sir-only, both authors target)            |

`recordObedienceEvent` is best-effort — failures never break the calling write path. Member `{type}:{eventId}` makes retries idempotent (ZADD overwrites the score).

### Multiplier + tier math

- Displayed score = `round(rawScore * multiplier)`. Multiplier comes from `multiplierForStreak(streakEntering, multipliers[])`. Past weeks use the frozen multiplier captured at finalize.
- Unlocked tier = highest tier with `threshold ≤ displayedScore`.
- Claim window: only the immediately prior week is claimable. Older lapses. `rewards:claims:by-week:*` enforces 1 claim per week.

### Finalization

`finalizeWeek(author, weekKey)` is idempotent — runs once via the sentinel. It:

1. Computes the week score (events × current multiplier).
2. Bumps `obedience:streak:{author}` if displayed ≥ threshold; resets to 0 otherwise.
3. Stores `obedience:multiplier:{author}:{weekKey}` (frozen).
4. Sets `obedience:finalized:{author}:{weekKey}` sentinel.
5. Fires a recap FCM to **both authors** (`📊 Week wrapped — {label}`, body carries score + tier + multiplier + streak fragment). Best-effort — FCM failure does not roll back the finalize. **Two gates**: (a) only fires when the finalized week is the immediately prior week (`shiftWeekKey(currentWeekKey(), -1)`); older weeks caught up after a deploy or long absence finalize silently, since their claim window has already lapsed; (b) empty weeks (zero events) stay silent even when they ARE the immediately prior week.

**Cron-only.** Finalization runs exclusively from `/api/cron/obedience-sweep` (daily). Page reads (`getRewardsBundle`) **must NEVER** call `finalizeWeek` or `catchUpFinalizations` directly — doing so fires recap FCMs as a side-effect, and on a fresh deploy or after a long absence the catch-up walk-back would push 4×2=8 notifications on a single `/rewards` visit. `catchUpFinalizations` remains exported for the cron's use only.

### Tier-unlock notifications

`recordObedienceEvent` fires `maybeNotifyTierUnlock(author, weekKey)` after every **positive** emit (points > 0). The helper compares the current unlocked tier's threshold to the value stored at `obedience:tier-notified:{author}:{weekKey}` and, if higher, sends Besho an FCM (`🏆 {tier.name} unlocked`) and updates the sentinel. Negative emits (and Sir-targeted emits) skip the check — there is no notification for tier-DROP, and Sir is not scored.

### Reward + tier emojis

Both `RewardItem` and `RewardTier` carry an optional `emoji` field (≤8 chars to allow compound emoji). At claim time the live tier and reward emojis are **snapshotted** onto `RewardClaim.tierEmoji` and `RewardClaim.rewardEmoji` so renames/deletes in the catalog don't rewrite history. Default seeds for tiers ship with 🥉 🥈 🥇 🏆 👑.

### Test mode

`obedience:test-mode` is a Sir-only single-string flag (presence === on). When ON:

- `claimReward` accepts the **current week** in addition to the immediately prior week.
- The week itself is **not** finalized as a side-effect — `obedience:streak:*` and `obedience:multiplier:*` stay untouched.
- All other claim rules apply: tier must be reached, no double-claim per week (`rewards:claims:by-week:{author}:{weekKey}` enforces).
- The `/rewards` page renders a `TestModeBanner` and a `CurrentWeekClaimSection` that pre-empts the prior-week section.
- Toggle: `/admin/rewards` → Status tab → Test mode card. 5s in-process cache mirrors the restraint pattern; toggling propagates within the cache window.

**Test claims are flagged.** Claims created via the test path get `testMode: true` set on the `RewardClaim` record. They're filtered out of:
- `listClaimsForAuthor` (so `ClaimHistoryCard` doesn't show them)
- `getRewardsHistory` (so the score history archive doesn't surface them as if real claims)
- `RewardsBundle.priorClaim` (so a leftover test claim from when the prior week was current doesn't trigger the "Last week's claim" path)

They're still readable from `RewardsBundle.currentClaim` (so the test status card renders during the test cycle) and from `readMostRecentPendingClaim` (so Sir can deliver/deny during testing).

**Cleanup.** `adminPurgeTestClaims` (Sir-only) hard-deletes every claim where `testMode === true` OR `weekKey >= currentWeekKey()` (legacy fallback for claims created before the flag existed). Wipes from all three index keys. Surfaced as a "Purge test claims" button in the Test mode card on `/admin/rewards`.

Don't propose a per-author or per-author-and-week test mode — it's a single global Sir-controlled flag for diagnostic flow verification.

### Manual adjustment

`admin.adminAdjustScore({ author, points, reason, weekKey? })` lets Sir grant ad-hoc obedience points outside the canonical event types. Lands as a `manual_adjust` ZSET member with the supplied points value. The `reason` string is **not** stored on the event — it lives in the activity log via `logger.interaction`. `manual_adjust` is excluded from the weights editor in `/admin/rewards` (each emit supplies its points value); the stored `obedience:weights.manual_adjust` is always 0 and unused.

### Per-event deletion

`admin.adminDeleteObedienceEvent({ author, weekKey, type, eventId })` is the Sir-only escape hatch for removing a single emit. Pipelines `ZREM` against both `obedience:events:*` and `obedience:audit:*` for the same member. Score recomputation is implicit — `computeWeekScore` reads the events ZSET fresh on every call, so deleting a `−10` event raises the displayed score by 10 (and vice versa for positive deletions). Idempotent. Surfaced in `/admin/rewards` → Status tab → Event log as a per-row trash button (two-tap confirm). **Caveat**: deleting events from a finalized past week does NOT roll back the streak counter or unfreeze the stored multiplier — those captured the at-finalize state and are immutable history. Removals are most meaningful for the current (unfinalized) week.

### Optional event note

`recordObedienceEvent` and `recordObedienceEventForWeek` accept an optional last-arg `note?: string`. When non-empty, the helper fires `logger.interaction("[obedience] event", { author, type, eventId, weekKey, points, note })` after the ZSET pipeline; the note **never** lands on the ZSET member, so dedup on `{type}:{eventId}` is unaffected. Currently used by `admin.setRestraintState(on, note?)` so Sir can leave context like *"engaged for ignoring rule X"* — surfaced in `/admin/activity`. Mirrors the `manual_adjust` reason pattern.

### Streak-at-risk FCM (Friday only)

`/api/cron/obedience-sweep` runs once per day. On any Cairo Friday (`weekdayOfDateKey(today) === 5`), it computes Besho's current-week score and fires a single nudge FCM to her if all of these hold:

- `streak > 0` (she has something to lose)
- `displayedScore < streakThreshold` (she's below the bar)
- `streakThreshold - displayedScore >= streakRiskMinDeficit` (deficit large enough to be worth nudging)

Body shape: `"You're {N} pts behind your streak. {D} days left."` where `D = 7 - weekdayCairo(today)` (Friday = 2 days remaining including today). Sentinel: `streak-risk:fcm:sent:{author}:{weekKey}` via `SET NX EX 30h` — atomic, so a re-tick on the same Friday is a no-op. The week itself is not mutated; this is purely a notification side-channel.

`obedience:streak-risk-min-deficit` is the Sir-tunable knob (default 1, raised to suppress trivial nudges) — surfaced in the Streak tab on `/admin/rewards`. Rejecting min-deficit `< 1` is the only validation; there's no upper alert UI, just the constant `MAX_STREAK_RISK_MIN_DEFICIT` from `reward-types.ts`.

### Stale pending claim nudge

Same cron walks `rewards:claims:pending` ZSET with `byScore: 0..now-24h` and fires one nudge FCM to Sir per stale claim (`STALE_CLAIM_NUDGE_HOURS = 24`). Body: `"kitten's {tier} claim ({reward}) has been pending {N}h."` Sentinel: `reward:claim:nudge-sent:{claimId}` via `SET NX EX 30d` — one nudge per claim ever. Test-mode claims are skipped. Decided claims (status !== "pending") are also defensively skipped even though the pending ZSET should reflect status.

Both nudges live in the existing `obedience-sweep` cron — no new cron-job.org entry. Counts surface in `cron:last-run:obedience-sweep` summary as `streakRiskFired` (0 or 1) and `staleClaimsNudged` (N).

### Audit/events ZSET drift repair

`obedience.repairObedienceZsetDrift(author, weekKey)` reconciles the events + audit ZSETs when a half-failed write left one populated and the other not. Members in `events:` but missing from `audit:` are re-added with score = now (best timestamp available). Members in `audit:` but missing from `events:` are removed (no points to recover, so the audit row would render as missing-points). Idempotent. The all-week sweep `repairAllObedienceZsetDrift(weeks=4)` walks both authors over current + prior 4 weeks. Sir-only via `admin.repairObedienceDrift()`, surfaced as a button in `/admin/health`.

---

## Cron telemetry

| Key                    | Type   | TTL    | Description                                                                          |
| ---------------------- | ------ | ------ | ------------------------------------------------------------------------------------ |
| `cron:last-run:{name}` | JSON   | 7 days | `{ ts, ok, durationMs, summary?, error? }` written at the end of every cron tick     |

`{name}` is one of `obedience-sweep` / `ritual-windows` / `review-window-open`. Written from `src/lib/cron-telemetry.ts::writeCronTelemetry(name, payload)` in BOTH the success and catch paths of each `/api/cron/*` route. Best-effort: telemetry never breaks the calling cron. The 7-day TTL means a cron that hasn't fired in over a week reads as "never run" rather than a stale snapshot — that's the alert signal.

Sir reads via `admin.getCronTelemetry()`, surfaced on `/admin/health` as a "Cron last runs" section. Per-cron freshness thresholds (5 min for ritual-windows, 26h for the daily crons) drive the ok/error rendering. This closes the visibility hole that made the earlier FCM-spam debug feel blind.

---

## Trash retention

Default 7 days. Sir-editable via `trash:retention-days` (STRING int, range 1–90). Read at every `moveToTrash` / `moveManyToTrash` call through the 5s in-process cache in `@/lib/trash`. Changing the value affects **only future deletions** — Redis TTLs are set at SET time and not recomputed retroactively.

| Key                      | Type   | Description                                                |
| ------------------------ | ------ | ---------------------------------------------------------- |
| `trash:retention-days`   | INT    | Sir-set TTL for trash entries (1-90 days). Default 7.      |

UI: `/admin/trash` carries a "Retention (days)" dial at the top of the page.

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
- **Reading `permissions:auto-rules` for Besho.** Sir-only by design — `getAutoRules` returns `[]` for non-Sir. Don't relax this; rules are private authoring artifacts.
- **Conflating `permission:reask-block:*` and `permissions:denied-hashes`.** They have different TTL semantics and different jobs (reject vs mark). Don't merge.
- **Hard-deleting via `del` from a `delete*` / `purgeAll*` action.** All destructive actions go through `moveToTrash` / `moveManyToTrash` first. Skipping the trash step for "performance" defeats the recovery window. If you want a non-recoverable purge, use `deleteTrashEntryAction` / `purgeTrashAction` from `/admin/trash` after the trash window has populated.
- **Re-implementing `decrypt` without the epoch check.** Single source of truth lives in `src/lib/auth-utils.ts`. Do not bypass it via raw `jwtVerify` — force-logout depends on the read.
- **Calling `recordActivity` from feature code.** It's a logger side-channel; let `logger.interaction` / `warn` / `error` / `fatal` drive it. Direct calls would double-write or skip the cap.
- **Calling `pingDevice` from feature code.** The `<DeviceTracker />` mounted in the root layout owns every write to `device:*`. Feature components don't ping. If a feature thinks it needs to update last-seen state, the answer is presence (`presence:{author}`), not the device record.
- **Skipping `assertWriteAllowed` on a new Besho-writable action.** Every Besho-write entry point checks restraint. There is no middleware; the guard is per-action by design. Skipping it gives Besho a back-door around the lock.
- **Logging the submitted passcode in `auth:failures`.** The record stores `passcodeLen` only. Even on a 2-user app with fixed passcodes, never write the value — the export tool dumps every key.
- **Re-reading `mode:restraint:Besho` directly inside an action.** Use `assertWriteAllowed`; it caches and centralizes the rule (e.g., Sir always passes).
- **Calling `recordObedienceEvent` from non-feature code.** It belongs at the natural action site (e.g. `tasks.approveTask`, `rules.acknowledgeRule`). Don't call it from UI code, components, or hooks. The cron sweep (`/api/cron/obedience-sweep`) owns the missed-event emissions; don't duplicate them in feature code.
- **Bypassing `assertWriteAllowed` in `claimReward`.** Claiming is a Besho-write; the restraint guard applies regardless of intuition. Same per-action pattern as the rest of the codebase.
- **Hard-deleting reward claims.** Claims are append-only audit history. There is no `delete*` action exposed; don't add one. If admin cleanup is ever needed, route through `/admin/trash`-style soft-delete first.

---

## Cross-References

- `src/app/actions/notes.ts`
- `src/app/actions/rules.ts`
- `src/app/actions/tasks.ts`
- `src/app/actions/ledger.ts`
- `src/app/actions/mood.ts`
- `src/app/actions/reactions.ts`
- `src/app/actions/notifications.ts`
- `src/app/actions/permissions.ts` — full permissions surface (see `references/permissions.md`)
- `src/app/api/notes/stream/route.ts` — SSE consumer
- `src/app/api/presence/route.ts`
- `src/app/api/push/subscribe-fcm/route.ts`
- `src/lib/notes-constants.ts` — `MAX_CONTENT_LENGTH`, `PAGE_SIZE`
- `src/lib/permissions-constants.ts` — categories, denial reasons, cooldowns, `AutoDecideRule`, `MAX_AUTO_RULES`
- `src/lib/constants.ts` — `MY_TZ`, `TITLE_BY_AUTHOR`
- `src/lib/trash.ts` — soft-delete helper (`moveToTrash`, `moveManyToTrash`, `restoreFromTrash`, `listTrash`, `purgeTrash`, `TRASH_FEATURE_LABELS`)
- `src/lib/activity.ts` — `recordActivity` (driven by logger), `getActivity`, `clearActivity`
- `src/lib/auth-utils.ts` — `revokeAuthorSessions`, `readAllSessionEpochs`, in-process epoch cache (5s TTL)
- `src/app/actions/admin.ts` — every Sir-only admin surface call (inspector, push test, sessions, export, trash list/restore/purge, activity feed, device list)
- `src/app/actions/devices.ts` — `pingDevice` (any authenticated user, own device only), `forgetDevice` (Sir-only)
- `src/lib/device-types.ts` — `DeviceRecord`, `PingDeviceInput`, `DEVICE_FRESH_MS`
- `src/lib/device-id.ts` — `getOrCreateDeviceId`, `buildFingerprint`
- `src/components/device-tracker.tsx` — mounted once in `src/app/layout.tsx` after `BiometricGate`
- `src/lib/restraint.ts` — `assertWriteAllowed`, `isRestrained`, `setRestraintRaw`, `readRestraintRaw`
- `src/app/actions/admin.ts` — `getStats`, `getHealthSnapshot`, `repairIndexes`, `getActivityHeatmap`, `adminSetMoodForAuthor`, `adminClearMoodForAuthor`, `getRelationshipDates`, `setRelationshipDates`, `getAuthFailures`, `clearAuthFailures`, `getRestraintState`, `setRestraintState`, `getRewardTiers`, `setRewardTiers`, `getObedienceWeights`, `setObedienceWeights`, `getStreakSettings`, `setStreakSettings`, `recomputeWeek`, `getObedienceAdminSnapshot`, `adminSetStreakRaw`, `adminAdjustScore`, `getObedienceEventLog`, `adminDeleteObedienceEvent`, `getTestModeState`, `setTestModeState`, `adminPurgeTestClaims`, `inspectRedisKey`, `getDeployInfo`, `getTrashRetention`, `setTrashRetention`
- `src/lib/obedience.ts` — `recordObedienceEvent`, `recordObedienceEventForWeek`, `getWeekState`, `computeWeekScore`, `currentWeekKey`, `finalizeWeek`, `catchUpFinalizations`, `getEventLog`, `deleteObedienceEvent`, weight/tier/streak/multiplier read+write helpers (5s in-process cache mirroring `restraint.ts`)
- `src/lib/reward-types.ts` — `ObedienceEventType`, `RewardTier`, `RewardItem`, `RewardClaim`, `ObedienceWeights`, `ObedienceWeekState`, default seeds + validation bounds
- `src/app/actions/rewards.ts` — `getRewardsBundle`, `getRewardsHistory`, `getLifetimeStats`, `claimReward`, `deliverClaim`, `denyClaim`, `revokeClaim`, `acknowledgeClaim`, `getClaimAudit`, `listAllClaims`, `listPendingClaims`, `listClaimsForAuthor`, `bulkDeliverPending`, `bulkDenyOlderThan`, `previewMultiplierForStreak`, `purgeTestClaimsRaw`
- `src/app/api/cron/obedience-sweep/route.ts` — daily missed-event sweep + week finalization; bearer-auth, no `vercel.json`
