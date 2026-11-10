import { test, after } from "node:test";
import assert from "node:assert/strict";
import { BASE, db } from "./helpers";

after(async () => {
  await db.$disconnect();
});

// The production build, served. These check what a browser is actually sent; the interactive behaviour (banner clicks, camera
// capture) is covered by the real-browser run described in the report.

test("the favicon, apple icon and social preview images are served with the right types and sizes", async () => {
  const get = async (p: string) => {
    const r = await fetch(`${BASE}${p}`);
    return { status: r.status, type: r.headers.get("content-type") ?? "", body: Buffer.from(await r.arrayBuffer()) };
  };
  const ico = await get("/favicon.ico");
  assert.equal(ico.status, 200);
  assert.match(ico.type, /icon|octet/);
  assert.equal(ico.body.readUInt16LE(4), 3, "a 3-size .ico");
  const svg = await get("/icon.svg");
  assert.equal(svg.status, 200);
  assert.match(svg.type, /svg/);
  assert.match(svg.body.toString(), /#1a56e8/);
  const apple = await get("/apple-icon.png");
  assert.deepEqual([apple.status, apple.body.readUInt32BE(16), apple.body.readUInt32BE(20)], [200, 180, 180]);
  for (const p of ["/opengraph-image.png", "/twitter-image.png"]) {
    const img = await get(p);
    assert.deepEqual([img.status, img.body.readUInt32BE(16), img.body.readUInt32BE(20)], [200, 1200, 630], p);
  }
});

test("the homepage head points at the icons and a real preview image (not the favicon), with a Twitter card", async () => {
  const html = await fetch(`${BASE}/`).then((r) => r.text());
  assert.match(html, /<link rel="icon"[^>]+href="\/icon\.svg/);
  assert.match(html, /<link rel="icon"[^>]+href="\/favicon\.ico/);
  assert.match(html, /<link rel="apple-touch-icon"[^>]+href="\/apple-icon\.png/);
  assert.match(html, /<meta property="og:image"[^>]+content="[^"]*opengraph-image\.png/);
  assert.match(html, /<meta property="og:image:width" content="1200"/);
  assert.match(html, /<meta property="og:image:height" content="630"/);
  assert.match(html, /<meta property="og:site_name" content="DIRECTOR\.LTD"/);
  assert.match(html, /<meta name="twitter:card" content="summary_large_image"/);
  assert.ok(!/og:image"[^>]+(icon\.svg|favicon\.ico|apple-icon)/.test(html), "the preview image is not the tiny icon");
});

test("before any consent the homepage HTML loads nothing from third parties and still offers the cookie settings link", async () => {
  const html = await fetch(`${BASE}/`).then((r) => r.text());
  assert.ok(!/<iframe/i.test(html), "no embedded player in the server-rendered page");
  assert.ok(!/(youtube|vimeo)\.com/i.test(html), "no YouTube / Vimeo reference");
  const external = [...html.matchAll(/<(?:script|link|img)[^>]+(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => m[1]).filter((u) => !u.startsWith(BASE) && !u.includes("127.0.0.1") && !u.includes("localhost"));
  assert.deepEqual(external, [], `external resources: ${external.join(", ")}`);
  assert.match(html, /Cookie settings/);
});

test("the Permissions-Policy header allows the camera for this site only, on app and public pages", async () => {
  for (const p of ["/", "/login", "/register"]) {
    const h = (await fetch(`${BASE}${p}`)).headers.get("permissions-policy") ?? "";
    assert.match(h, /camera=\(self\)/, p);
    assert.ok(!h.includes("camera=()"), p);
    assert.match(h, /microphone=\(\)/);
    assert.match(h, /geolocation=\(\)/);
  }
});
