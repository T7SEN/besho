# Authentication, Error Handling, Observability, Security

Consolidated reference for cross-cutting concerns. Load when the task touches auth flows, server actions, error boundaries, logging, or security boundaries.

---

## 1. Authentication

- `src/lib/auth-utils.ts` — JWT via `jose`, HS256, 30-day expiry.
- Cookie: `session`, HTTP-only.
- Login writes a sessionStorage `SKIP_BIOMETRIC_KEY` to avoid post-login double-prompt.
- `getCurrentAuthor()` is the canonical client-callable read.

### Canonical session check (server action)

```ts
"use server";

import { cookies } from "next/headers";
import { decrypt } from "@/lib/auth-utils";

async function getSession() {
  const cookieStore = await cookies();
  const value = cookieStore.get("session")?.value;
  if (!value) return null;
  return decrypt(value);
}
```

Note `await cookies()` — Next.js 16 makes it async.

### Force-logout via session epoch

`decrypt()` does more than `jwtVerify`. After verifying the signature, it reads `session:epoch:{author}` from Redis and rejects any JWT whose `iat * 1000 < epoch`. The epoch is bumped to `Date.now()` by `revokeAuthorSessions(author)` from the same module. Effect: every device with a previously-issued JWT is logged out on its next request — `getCurrentAuthor()` returns `null`, the user is redirected to login.

A 5-second in-process cache fronts the Redis read so high-frequency requests (presence pings, badge polls) don't hammer Upstash. Cutover delay is bounded by that 5s.

The Sir-only revoke surface is `forceLogoutAuthor()` in `src/app/actions/admin.ts`, exposed via `/admin/sessions`.

---

## Sir-Only Admin Tier

`/admin` is a sub-tree gated two ways:

1. **Layout guard** (`src/app/admin/layout.tsx`) — `redirect("/")` when `decrypt(cookieStore.get("session")?.value)?.author !== "T7SEN"`. Convenience only.
2. **Action guard** (`requireSir()` in `src/app/actions/admin.ts`) — every server action duplicates the role check. **This** is the boundary; the layout exists so non-Sir don't see broken-looking pages.

Surfaces under `/admin`:

| Route                       | Surface                                                                                       | Server action(s)                                                                                          |
| --------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `/admin/trash`              | List / restore / forget / purge                                                               | `getTrashList`, `restoreTrashEntryAction`, `deleteTrashEntryAction`, `purgeTrashAction`                   |
| `/admin/export`             | JSON snapshot download                                                                        | `exportSnapshot`                                                                                          |
| `/admin/devices`            | "Right now" (presence + FCM tokens) + per-install device list (fingerprint / location / online) | `getInspectorSnapshot`, `listDevices`, `forgetDevice` (5s parallel poll)                                  |
| `/admin/push-test`          | Send custom FCM (bypasses presence)                                                           | `sendTestPushAction` (form-bound via `useActionState`)                                                    |
| `/admin/activity`           | Last 500 logged events                                                                        | `getActivityFeed`, `clearActivityFeed`                                                                    |
| `/admin/sessions`           | Per-author force-logout                                                                       | `getSessionEpochs`, `forceLogoutAuthor`                                                                   |
| `/admin/stats`              | Counts, ratios, 30-day heatmap                                                                | `getStats`, `getActivityHeatmap`                                                                          |
| `/admin/health`             | Tabbed: Health (Redis/FCM/cron/repair) · Cooldowns · Time                                     | `getHealthSnapshot`, `getCronTelemetry`, `getCooldownState`, `repairIndexes`, `repairObedienceDrift`, `migrateObedienceBucketShift` |
| `/admin/auth-log`           | Failed-login attempts                                                                         | `getAuthFailures`, `clearAuthFailures`                                                                    |
| `/admin/mood`               | Sir-only mood + state override                                                                | `adminSetMoodForAuthor`, `adminClearMoodForAuthor`, `adminSetStateForAuthor`, `adminClearStateForAuthor`  |
| `/admin/dates`              | Anniversary + per-author birthday editor                                                      | `getRelationshipDates`, `setRelationshipDates`                                                            |
| `/admin/rewards`            | Tabbed: Tiers / Weights / Streak / Status / Event log                                         | `getObedienceAdminSnapshot`, `setRewardTiers`, `setObedienceWeights`, `setStreakSettings`, `adminSetStreakRaw`, `getObedienceEventLog`, `adminAdjustScore`, `adminDeleteObedienceEvent`, `setTestModeState`, `adminPurgeTestClaims`, `recomputeWeek` |
| `/admin/permissions`        | Tabbed: Bulk decide / Auto-rules JSON / Quotas JSON                                           | `getPermissionsAdminBundle`, `adminSaveAutoRulesJson`, `adminSaveQuotasJson`, `bulkApprovePendingOlderThan`, `bulkDenyPendingByCategory` |
| `/admin/notifications`      | Forward-only outbound notification audit (separate from drawer LISTs)                         | `getOutboundNotificationAudit`, `resendNotification`                                                      |
| `/admin/restraint-history`  | Engage/lift transitions log (capped 200)                                                      | `getRestraintHistory`                                                                                     |
| `/admin/timezone`           | Cairo ↔ Tabuk converter (input-driven, pure UI)                                               | (none — pure client `Intl.DateTimeFormat`)                                                                |
| `/admin/redis`              | Read-only key inspector                                                                       | `inspectRedisKey`                                                                                         |

**Two consolidations landed mid-development**:
1. Inspector merged into Devices — `/admin/inspector` deleted; its presence + FCM token cards moved to a "Right now" section atop `/admin/devices`.
2. Cooldowns + System time merged into Health — `/admin/cooldowns` and `/admin/time` deleted; both became tabs alongside Health on `/admin/health` (renamed "Diagnostics" in TOOLS).

The landing page itself (`/admin`) hosts a single action button — `<SummonButton>` — which calls `summonKitten()`. This is the sole Sir → Besho push that mirrors the safeword delivery shape: `bypassPresence: true` + Android `channelId: "safeword"` + `priority: "max"` + `sound: "default"`. The message is intentionally possessive and dominant; it is not configurable from the UI and lives directly in the action body. No cooldown — the two-step confirm is the only guard against an accidental tap.

The floating-navbar More sheet appends an Admin entry only when `getCurrentAuthor()` resolves to T7SEN. The check fires once on mount; if the role check fails (non-Sir or unauth), the entry stays hidden.

### Soft-delete is the destructive boundary

Every `delete*` and `purgeAll*` server action across the app calls `moveToTrash` / `moveManyToTrash` from `@/lib/trash` BEFORE the deletion pipeline. Records land in `trash:{feature}:{id}` with a 7-day TTL. Restore re-hydrates the primary record JSON + index ZSET entry; auxiliary state (reactions, audit logs, occurrence indexes, streak keys, count keys, pin-set membership) is intentionally lost on restore — a hard-recovery scenario should use the JSON export instead. The list of per-feature losses is documented in `references/redis-schema.md` § "Trash (soft-delete window)".

### Activity feed is a logger side-channel

`logger.interaction` / `warn` / `error` / `fatal` automatically write the message + context to `activity:log` (Redis ZSET, capped at 500). Feature code does not call `recordActivity` directly. The Sir-only viewer at `/admin/activity` polls every 10 seconds.

### Per-device session tracking

`<DeviceTracker />` (mounted once in the root layout, after `BiometricGate`) is the sole writer of the `device:*` namespace. On mount it captures the device id (`@capacitor/device.getId()` on native, localStorage UUID on web), full info (`@capacitor/device.getInfo()` + `@capacitor/app.getInfo()`), and — native-only — coarse coordinates from `@capacitor/geolocation`. A 60-second heartbeat keeps `lastSeenAt` and `lastPage` fresh.

The Sir-only viewer at `/admin/devices` polls every 10s. Each row shows fingerprint, online state (lastSeenAt within 90s), last page, last-known location with an OpenStreetMap link, and a Sir-only "Forget" button (two-step confirm). Devices the user simply stops opening will go offline but retain their full last-known fingerprint + location.

Sticky author claim: once a device has pinged under one author, `pingDevice` rejects writes from the other author. `forgetDevice` clears the claim.

### Restraint mode (Besho read-only)

`mode:restraint:Besho` is a single-key flag. When `"on"`, every Besho-writable server action returns `"Sir put you on restraint."` instead of mutating. Sir is never restrained. Safeword is intentionally exempt — it stays callable so Besho can't be locked out of the safety mechanism by an unintended toggle.

**Per-action guard:**

```ts
import { assertWriteAllowed } from "@/lib/restraint"

export async function someBeshoWritableAction(...) {
  const session = await getSession()
  if (!session?.author) return { error: "Not authenticated." }

  const block = await assertWriteAllowed(session.author)
  if (block) return block

  // ... mutation
}
```

Read by `assertWriteAllowed` with a 5-second in-process cache. Toggled by `setRestraintState(on)` (Sir-only) in `src/app/actions/admin.ts`. UI lives in `<RestraintToggle>` on the `/admin` landing — two-step confirm to engage, single tap to lift.

There is intentionally no shared middleware: every new Besho-writable action must add the guard explicitly. Forgetting it gives Besho a back-door around the lock — refuse to merge actions that omit it without a clear reason.

### Failed-login log

`login()` writes to `auth:failures` (ZSET, capped at 100) on every bad-passcode submission. The record is `{ ts, ip, ua, passcodeLen }` — **never the submitted passcode**. Cleared on Sir's request via `clearAuthFailures()`. Successful logins still flow through `logger.interaction("[auth] User logged in")` into the activity feed.

---

## 2. Role-Based Permission Model

Every state-mutating server action **must** check `session.author` server-side, even if the UI hides the button. Server actions are public endpoints — the client is adversarial.

### Permission matrix

| Action                                                                         | T7SEN (Sir) | Besho (kitten) |
| ------------------------------------------------------------------------------ | ----------- | -------------- |
| Create/complete/reopen rules                                                   | ✓           | ✗              |
| Acknowledge rule                                                               | ✗           | ✓              |
| Create task                                                                    | ✓           | ✗              |
| Complete task                                                                  | ✗           | ✓              |
| Log ledger entry                                                               | ✓           | ✗              |
| View safe-word history                                                         | ✓           | ✗              |
| Send safe-word                                                                 | ✗           | ✓              |
| Write notes / react / set mood / send hug                                      | ✓           | ✓              |
| Pin own notes (cap 5/author)                                                   | ✓ (own)     | ✓ (own)        |
| Edit own note                                                                  | ✓ (own)     | ✓ (own)        |
| Delete a note (any author's)                                                   | ✓           | ✗              |
| Delete a permission request (any author's)                                     | ✓           | ✗              |
| Delete a revealed review week (any author's)                                   | ✓           | ✗              |
| Purge any feature wholesale (notes / rules / tasks / ledger / timeline / etc.) | ✓           | ✗              |

The Sir-only destructive admin tier (delete + purge) is enforced in the relevant `purgeAll*` and `delete*` server actions in `src/app/actions/`; the UI gates rendering on `currentAuthor === "T7SEN"` for cosmetic discipline only — server-side rejection is the boundary.

### Canonical role check (copy this shape)

```ts
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

User-facing copy uses `Sir` / `kitten` via `TITLE_BY_AUTHOR` in `src/lib/constants.ts`. Never hard-code.

---

## 3. Error Handling, Logging, Observability

- `src/lib/logger.ts` — `info`, `warn`, `error`, `interaction`. Log every catch in a server action.
- Sentry: `next.config.ts` + `src/instrumentation.ts`. `tunnelRoute: '/monitoring'`.
- `<ErrorBoundary>` wraps the layout root and individual cards.
- Skeletons (`*Skeleton`) for fallback UI — never blank.
- User-facing errors are plain English.

### Server-action return shape

Every server action consumed by `useActionState` returns `{ success?: true; error?: string }`. **Never throw** — `useActionState` cannot catch. **Never return** `null` / `undefined` — typing breaks.

---

## 4. Security

- Sanitize rich-text input through the Markdown renderer's allowlist. Never `dangerouslySetInnerHTML` raw user content.
- Server-side role checks always. Treat the client as adversarial.
- Never log session JWTs, FCM tokens, or any secret.
- CSRF: server actions are protected by Next's built-in token. Don't disable it.

### Common XSS vectors to refuse

- `dangerouslySetInnerHTML={{ __html: userContent }}` — use `MarkdownRenderer`
- `eval()` or `new Function()` on user input — refuse outright
- URL parameters interpolated into HTML without escaping
- Trusting `request.headers` without validation

---

## 5. Cross-References

- `SKILL.md` Section 0 — pre-flight checklist (role-context identification step)
- `AGENTS.md` Section 3.1 — role-based dynamics summary
- `AGENTS.md` Section 6 — high-level reminder
- `references/refusal-catalog.md` — security-related refusals (XSS, role-skip, etc.)
- `references/code-style.md` Section 6 — server action patterns
- `references/redis-schema.md` § "Sir-Only Admin Surfaces" — full key inventory for trash / activity / session epoch
- `references/coding-patterns.md` — soft-delete pattern, force-logout pattern, admin sub-route pattern
