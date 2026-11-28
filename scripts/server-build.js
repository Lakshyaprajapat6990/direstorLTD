// Builds a Next.js app on the Windows/Plesk server with the folder path in its TRUE letter case.
//
// Why: Plesk starts commands from "C:\inetpub\..." while the real folder is "C:\Inetpub\...". Windows does not mind, but
// the bundler then sees every file twice (two spellings), loads React twice, and prerendering fails with
// "Cannot read properties of null (reading 'useContext')" on /_global-error, /_not-found, /cookie-policy ...
//
// Usage (Plesk -> Node.js -> Run Node.js commands, npm only):
//   pkg set scripts.rebuild="node rebuild.js"
//   run rebuild                          builds the folder this file is in
//   run rebuild -- ../../../app_new      builds another folder
//   run rebuild -- ../../../app_new --webpack
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const args = process.argv.slice(2);
const dirArg = args.find((a) => !a.startsWith("--"));
const extra = args.filter((a) => a.startsWith("--"));

const target = fs.realpathSync.native(path.resolve(__dirname, dirArg || "."));
process.chdir(target);
console.log("Building in: " + target);

const run = (file, argv) => {
  console.log("> " + path.basename(file) + " " + argv.join(" "));
  const r = spawnSync(process.execPath, [file, ...argv], { cwd: target, stdio: "inherit", env: { ...process.env, INIT_CWD: target, PWD: target } });
  if (r.status !== 0) {
    console.log("FAILED (exit " + r.status + ")");
    process.exit(r.status || 1);
  }
};

const resolve = (id) => require.resolve(id, { paths: [target] });
run(resolve("prisma/build/index.js"), ["generate"]);
run(resolve("next/dist/bin/next"), ["build", ...extra]);
console.log("BUILD OK in " + target);
