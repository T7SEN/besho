import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "me.t7senlovesbesho",
  appName: "Our Space",
  webDir: "public",
  // Points the WebView at the live Vercel deployment.
  // The app is a shell — all logic stays on Vercel.
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
  },
  android: {
    backgroundColor: "#09090b",
    allowMixedContent: false,
  },
};

export default config;
