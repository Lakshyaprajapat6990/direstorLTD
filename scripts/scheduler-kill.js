// Stops leftover scheduler processes (node ... scheduler.ts and their supervisor PowerShell) in THIS app folder,
// so the website can start a fresh one. Plesk: pkg set scripts.schedkill="node scheduler-kill.js"  then  run schedkill
const { execFileSync } = require("child_process");
const fs = require("fs");
const dir = fs.realpathSync.native(__dirname).replace(/'/g, "''");
const ps = `
$me = $PID
$p = Get-CimInstance Win32_Process | Where-Object {
  $_.ProcessId -ne $me -and $_.CommandLine -and
  ($_.CommandLine -like '*scheduler.ts*' -or $_.CommandLine -like '*run-production-scheduler.ps1*') -and
  ($_.CommandLine -like '*${dir}*' -or $_.CommandLine -like '*scheduler.ts*')
}
if (-not $p) { 'No leftover scheduler processes found.' }
foreach ($x in $p) {
  try { Stop-Process -Id $x.ProcessId -Force -ErrorAction Stop; 'Stopped ' + $x.Name + ' (pid ' + $x.ProcessId + ')' }
  catch { 'Could not stop pid ' + $x.ProcessId + ': ' + $_.Exception.Message }
}`;
try {
  console.log(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8" }));
} catch (e) {
  console.log("ERROR: " + (e.stdout || "") + (e.stderr || e.message));
}
console.log("Done. Now: Restart App in Plesk, then open the website once.");
