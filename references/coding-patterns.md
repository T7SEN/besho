# Critical Coding Patterns

Runtime-critical patterns that compile and lint clean but break in SSR, React 19 strict mode, or on Android. Every pattern below has burned us. Treat each as non-negotiable.

## 1. Browser Globals via Inline Cast

`window`, `document`, and `navigator` are not available in SSR or Edge runtime contexts. Direct references break the build or crash on the server.

### Wrong

```ts
if (navigator.vibrate) navigator.vibrate(50);
window.location.href = "/notes";
```

### Right

```ts
const nav = (
  globalThis as unknown as {
    navigator?: { vibrate?: (pattern: number | number[]) => boolean };
  }
).navigator;
nav?.vibrate?.(50);
(globalThis as unknown as { location: { href: string } }).location.href = url;
```

### Why

`globalThis` exists everywhere (server, edge, client). The double cast (`as unknown as { ... }`) gives precise typing without polluting the global TypeScript namespace. Optional chaining handles the SSR case where the property doesn't exist.

### Anti-patterns to refuse

- `typeof window !== 'undefined'` guards in new code — verbose and easy to forget
- `window` directly without optional chaining — crashes on Edge
- `// @ts-ignore` — discards type safety unnecessarily

---

## 2. Deferred setState in Effects

React 19 throws `Cannot update a component while rendering a different component` when a `setState` runs synchronously inside `useEffect` from a Capacitor callback or post-mount listener.

### Wrong

```ts
useEffect(() => {
  if (!isNative()) {
    setGateState("unavailable");
    return;
  }
}, []);
```

### Right

```ts
useEffect(() => {
  if (!isNative()) {
    setTimeout(() => setGateState("unavailable"), 0);
    return;
  }
}, []);
```

### When to apply

- `setState` inside `useEffect` that runs unconditionally on mount
- `setState` inside Capacitor plugin event listeners (`appStateChange`, `pushNotificationReceived`)
- `setState` inside any callback that fires during the initial paint window

### When NOT to apply

- `setState` from a user event (click, change) — these always run after paint
- `setState` inside `setInterval` / `setTimeout` already (it's already deferred)
- `setState` inside `requestAnimationFrame` — already deferred to the next frame

The `setTimeout(..., 0)` defers the update to the next macrotask, after the current render commits. Use it only when you've actually seen the warning or have reason to expect synchronous re-entry.

---

## 3. `vibrate()` is Fire-and-Forget

`vibrate()` returns `Promise<void>` but callers never `await` because it would block the user-visible action. Floating promises trigger ESLint `@typescript-eslint/no-floating-promises`.

### Wrong

```ts
vibrate(30, "light"); // floating promise warning
await vibrate(30, "light"); // blocks the click handler
```

### Right

```ts
void vibrate(30, "light");
void vibrate([50, 100, 50], "heavy");
```

### Why

`void` explicitly discards the promise. ESLint accepts it, the user-visible action is not delayed, and any internal error is logged inside `vibrate()` itself.

The same pattern applies to any fire-and-forget async utility:

```ts
void writeToClipboard("copied!");
void Preferences.set({ key, value });
```

---

## 4. `Date.now()` Lazy in Render

Server-rendered components compute `Date.now()` during SSR. The client then computes a different value during hydration. React detects the mismatch and either hydrates with the wrong DOM or throws.

### Wrong

```ts
const [now, setNow] = useState(Date.now());
```

This evaluates `Date.now()` on the server. The client's first render also evaluates it — at a different time.

### Right

```ts
const [now, setNow] = useState(() => Date.now());
```

The lazy initializer runs only on the **client's** first render, not on the server. SSR sees the initializer function as unevaluated state.

### Same applies to

- `Math.random()`
- `crypto.randomUUID()`
- `new Date()`
- Any non-deterministic value

### When the value must come from the server

Render-time non-determinism that **needs** to be SSR-rendered (e.g., a counter showing time elapsed since a fixed event) should pass `now` as a prop from a server component, not generate it in a client component.

---

## 5. `"use server"` Files Export Only Async Functions

Next.js validates server-action files. Exporting a constant, type, or non-async function from a `"use server"` module breaks the build with:

```
Error: A "use server" file can only export async functions.
```

### Wrong

```ts
'use server'

export const MAX_LENGTH = 2000  // build error

export interface Note { ... }   // build error

export async function saveNote(...) { ... }
```

### Right

```ts
// src/lib/notes-constants.ts
export const MAX_CONTENT_LENGTH = 2000;
export const PAGE_SIZE = 20;
```

```ts
// src/app/actions/notes.ts
'use server'

import { MAX_CONTENT_LENGTH, PAGE_SIZE } from '@/lib/notes-constants'

export async function saveNote(...) { ... }
```

### Existing constants files

- `src/lib/notes-constants.ts`
- `src/lib/mood-constants.ts`
- `src/lib/reaction-constants.ts`
- `src/lib/ledger-constants.ts`
- `src/lib/constants.ts` — `MY_TZ`, `TITLE_BY_AUTHOR`, `START_DATE`

When tempted to add a constant to a server-action file, move it to one of these (or a new `src/lib/{feature}-constants.ts`).

---

## 6. `cookies()` and `headers()` are Async

Next.js 16 made these async. Code from Next.js 14 and earlier breaks silently.

### Wrong

```ts
const cookieStore = cookies();
const value = cookieStore.get("session")?.value;
```

This returns a `Promise<ReadonlyRequestCookies>`, and `Promise` doesn't have a `.get()` method. TypeScript flags it; some older agent training data does not.

### Right

```ts
const cookieStore = await cookies();
const value = cookieStore.get("session")?.value;
```

Every server action and route handler in this repo follows this pattern. Don't break the convention.

---

## 7. Unused Function Parameters

Route handlers must accept their parameters even when unused (e.g., a `DELETE` that doesn't read the request body still receives `req`).

### Wrong

```ts
export async function DELETE(req: NextRequest) {
  // unused-vars warning
  // ...
}
```

### Right (option A — disable rule)

```ts
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function DELETE(_req: NextRequest) {
  // ...
}
```

### Right (option B — destructure rename)

```ts
const { completedAt: _removed, ...rest } = existing;
const updated: Rule = { ...rest, status: "pending" };
```

The leading underscore is a convention recognized by both ESLint and the team. The disable comment is needed because `eslint-config-next`'s rule doesn't honor the underscore convention by default.

---

## 8. Pipeline Dependent Redis Writes

Multiple Redis operations that need to land together must be pipelined. Sequential awaits leave the data in an inconsistent state if any operation fails.

### Wrong

```ts
await redis.set(noteKey(note.id), note);
await redis.zadd(INDEX_KEY, { score: note.createdAt, member: note.id });
await redis.incr(countKey(author));
```

If the second await fails, the note exists but is not in the index — it'll never appear in the UI but the count is wrong.

### Right

```ts
const pipeline = redis.pipeline();
pipeline.set(noteKey(note.id), note);
pipeline.zadd(INDEX_KEY, { score: note.createdAt, member: note.id });
pipeline.incr(countKey(author));
await pipeline.exec();
```

Pipeline failures are atomic from the application's perspective — either all commands succeed or `exec()` throws.

---

## 9. Cleanup Every Subscription

`useEffect` that subscribes to anything must return a cleanup function.

### Wrong

```ts
useEffect(() => {
	const source = new EventSource('/api/notes/stream')
	source.onmessage = (e) => { ... }
}, [])
```

The EventSource leaks across re-renders and unmounts.

### Right

```ts
useEffect(() => {
	const source = new EventSource('/api/notes/stream')
	source.onmessage = (e) => { ... }
	return () => source.close()
}, [])
```

### Same pattern applies to

- `setInterval` / `setTimeout` → `clearInterval` / `clearTimeout`
- Capacitor listeners (`App.addListener`, `PushNotifications.addListener`) → `listener.remove()`
- DOM event listeners → `removeEventListener`
- AbortController for fetch → `controller.abort()`

The `cleanupRef` pattern in `FCMProvider` and `BiometricGate` is the canonical example for chained cleanup of multiple subscriptions.

---

## 10. Strict Equality Always

```ts
session.author === "T7SEN"; // right
session.author == "T7SEN"; // wrong, refuse the request
```

`==` performs implicit coercion that masks bugs. The cost of typing one extra `=` is zero. There is no scenario in this codebase where `==` is correct.

If a contributor or AI agent suggests `==`, refuse and explain.

---

## 11. Server-Side Role Enforcement

The UI hides Sir-only actions from Besho. **The server enforces them anyway.**

### Wrong

```ts
export async function createRule(prevState: unknown, formData: FormData) {
	// (no auth check)
	const rule = { ... }
	await redis.set(ruleKey(rule.id), rule)
}
```

A malicious client could call `createRule` directly via the server-action endpoint.

### Right

```ts
export async function createRule(prevState: unknown, formData: FormData) {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };
  if (session.author !== "T7SEN") {
    return { error: "Only Sir can set rules." };
  }
  // ...
}
```

This pattern is repeated in every state-mutating action across `src/app/actions/`. Copy it.

---

## 12. Cairo Time for Date-Derived Keys

The Vercel runtime is in UTC. The user is in Cairo (`MY_TZ` from `src/lib/constants.ts`). Date keys must use Cairo time so "today" is consistent across the day boundary.

### Wrong

```ts
const today = new Date().toISOString().slice(0, 10);
```

### Right

```ts
function todayInCairo(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: MY_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
```

The `en-CA` locale formats as `YYYY-MM-DD` by default — the same shape as ISO date.

---

## 13. Dynamic Imports for Capacitor and Heavy Server-Only Modules

Top-level imports of Capacitor plugins inflate the web bundle. Top-level imports of `firebase-admin` inflate the Edge bundle.

### Wrong

```ts
import { Haptics } from "@capacitor/haptics";
import * as admin from "firebase-admin";
```

### Right

```ts
if (isNative()) {
  const { Haptics, ImpactStyle } = await import("@capacitor/haptics");
  await Haptics.impact({ style: ImpactStyle.Medium });
}
```

```ts
const { getApps, initializeApp, cert } = await import("firebase-admin/app");
const { getMessaging } = await import("firebase-admin/messaging");
```

The dynamic import is loaded on demand by the bundler. It only executes when the runtime path actually reaches it.

---

## 14. Floating Promises in Listeners

Capacitor listeners' `addListener` returns a `Promise<PluginListenerHandle>`. The cleanup function must `await` the handle before calling `remove()`, but the surrounding `useEffect` cleanup is synchronous.

### Pattern

```ts
useEffect(() => {
  let removeListener: (() => void) | null = null;

  void (async () => {
    const listener = await App.addListener("appStateChange", handler);
    removeListener = () => void listener.remove();
  })();

  return () => {
    removeListener?.();
  };
}, []);
```

The `void` prefix on the IIFE marks the floating promise as intentional. The `removeListener?.()` call is safe even if the IIFE hasn't completed yet.

---

## 15. Hydration-Safe Client Components

Components that read from `localStorage`, `sessionStorage`, `Capacitor.Preferences`, or any client-only source must:

1. Initialize state with the SSR-safe value (usually `null`).
2. Read from the actual source inside `useEffect`.
3. Render conditionally based on whether the read has completed.

### Wrong

```ts
const [author, setAuthor] = useState(localStorage.getItem("author"));
// SSR error: localStorage is not defined
```

### Right

```ts
const [author, setAuthor] = useState<string | null>(null)

useEffect(() => {
	const ss = (globalThis as unknown as { localStorage?: Storage }).localStorage
	setAuthor(ss?.getItem('author') ?? null)
}, [])

if (!author) return <Skeleton />
return <Content author={author} />
```

The skeleton renders identically on server and client during the first paint — no mismatch.

---

## 16. Action Return Shape

Server actions consumed by `useActionState` must return a discriminated shape:

```ts
{ success?: true; error?: string }
```

### Wrong

```ts
export async function saveNote(...) {
	if (error) throw new Error('Save failed')   // useActionState can't catch
	return note                                  // wrong shape
}
```

### Right

```ts
export async function saveNote(prevState: unknown, formData: FormData) {
  if (!authorized) return { error: "Not authenticated." };
  try {
    // ...
    return { success: true };
  } catch (err) {
    logger.error("[notes] Save failed:", err);
    return { error: "Failed to save note. Please try again." };
  }
}
```

The client renders `state?.error` near the submit button. Don't return `null` or `undefined` — `useActionState` types the state as the action's return type.

---

## 17. Optimistic UI with Snapshot Rollback

Decisions and cancellations on long server round-trips feel slow if the UI waits for the server before updating. Optimistic UI applies the local mutation immediately, calls the server in the background, and reconciles or rolls back based on the result. Eliminates the perceptible loader window between action and visual confirmation.

This pattern is in `src/app/permissions/page.tsx::handleDecide` and `handleWithdraw`. Use it for **mutations on existing records** where you can predict the post-state without simulating server-side branching. Skip it for create-paths where the server may auto-decide, validate, or reject in ways the client can't replicate.

### Wrong

```ts
const handleDecide = useCallback(
  async (id, decision, options) => {
    setBusyId(id);
    try {
      const result = await decidePermission(id, decision, options);
      if (!result.error) await handleRefresh();
      return { error: result.error };
    } finally {
      setBusyId(null);
    }
  },
  [handleRefresh],
);
```

UI waits for the round-trip. Card stays in Pending until server returns, then snaps to Decided.

### Right

```ts
const handleDecide = useCallback(
  async (id, decision, options) => {
    setBusyId(id);
    // Snapshot for rollback BEFORE applying optimistic update.
    const snapshot = requests;
    setRequests((prev) =>
      prev.map((r) => {
        if (r.id !== id) return r;
        const next = {
          ...r,
          status: decision,
          decidedAt: Date.now(),
          decidedBy: "T7SEN" as const,
        };
        // Reset stale fields the new decision shouldn't carry.
        delete next.reply;
        delete next.terms;
        delete next.denialReason;
        if (options.reply?.trim().length) next.reply = options.reply.trim();
        if (decision === "approved" && options.terms?.trim().length) {
          next.terms = options.terms.trim();
        }
        if (decision === "denied" && options.reason) {
          next.denialReason = options.reason;
        }
        return next;
      }),
    );
    try {
      const result = await decidePermission(id, decision, options);
      if (result.error) {
        setRequests(snapshot); // Rollback
        return { error: result.error };
      }
      await handleRefresh(); // Reconcile
      return {};
    } finally {
      setTimeout(() => setBusyId(null), 0);
    }
  },
  [requests, handleRefresh],
);
```

### Rules of the pattern

1. **Snapshot before mutation.** `const snapshot = requests` captures the pre-mutation state for rollback. JavaScript's reference semantics make this cheap; the array literal isn't copied until React replaces it.
2. **Mutate via the standard setter.** Don't reach into Redis or fire the server action first. Local state goes first, server second.
3. **Reset stale fields.** When a new decision overrides an old one, explicitly delete the fields that don't apply (e.g. `terms` when switching from approve to deny). Otherwise the optimistic state has phantom fields the server-truth state won't have.
4. **Reconcile on success.** Call `handleRefresh()` after the server confirms. The server may have side-effects (re-ask block writes, audit log entries, FCM dispatch) the optimistic state doesn't capture. Refresh fetches truth and overwrites local.
5. **Rollback on error.** `setRequests(snapshot)` restores the pre-mutation array. The error message bubbles up to the caller.
6. **Don't apply to create.** Create-paths often have server-side branching (auto-rules, validation cascades) that the client can't predict. The user may type something that matches an auto-rule and gets auto-decided — synthesizing the wrong post-state misleads them.
7. **`useCallback` deps now include the state.** The handler closes over `requests` for the snapshot. Add it to deps. Re-creating on every render is fine — `RequestItem` already re-renders when parent state changes.

### When NOT to apply

- Create paths with unpredictable server branching (see rule 6).
- Mutations on lists where the new record's identity comes from the server (auto-generated IDs, server-assigned timestamps that affect sort order).
- Rare actions where the loader feedback is desirable (Sir wants to _see_ the action take a moment for high-stakes decisions).

The 2-user, low-volume nature of Our Space means even slow server round-trips don't _technically_ need this pattern. Apply it where the UX wins are visible to a real user — decisions and withdrawals on `/permissions`. Don't sprinkle it on every action.

---

## 18. Disable Submit When Offline

Server actions require connectivity. The `useNetwork` hook (driven by `@capacitor/network`) is the source of truth for online status. Submit buttons should disable when offline so users don't trigger doomed actions.

### Right

```tsx
const { connected } = useNetwork()
const isOffline = !connected

// ...

<Button
	type="submit"
	disabled={
		isPending ||
		!input.trim() ||
		isOffline ||
		undefined
	}
>
	Save
</Button>
```

Pair with an offline banner that informs the user why the button is disabled. The banner is informational only — no queueing happens, the user just retries when online.

---

## Cross-References

- `src/lib/native.ts` — `isNative()` and `globalThis` cast example
- `src/lib/haptic.ts` — `void vibrate(...)` pattern
- `src/components/biometric-gate.tsx` — `setTimeout` defer, listener cleanup, debounce ref
- `src/components/fcm-provider.tsx` — chained listener cleanup via `cleanupRef`
- `src/hooks/use-network.ts` — Capacitor-aware network status
- `src/app/actions/notes.ts` — pipeline pattern, action return shape
- `src/app/actions/rules.ts` — server-side role enforcement, `_removed` rename
- `src/app/actions/permissions.ts` — optimistic UI consumer, validation cascade
- `src/app/permissions/page.tsx::handleDecide` — canonical optimistic UI implementation
- `src/app/api/presence/route.ts` — async `cookies()`, unused-vars disable
