import type { Metadata, Viewport } from "next";
import { Source_Sans_3, Tajawal } from "next/font/google";
import "./globals.css";
import { cn } from "@/lib/utils";
import { ThemeProvider } from "@/components/theme-provider";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { Analytics } from "@vercel/analytics/next";
import { TooltipProvider } from "@/components/ui/tooltip";
import { FloatingNavbar } from "@/components/navigation/floating-navbar";
import { CapacitorInit } from "@/components/capacitor-init";
import { PushToast } from "@/components/push-toast";
import { FCMProvider } from "@/components/fcm-provider";
import { BiometricGate } from "@/components/biometric-gate";
import { TopNavbar } from "@/components/navigation/top-navbar";
import { PullToRefresh } from "@/components/pull-to-refresh";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { GlobalLogger } from "@/components/global-logger";
import { SentryUserProvider } from "@/components/sentry-user-provider";

const sourceSans3 = Source_Sans_3({
  subsets: ["latin"],
  variable: "--font-source-sans",
  display: "swap",
  adjustFontFallback: false,
});

const tajawal = Tajawal({
  subsets: ["arabic"],
  weight: ["400", "500", "700"],
  variable: "--font-tajawal",
  display: "swap",
  adjustFontFallback: false,
});

const APP_NAME = "Our Space";
const APP_DEFAULT_TITLE = "Our Space";
const APP_TITLE_TEMPLATE = "%s | Our Space";
const APP_DESCRIPTION = "A private digital space for us.";

export const viewport: Viewport = {
  themeColor: "#09090b",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

export const metadata: Metadata = {
  applicationName: APP_NAME,
  title: {
    default: APP_DEFAULT_TITLE,
    template: APP_TITLE_TEMPLATE,
  },
  description: APP_DESCRIPTION,
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: APP_DEFAULT_TITLE,
  },
  formatDetection: {
    telephone: false,
  },
  openGraph: {
    type: "website",
    siteName: APP_NAME,
    title: { default: APP_DEFAULT_TITLE, template: APP_TITLE_TEMPLATE },
    description: APP_DESCRIPTION,
  },
  twitter: {
    card: "summary",
    title: { default: APP_DEFAULT_TITLE, template: APP_TITLE_TEMPLATE },
    description: APP_DESCRIPTION,
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={cn(
        "h-full antialiased dark",
        sourceSans3.variable,
        tajawal.variable,
        "font-sans",
      )}
      style={{ colorScheme: "dark" }}
      suppressHydrationWarning
    >
      <body className="flex min-h-full flex-col">
        <GlobalLogger />
        <ErrorBoundary>
          <ThemeProvider
            attribute="class"
            defaultTheme="dark"
            forcedTheme="dark"
            disableTransitionOnChange
          >
            <TooltipProvider>
              <BiometricGate>
                <PullToRefresh />
                <TopNavbar />
                {children}
                <CapacitorInit />
                <PushToast />
                <FCMProvider />
                <SentryUserProvider />
                <FloatingNavbar />
              </BiometricGate>
            </TooltipProvider>
          </ThemeProvider>
        </ErrorBoundary>
        <SpeedInsights />
        <Analytics />
      </body>
    </html>
  );
}
