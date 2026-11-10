import { test } from "node:test";
import assert from "node:assert/strict";

process.env.AUTH_SECRET = "unit-test-secret-unit-test-secret-unit-test-secret";

// The pure parts of the numeric CAPTCHA (src/lib/auth/captcha.ts). Verification against the used-ticket table is covered by the
// integration suite (tests/integration/customer-registration.test.ts), which needs a database.
test("a challenge is a 5-digit number with no leading zero, and its ticket never contains the answer", async () => {
  const { mintChallenge, CAPTCHA_LENGTH } = await import("@/lib/auth/captcha");
  for (let i = 0; i < 200; i++) {
    const c = mintChallenge();
    assert.match(c.answer, /^[1-9][0-9]{4}$/);
    assert.equal(c.answer.length, CAPTCHA_LENGTH);
    assert.equal(c.ticket.split(".").length, 3);
    assert.ok(!c.ticket.includes(c.answer), "answer is not readable from the ticket");
  }
});

test("challenges are different each time and expire five minutes after they are made", async () => {
  const { mintChallenge, CAPTCHA_TTL_MS } = await import("@/lib/auth/captcha");
  const now = 1_800_000_000_000;
  const a = mintChallenge(now);
  const b = mintChallenge(now);
  assert.notEqual(a.ticket, b.ticket);
  assert.equal(a.expiresAt, now + CAPTCHA_TTL_MS);
  assert.equal(CAPTCHA_TTL_MS, 5 * 60 * 1000);
  assert.equal(Number(a.ticket.split(".")[1]), a.expiresAt);
});

test("the rendered image is a self-contained SVG with a distorted digit per character and no script", async () => {
  const { renderChallengeSvg } = await import("@/lib/auth/captcha");
  const svg = renderChallengeSvg("48213");
  assert.ok(svg.startsWith("<svg") && svg.endsWith("</svg>"));
  assert.equal((svg.match(/<text /g) ?? []).length, 5);
  assert.ok(/rotate\(/.test(svg) && /skewX\(/.test(svg));
  assert.ok(!/<script|onload|href=|javascript:/i.test(svg));
  assert.notEqual(renderChallengeSvg("48213"), renderChallengeSvg("48213"), "noise differs on every render");
});

test("the issued challenge carries an image and a ticket but not the answer", async () => {
  const { issueChallenge } = await import("@/lib/auth/captcha");
  const c = issueChallenge();
  assert.deepEqual(Object.keys(c).sort(), ["expiresAt", "image", "ticket"]);
  assert.match(c.image, /^data:image\/svg\+xml;base64,/);
});
