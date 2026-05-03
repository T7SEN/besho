# Permissions (`/permissions`)

The two-author negotiation surface. Besho asks for things; Sir adjudicates. Single page, single server-action file, single Redis namespace. Role enforcement is server-side at every action.

This reference is the canonical spec for the permissions feature surface. Schema, validation order, decision routing, and the mechanisms (re-ask, quota, auto-decide, audit, optimistic UI) all live here. Brief context lives in `AGENTS.md` Section 3.1; this file goes deep.

---

## File map

| Path                               | Role                                                               |
| ---------------------------------- | ------------------------------------------------------------------ |
| `src/app/permissions/page.tsx`     | Client page. ~2750 lines. Houses every sub-component.              |
| `src/app/actions/permissions.ts`   | All server actions. Single `'use server'` file.                    |
| `src/lib/permissions-constants.ts` | Categories, denial reasons, cooldowns, auto-rule type, max counts. |

The page is large because every sub-component (`RequestForm`, `RequestItem`, `QuotaModal`, `AutoRulesModal`, `AutoRuleEditor`, `AuditLogView`, `QuotaUsageBar`, `AllCaughtUp`, etc.) lives in the same file. Don't split unless extracting for reuse.

---

## Schema

Defined in `src/app/actions/permissions.ts`. Re-exported types are consumed by the page.

```ts
type PermissionStatus =
  | "pending" // Besho submitted; Sir hasn't acted
  | "approved" // Sir approved (manual or auto)
  | "denied" // Sir denied (manual or auto)
  | "queued" // Sir wants to think about it
  | "withdrawn"; // Besho retracted before Sir acted

interface PermissionRequest {
  id: string;
  requestedBy: "Besho"; // Always — Sir cannot submit
  body: string;
  category?: PermissionCategory;
  expiresAt?: number;
  status: PermissionStatus;
  requestedAt: number;
  decidedAt?: number;
  decidedBy?: "T7SEN"; // Always Sir, even on auto-decide
  reply?: string;
  terms?: string; // Approval conditions
  denialReason?: DenialReason; // Drives re-ask cooldown
  withdrawnAt?: number;
  price?: number; // Required when category === "purchase"
  whoWith?: string; // Required when category === "social"
  protocolRef?: string; // Heading text linking to /protocol
  decidedByRuleId?: string; // Set when an auto-rule fired
  wasReasked?: boolean; // Same body hash as a prior denial
  auditCount?: number; // Computed at fetch time, not persisted
}

type DenialReason =
  | "not_now"
  | "unsafe"
  | "earn_first"
  | "discuss_in_person"
  | "nope";

interface PermissionAuditEntry {
  status: PermissionStatus;
  decidedAt?: number;
  decidedBy?: "T7SEN";
  reply?: string;
  terms?: string;
  denialReason?: DenialReason;
}

interface PermissionQuotas {
  monthlyLimits: Partial<Record<PermissionCategory, number>>;
  maxPending?: number; // Global pending-queue cap
}

interface CategoryUsage {
  category: PermissionCategory;
  used: number;
  limit?: number;
}

interface AutoDecideRule {
  id: string;
  enabled: boolean;
  category?: PermissionCategory;
  priceMax?: number;
  bodyContainsAny?: string[]; // OR within array
  noExpiry?: boolean;
  decision: "approved" | "denied";
  terms?: string;
  denialReason?: DenialReason;
  reply?: string;
  notifySir?: boolean; // Defaults TRUE in editor
  createdAt: number;
}

interface DecideOptions {
  reply?: string;
  terms?: string; // Ignored unless decision === "approved"
  reason?: DenialReason; // Ignored unless decision === "denied"
}
```

`auditCount` is a fetch-time computation (not persisted) — `getPermissions` pipelines a `LLEN` for each record's audit list alongside the record `GET`.

---

## Role enforcement

Every state-mutating action checks `session.author` server-side. The UI hides buttons but server actions are public endpoints.

| Action                       | Allowed authors | Notes                                                          |
| ---------------------------- | --------------- | -------------------------------------------------------------- |
| `getPermissions`             | T7SEN, Besho    | Both see everything.                                           |
| `getPermissionAudit`         | T7SEN, Besho    | Audit history of a single request.                             |
| `getCategoryUsage`           | T7SEN, Besho    | Used + limit per category.                                     |
| `getQuotas`                  | T7SEN, Besho    | Both can read; only Sir writes.                                |
| `setQuotas`                  | T7SEN           | Single FormData call sets per-category limits + `maxPending`.  |
| `getAutoRules`               | T7SEN           | **Sir-only read.** Returns `[]` for Besho — rules are private. |
| `saveAutoRules`              | T7SEN           | Wholesale array replacement.                                   |
| `createPermission`           | Besho           | Only kitten can submit.                                        |
| `decidePermission`           | T7SEN           | Approve / Deny / Queue. Re-decides allowed (audit log).        |
| `withdrawPermission`         | Besho           | Status update only — record stays for audit.                   |
| `getPendingPermissionsCount` | T7SEN           | Used by `useNavBadges`.                                        |

The auto-rule privacy point matters: Besho seeing the rules would let her game the heuristics. `getAutoRules` returns `[]` for non-Sir even when rules exist.

---

## `createPermission` — validation order

Order is load-bearing. Reordering changes user-facing behavior, especially around the auto-decide / pending-cap interaction.

1. **Auth + role.** Reject non-authenticated, reject non-Besho.
2. **Body length & non-empty.** ≤ `MAX_BODY_LENGTH` (2000).
3. **Re-ask block.** `GET permission:reask-block:{bodyHash}`. If present → reject with remaining cooldown ("Try in 24h"). Fails open on Redis errors.
4. **Re-ask detection.** `SISMEMBER permissions:denied-hashes {bodyHash}`. If member → set `wasReasked: true` on the new record. Doesn't reject; this is a chip-flag only. Fails open.
5. **Category & per-category required fields.** Validate category is in `PERMISSION_CATEGORIES`. Apply `CATEGORY_SCHEMA[category]`: `purchase` requires `price`, `social` requires `whoWith`.
6. **Expiry parse.** If supplied, must be a future timestamp.
7. **Quota check.** `GET permissions:quotas` → if `monthlyLimits[category]` set, count approved requests this Cairo calendar month with same category, reject at-cap with explicit `used/limit`. Fails open.
8. **Auto-decide rule eval.** `GET permissions:auto-rules` → first-match-wins via `matchesAutoRule`. If matched: set `status = decision`, `decidedAt`, `decidedBy = "T7SEN"`, `decidedByRuleId`, copy `terms`/`denialReason`/`reply`. Fails closed (lookup error → no auto-decision; falls through to pending).
9. **Pending-queue cap.** Only when no rule matched. `GET permissions:quotas` → if `maxPending > 0`, count current pending records, reject at-cap. Auto-decided requests bypass — they don't add Sir's backlog.
10. **Insert.** Pipeline: `SET permission:{id}` + `ZADD permissions:index`. Auto-denials additionally `SADD permissions:denied-hashes` + `SET permission:reask-block:{hash}` with TTL.
11. **Notify.** Auto-decide → decision FCM to Besho; optional heads-up to Sir if `notifySir !== false`. Manual → request FCM to Sir only.

---

## `decidePermission` — re-decide semantics

Sir is allowed to change his mind. Re-deciding an already-decided request is permitted; the new decision overwrites status, decidedAt, decidedBy, and the decision-specific fields (reply, terms, denialReason).

Audit log writes only on **re-decide** (existing.status !== "pending"). The OLD state is `LPUSH`ed onto `permission:audit:{id}` BEFORE the overwrite, then `LTRIM 0 19` to cap at 20 entries. First decisions don't log because there's no prior decision worth preserving.

On denial:

- `SADD permissions:denied-hashes {bodyHash}` — survives forever, drives the ↺ chip.
- `SET permission:reask-block:{bodyHash} 1 EX cooldownSeconds` — TTL from `DENIAL_REASON_COOLDOWN_HOURS[denialReason ?? "default"]`.

These two are deliberately distinct. The TTL'd block enforces a cooldown; the no-TTL set is a persistent persistence-pattern detector that survives the cooldown window.

---

## Re-ask mechanisms (two, not one)

This trips people up. There are two separate Redis structures with different jobs.

| Mechanism            | Key                                      | TTL    | Job                                                 |
| -------------------- | ---------------------------------------- | ------ | --------------------------------------------------- |
| **Re-ask block**     | `permission:reask-block:{bodyHash}`      | varies | Rejects new requests during cooldown                |
| **Re-ask detection** | `permissions:denied-hashes` (SET member) | none   | Marks new requests with `wasReasked: true` (↺ chip) |

Cooldown TTL by `DenialReason` (in `permissions-constants.ts`):

| Reason              | Hours        |
| ------------------- | ------------ |
| `not_now`           | 12           |
| `discuss_in_person` | 24           |
| `earn_first`        | 48           |
| `unsafe`            | 72           |
| `nope`              | 168 (7 days) |
| (no reason given)   | 12 (default) |

Body hash uses `bodyHashFor()` — case-insensitive, whitespace-collapsed, FNV-style integer hash to base36. Trivial rewordings (changing case, adding spaces) hit the same hash. Actual semantic rewording bypasses both mechanisms — that's a feature, not a bug.

---

## Quotas

`permissions:quotas` JSON, single key. Read by both authors; written by Sir only.

```ts
{
  monthlyLimits: { treat: 4, outing: 2 },  // per-category approval cap per Cairo month
  maxPending: 5                            // global cap on simultaneous pending
}
```

Empty / zero / missing values clear the corresponding cap.

**Monthly window** uses `startOfCairoMonthMs(now)` — `Intl.DateTimeFormat` with `Africa/Cairo` timezone, fixed `+02:00` offset. DST drift across boundaries is acceptable for monthly windows.

**Quota counting** is on-the-fly: ZRANGE month-window from index, pipelined GET, filter to `status === "approved" && category === target`. O(N) scan over current-month records — fine at the project's scale (2 users, ~50 requests/month upper bound).

**Pending-cap counting** is a full-index scan over current pending records. Same O(N) characteristics.

Both checks fail open on Redis errors — better to let a request through than reject on infra hiccups.

---

## Auto-decide rules (feature 17)

Sir authors deterministic predicates evaluated at create-time. Stored at `permissions:auto-rules` as a single ordered JSON array. Array order = priority order. First-match-wins.

### Match semantics

`matchesAutoRule(rule, req)`:

- Disabled rules never match.
- `category`: exact match, or unset (any).
- `priceMax`: matches when `req.price !== undefined && req.price <= rule.priceMax`.
- `bodyContainsAny`: any keyword in the array matches the body case-insensitively (OR within the array).
- `noExpiry === true`: matches only when `req.expiresAt === undefined`.
- All conditions AND-combined within the rule.

### Decision flow

Match → request inserted with `status = decision`, `decidedAt = requestedAt`, `decidedBy = "T7SEN"`, `decidedByRuleId = rule.id`. Decision-specific fields copied (`terms` for approve, `denialReason` for deny, `reply` for either).

Auto-denials follow the same denial side-effects as manual denials — `denied-hashes` SET membership and `reask-block` TTL key. Otherwise the same body would re-fire the rule on every retry, which is the spam behavior the rule exists to prevent.

### Notification routing

| Path              | Sir gets FCM?                 | Besho gets FCM? |
| ----------------- | ----------------------------- | --------------- |
| Manual pending    | Yes (request notification)    | No              |
| Auto-approve/deny | If `rule.notifySir !== false` | Yes (decision)  |

`notifySir` defaults TRUE in the editor — awareness backstop. Sir can opt out per-rule for genuinely trivial asks ("auto-approve treats under $3, silent").

### Privacy

`getAutoRules` returns `[]` for Besho. Rules are Sir's private authoring artifacts. Besho seeing them would let her game the heuristics. The visible `decidedByRuleId` on her cards just renders an "Auto" chip — no link, no rule details.

---

## Audit log

Per-request decision history. Surfaces in the UI as a "Changed Nx" chip when `auditCount > 0`.

| Aspect             | Detail                                                                     |
| ------------------ | -------------------------------------------------------------------------- |
| Key                | `permission:audit:{id}` LIST                                               |
| Cap                | 20 entries via `LTRIM 0 19`                                                |
| Order              | Most-recent-prior first (LPUSH semantics)                                  |
| Triggered by       | Re-decide only (existing.status !== "pending")                             |
| Captured fields    | `status`, `decidedAt`, `decidedBy`, `reply`, `terms`, `denialReason`       |
| Skipped            | Pending → decided (first decision); withdrawals (different code path)      |
| Computed alongside | `getPermissions` pipelines `LLEN` next to record `GET` — single round-trip |

Loading the full audit list happens lazily on demand via `getPermissionAudit(id)` when Sir or Besho expands the chip in the UI.

---

## Optimistic UI

`handleDecide` and `handleWithdraw` apply the local mutation immediately, call the server, rollback on error, reconcile via `handleRefresh()` on success. Eliminates the ~500ms loader window between action and section-move.

Pattern documented in `references/coding-patterns.md` § "Optimistic UI with Snapshot Rollback".

**Skipped for create.** `createPermission` has too many server-side branches (auto-rule eval, pending-cap, validation cascade) to predict the post-insert state client-side. Submit still uses the existing `useActionState`-driven loader.

---

## UI surface notes

A few non-obvious affordances:

- **FIFO position chip** (`#1 of 3`) — only renders on pending cards when `pendingTotal > 1`.
- **Long-press copy** — 500ms hold on the body wrapper copies the raw markdown to clipboard. `Copied` chip flashes top-right for 1.5s. Native context menu suppressed during the success window.
- **Keyboard shortcuts** — Sir-actionable pending cards are `tabIndex={0}`. `A`/`D`/`Q` open the corresponding decide-confirm panel. Skip when target is `INPUT`/`TEXTAREA`/`isContentEditable`. Hint chip (`A approve · D deny · Q queue`) appears below the action buttons when the card is focused. Touch devices never trigger Tab focus → hint stays hidden in practice.
- **Body markdown** — bodies render through `MarkdownRenderer`. Submission is plain text; rendering is markdown.
- **Re-ask chip** — violet `↺ Asked again` chip when `wasReasked === true`. `title` attribute carries the explanation.
- **All caught up** — Sir-only celebration card with sparkle burst between an empty pending section and a non-empty decided list. Skipped on first-ever load (decided.length must be > 0).
- **Granted view toggle** — `Shield` icon in the header swaps between all-list and approved-only mode, with category filter chips in granted mode.
- **Quota usage bar** — appears below the page header when any cap (per-category OR `maxPending`) is set. Both authors see it.
- **Empty-state tip rotation** — Besho-only, picked once per session via `useState(() => ...)`.
- **Pull-to-refresh** — touch-event handlers on the outer page container, threshold 80px, anchors at `scrollTop === 0`.

---

## Cross-references

- `references/redis-schema.md` § Permissions — full key list with TTLs
- `references/coding-patterns.md` § "Optimistic UI with Snapshot Rollback"
- `references/auth-and-security.md` — server-side role check shape
- `src/app/actions/permissions.ts` — every action
- `src/lib/permissions-constants.ts` — categories, reasons, cooldowns, auto-rule type
- `src/components/ui/markdown-renderer.tsx` — used for body display
- `src/app/protocol/page.tsx` — reads `?focus=` query param for protocolRef deep-links

---

## Anti-patterns to refuse

- **Adding voice notes / audio recording / `MediaRecorder` / `RECORD_AUDIO`** — explicitly removed. Don't re-suggest.
- **Adding a third user role** — two-user app, hardcoded `T7SEN` / `Besho` literals throughout.
- **Removing `decidedBy: "T7SEN"` on auto-decided records** — even auto-rules count as Sir's decision (he authored the rule).
- **Auto-deciding without setting the re-ask block** — same body would loop the same rule on every retry.
- **Changing the validation order in `createPermission`** — auto-rule must come AFTER quota and BEFORE pending-cap. Reordering changes UX.
- **Counting pending or quota on the client** — server is the source of truth. Client `pending.length` is for display only.
- **Storing `Sir`/`kitten` strings in the schema** — only `T7SEN` / `Besho` literals. `TITLE_BY_AUTHOR` translates at render time.
