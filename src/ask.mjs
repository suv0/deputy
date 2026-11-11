// `deputy ask "<question>"`: the rare question a review run can't settle from the rules, the
// code and the docs. Shows a window on top of everything; prints one JSON line:
//   {"answer":"yes"} | {"answer":"no"} | {"answer":"text","text":"..."} | {"answer":"none"}
// "none" means nobody answered in time, and the run takes the safer choice.
import { join } from "node:path";
import { ROOT } from "./config.mjs";
import { run } from "./util.mjs";

/** Turn the window's one-line output into the JSON answer. Pure. */
export function parseAnswer(raw) {
  const s = String(raw ?? "").trim().split("\n").pop().trim();
  if (s.startsWith("text:") && s.slice(5).trim()) return { answer: "text", text: s.slice(5).trim() };
  if (s === "yes" || s === "no") return { answer: s };
  return { answer: "none" };
}

export function askCommand(platform, question, { minutes, remindEveryMinutes }) {
  if (platform === "win32") {
    return ["powershell.exe", ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", join(ROOT, "src", "platform", "ask-windows.ps1"),
      "-Question", question, "-Minutes", String(minutes), "-RemindEveryMinutes", String(remindEveryMinutes)]];
  }
  if (platform === "darwin") {
    // One dialog with a text box; "giving up after" closes it with no answer.
    const q = question.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const script = [
      `set r to display dialog "${q}" default answer "" buttons {"No", "Yes", "Send my answer"} default button "Send my answer" with title "deputy needs your answer" giving up after ${minutes * 60}`,
      `if gave up of r then return "none"`,
      `if button returned of r is "Yes" then return "yes"`,
      `if button returned of r is "No" then return "no"`,
      `return "text:" & text returned of r`,
    ];
    return ["osascript", script.flatMap((l) => ["-e", l])];
  }
  if (platform === "linux") {
    // zenity's entry box: empty text with OK counts as yes, Cancel as no.
    return ["sh", ["-c", `a=$(zenity --entry --title="deputy needs your answer" --text="$1" --timeout=${minutes * 60} 2>/dev/null); c=$?; if [ $c -eq 0 ]; then if [ -n "$a" ]; then echo "text:$a"; else echo yes; fi; elif [ $c -eq 1 ]; then echo no; else echo none; fi`, "deputy-ask", question]];
  }
  return null;
}

export async function askUser(question, { platform = process.platform, minutes = 10, remindEveryMinutes = 2 } = {}) {
  const cmd = askCommand(platform, question, { minutes, remindEveryMinutes });
  if (!cmd) return { answer: "none" };
  // windowsHide would hide the answer window itself.
  const r = await run(cmd[0], cmd[1], { timeoutMs: (minutes + 2) * 60_000, windowsHide: false });
  return parseAnswer(r.stdout);
}
