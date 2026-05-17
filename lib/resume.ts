import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";

// Pick the terminal app for `claude --resume`. Set TERMINAL_APP=iterm|terminal|
// ghostty to override; otherwise prefer iTerm if installed, else Terminal.
export const TERMINAL_APP = (() => {
  const requested = (process.env.TERMINAL_APP || "").trim().toLowerCase();
  if (requested) return requested;
  if (existsSync("/Applications/iTerm.app")) return "iterm";
  if (existsSync("/Applications/Ghostty.app")) return "ghostty";
  return "terminal";
})();

function appleScriptFor(app: string, shellCmd: string): string {
  // Escape for embedding inside an AppleScript double-quoted string.
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const escaped = esc(shellCmd);
  switch (app) {
    case "iterm":
    case "iterm2":
      return [
        'tell application "iTerm"',
        '  create window with default profile',
        '  tell current session of current window',
        `    write text "${escaped}"`,
        '  end tell',
        '  activate',
        'end tell',
      ].join("\n");
    case "ghostty":
      return [
        'tell application "Ghostty" to activate',
        'delay 0.4',
        'tell application "System Events" to keystroke "n" using {command down}',
        'delay 0.5',
        `tell application "System Events" to keystroke "${escaped}"`,
        'tell application "System Events" to key code 36',
      ].join("\n");
    case "terminal":
    default:
      return [
        `tell application "Terminal" to do script "${escaped}"`,
        'tell application "Terminal" to activate',
      ].join("\n");
  }
}

export function dispatchResume(id: string, cwd: string | undefined) {
  const safeCwd = typeof cwd === "string" && existsSync(cwd) ? cwd : homedir();
  const shellCmd = `cd ${JSON.stringify(safeCwd)} && claude --resume ${JSON.stringify(id)}`;
  const script = appleScriptFor(TERMINAL_APP, shellCmd);
  spawn("osascript", ["-e", script], { detached: true, stdio: "ignore" }).unref();
}
