import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Absolute base for the social-preview (Open Graph / Twitter) image URLs, from configuration: set APP_BASE_URL (or NEXTAUTH_URL) to the
// real HTTPS address BEFORE building, otherwise previews would point at the wrong host. The icon, apple-icon and the 1200x630 preview
// images are the files in this folder (icon.svg, favicon.ico, apple-icon.png, opengraph-image.png, twitter-image.png).
function metadataBase(): URL | undefined {
  try {
    const raw = process.env.APP_BASE_URL || process.env.NEXTAUTH_URL;
    return raw ? new URL(raw) : undefined;
  } catch {
    return undefined;
  }
}

const TITLE = "DIRECTOR.LTD — Companies House Intelligence Platform";
const DESCRIPTION = "Search, filter and monitor Companies House company data. Build custom reports, track leads and manage follow-ups in one platform.";

export const metadata: Metadata = {
  metadataBase: metadataBase(),
  title: {
    default: TITLE,
    template: "%s — DIRECTOR.LTD",
  },
  description: DESCRIPTION,
  openGraph: { type: "website", siteName: "DIRECTOR.LTD", title: TITLE, description: DESCRIPTION },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-white text-slate-900">{children}</body>
    </html>
  );
}
