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
      // Must exist in android/app/src/main/res/drawable/
      // Use ic_launcher_foreground as a safe default that Capacitor
      // always generates. Replace with a proper 24dp monochrome icon
      // for production.
      smallIcon: "ic_launcher_foreground",
      iconColor: "#a855f7",
    },
    Keyboard: {
      // Body resize: the document body shrinks when the keyboard opens.
      // This is the most compatible mode for Next.js web apps.
      resize: KeyboardResize.Body,
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
