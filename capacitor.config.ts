import type { CapacitorConfig } from "@capacitor/cli";
import { KeyboardResize, KeyboardStyle } from "@capacitor/keyboard";

const config: CapacitorConfig = {
  appId: "me.t7senlovesbesho",
  appName: "Our Space",
  webDir: "public",
  server: {
    url: "https://t7senlovesbesho.me",
    cleartext: false,
  },
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
    PushNotifications: {
      presentationOptions: ["badge", "sound", "alert"],
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
