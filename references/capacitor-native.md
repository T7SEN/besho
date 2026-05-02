# Capacitor & Native Handling

Reference for Capacitor 8 integration, the hosted-webapp architecture, no-GMS handling, and the BiometricGate component.

## Architecture: Hosted-Webapp via `server.url`

**This is the most important detail in this document.** `capacitor.config.ts`:

```ts
const config: CapacitorConfig = {
  appId: "me.t7senlovesbesho",
  appName: "Our Space",
  webDir: "public",
  server: {
    url: "https://t7senlovesbesho.me",
    cleartext: false,
  },
  plugins: {
    // ...
  },
};
```

When `server.url` is set, Capacitor's WebView ignores `webDir` entirely. Instead, on app launch, the WebView navigates directly to `https://t7senlovesbesho.me`. The APK is a **thin native shell** containing only:

- The Capacitor runtime
- All Capacitor plugins (haptics, biometric, push, preferences, network, keyboard, status bar, splash screen, badge)
- The keystore-signed identity (`me.t7senlovesbesho`)
- The notification channel registration
- The splash screen and status bar config

**There is no bundled web build.** The web app is served live from Vercel.

### What this enables

- **Instant deploys.** Push to `main` → Vercel deploys → both phones see the update on next launch with zero APK rebuild.
- **All Next.js features work.** Server actions, route handlers, SSE, Edge runtime, dynamic rendering — all available because the page is served live from Next.js.
- **Capacitor plugins still work.** The native bridges are injected into the WebView regardless of where the page loaded from. Haptics, biometric, FCM, etc. all behave normally.

### What this constrains

- **No offline support.** App requires connectivity to load. The WebView shows a system network error page if there's no connection at launch.
- **Mid-session network drops degrade gracefully.** The `useNetwork` hook (driven by `@capacitor/network`) drives the offline banner in `notes/page.tsx` and disables the submit button. Server actions fail and surface their errors via the existing UI.
- **No Service Worker / PWA features.** The WebView's service worker support inside Capacitor is unreliable, and `server.url` makes them moot anyway since there's nothing local to cache. Web Push, Background Sync, and offline app shell are all unavailable.
- **APK rebuilds are still needed when:**
  - `capacitor.config.ts` changes (plugin config, `appName`, splash, etc.)
  - A new Capacitor plugin is added or removed
  - The keystore or signing config changes
  - The Android manifest needs new permissions
  - But **never** for routine code changes — those ship via Vercel.

### Why this is intentional

For a two-user app where both users have reliable cellular and home WiFi, the trade-off skews heavily in favor of fast iteration:

- **Pro:** Days saved per month not rebuilding APKs for content changes.
- **Pro:** Server-rendered features (SSE, server actions) work without static-export gymnastics.
- **Con:** No offline support — but neither user has expressed needing it, and the previous offline-notes infrastructure was never functional anyway.

A future migration to a bundled APK would require:

1. Configuring Next.js for static export (`output: 'export'`)
2. Hosting all API routes separately (or as separate Edge functions)
3. Dropping or restructuring SSE
4. Wiring a manifest of API base URLs per environment
5. Bumping APK on every content change

This is a real project, not a config tweak. Not justified for current usage.

**Refuse "remove `server.url` to add offline" requests** unless the requester is willing to do all of the above and accepts the deploy-cycle cost.

---

## Platform Detection

`src/lib/native.ts` — the **only** sanctioned platform check. Don't sniff user agents, don't check `window.matchMedia`, don't probe for `Capacitor` directly.

```ts
import { isNative } from "@/lib/native";

if (isNative()) {
  // Capacitor plugin path
} else {
  // Web fallback
}
```

The implementation:

```ts
interface GlobalWithCapacitor {
  Capacitor?: {
    isNativePlatform?: () => boolean;
  };
}

export const isNative = (): boolean => {
  if (typeof globalThis === "undefined") return false;
  const cap = (globalThis as unknown as GlobalWithCapacitor).Capacitor;
  return typeof cap !== "undefined" && cap.isNativePlatform?.() === true;
};
```

Note the `globalThis as unknown as { ... }` pattern — this is the canonical browser-globals access pattern across the entire codebase.

---

## Plugin Matrix

All Capacitor plugins are imported **dynamically** to keep the web bundle slim.

| Plugin                                | Used in                                 | Purpose                                                   |
| ------------------------------------- | --------------------------------------- | --------------------------------------------------------- |
| `@aparajita/capacitor-biometric-auth` | `BiometricGate`                         | Fingerprint / Face Unlock                                 |
| `@capacitor/preferences`              | `BiometricGate`, login flow             | Persistent key-value (replaces localStorage on native)    |
| `@capacitor/push-notifications`       | `FCMProvider`                           | FCM token + foreground/tap listeners                      |
| `@capacitor/local-notifications`      | `useLocalNotifications`                 | Offline reminders for task/rule deadlines                 |
| `@capacitor/haptics`                  | `vibrate()` in `src/lib/haptic.ts`      | Native vibration via Android API                          |
| `@capacitor/clipboard`                | `writeToClipboard`, `readFromClipboard` | Works without WebView focus, unlike `navigator.clipboard` |
| `@capacitor/app`                      | `BiometricGate`, `CapacitorInit`        | App lifecycle (`appStateChange`)                          |
| `@capacitor/keyboard`                 | `useKeyboardHeight`                     | Keyboard show/hide events for layout adjustment           |
| `@capacitor/network`                  | `useNetwork`, `CapacitorInit`           | Network status — drives offline banner in `/notes`        |
| `@capacitor/status-bar`               | `CapacitorInit`                         | Tint and visibility                                       |
| `@capacitor/splash-screen`            | `CapacitorInit`                         | Hide on app ready                                         |
| `@capawesome/capacitor-badge`         | Badge updates                           | App icon badge count                                      |

### Dynamic import pattern

```ts
if (isNative()) {
  try {
    const { Haptics, ImpactStyle } = await import("@capacitor/haptics");
    await Haptics.impact({ style: ImpactStyle.Medium });
  } catch (err) {
    logger.error("[haptic] Capacitor haptics failed:", err);
  }
}
```

Always wrap in `try/catch`. Plugin failures must never crash the calling code path.

---

## No-GMS Handling (Honor Device)

Besho's Honor phone and tablet have **no Google Mobile Services**. Anything that depends on Google Play APIs will fail. The codebase handles this in two places:

### 1. FCMProvider — `src/components/fcm-provider.tsx`

```ts
const errorListener = await PushNotifications.addListener(
  "registrationError",
  (err) => {
    logger.warn(`[fcm] Registration error for ${author} (Likely No GMS):`, {
      error: err,
    });
  },
);
```

The error is **caught and logged**. It does not throw. The app continues to function normally — only background push delivery is unavailable.

### 2. Server-side: assume token may be null

Server-side code that touches the FCM path must always `await redis.get<string>(`push:fcm:${author}`)` and check for null. Treat the absence as **expected**, not exceptional. See [`./push-routing.md`](./push-routing.md).

### Accepted regression

Besho receives **zero background notifications** on the Honor device. The notification is logged to `notifications:Besho` and surfaces via:

- `NotificationDrawer` (in-app, opens via the bell in `TopNavbar`)
- `useNavBadges` (red dot on `FloatingNavbar` items when there's unread content)
- SSE real-time updates when she's actively in `/notes`

This is intentional. It is **not a bug to fix**.

### Why No Web Push

This section exists to preempt the eventual "let me add Web Push as a fallback for Honor" proposal. The reasoning:

1. **The hosted-webapp architecture (`server.url`) makes Web Push impractical.** Service worker support inside Capacitor's WebView is inconsistent across Android OEM customizations. Honor's WebView in particular has known issues. Building a feature whose reliability depends on the most-divergent WebView implementation in the user base is folly.

2. **Web Push without a service worker is a contradiction.** Web Push requires a service worker to receive `push` events. Adding one back means rebuilding PWA infrastructure (Serwist or equivalent), which we explicitly removed.

3. **The cost-to-benefit ratio is bad.** Maintaining two transport stacks (FCM + Web Push) for a two-user app is disproportionate. The user-facing benefit is "Besho gets background pushes when she's offline-but-the-server-is-up" — a narrow window.

4. **The accepted regression already has mitigations** (history list, badge dot, SSE). They cover the realistic use cases.

If a future contribution proposes adding Web Push back, they must:

- Demonstrate the previous reasoning no longer applies (e.g., Honor stopped shipping or got GMS).
- Implement and test on an actual Honor device (not assumptions).
- Plan for maintaining two push stacks indefinitely.

If those bars aren't met: refuse.

---

## BiometricGate

`src/components/biometric-gate.tsx`. The fullscreen lock overlay and the primary unlock mechanism on native.

### Invariants

- Renders above all routes **except** `UNGUARDED_ROUTES` (currently the login route).
- Web/desktop falls through immediately — `isNative()` → `false` → state set to `'unavailable'` and children render.
- Reads `biometric_enrolled` from `@capacitor/preferences` to decide whether to prompt on cold start.
- `last_unlocked_at` (also in Preferences) gates a **cold-start grace period** — if the user unlocked recently, skip the prompt to avoid annoying loops.
- `appStateChange` listener re-locks after `LOCK_AFTER_MS` of background time.

### The Knox/Honor Double-Prompt Loop

Samsung Knox and Honor's biometric subsystem fire a redundant `appStateChange` event 0–500ms after the auth prompt closes. Without protection, this triggers a second prompt immediately after the first dismissal.

The fix:

```ts
const lastAuthEndedAtRef = useRef<number>(0);

// In appStateChange handler:
if (Date.now() - lastAuthEndedAtRef.current < 2000) return;
```

A 2-second debounce window absorbs the spurious event. **Do not remove this ref.** It looks redundant. It is not.

### State machine

```
checking → (native?) ↘
                     locked → prompting → unlocked
                                       ↘ locked (failed)
checking → (web?) → unavailable
```

`gateState` transitions:

- `'checking'` → initial
- `'locked'` → ready to prompt or already failed
- `'prompting'` → biometric dialog open
- `'unlocked'` → children render
- `'unavailable'` → web fallthrough or no biometry on device

### Failure handling

After `MAX_AUTO_FAILURES` consecutive failures, the gate offers a "Use Password" fallback (`authError === 'use_password'`) which routes to the password login flow.

---

## Build Pipeline

### Web (frequent)

Vercel builds the Next.js app on push to `main`. Standard pipeline — nothing Capacitor-specific. **APK is not rebuilt for routine code changes** because the WebView loads from Vercel.

### Android (rare)

Only needed when:

- `capacitor.config.ts` changes
- Capacitor plugins are added/removed
- Native code or manifest changes
- Keystore changes
- Releasing a versioned APK to install on a device

```bash
pnpm build              # Next.js production build (mostly unused — webDir is "public")
npx cap sync android    # Copy plugin configs into android/
```

Then build the APK from Android Studio. The `android/` directory is **gitignored** — it's regenerated locally from `capacitor.config.ts`.

### Capacitor config

```ts
const config: CapacitorConfig = {
  appId: "me.t7senlovesbesho", // PERMANENT — Play Store identity
  appName: "Our Space", // Display name on home screen
  webDir: "public", // Ignored when server.url is set
  server: {
    url: "https://t7senlovesbesho.me",
    cleartext: false,
  },
};
```

**Never change `appId`.** It's the device-side primary key for installs, biometric enrollment, FCM tokens, and Preferences storage. Changing it creates a new "app" on every existing device.

`appName` is what the user reads — change freely. The change propagates through `cap sync` to `android/app/src/main/res/values/strings.xml`. Don't edit `strings.xml` directly; it gets regenerated.

---

## Keystore

`C:\Users\T7SEN\keys\ourspace.jks`. Used to sign release APKs.

- **Never commit** the keystore or its passwords to the repo or any `.env*` file.
- **Never log** the passwords.
- Keep an offline backup. Losing the keystore means losing the ability to publish updates without forcing every user to uninstall and reinstall.

---

## Versioning

`android/app/build.gradle`:

```gradle
defaultConfig {
	applicationId "me.t7senlovesbesho"
	versionCode 14    // bump for every release
	versionName "1.4.0"  // human-readable
}
```

`versionCode` must increase monotonically. `versionName` should track `package.json`'s `version` field.

Note: because of the `server.url` architecture, you'll bump `versionCode` much less often than in a bundled-APK app. Most "releases" are Vercel deploys.

---

## Cross-References

- `src/lib/native.ts` — `isNative()`
- `src/lib/haptic.ts` — `vibrate()`
- `src/lib/clipboard.ts` — `writeToClipboard`, `readFromClipboard`
- `src/components/biometric-gate.tsx`
- `src/components/fcm-provider.tsx`
- `src/components/capacitor-init.tsx`
- `src/hooks/use-network.ts` — `@capacitor/network` integration
- `src/hooks/use-local-notifications.ts`
- `src/hooks/use-keyboard.ts`
- `capacitor.config.ts` (root)
