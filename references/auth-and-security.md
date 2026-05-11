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

The Sir-only revoke surface is `forceLogoutAuthor()` in `src/app/actions/admin.ts`, exposed via the "Sessions" section on `/admin/devices` (formerly the standalone `/admin/sessions` page).

---

## Sir-Only Admin Tier

`/admin` is a sub-tree gated two ways:

1. **Layout guard** (`src/app/admin/layout.tsx`) — `redirect("/")` when `decrypt(cookieStore.get("session")?.value)?.author !== "T7SEN"`. Convenience only.
2. **Action guard** (`requireSir()` in `src/app/actions/admin.ts`) — every server action duplicates the role check. **This** is the boundary; the layout exists so non-Sir don't see broken-looking pages.

Surfaces under `/admin`:

| Route                       | Surface                                                                                       | Server action(s)                                                                                          |
| --------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `/admin/export`             | JSON snapshot download                                                                        | `exportSnapshot`                                                                                          |
| `/admin/devices`            | "Right now" (presence + FCM tokens) + Sessions (force-logout) + per-install device list      | `getInspectorSnapshot`, `getSessionEpochs`, `forceLogoutAuthor`, `listDevices`, `forgetDevice`            |
| `/admin/push-test`          | Send custom FCM (Daddy/Kitten/Both recipient) + 12 tap-to-fill presets                        | `sendTestPushAction` (form-bound via `useActionState`; "Both" fans out via `Promise.allSettled`)          |
| `/admin/logs`               | Tabbed: Activity (level filter) / Outbound / Restraint / Auth failures (IP filter)            | `getActivityFeed`, `clearActivityFeed`, `getOutboundNotificationAudit`, `resendNotification`, `getRestraintHistory`, `getAuthFailures`, `clearAuthFailures` |
| `/admin/stats`              | Counts, ratios, 30-day heatmap                                                                | `getStats`, `getActivityHeatmap`                                                                          |
| `/admin/health`             | Tabbed: Health (Redis/FCM/cron/time-integrity/repair) · Cooldowns · Time (snapshot + converter) | `getHealthSnapshot`, `getCronTelemetry`, `getCooldownState`, `repairIndexes`, `repairObedienceDrift`, `reconcileFeatureIndexes`, `reconcilePendingRewardClaims`, `pruneOrphanedReactions`, `pruneOrphanedRitualOccurrences`, `migrateObedienceBucketShift` |
| `/admin/trash`              | List / restore / forget / purge with multi-select bulk ops                                    | `getTrashList`, `getTrashRetention`, `restoreTrashEntryAction`, `deleteTrashEntryAction`, `purgeTrashAction`, `setTrashRetention` |
| `/admin/mood`               | Sir-only mood + state override                                                                | `adminSetMoodForAuthor`, `adminClearMoodForAuthor`, `adminSetStateForAuthor`, `adminClearStateForAuthor`  |
| `/admin/dates`              | Anniversary + per-author birthday editor                                                      | `getRelationshipDates`, `setRelationshipDates`                                                            |
| `/admin/rewards`            | Tabbed: Tiers / Weights / Streak / Status (with score simulator) / Event log                  | `getObedienceAdminSnapshot`, `setRewardTiers`, `setObedienceWeights`, `setStreakSettings`, `adminSetStreakRaw`, `getObedienceEventLog`, `adminAdjustScore`, `adminDeleteObedienceEvent`, `setTestModeState`, `adminPurgeTestClaims`, `recomputeWeek` |
| `/admin/permissions`        | Tabbed: Bulk decide / Auto-rules JSON / Quotas JSON / Simulate                                | `getPermissionsAdminBundle`, `adminSaveAutoRulesJson`, `adminSaveQuotasJson`, `bulkApprovePendingOlderThan`, `bulkDenyPendingByCategory`, `simulateAutoRules` |
| `/admin/redis`              | Read-only key inspector                                                                       | `inspectRedisKey`                                                                                         |

**Five consolidations landed mid-development**:
1. Inspector merged into Devices — `/admin/inspector` deleted; its presence + FCM token cards moved to a "Right now" section atop `/admin/devices`.
2. Cooldowns + System time merged into Health — `/admin/cooldowns` and `/admin/time` deleted; both became tabs alongside Health on `/admin/health` (renamed "Diagnostics" in TOOLS).
3. Timezone converter merged into Health → Time tab — `/admin/timezone` deleted; the input-driven Cairo↔Tabuk converter sits below the live time snapshot in the Time tab.
4. Sessions merged into Devices — `/admin/sessions` deleted; force-logout buttons live as a "Sessions" section between "Right now" and "Registered devices" on `/admin/devices`.
5. Logs cluster — `/admin/activity`, `/admin/notifications`, `/admin/restraint-history`, `/admin/auth-log` deleted and folded into `/admin/logs` as four tabs (Activity / Outbound / Restraint / Auth failures). Each tab body owns its own data fetch and subscribes to `useRefreshListener`; the page header's Refresh button dispatches a single `ourspace:refresh` event so all four tabs refetch in parallel. Rationale: all four were append-only chronological event streams with the same UX shape.

The landing page itself (`/admin`) hosts a single action button — `<SummonButton>` — which calls `summonKitten()`. This is the sole Sir → Besho push that mirrors the safeword delivery shape: `bypassPresence: true` + Android `channelId: "safeword"` + `priority: "max"` + `sound: "default"`. The message is intentionally possessive and dominant; it is not configurable from the UI and lives directly in the action body. No cooldown — the two-step confirm is the only guard against an accidental tap.

The floating-navbar More sheet appends an Admin entry only when `getCurrentAuthor()` resolves to T7SEN. The check fires once on mount; if the role check fails (non-Sir or unauth), the entry stays hidden.

### Soft-delete is the destructive boundary

Every `delete*` and `purgeAll*` server action across the app calls `moveToTrash` / `moveManyToTrash` from `@/lib/trash` BEFORE the deletion pipeline. Records land in `trash:{feature}:{id}` with a 7-day TTL. Restore re-hydrates the primary record JSON + index ZSET entry; auxiliary state (reactions, audit logs, occurrence indexes, streak keys, count keys, pin-set membership) is intentionally lost on restore — a hard-recovery scenario should use the JSON export instead. The list of per-feature losses is documented in `references/redis-schema.md` § "Trash (soft-delete window)".

### Activity feed is a logger side-channel

`logger.interaction` / `warn` / `error` / `fatal` automatically write the message + context to `activity:log` (Redis ZSET, capped at 500). Feature code does not call `recordActivity` directly. The Sir-only viewer is the Activity tab on `/admin/logs` (formerly the standalone `/admin/activity` page).

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

## 4.5 Desktop CLI authentication

The `ourspace` desktop CLI (`packages/cli`) is a separate auth surface — **bearer-token only**, no cookie. It exists because Sir wants keyboard-driven admin ops without opening a browser to `/admin/*` for every action. It targets the same Redis cluster + FCM tier as the web app, just through dedicated routes that don't pretend a session exists.

### The token

- Env var name: `ADMIN_CLI_TOKEN` on Vercel.
- Mirror env var name: `OURSPACE_CLI_TOKEN` on Sir's Windows machine (PowerShell profile or system env). Same value, different name so the client/server distinction is obvious in logs and config.
- Minimum length: 32 chars, enforced server-side (`requireCliAuth` refuses shorter tokens with a 503). Generate with `openssl rand -base64 48` or equivalent.
- Treat it as Sir-level admin credentials. Loss is equivalent to a stolen `/admin` session.
- Rotation: update the Vercel env → redeploy → update Sir's shell profile. Brief window where the old token still works (until the new deploy rolls out) — acceptable for a 2-user app.

### The validation path

`src/lib/admin-cli-auth.ts::requireCliAuth(req)` does the work. Every `/api/admin/cli/*` route calls it first thing:

```ts
export async function POST(req: Request) {
  const guard = requireCliAuth(req);
  if (!guard.ok) return cliAuthError(guard);
  // ... handle request ...
}
```

Internals:

1. Read `process.env.ADMIN_CLI_TOKEN`. If missing or < 32 chars → 503 with "ADMIN_CLI_TOKEN not configured."
2. Read `Authorization: Bearer <token>` header. Missing scheme / empty → 401.
3. Length-aware constant-time compare via Node's `crypto.timingSafeEqual`. Mismatched lengths run a dummy compare against an equal-length buffer first to keep timing flat-ish.
4. Match → `{ ok: true }`. Mismatch → 401 "Invalid token."

The dummy compare on length mismatch is paranoia for a 2-user app, but cheap to include and the right pattern if anyone copies this auth helper elsewhere.

### Why no cookie fallback

The web `/admin/*` routes use JWT cookie + `requireSir()`. The CLI routes deliberately do NOT fall back to cookie auth if the bearer is missing — bearer-only is the contract. If a future contributor wants to merge the surfaces, they should pick one auth mode per route, not both.

### Audit trail

CLI ops log with `by: "T7SEN (cli)"` so `/admin/logs` Activity tab can visually distinguish desktop ops from in-app /admin clicks. Same `logger.interaction` / `logger.warn` paths as the existing admin actions — no separate log stream.

### Route inventory

| Route | Method | Body | Effect |
|---|---|---|---|
| `/api/admin/cli/summon` | POST | (none) | Fire Sir → Besho summon push (safeword channel, max priority). |
| `/api/admin/cli/restrain` | POST | `{ on: boolean, note?: string }` | Toggle Besho's restraint. Fires `restraint_engaged` obedience event on off→on transition. Writes restraint-history audit entry. |
| `/api/admin/cli/restrain` | GET | (none) | Read current restraint state. |
| `/api/admin/cli/push` | POST | `{ to, title, body, url?, bypassPresence? }` | Generic FCM. `to` is `T7SEN`/`Besho`/`both`. |
| `/api/admin/cli/logout` | POST | `{ author }` | Bump session epoch for target. |
| `/api/admin/cli/status` | GET | (none) | Read-only: presence, cron telemetry, restraint, FCM token counts. |
| `/api/admin/cli/directive` | POST | `{ title, body?, durationSec? }` | Issue a real-time directive overlay against Besho. Single-slot (409 if active); cancel first. `durationSec` ∈ [60, 3600] or null for open-ended. Fires presence-aware FCM with `data.kind: "directive"`. |
| `/api/admin/cli/directive` | GET | `?limit=N` | `{ active, recent }` — active directive (if any) + recent history. |
| `/api/admin/cli/directive/cancel` | POST | `{ id? }` | Cancel active directive (omit `id`) or specified directive. Sets state → "cancelled" and clears the active sentinel. |
| `/api/admin/cli/punish` | POST | `{ reason, durationSec }` | Issue a punishment timer. `durationSec` ∈ [60, 7200], required. Single-slot. Fires `bypassPresence: true` high-priority FCM with `data.kind: "punishment"`. |
| `/api/admin/cli/punish` | GET | `?limit=N` | `{ active, recent }` — active punishment (if any) + recent history. |
| `/api/admin/cli/punish/cancel` | POST | `{ id? }` | Cancel active punishment (omit `id`) or specified punishment. |
| `/api/admin/cli/rules` | GET | `?status=pending\|active\|completed` | List rules with UUIDs. Used by `ourspace violation` to resolve `ruleId`. |
| `/api/admin/cli/violation` | POST | `{ ruleId, severity, title, description?, timestamp? }` | Log a rule-violation ledger entry. `severity` ∈ `minor`/`moderate`/`major`. Snapshots the rule body. Fires severity-scaled `rule_violation_${severity}` obedience emit + FCM. |

### Don't propose

- A "ourspace CLI without the token" mode for local dev. The 503 fail-closed behavior protects against accidentally shipping no-auth routes if env vars get misconfigured.
- Routing CLI commands through the existing server actions via cookie injection. Server actions are React-specific transport; the CLI is a Node script over HTTP. Replicating the underlying primitives (`sendNotification`, `setRestraintRaw`, `revokeAuthorSessions`, etc.) is the right pattern.
- Logging the token value to debug auth failures. The 503 message tells the operator exactly what's wrong without exposing the secret.

---

## 5. Cross-References

- `SKILL.md` Section 0 — pre-flight checklist (role-context identification step)
- `AGENTS.md` Section 3.1 — role-based dynamics summary
- `AGENTS.md` Section 6 — high-level reminder
- `references/refusal-catalog.md` — security-related refusals (XSS, role-skip, etc.)
- `references/code-style.md` Section 6 — server action patterns
- `references/redis-schema.md` § "Sir-Only Admin Surfaces" — full key inventory for trash / activity / session epoch
- `references/coding-patterns.md` — soft-delete pattern, force-logout pattern, admin sub-route pattern
