import type { CapacitorConfig } from "@capacitor/cli";
import { KeyboardResize, KeyboardStyle } from "@capacitor/keyboard";

const config: CapacitorConfig = {
  appId: "me.t7senlovesbesho",
  appName: "Our Space",
  webDir: "public",
  server: {
    url: "https://t7senlovesbesho.me",
    cleartext: false,
    // Explicit allowlist — any link that resolves outside this host
    // opens in the system browser instead of the WebView. For a
    // hosted-webapp APK this is mostly defensive (we control the
    // origin), but it makes the boundary auditable.
    allowNavigation: ["t7senlovesbesho.me"],
  },
  // Distinguish APK from web in Sentry user-agent + server access
  // logs. Sentry tags `browser` will read this verbatim.
  appendUserAgent: "OurSpaceAPK",
  plugins: {
    SplashScreen: {
      launchShowDuration: 1500,
      backgroundColor: "#09090b",
      showSpinner: false,
      androidScaleType: "CENTER_CROP",
    },
    StatusBar: {
      style: "DARK",
      backgroundColor: "#09090b",
    },
    LocalNotifications: {
      smallIcon: "ic_launcher_foreground",
      iconColor: "#a855f7",
    },
    Keyboard: {
      // Architectural Fix: Stops the OS from crushing the webview.
      // The keyboard will now slide OVER the app, and React will handle the UI.
      resize: KeyboardResize.None,
      style: KeyboardStyle.Dark,
      resizeOnFullScreen: true,
    },
  },
  android: {
    backgroundColor: "#09090b",
    allowMixedContent: false,
  },
};

export default config;
