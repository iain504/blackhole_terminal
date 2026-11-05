import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, LXGW_WenKai_TC, Ma_Shan_Zheng } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { InkBackdrop } from "@/components/theme/InkBackdrop";

// v2.12.15 — 毛筆繁中 typography for the Taoist landing page.
// LXGW WenKai TC (霞鶩文楷·繁) has FULL Traditional-Chinese glyph coverage
// with a brush-pen 楷 feel; Ma Shan Zheng (马善政毛筆楷書) is the true
// calligraphy display face for big titles/seals. Both self-hosted by
// next/font at build time; CJK slices load on demand (preload: false —
// preloading ~120 CJK unicode-range slices would waste the bandwidth budget).

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const wenkaiTC = LXGW_WenKai_TC({
  weight: ["300", "400", "700"],
  subsets: ["latin"],
  preload: false,
  display: "swap",
  variable: "--font-kai",
});

const brushScript = Ma_Shan_Zheng({
  weight: "400",
  subsets: ["latin"],
  preload: false,
  display: "swap",
  variable: "--font-brush",
});

export const metadata: Metadata = {
  title: "黑洞終端 BLACKHOLE Terminal — Charts, Alerts & Trading by Alpaca",
  description:
    "玄之又玄，眾妙之門 — BLACKHOLE Terminal（黑洞終端），TradingView-style 自託管交易終端：美股與加密貨幣走勢、畫線、價格警報、Telegram 通知、經濟日曆與熱力圖。數據由 Alpaca 提供，2FA 保護。",
  keywords: [
    "trading",
    "charts",
    "alpaca",
    "crypto",
    "watchlist",
    "alerts",
    "economic calendar",
    "交易終端",
    "黑洞終端",
    "價格警報",
  ],
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
// zinc surfaces (v1.88.0: same for the light "Day" skin). Runs pre-hydration;
// <html> carries suppressHydrationWarning.
const UI_THEME_BOOT = `(function(){try{var t=localStorage.getItem('tt_ui_theme');var m={christmas:'#07150d',day:'#edf0f3'}[t];if(m){document.documentElement.classList.add('theme-'+t);var el=document.querySelector('meta[name="theme-color"]');if(el)el.setAttribute('content',m);}}catch(e){}})();`;

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
        className={`${geistSans.variable} ${geistMono.variable} ${wenkaiTC.variable} ${brushScript.variable} antialiased bg-zinc-950 text-zinc-200`}
      >
        {/* v2.12.11 — Chinese ink-painting backdrop: 雕 above misty mountains,
            fixed behind every page at z-0 (page roots are z-10 translucent) */}
        <InkBackdrop />
        {children}
        <Toaster />
      </body>
    </html>
  );
}
