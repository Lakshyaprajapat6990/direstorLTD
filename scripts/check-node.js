// Refuses to build on a Node version this project cannot run on, with a message that says what to do.
//
// Plain CommonJS JavaScript on purpose: it must run BEFORE anything is compiled, on whatever Node the host happens to use,
// including versions too old for the syntax the rest of the project is written in.
//
// Why this exists: on an older Node the build does not fail honestly. Next.js 16 needs Node >= 20.9, and a build on an
// older one dies inside React with "Invalid hook call" / "Cannot read properties of null (reading 'useContext')" while
// prerendering /_global-error - an error that points at React and tells you nothing about the real cause. The floor here is
// 20.12, not 20.9, because the background scheduler calls process.loadEnvFile (added in 20.12); below that the .env is
// silently ignored and the scheduler refuses to start. See docs/PRODUCTION_SCHEDULER.md section 2.

const MIN = [20, 12, 0];
const current = process.versions.node.split(".").map(Number);

const tooOld =
  current[0] < MIN[0] ||
  (current[0] === MIN[0] && current[1] < MIN[1]) ||
  (current[0] === MIN[0] && current[1] === MIN[1] && current[2] < MIN[2]);

if (tooOld) {
  const want = MIN.join(".");
  process.stderr.write(
    "\n" +
      "  This project needs Node " + want + " or newer. This is Node " + process.versions.node + ".\n" +
      "\n" +
      "  Building on an older Node fails inside React while prerendering /_global-error\n" +
      "  (\"Invalid hook call\" / \"useContext of null\"), which looks like a React bug but is not.\n" +
      "\n" +
      "  On Plesk: Websites & Domains > the domain > Node.js > Node.js version, pick 20.12+ (22 LTS preferred),\n" +
      "  then run NPM install again so the modules are rebuilt against it.\n" +
      "  Node path in use: " + process.execPath + "\n" +
      "\n",
  );
  process.exit(1);
}
