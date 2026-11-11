// Pop-up notifications. Each OS gets its own small adapter; anything else prints to the console.
//
// Windows: a small always-on-top pop-up that closes itself after a minute. Toasts sent from
// PowerShell are dropped on many PCs (PowerShell isn't a registered sender), so it's a pop-up.
// macOS: Notification Center through osascript. Linux: notify-send, when it is installed.
import { spawn } from "node:child_process";

export function notifyCommand(platform, title, body) {
  const t = String(title).slice(0, 120), b = String(body).slice(0, 400);
  if (platform === "win32") {
    const esc = (s) => s.replace(/'/g, "''");
    // 4160 = OK button (0) + information icon (64) + always on top (4096).
    return ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(New-Object -ComObject WScript.Shell).Popup('${esc(b)}', 60, '${esc(t)}', 4160) | Out-Null`]];
  }
  if (platform === "darwin") {
    const esc = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return ["osascript", ["-e", `display notification "${esc(b)}" with title "${esc(t)}" sound name "Glass"`]];
  }
  if (platform === "linux") return ["notify-send", ["--app-name=deputy", t, b]];
  return null;
}

/** Show a notification without waiting for it. Never throws. */
export function notify(title, body, { platform = process.platform, enabled = true } = {}) {
  console.log(`[deputy] ${title}: ${body}`);
  if (!enabled) return;
  const cmd = notifyCommand(platform, title, body);
  if (!cmd) return;
  try {
    const child = spawn(cmd[0], cmd[1], { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    child.unref();
  } catch {}
}
