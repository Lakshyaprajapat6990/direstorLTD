// Side-effect module: import it FIRST in a standalone job script (before anything that reads process.env).
// Loads <repository root>/.env into process.env WITHOUT overriding variables that are already set, so the precedence is
//   real process environment (service / task / Plesk)  >  .env
// It deliberately does NOT read .env.local or .env.production*: a stray developer .env.local copied to a server must not be able to
// redirect a production scheduler to another database or API key. Values are never printed.
import fs from "node:fs";
import path from "node:path";

const file = path.resolve(__dirname, "..", ".env");
if (fs.existsSync(file)) {
  try {
    process.loadEnvFile(file);
  } catch (err) {
    console.error(`Could not read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
