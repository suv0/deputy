// Small shared helpers: argument parsing, JSON files, and spawning CLIs the same way on every OS.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** `--key value`, `--flag` and positional words. Repeated keys keep the last value. */
export function parseArgs(list) {
  const out = { _: [] };
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a.startsWith("--")) { out._.push(a); continue; }
    const eq = a.indexOf("=");
    if (eq > 0) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const key = a.slice(2);
    const next = list[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

export function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, "utf8"));
}

/** Write through a temp file, so a reader never sees half a file. */
export function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, file);
}

/**
 * Quote one argument for cmd.exe. On Windows most CLIs (claude, codex, gh from npm) are `.cmd`
 * shims, and Node refuses to start a `.cmd` without a shell, so every spawn goes through one.
 */
export function quoteWin(arg) {
  const s = String(arg);
  if (s && !/[\s"&|<>^()%!,;]/.test(s)) return s;
  return `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

/** Spawn a CLI by name, found on PATH, with the same behaviour on Windows, macOS and Linux. */
export function spawnTool(command, args = [], options = {}) {
  // A named .exe (powershell.exe, node.exe) starts directly, which keeps its arguments exact.
  if (process.platform === "win32" && !/\.exe$/i.test(command)) {
    const line = [quoteWin(command), ...args.map(quoteWin)].join(" ");
    return spawn(line, [], { ...options, shell: true, windowsHide: true });
  }
  return spawn(command, args, { ...options, windowsHide: true });
}

/**
 * Run a CLI to the end. Resolves with { code, stdout, stderr, timedOut }; never rejects, so a
 * missing tool reads as an ordinary failure the caller can fall through on.
 */
export function run(command, args = [], { input, cwd, env, timeoutMs = 0 } = {}) {
  return new Promise((done) => {
    let child;
    try {
      child = spawnTool(command, args, { cwd, env: env ?? process.env });
    } catch (error) {
      done({ code: -1, stdout: "", stderr: String(error), timedOut: false });
      return;
    }
    let stdout = "", stderr = "", timedOut = false;
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs) : null;
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    child.on("error", (e) => { stderr += String(e); });
    child.on("close", (code) => { if (timer) clearTimeout(timer); done({ code, stdout, stderr, timedOut }); });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin?.end();
  });
}

export function ago(iso, now = Date.now()) {
  if (!iso) return "never";
  const m = Math.round((now - Date.parse(iso)) / 60_000);
  if (m < 1) return "just now";
  return m < 60 ? `${m}m ago` : m < 48 * 60 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
