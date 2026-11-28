// Under the IIS website account, os.userInfo() fails (uv_os_get_passwd ENOMEM) and tsx crashes on start.
// Loaded via NODE_OPTIONS=--require by start.js, so tsx and its child process get a safe fallback instead.
const os = require("os");
const real = os.userInfo;
os.userInfo = function (opts) {
  try {
    return real.call(os, opts);
  } catch {
    return { uid: -1, gid: -1, username: process.env.USERNAME || "site", homedir: os.tmpdir(), shell: null };
  }
};
// tsx uses `import { userInfo } from "os"` (ESM); named ESM imports only see the patch after this sync.
require("module").syncBuiltinESMExports();
