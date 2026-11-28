// tsx asks Windows for the user name (os.userInfo), which fails under the IIS site account and crashes the scheduler.
// This patches tsx to use the USERNAME variable instead. Re-run after every "npm ci".
//   Plesk: pkg set scripts.tsxfix="node tsx-fix.js"   then   run tsxfix
const fs = require("fs");
const path = require("path");
const dist = path.join(__dirname, "node_modules", "tsx", "dist");
let done = 0;
for (const f of fs.readdirSync(dist).filter((n) => n.endsWith(".mjs") || n.endsWith(".cjs"))) {
  const p = path.join(dist, f);
  const s = fs.readFileSync(p, "utf8");
  const t = s.replace(/([A-Za-z_$][\w$]*)\.userInfo\(\)\.username/g, '(process.env.USERNAME||"site")');
  if (t !== s) {
    fs.writeFileSync(p, t);
    console.log("Patched " + f);
    done++;
  }
}
console.log(done ? "tsx fixed." : "Nothing to patch (already fixed).");
