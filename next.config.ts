import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

// Static CSP (no per-request nonce): Next.js App Router needs inline scripts
// for hydration, so script-src keeps 'unsafe-inline'. Everything that can be
// locked down is: no framing, no plugins, same-origin connections/forms only.
// Move to a nonce-based policy (proxy.ts) if a stricter script policy is required.
//
// frame-src: the website editor's video sections embed YouTube (privacy-enhanced domain) and Vimeo players, and the editor page
// itself frames its own canvas ('self'); nothing else can be embedded.
// The editor's canvas (/website-preview/editor) is the one page that may be framed, and only by this same origin.
const cspFor = (frameAncestors: string) =>
  [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${isDev ? " ws: wss:" : ""}`,
    "frame-src 'self' https://www.youtube-nocookie.com https://player.vimeo.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `frame-ancestors ${frameAncestors}`,
    ...(isDev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");

const commonHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // camera=(self): this site's own pages may ask for the camera (the profile "Take a photo" button, which still needs the person's
  // permission); embedded third-party frames never may. Everything else stays switched off.
  { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=(), payment=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

const securityHeaders = [{ key: "Content-Security-Policy", value: cspFor("'none'") }, { key: "X-Frame-Options", value: "DENY" }, ...commonHeaders];
const editorCanvasHeaders = [{ key: "Content-Security-Policy", value: cspFor("'self'") }, { key: "X-Frame-Options", value: "SAMEORIGIN" }, ...commonHeaders];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // pdfkit reads its built-in font files from disk at runtime, so it must not be bundled.
  serverExternalPackages: ["pdfkit"],
  async headers() {
    // Every path gets the strict set, except the editor canvas, which is matched by the one rule that allows same-origin framing.
    return [
      { source: "/((?!website-preview/editor$).*)", headers: securityHeaders },
      { source: "/website-preview/editor", headers: editorCanvasHeaders },
    ];
  },
};

export default nextConfig;
