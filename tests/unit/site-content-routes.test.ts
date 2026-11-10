import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// Static inventory: every Website Content page and API handler must authorise ITSELF, on the server, as its first act.
// Hiding the tab or relying on the proxy is not authorisation (the proxy does not even cover /api or /website-preview).

const root = path.join(__dirname, "../..");
const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

const apiRoutes = walk(path.join(root, "src/app/api/admin/website-content")).filter((f) => /route\.ts$/.test(f));
const pages = [path.join(root, "src/app/(app)/admin/website-content/page.tsx"), path.join(root, "src/app/website-preview/page.tsx"), path.join(root, "src/app/website-preview/editor/page.tsx")];

test("the expected Website Content API routes exist (a new route must be added to this inventory deliberately)", () => {
  const rel = apiRoutes.map((f) => path.relative(path.join(root, "src/app/api/admin/website-content"), f).replace(/\\/g, "/")).sort();
  assert.deepEqual(rel, ["draft/route.ts", "media/route.ts", "publish/route.ts", "rollback/route.ts", "route.ts"]);
});

test("every API handler calls the Super Admin guard before it reads the request or touches the database", () => {
  for (const file of apiRoutes) {
    const code = strip(fs.readFileSync(file, "utf8"));
    const handlers = [...code.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/g)];
    assert.ok(handlers.length >= 1, `${file} exports a handler`);
    for (const [, method, body] of handlers) {
      const firstStatement = body.trim().split("\n")[0];
      assert.match(firstStatement, /const auth = await requireSuperAdminForCms\(\);/, `${path.basename(path.dirname(file))} ${method}: guard must be the first statement`);
      assert.match(body, /if \("error" in auth\) return auth\.error;/, `${method}: the guard result must be honoured`);
      const guardAt = body.indexOf("requireSuperAdminForCms");
      for (const later of ["readMutationJson", "request.", "saveDraft", "publish(", "rollback(", "getState", "currentState", "db."]) {
        const at = body.indexOf(later);
        assert.ok(at === -1 || at > guardAt, `${method}: ${later} must come after the guard`);
      }
    }
    assert.ok(!/export (const|function) (GET|POST|PUT|PATCH|DELETE)\b/.test(code.replace(/export async function/g, "")), "handlers are declared as async functions");
  }
});

test("mutating handlers also enforce origin, content type and a bounded body (through readMutationJson)", () => {
  for (const file of apiRoutes) {
    const code = strip(fs.readFileSync(file, "utf8"));
    if (/export async function (POST|PUT|PATCH|DELETE)/.test(code)) assert.match(code, /readMutationJson\(request\)|requireSameOrigin\(request\)/, `${file} checks the origin (and reads JSON through readMutationJson, or a bounded binary body)`);
  }
});

test("every Website Content page requires SUPER_ADMIN on the server as its first statement", () => {
  for (const file of pages) {
    const code = strip(fs.readFileSync(file, "utf8"));
    const body = code.slice(code.indexOf("export default async function"));
    const first = body.split("\n").slice(1).find((l) => l.trim().length > 0) ?? "";
    assert.match(first, /await requireRole\("SUPER_ADMIN"\);/, `${path.relative(root, file)}: requireRole("SUPER_ADMIN") must be the first statement`);
  }
});

test("the preview is never cached or indexed", () => {
  const code = fs.readFileSync(path.join(root, "src/app/website-preview/page.tsx"), "utf8");
  assert.match(code, /export const dynamic = "force-dynamic"/);
  assert.match(code, /index: false/);
});

test("no Website Content module imports company, report or ingestion data code", () => {
  const files = [...walk(path.join(root, "src/lib/site-content")), ...walk(path.join(root, "src/app/(app)/admin/website-content")), ...walk(path.join(root, "src/app/website-preview")), path.join(root, "src/app/media/[id]/route.ts"), ...apiRoutes, ...pages].filter((f) => /\.tsx?$/.test(f));
  for (const f of files) {
    const imports = [...fs.readFileSync(f, "utf8").matchAll(/from "(@\/[^"]+)"/g)].map((m) => m[1]);
    for (const i of imports) {
      assert.ok(!/@\/lib\/(data\/companies|companies-house|filters|reports|ingest|columns)/.test(i), `${path.relative(root, f)} imports ${i}`);
    }
  }
});

test("the Super Admin tab bar keeps every existing tab, in order, and adds Website Content last, for Super Admins only", () => {
  const code = fs.readFileSync(path.join(root, "src/components/admin/AdminTabs.tsx"), "utf8");
  const labels = [...code.matchAll(/\{ key: "([a-z]+)", href: "([^"]+)", label: "([^"]+)"(, superOnly: true)?(?:, permission: "([^"]+)")? \}/g)].map((m) => [m[1], m[2], m[3], !!m[4], m[5] ?? null]);
  assert.deepEqual(labels, [
    ["overview", "/admin", "Overview", true, null],
    ["staff", "/admin/staff", "Staff", false, "staff.view"],
    ["activity", "/admin/activity", "Activity & reports", false, "staff.activity"],
    ["timesheets", "/admin/timesheets", "Timesheets", false, "timesheets.approve"],
    ["customers", "/admin/customers", "Customers", true, null],
    ["columns", "/admin/columns", "Column & Default Settings", true, null],
    ["content", "/admin/website-content", "Website Content (CMS)", true, null],
  ]);
});

test("the main navigation has no Website Content entry", () => {
  const nav = fs.readFileSync(path.join(root, "src/lib/nav.ts"), "utf8");
  assert.ok(!/website|content|cms/i.test(nav.replace(/\/\/.*$/gm, "")));
});

test("the public image route only serves an image that the PUBLISHED content refers to (or to a signed-in Super Admin)", () => {
  const code = strip(fs.readFileSync(path.join(root, "src/app/media/[id]/route.ts"), "utf8"));
  assert.match(code, /MEDIA_ID\.test\(id\)/, "ids are validated before any query");
  assert.match(code, /session\?\.role === "SUPER_ADMIN"/);
  assert.match(code, /!isSuperAdmin && !\(await isMediaPublished\(id\)\)/, "everyone else needs the published check");
  assert.match(code, /status: 404/);
  assert.ok(!/draft/i.test(code));
  const store = strip(fs.readFileSync(path.join(root, "src/lib/site-content/media-store.ts"), "utf8"));
  assert.match(store, /"publishedJson"::text LIKE/, "published content only");
  assert.ok(!/draftJson/.test(store));
});

test("uploads: type, size and dimensions come from the bytes; the library is bounded; the migration backs it up", () => {
  const store = strip(fs.readFileSync(path.join(root, "src/lib/site-content/media-store.ts"), "utf8"));
  assert.match(store, /readImageInfo\(input\.bytes\)/);
  assert.match(store, /MAX_MEDIA_COUNT/);
  const route = strip(fs.readFileSync(path.join(root, "src/app/api/admin/website-content/media/route.ts"), "utf8"));
  assert.match(route, /IMAGE_TYPES/);
  assert.match(route, /readBoundedBytes\(request, MAX_IMAGE_BYTES/);
});

test("the editor's markup hooks never reach the public page: HomeView defaults to editing off and the public route never passes it", () => {
  const view = strip(fs.readFileSync(path.join(root, "src/components/marketing/HomeView.tsx"), "utf8"));
  assert.match(view, /editing = false/);
  const page = strip(fs.readFileSync(path.join(root, "src/app/page.tsx"), "utf8"));
  assert.ok(!/<HomeView[^>]*editing/.test(page));
  const preview = strip(fs.readFileSync(path.join(root, "src/app/website-preview/page.tsx"), "utf8"));
  assert.ok(!/<HomeView[^>]*editing/.test(preview), "the private preview is the real page, not the editing view");
});

test("no code path can inject HTML or run strings as code: the CMS and the pages it feeds never use the unsafe browser APIs", () => {
  const roots = ["src/lib/site-content", "src/app/(app)/admin/website-content", "src/app/website-preview", "src/app/media", "src/components/marketing"].map((r) => path.join(root, r));
  const forbidden = /dangerouslySetInnerHTML|\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write|eval\s*\(|new Function\s*\(|createContextualFragment|srcdoc/;
  const files = roots.flatMap((r) => walk(r)).filter((f) => /\.tsx?$/.test(f));
  assert.ok(files.length > 20);
  for (const f of files) {
    const code = strip(fs.readFileSync(f, "utf8"));
    assert.ok(!forbidden.test(code), `${path.relative(root, f)} uses an unsafe API`);
  }
});

test("rich text renders only through React elements: the renderer builds no strings of markup", () => {
  const code = strip(fs.readFileSync(path.join(root, "src/components/marketing/RichText.tsx"), "utf8"));
  assert.ok(!/<\/?(strong|em|u|span|a)[^>]*>`|`<[a-z]/.test(code), "no template strings that look like markup");
  assert.match(code, /rel: "noopener noreferrer"/);
});
