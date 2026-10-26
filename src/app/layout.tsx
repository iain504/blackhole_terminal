import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "BLACKHOLE Terminal — Charts, Alerts & Trading by Alpaca",
  description:
    "BLACKHOLE Terminal — TradingView-style terminal with US stock & crypto charts, drawings, price alerts, Telegram notifications, economic calendar and heat map. Data provided by Alpaca. Protected by 2FA.",
  keywords: ["trading", "charts", "alpaca", "crypto", "watchlist", "alerts", "economic calendar"],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
};

export const viewport: Viewport = {
  themeColor: "#09090b",
  width: "device-width",
  initialScale: 1,
  // viewport-fit=cover lets the mobile shell pad for the iOS home indicator
  // via env(safe-area-inset-bottom) (Task 56 mobile interface).
  viewportFit: "cover",
};

// Task 28 — apply the saved UI theme (localStorage 'tt_ui_theme') BEFORE
// first paint so switching to the Christmas skin never flashes the default
// zinc surfaces. Runs pre-hydration; <html> carries suppressHydrationWarning.
const UI_THEME_BOOT = `(function(){try{if(localStorage.getItem('tt_ui_theme')==='christmas'){document.documentElement.classList.add('theme-christmas');}}catch(e){}})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: UI_THEME_BOOT }} />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-zinc-950 text-zinc-200`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
