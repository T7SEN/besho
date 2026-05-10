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

### Applied across

All primary form submits in user-facing pages now carry this gate: `/notes`, `/tasks`, `/rules`, `/timeline`, `/ledger`, `/rituals` (both `SubmitForm` and `RitualForm` sub-components call `useNetwork` themselves), `/protocol` (inside `EditForm`), `/permissions` (`RequestForm` + `QuotaModal`), `/review` (`ReviewForm`'s `canSubmit` includes `!isOffline`). Sub-component forms call `useNetwork` directly rather than drilling `isOffline` as a prop — the hook is cheap and avoids prop pollution. The `/login` form is intentionally exempt: if the user is offline they can't authenticate at all, no point disabling the submit.

---

## 19. `<TabsContent>` Holding Form Inputs Must `forceMount`

Radix Tabs unmounts inactive `<TabsContent>` by default. When the user submits a form while a different tab is active, the form-bearing input is not in the DOM — and native HTML form submission only collects values from elements present at submit time. The server action receives `null` and renders nothing.

### Wrong

```tsx
<Tabs defaultValue="write">
  <TabsList>
    <TabsTrigger value="write">Write</TabsTrigger>
    <TabsTrigger value="preview">Preview</TabsTrigger>
  </TabsList>
  <TabsContent value="write">
    <textarea name="content" />
  </TabsContent>
  <TabsContent value="preview">{/* read-only */}</TabsContent>
</Tabs>
```

Submit from the Preview tab → `formData.get('content')` is `null`.

### Right

```tsx
<TabsContent value="write" forceMount>
  <textarea name="content" />
</TabsContent>
```

`forceMount` keeps the textarea in the DOM at all times. Radix applies `hidden` to inactive forceMounted content; `FormData` still picks up the value because `hidden` is purely visual. The Preview tab does not need `forceMount` — it's display-only.

### Edge

Browsers skip native `required` validation on `hidden` elements. Submitting an empty `required` field from the Preview tab will not fire the validation bubble. Server-side validation must reject empty bodies regardless. This is acceptable because server-side validation is the source of truth in this codebase.

### Canonical example

`src/components/ui/rich-text-editor.tsx` — Write tab uses `forceMount`.

---

## 20. Bottom Sheets Use the Dialog Primitive Directly

The shadcn `Sheet` helper at `src/components/ui/sheet.tsx` is fine for static sheets. For a drag-to-dismiss bottom sheet, bypass `<SheetContent>` and use `radix-ui`'s `Dialog` primitive directly via `asChild` on a `motion.div`. This is the only way to attach `motion`'s drag gestures to the Radix-positioned content.

### Pattern

```tsx
import { Dialog as SheetPrimitive } from "radix-ui";
import { Sheet, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { AnimatePresence, motion, type PanInfo } from "motion/react";

<Sheet open={open} onOpenChange={setOpen}>
  <AnimatePresence>
    {open && (
      <SheetPrimitive.Portal forceMount>
        <SheetPrimitive.Overlay asChild forceMount>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/40"
          />
        </SheetPrimitive.Overlay>
        <SheetPrimitive.Content asChild forceMount>
          <motion.div
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", damping: 30, stiffness: 300 }}
            drag="y"
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 1 }}
            dragMomentum={false}
            onDragEnd={(_, info: PanInfo) => {
              if (info.offset.y > 100 || info.velocity.y > 500) {
                void vibrate(50, "medium");
                setOpen(false);
              }
            }}
            className={cn(
              "fixed inset-x-0 bottom-0 z-50 rounded-t-3xl bg-black/80",
              "pb-[max(env(safe-area-inset-bottom),1rem)] touch-none",
            )}
          >
            <SheetTitle className="sr-only">…</SheetTitle>
            <SheetDescription className="sr-only">…</SheetDescription>
            {/* content */}
          </motion.div>
        </SheetPrimitive.Content>
      </SheetPrimitive.Portal>
    )}
  </AnimatePresence>
</Sheet>
```

### Why this shape

- `dragConstraints={{ top: 0, bottom: 0 }}` pins rest position to `y: 0`.
- `dragElastic={{ top: 0, bottom: 1 }}` is rigid upward, 1:1 follow downward (motion v12 supports the per-axis object form via `Partial<BoundingBox>`).
- `dragMomentum={false}` prevents fling-throw — release commits to either close or spring-back, no in-between drift.
- `forceMount` + `AnimatePresence` lets motion run the exit animation; otherwise Radix unmounts immediately and the slide-out is dropped.
- `touch-none` blocks browser overscroll/pull-to-refresh from competing with the drag.
- `SheetTitle`/`SheetDescription` are required by Radix Dialog for a11y; use `sr-only` if the visible header doesn't need them.

### Pull-to-refresh interaction

`use-pull-to-refresh.ts` checks `target.closest('[role="dialog"]')` in its touchstart handler and bails when true. Any drag-to-dismiss sheet built on Radix Dialog is automatically immune from triggering page-level PTR — no per-sheet wiring needed.

### Caveat

`touch-none` on the sheet body blocks vertical scroll inside the sheet. If the sheet ever needs scrollable content, switch to drag-only-from-the-handle (`useDragControls().start(event)` on the header `onPointerDown`, drag wired to a parent that doesn't have `touch-none`).

### Canonical example

`src/components/navigation/floating-navbar.tsx` — More sheet.

---

## 21. Localized 1Hz Tick

A `setInterval(setNow, 1000)` at the dashboard parent re-renders the entire tree every second. Cards that don't need second-resolution time still re-render — wasteful on Android.

### Wrong

```tsx
// src/app/page.tsx
const [now, setNow] = useState<Date | null>(null);
useEffect(() => {
  setNow(new Date());
  const id = setInterval(() => setNow(new Date()), 1000);
  return () => clearInterval(id);
}, []);

return <CounterCard now={now} />;
```

### Right

```tsx
// src/app/page.tsx
const [mounted, setMounted] = useState(false);
useEffect(() => {
  setTimeout(() => setMounted(true), 0);
}, []);

if (!mounted) return <DashboardSkeleton />;
return <CounterCard />;
```

```tsx
// src/components/dashboard/counter-card.tsx
export function CounterCard() {
  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  // ...
}
```

### Tick-frequency by card

- **`CounterCard`** — 1s tick (shows seconds).
- **`TimezoneCard`** — 60s tick (only minutes shown, no need for second resolution).
- **Header / Birthday / Moon** — no tick. Call `new Date()` inline at render. They re-render when `refreshKey` changes (pull-to-refresh) or when their parent re-renders for any other reason.

### Trade-off

Header greeting, BirthdayCard days-left, and MoonPhaseCard drift if the dashboard stays open across an hour boundary or midnight. Pull-to-refresh fixes it. Acceptable for this app's usage pattern; if drift becomes a real complaint, add a low-frequency parent tick at 60s+ instead of restoring the 1Hz one.

### Lazy initializer is the safe pattern

`useState<Date>(() => new Date())` runs the initializer once on the client's first render. Compare to `useState(new Date())` which evaluates `new Date()` on every render before discarding all but the first — wasteful and triggers SSR/client mismatch warnings if the component is ever rendered server-side.

---

## 22. Active-Press Feedback for Custom Interactive Surfaces

On a hosted-webapp every navigation is a real network round-trip. Without an immediate visual response to taps, users wonder if the tap registered.

### Right

```tsx
// Custom interactive surfaces (raw button, Link, navbar tile)
className={cn(
  "...",
  "active:scale-[0.95]",
)}
```

### When NOT to add

The shadcn `<Button>` primitive at `src/components/ui/button.tsx` already includes `active:not-aria-[haspopup]:translate-y-px` in its cva config. Adding `active:scale` on top of `<Button>` would compound feedback. Leave `<Button>` instances alone.

### Why scale-only, no transition-transform

Native press feedback feels best when the press itself is instant. The `transition-colors` already on most elements stays for color/bg state; the scale snaps in/out with the touch lifecycle, matching iOS/Android default press behavior. Adding `transition-transform` smooths the snap and feels artificial.

### Canonical examples

- `src/components/navigation/floating-navbar.tsx` — primary tabs and More button (`active:scale-[0.95]`)
- `src/components/dashboard/notification-drawer.tsx` — bell button (`active:scale-95`)
- `src/components/dashboard/logout-button.tsx` — submit button (`active:scale-95`)

---

## 23. Mobile-Friendly Form Input Attributes

Default browser form attributes assume a desktop keyboard. On Android, that means: aggressive autocorrect on a passcode, "return" key where "search" or "go" would be more intuitive, autocapitalize-on-first-letter for handles and search queries. Set the attributes deliberately per field.

### Right

```tsx
// Login passcode
<input
  type="password"
  name="passcode"
  required
  autoComplete="current-password"  // password-manager fill
  autoCapitalize="off"
  autoCorrect="off"
  spellCheck={false}
  inputMode="text"
  enterKeyHint="go"                // Samsung keyboard shows "Go"
/>

// Search box
<input
  type="search"
  inputMode="search"
  enterKeyHint="search"            // magnifying-glass enter key
  autoCorrect="off"
  autoCapitalize="off"
  spellCheck={false}
  aria-label="Search notes"
/>
```

### When NOT to disable autocorrect / spellcheck

Prose textareas (notes, rules, ritual reflections, review fields) — leave platform defaults. The user wants typo-correction in long-form writing. Don't blanket-default the `<Textarea>` component to spellCheck=false; do it per call site only when the field is for handles, codes, or queries.

### Canonical examples

- `src/app/login/page.tsx` — passcode field
- `src/app/notes/page.tsx` — search box

---

## 24. Tap-Target Visibility on Mobile

`opacity-0 group-hover:opacity-100` is a desktop-only reveal. On touch, there is no `:hover` — the element is invisible AND inaccessible. For any action a mobile user needs (delete, edit, share, dismiss), the button must render at a visible-but-muted color on mobile and only hover-reveal at `md:` and up.

### Wrong

```tsx
<button className="opacity-0 group-hover:opacity-100 ...">
  <Trash2 />
</button>
```

Mobile user can't see or tap it.

### Right

```tsx
<button className="opacity-100 text-muted-foreground/40 md:opacity-0 md:text-muted-foreground/20 md:group-hover:opacity-100 ...">
  <Trash2 />
</button>
```

Mobile sees a subtle muted icon. Desktop hover-reveals at full opacity.

### Tap-target sizing

Icon-only buttons need a hit area of ≥24dp. Most lucide icons are `h-3 w-3` (12px) to `h-4 w-4` (16px) — wrap with `p-1.5` (≥24dp) at minimum, `p-2` (≥28dp) for primary panel-dismiss / drawer-close / push-toast actions where misses are costly. Add `active:scale-95` for tactile feedback (or `active:scale-[0.95]` if it's already on a `transition-colors` parent — see Pattern 22).

Skip for shadcn `<Button>` instances; the cva config bakes in `active:translate-y-px`.

### Canonical examples

- `src/app/timeline/page.tsx` and `src/app/ledger/page.tsx` — `Trash2` delete buttons that hover-reveal at `md:` only
- `src/app/permissions/page.tsx` — chevron up/down (`p-1.5`), auto-rule delete (`p-2`)
- `src/components/dashboard/notification-drawer.tsx` — close X (`p-2`)
- `src/components/push-toast.tsx` — dismiss X (`p-2`)

---

## 25. `hideKeyboard()` After Form Submit Success

The soft keyboard does not auto-dismiss when a form's submit button is tapped — it stays up until the user blurs the input. After a successful submit, the form usually closes; leaving the keyboard up wastes screen space and feels broken.

### Right

```ts
useEffect(() => {
  if (!state?.success) return;
  setTimeout(() => {
    formRef.current?.reset();
    setShowForm(false);
    void vibrate(50, "medium");
    void hideKeyboard();
  }, 0);
}, [state]);
```

`hideKeyboard()` from `@/lib/keyboard.ts`:

```ts
import { isNative } from "@/lib/native";
import { logger } from "./logger";

export async function hideKeyboard(): Promise<void> {
  if (!isNative()) return;
  try {
    const { Keyboard } = await import("@capacitor/keyboard");
    await Keyboard.hide();
  } catch (err) {
    logger.error("[keyboard] hide failed:", err);
  }
}
```

Same shape as `vibrate()` — dynamic import, native gate, fire-and-forget via `void`. Web sessions skip silently (the browser handles its own focus lifecycle).

### When to call

In every `useEffect(() => { if (state?.success) { ... } }, [state])` block that closes a form. Currently wired into:

- `src/app/notes/page.tsx` — note compose
- `src/app/timeline/page.tsx` — milestone create
- `src/app/rules/page.tsx` — rule create
- `src/app/tasks/page.tsx` — task create
- `src/app/ledger/page.tsx` — ledger entry create
- `src/app/rituals/page.tsx` — ritual create + edit (two effects)
- `src/app/permissions/page.tsx` — auto-rule submit

If you add a new form whose success closes the form, wire `void hideKeyboard()` in the same effect.

---

## 26. Sir-Only Destructive Admin Controls

Per-page purge buttons and per-item delete UIs that wipe shared data are restricted to T7SEN (Sir). The pattern has three layers:

### 1. Server-side role check (the boundary)

```ts
export async function purgeAllNotes(): Promise<{
  success?: boolean;
  error?: string;
  deletedCount?: number;
}> {
  const author = await getSessionAuthor();
  if (!author) return { error: "Not authenticated." };
  if (author !== "T7SEN") return { error: "Only Sir can purge notes." };

  const ids = (await redis.zrange(INDEX_KEY, 0, -1)) as string[];
  const pipeline = redis.pipeline();
  for (const id of ids) {
    pipeline.del(noteKey(id));
    pipeline.del(`reactions:${id}`);
  }
  pipeline.del(INDEX_KEY);
  pipeline.del(PINNED_KEY);
  pipeline.del(LEGACY_KEY);
  pipeline.set(countKey("T7SEN"), 0);
  pipeline.set(countKey("Besho"), 0);
  if (ids.length > 0) await pipeline.exec();

  revalidatePath("/notes");
  logger.warn(`[notes] Sir purged ${ids.length} notes.`);
  return { success: true, deletedCount: ids.length };
}
```

Every purge logs at `warn` so the action is visible in Sentry as a breadcrumb. Every purge pipelines item-key + index-key + sub-key deletes (audit logs, occurrences, streaks, reactions, counts, quotas, auto-rules, denied-hash sets) so partial failure is impossible.

### 2. Client gate (cosmetic, not security)

```tsx
{isT7SEN && (
  <PurgeButton
    label="Purge all notes"
    onPurge={async () => {
      const r = await purgeAllNotes();
      if (!r.error) setNotes([]);
      return r;
    }}
  />
)}
```

The `<PurgeButton>` component does NOT check the role itself — the caller does. Server-side check is the actual security boundary.

### 3. Two-step confirmation UX

`<PurgeButton>` (at `src/components/admin/purge-button.tsx`):
- First tap → flips to red `Confirm purge` + `Cancel` for 5s, fires medium haptic.
- Second tap within 5s → fires heavy `[100, 50, 100]` haptic, calls `onPurge`, locks the button while busy.
- No tap within 5s → auto-cancel back to initial state.

The same two-tap shape is mirrored on per-item Sir-only delete controls in `notes/page.tsx::NoteItem`, `permissions/page.tsx::RequestItem`, and `review/history-drawer.tsx`. Existing per-item delete mechanisms on tasks, rules, ledger, timeline, rituals, and permissions auto-rules are untouched — they predate this change and use their own role gates.

### Inventory of new server actions

| Action                           | Scope                                      |
| -------------------------------- | ------------------------------------------ |
| `deleteNote(id)`                 | Single note + reactions + index + count    |
| `purgeAllNotes()`                | All notes + reactions + index + counts     |
| `purgeAllRules()`                | All rules + index                          |
| `purgeAllTasks()`                | All tasks + index                          |
| `purgeAllLedgerEntries()`        | All ledger entries + index                 |
| `purgeAllMilestones()`           | All timeline milestones + index            |
| `deletePermissionRequest(id)`    | Single request + audit log + index entry   |
| `purgeAllPermissions()`          | All requests + audit logs + auto-rules + quotas + denied-hashes |
| `purgeAllRituals()`              | All rituals + occurrences + streaks + index |
| `deleteReviewWeek(weekDate)`     | Both authors' records for one week + index |
| `purgeAllReviews()`              | All revealed weeks + index                 |

### Skipped intentionally

- Re-ask block keys (`permission:reask-block:{hash}`) are TTL-bound and left to expire after a permissions purge — sweeping them requires `KEYS *` which Upstash discourages.
- Solo / orphaned weekly review records (one author submitted but never revealed) aren't in the `reviews:revealed` index, so they survive a `purgeAllReviews`. Acceptable trade — the index is the canonical "things the user can navigate to" surface.

---

## 27. `<body>` Suppresses Hydration on Browser-Extension Attributes

Browser extensions (Grammarly, password managers, tab/session managers like the one that injects `inmaintabuse="1"`) modify `<body>` after SSR delivers the HTML and before React hydrates. React compares the DOM with its expected tree and throws a hydration mismatch warning even though no app code is wrong.

### Right

```tsx
// src/app/layout.tsx
<html
  lang="en"
  className={...}
  style={{ colorScheme: "dark" }}
  suppressHydrationWarning
>
  <body className="flex min-h-full flex-col" suppressHydrationWarning>
    {/* ... */}
  </body>
</html>
```

### Why both

`suppressHydrationWarning` is **one level only** — it suppresses for the element it's set on, not its children. Both `<html>` (where `next-themes` typically writes a class) and `<body>` (where extensions write attributes) need it independently. Children inside the layout still hydrate strictly — a real mismatch in any descendant still surfaces normally.

### Don't

- Don't propagate `suppressHydrationWarning` to children to silence other warnings — those are real bugs.
- Don't remove it from `<body>` "for cleanliness" — the extensions are not under your control, and the Honor and Samsung devices may run different ones.

---

## 28. Soft-Delete via Trash Helper

Every `delete*` and `purgeAll*` server action moves records into the trash before the deletion pipeline. Sir restores within 7 days from `/admin/trash`; after the TTL expires, the entry self-evicts.

### Wrong

```ts
// src/app/actions/notes.ts (pre-refactor)
const pipeline = redis.pipeline()
pipeline.del(noteKey(id))
pipeline.zrem(INDEX_KEY, id)
await pipeline.exec()
```

Hard-deletes with no recovery window.

### Right (per-item)

```ts
import { moveToTrash } from "@/lib/trash"

const note = await redis.get<Note>(noteKey(id))
if (!note) return { error: "Note not found." }

const score = await redis.zscore(INDEX_KEY, id)
await moveToTrash(redis, {
  feature: "notes",
  id,
  label: note.content.slice(0, 80),
  deletedBy: author,
  payload: note,
  indexScore:
    typeof score === "number" ? score : Number(score) || note.createdAt,
  recordKey: noteKey(id),
  indexKey: INDEX_KEY,
})

const pipeline = redis.pipeline()
pipeline.del(noteKey(id))
pipeline.zrem(INDEX_KEY, id)
// ... aux deletes (reactions, count, pinned set) — these are not preserved on restore
await pipeline.exec()
```

### Right (purge)

```ts
import { moveManyToTrash } from "@/lib/trash"

const raw =
  ((await redis.zrange<(string | number)[]>(INDEX_KEY, 0, -1, {
    withScores: true,
  })) as (string | number)[]) ?? []
const pairs: { id: string; score: number }[] = []
for (let i = 0; i < raw.length; i += 2) {
  pairs.push({ id: String(raw[i]), score: Number(raw[i + 1]) || 0 })
}
const ids = pairs.map((p) => p.id)

if (ids.length > 0) {
  const records = (await redis.mget<Note[]>(...ids.map(noteKey))) ?? []
  await moveManyToTrash(
    redis,
    pairs.map((p, i) => ({
      feature: "notes" as const,
      id: p.id,
      label: records[i]?.content?.slice(0, 80) ?? p.id,
      deletedBy: author,
      payload: records[i] ?? null,
      indexScore: p.score,
      recordKey: noteKey(p.id),
      indexKey: INDEX_KEY,
    })),
  )
}

// existing pipeline-delete continues unchanged
```

`moveManyToTrash` writes every entry in one pipeline. 100 records is one round-trip, not 100.

### Auxiliary records (reviews)

Features with composite layouts (one logical record → multiple Redis keys) use `extraRecords`:

```ts
await moveToTrash(redis, {
  feature: "reviews",
  id: weekDate,
  recordKey: reviewKey(weekDate, "T7SEN"),
  indexKey: REVEALED_INDEX,
  extraRecords: [
    { key: reviewKey(weekDate, "Besho"), value: beshoReview },
  ],
  // ...
})
```

On restore, `extraRecords[].key` is `SET` alongside the primary `recordKey`.

### What restore preserves

- The primary record JSON (and `extraRecords`).
- The index ZSET entry with the **original** score, so list ordering survives.

### What restore does NOT preserve

This is intentional — capturing every aux key would 10x the trash payload size and complicate the schema for marginal gain. Use the JSON export tool for full backups.

| Feature      | Lost on restore                                                                          |
| ------------ | ---------------------------------------------------------------------------------------- |
| Notes        | reactions hash, pin-set membership, per-author count keys                                |
| Permissions  | audit log; bulk purge wipes quotas / auto-rules / denied-hashes (not restorable per-item) |
| Rituals      | occurrence index + per-date occurrence keys, current/longest streak                       |
| Reviews      | only the single trash entry per week — both authors' records are inside `extraRecords`   |
| Ledger (violations) | `ledger:violations:by-rule:{ruleId}` ZSET membership — restored entries appear in `getLedgerEntries` but NOT in `getViolationsByRule` until manually reconciled |
| Directives    | `directive:active:Besho` sentinel is never restored (terminal-state-only soft-delete). Restored directives appear in history but never re-occupy the active slot. |
| Punishments   | `punishment:active:Besho` sentinel never restored. The auto-created `ledger:{id}` entry is independent — soft-deleting one does NOT cascade to the other. `linkedLedgerId` / `linkedPunishmentId` are back-references, not foreign-key constraints. |
| Tasks / Rules / Ledger (reward & punishment & violation manual) / Timeline | nothing additional — those types only have the index + record |

### Reviews use composite ids

`TrashEntry.id` for reviews is `{weekDate}` (e.g. `2026-04-27`). The global `trash:index` member uses `{feature}::{id}` (double colon) to avoid collision with `:`-containing ids. The trash helper handles this transparently — callers always pass plain ids.

### Score capture

Most features have a timestamp field on the record (`createdAt`, `requestedAt`, `date`). `zscore` is the source of truth, but if it returns `null` (race or schema drift), fall back to the record's timestamp. Don't fall back to `Date.now()` — that re-orders the record on restore.

### Snapshot referenced data at write time

Some entries reference another record by id (e.g. a violation references a rule). When the referenced record is editable or deletable independently of the entry, the entry MUST snapshot the relevant fields at write time. Otherwise a future edit / delete silently rewrites the entry's display.

Currently applied to:

- **`RewardClaim.rewardEmoji` / `rewardLabel` / `rewardBody`** — snapshot of the catalog reward at claim time (`src/app/actions/rewards.ts::claimReward`).
- **`RewardClaim.tierEmoji` / `tierName`** — snapshot of the tier at claim time (same site).
- **`LedgerEntry.ruleSnapshot: { title, body? }` for `type === "violation"`** — snapshot of `rule:{ruleId}` at violation-log time. Body truncated to `MAX_VIOLATION_RULE_SNAPSHOT_BODY_LEN = 1000` chars to keep entry storage bounded. The entry still carries `ruleId` for navigation back to the live rule (which may have been edited or deleted), but rendering reads from the snapshot.

Don't rehydrate from the live source at display time. The snapshot IS the historical truth.

### Inline ledger writes for cross-feature side effects

Most `ledger:{id}` entries flow through `createLedgerEntry`, which fires the standard `ledger_punishment` obedience emit on `type === "punishment"`. Some features need to write a punishment entry as a side effect AND emit a different typed event — going through `createLedgerEntry` would double-count.

The sanctioned pattern is an **inline write** in the feature's action file:

- Mint a `ledger:{id}` UUID.
- Build a complete `LedgerEntry` JSON shape (matching the interface in `@/app/actions/ledger`).
- Pipeline `SET ledger:{id}` + `ZADD ledger:index`.
- Skip the obedience emit at the inline site; the feature's typed event is fired separately at the call site.

Currently applied to:

- **`punishment.completePunishment` / `bailPunishment`** — writes a `ledger:{id}` `punishment` entry with `linkedPunishmentId` back-reference. Inline because the typed `punishment_completed` (+2) / `punishment_bailed` (−20) events are the canonical obedience signal; routing through `createLedgerEntry` would also fire `ledger_punishment` (−10) and double-count.

Don't refactor inline writers to share with `createLedgerEntry` "for consistency" — the divergence is intentional and the alternative is the double-count footgun. If a third caller appears, factor a non-exported `_writeLedgerEntry({ entry, suppressObedienceEmit })` helper inside `ledger.ts`.

### App-state-change grace timers (Capacitor)

When a feature surface needs to respond to "kitten left the app while doing X" (e.g. `<PunishmentOverlay>` running state), use `@capacitor/app::appStateChange` with a refTracked timeout:

```ts
const graceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

useEffect(() => {
  if (!shouldWatch) return;
  let cancelled = false;
  let appHandle: { remove: () => Promise<void> } | null = null;

  void (async () => {
    const { App } = await import("@capacitor/app");
    const handle = await App.addListener("appStateChange", (state) => {
      if (cancelled) return;
      if (state.isActive) {
        // Returned to foreground — cancel pending grace.
        if (graceTimeoutRef.current) {
          clearTimeout(graceTimeoutRef.current);
          graceTimeoutRef.current = null;
        }
        return;
      }
      // Backgrounded — start grace.
      if (graceTimeoutRef.current) clearTimeout(graceTimeoutRef.current);
      graceTimeoutRef.current = setTimeout(() => {
        graceTimeoutRef.current = null;
        // Fire the bail / penalty action.
        void onGraceExpiry();
      }, GRACE_MS);
    });
    if (cancelled) {
      void handle.remove();
      return;
    }
    appHandle = handle;
  })();

  return () => {
    cancelled = true;
    if (graceTimeoutRef.current) {
      clearTimeout(graceTimeoutRef.current);
      graceTimeoutRef.current = null;
    }
    void appHandle?.remove();
  };
}, [shouldWatch, onGraceExpiry]);
```

Critical details:

- Dynamic `import("@capacitor/app")` keeps the web bundle slim. Web silently no-ops because the module load fails harmlessly inside the IIFE try-block — but for safety, wrap it in try/catch so a missing @capacitor/app doesn't throw to the renderer.
- Always clear the timeout in cleanup; otherwise navigating away while backgrounded leaks the grace expiry.
- The `cancelled` flag prevents the listener attaching after the effect has already cleaned up (race during fast remount).

Currently applied in `<PunishmentOverlay>` for the 60s background-grace bail.

---

## 29. Force-Logout via Per-Author Session Epoch

`decrypt()` consults Redis on every JWT verify. This is the single mechanism that lets Sir invalidate Besho's device remotely.

### Pattern

```ts
// src/lib/auth-utils.ts
export async function decrypt(session: string | undefined = "") {
  const { payload } = await jwtVerify(session, encodedKey, { algorithms: ["HS256"] })
  const data = payload as SessionPayload & { iat?: number }

  const iatMs = typeof data.iat === "number" ? data.iat * 1000 : 0
  const epoch = await readSessionEpoch(data.author) // 5s in-process cache
  if (epoch > 0 && iatMs < epoch) return null

  return data
}

export async function revokeAuthorSessions(author: Author) {
  await redis.set(`session:epoch:${author}`, Date.now())
}
```

### Why iat instead of a per-jti revocation list

A per-jti list grows unboundedly and requires bumping every JWT through a deny-list. A per-author epoch invalidates all of that author's tokens at once with a single `SET`.

### Why the in-process cache

`decrypt()` is called from many places — every server action, presence pings, badge polls. A bare Redis read on every call multiplies load by an order of magnitude. The 5s TTL bounds the cutover delay; "instant logout" is not a real requirement for a 2-user app.

### Cache invalidation on revoke

`revokeAuthorSessions` updates the cache entry along with the Redis write so the issuing process sees the new epoch immediately. Other Node processes catch up after 5s.

### Existing JWTs without bumped epoch

Default behavior: epoch absent → `0` → no invalidation. The first revoke creates the marker; the second invalidates everything before it. Don't pre-emptively bump on deploy — that would force-logout everyone on every release.

---

## 30. Admin Sub-Route Convention

`/admin` is a Sir-only sub-tree. The layout redirects, but the layout is **not** the boundary.

### Pattern

```tsx
// src/app/admin/layout.tsx
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const cookieStore = await cookies()
  const session = await decrypt(cookieStore.get("session")?.value)
  if (!session?.author || session.author !== "T7SEN") {
    redirect("/")
  }
  return <>{children}</>
}
```

```ts
// src/app/actions/admin.ts
async function requireSir(): Promise<{ ok: true; session: SessionPayload } | { ok: false; error: string }> {
  const session = await getSession()
  if (!session?.author) return { ok: false, error: "Not authenticated." }
  if (session.author !== "T7SEN") return { ok: false, error: "Forbidden." }
  return { ok: true, session }
}

export async function someAdminAction() {
  const guard = await requireSir()
  if (!guard.ok) return { error: guard.error }
  // ... real work
}
```

### Why both

The layout exists so non-Sir don't see broken-looking pages on direct-link load. The action guard is the actual security boundary — server actions are public endpoints, the client is adversarial. Skip the action guard and you've shipped a privilege-escalation bug.

### Admin entry in floating navbar

The More-sheet item is conditionally appended to `MORE_ITEMS` after `getCurrentAuthor()` resolves. The render flicker (one tick where it's hidden) is acceptable because non-Sir would never see it anyway and the route guard catches direct navigation.

```tsx
const [isT7SEN, setIsT7SEN] = useState(false)
useEffect(() => {
  let cancelled = false
  void (async () => {
    try {
      const author = await getCurrentAuthor()
      if (!cancelled) setIsT7SEN(author === "T7SEN")
    } catch {
      // unauth or transient — leave hidden
    }
  })()
  return () => { cancelled = true }
}, [])

const moreItems = useMemo(
  () => (isT7SEN ? [...MORE_ITEMS, ADMIN_ITEM] : MORE_ITEMS),
  [isT7SEN],
)
```

---

## 31. Bilingual Text — `dir="auto"` on Every Text-Bearing Element

Both authors are bilingual (Arabic + English). Every element that holds typed-by-a-user text — whether it's an input being typed into OR a display surface rendering a stored field — MUST set `dir="auto"`. The browser's BiDi algorithm uses the first strong directional character to decide RTL or LTR alignment, so Arabic content right-aligns automatically and English left-aligns, with no toggle, no user setting, and no JS.

This is not a "sometimes" rule. New components that render user text MUST include `dir="auto"` from the first commit. New input primitives MUST default to it like the shadcn `<Textarea>` does.

### Where to apply

**Inputs (where the user types):**

- All raw `<input>` of types `text` / `search` / `email` / `url` / `tel` / `password` / no-type.
- All raw `<textarea>`.
- All raw `<select>`.

**Display surfaces (where user-entered text renders):**

- Any `<p>`, `<span>`, `<div>`, `<h1>…<h6>`, etc. whose content includes a user-supplied field. Common field names: `.title`, `.body`, `.description`, `.content`, `.text`, `.notes`, `.note`, `.reason`, `.reply`, `.terms`, `.message`, `.label`, `.feedback`, `.author` (when sourced from quote APIs that may be Arabic), record snapshots like `.ruleSnapshot.title`, etc.

### Where it's already handled (don't duplicate)

- **`<Textarea>` primitive** (`src/components/ui/textarea.tsx`) defaults to `dir="auto"`. Consumers can still override.
- **`<MarkdownRenderer>`** (`src/components/ui/markdown-renderer.tsx`) sets `dir="auto"` on its outer `<div>`. Anything piping user text through `<MarkdownRenderer content={...} />` is fine — don't add a redundant attribute on a wrapping element.
- **`<RichTextEditor>`** uses both: the textarea via the primitive default, the preview via `<MarkdownRenderer>`.

### Where NOT to apply

These are deliberately skipped — `dir="auto"` is meaningless or actively harmful:

- **Browser-chromed inputs:** `<input type="checkbox">`, `radio`, `hidden`, `datetime-local`, `date`, `time`, `number`, `range`, `color`, `file`. The native UI controls layout; `dir="auto"` interferes with the chrome.
- **Static UI labels:** "Submit", "Cancel", "Approved", category chips, status pills, timestamps, IDs, hashes, navigation item names, form `<label>` text.
- **Constants from static catalogs:** `ADMIN_SETTINGS`, `OBEDIENCE_EVENT_LABELS`, `WEEKDAY_LABELS`, `TITLE_BY_AUTHOR`, mood/zodiac labels, default category names — these are static English (or static Arabic where i18n applies later), not user-typed.
- **Computed strings:** counts, badges, derived metrics, formatted dates.

### Convention: first attribute

Place `dir="auto"` as the FIRST attribute after the tag name, before any other attributes. Keeps the diff readable across the codebase, signals intent, and makes the rule auditable with grep.

### Wrong (display surface)

```tsx
<p className="mt-1 whitespace-pre-wrap text-sm text-emerald-100/90">
  {request.terms}
</p>
```

Arabic content here renders left-aligned because the default `<p>` direction is inherited from the document (LTR).

### Right (display surface)

```tsx
<p
  dir="auto"
  className="mt-1 whitespace-pre-wrap text-sm text-emerald-100/90"
>
  {request.terms}
</p>
```

### Wrong (input)

```tsx
<input
  id="reason"
  name="reason"
  type="text"
  required
/>
```

### Right (input)

```tsx
<input
  dir="auto"
  id="reason"
  name="reason"
  type="text"
  required
/>
```

### Right (primitive default)

```tsx
function Textarea({
  className,
  dir = "auto",
  ...props
}: React.ComponentProps<"textarea">) {
  return <textarea dir={dir} className={cn(...)} {...props} />
}
```

The default is overridable via prop. Consumers that explicitly want LTR-only (e.g. a code-input box) can pass `dir="ltr"` and bypass auto-detection.

### Form serialization is unaffected

`dir="auto"` is purely a render hint. Form submissions encode the typed string as the user typed it; the server receives the same characters regardless of direction. No special handling needed in server actions.

### Why `dir="auto"` and not `dir="rtl"` for Arabic

`dir="rtl"` forces RTL regardless of content — Arabic AND English would both be right-aligned, which looks wrong for English text. `dir="auto"` flips per-element based on content, so the same input renders correctly whichever language the user chose.

### Sweep audit

When adding a new feature, grep for these patterns in your touched files:

```
grep -E "<(input|textarea|select)" path/to/file.tsx | grep -v 'dir='
grep -E "{[a-z]+\.(title|body|description|reason|reply|terms|notes|message|label|feedback|content|text)}" path/to/file.tsx
```

Anything turning up in the first grep needs `dir="auto"` (with the type-skip exceptions above). Anything in the second grep needs review — confirm it's wrapped in `<MarkdownRenderer>` or has `dir="auto"` on the rendering element.

---

## Cross-References

- `src/lib/native.ts` — `isNative()` and `globalThis` cast example
- `src/lib/haptic.ts` — `void vibrate(...)` pattern
- `src/lib/keyboard.ts` — `hideKeyboard()` for form-submit-success effects
- `src/lib/constants.ts` — `Author` type, `AUTHOR_COLORS` map, `partnerOf` helper, `TITLE_BY_AUTHOR`
- `src/components/biometric-gate.tsx` — `setTimeout` defer, listener cleanup, debounce ref
- `src/components/fcm-provider.tsx` — chained listener cleanup via `cleanupRef`
- `src/components/sentry-user-provider.tsx` — `@capacitor/device` + `@capacitor/app` Sentry context on mount
- `src/components/ui/sheet.tsx` — shadcn Sheet helper (used by the floating-navbar More sheet via the Dialog primitive directly)
- `src/components/ui/rich-text-editor.tsx` — `forceMount` on Write tab so submitted forms always have the textarea
- `src/components/navigation/floating-navbar.tsx` — Dialog-direct + motion drag-to-dismiss; `active:scale-[0.95]`
- `src/components/navigation-progress.tsx` — top progress bar fired on internal `<a href>` clicks
- `src/components/dashboard/today-strip.tsx` — daily-attention chip strip wired to `useNavBadges` + `getTodayMoods`
- `src/components/dashboard/distance-card.tsx` — `@capacitor/geolocation` consumer; Haversine + status badge
- `src/components/dashboard/counter-card.tsx` — own internal 1Hz tick + anniversary countdown (closer of next 30-day vs yearly milestone), unit-toggle drives both the main and anniversary numbers
- `src/components/dashboard/timezone-card.tsx` — own internal 60s tick
- `src/components/admin/purge-button.tsx` — Sir-only two-step destructive confirm. Caller gates render
- `src/lib/trash.ts` — soft-delete helper (`moveToTrash`, `moveManyToTrash`, `restoreFromTrash`, `listTrash`, `purgeTrash`)
- `src/lib/activity.ts` — `recordActivity` (logger side-effect), `getActivity`, `clearActivity`
- `src/lib/auth-utils.ts` — `decrypt` epoch check, `revokeAuthorSessions`, `readAllSessionEpochs`
- `src/app/admin/layout.tsx` — Sir-only redirect guard
- `src/app/actions/admin.ts` — `requireSir`, inspector, push test, sessions, export, trash list/restore/purge, activity feed
- `src/hooks/use-network.ts` — Capacitor-aware network status
- `src/hooks/use-pull-to-refresh.ts` — bails when touch starts inside `[role="dialog"]`
- `src/app/template.tsx` — per-route enter animation, `ROUTE_ORDER` for directional slide
- `src/app/actions/notes.ts` — pipeline pattern, action return shape
- `src/app/actions/rules.ts` — server-side role enforcement, `_removed` rename
- `src/app/actions/permissions.ts` — optimistic UI consumer, validation cascade
- `src/app/permissions/page.tsx::handleDecide` — canonical optimistic UI implementation
- `src/app/api/presence/route.ts` — async `cookies()`, unused-vars disable
