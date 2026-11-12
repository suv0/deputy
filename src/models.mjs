// `deputy model --tier <legwork|review|challenge> --prompt-file brief.md --out answer.md`
//
// Runs one task on an outside coding agent and prints its final answer. Each tier is a list of
// { tool, model, effort? } tried in order. When a tool says its account is out of limit or credit,
// deputy remembers that until the reset (or 15 minutes) and skips every model on that tool.
//
// Tools: command-code, codex, opencode (OpenRouter and others), claude. Read-only by default.
// Legwork may run on any tool. The judging tiers (review, challenge) run only on the tools in
// models.judges (Codex and Claude by default): when none of those is available, deputy model exits
// with code 3, and the agent run does that stage itself.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readJson, run, writeJson } from "./util.mjs";

export const TOOLS = ["command-code", "codex", "opencode", "claude"];
export const ACCOUNT_LIMIT = /usage limit|rate limit|insufficient|out of credit|credit balance|balance|quota|billing|unauthori[sz]ed|not logged in|\b401\b|\b402\b|\b429\b/i;

export const DEFAULT_JUDGES = ["codex", "claude"];
export const DEFAULT_JUDGING_TIERS = ["review", "challenge"];

/** Is this tier one that judges (drafts a verdict or tries to disprove one)? Pure. */
export function isJudgingTier(models, tier) {
  return (models.judgingTiers ?? DEFAULT_JUDGING_TIERS).includes(tier);
}

/** Judging tiers that name a tool not trusted to judge. Pure. */
export function judgeProblems(models) {
  const judges = models.judges ?? DEFAULT_JUDGES;
  const out = [];
  for (const tier of models.judgingTiers ?? DEFAULT_JUDGING_TIERS)
    for (const c of models.tiers?.[tier] ?? []) if (!judges.includes(c.tool)) out.push(`models.tiers.${tier}: ${c.tool} is not in models.judges (${judges.join(", ")}), so it can't judge`);
  return out;
}

/**
 * The models to try, in order, with the ones skipped because their tool is down, or because the
 * tier judges and the tool isn't trusted to. Pure.
 */
export function planCandidates(models, { tier, tool, model, effort } = {}, down = {}, now = Date.now()) {
  const list = [];
  if (tool || model) {
    if (!tool || !model) throw new Error("--tool and --model go together");
    list.push({ tool, model, effort });
  }
  if (tier) {
    const t = models.tiers?.[tier];
    if (!t) throw new Error(`unknown tier "${tier}"; tiers: ${Object.keys(models.tiers ?? {}).join(", ")}`);
    list.push(...t.map((c) => ({ ...c, effort: effort ?? c.effort })));
  }
  if (!list.length) list.push(...(models.tiers?.legwork ?? []));
  const usable = [], skipped = [];
  const judges = models.judges ?? DEFAULT_JUDGES;
  for (const c of list) {
    if (tier && isJudgingTier(models, tier) && !judges.includes(c.tool)) { skipped.push({ ...c, why: `${c.tool} is not trusted to judge` }); continue; }
    const d = down[c.tool];
    if (d && Date.parse(d.until) > now) skipped.push({ ...c, why: `${c.tool} is out of limit until ${d.until}` });
    else usable.push(c);
  }
  return { usable, skipped };
}

/** When an error means the whole account is out, how long to stay away. Pure. */
export function downUntil(error, now = Date.now()) {
  if (!ACCOUNT_LIMIT.test(error)) return null;
  const reset = error.match(/resets? at (\d{4}-\d\d-\d\dT[\d:.]+Z)/i)?.[1];
  return reset ?? new Date(now + 15 * 60_000).toISOString();
}

/** Drop the model's closing "DID: ..." line from the answer and keep it as the run's note. Pure. */
export function takeDidLine(text) {
  const lines = text.trimEnd().split("\n");
  const at = lines.findLastIndex((l) => /^\s*\**DID:\**/i.test(l));
  if (at < 0) return { text: text.trimEnd() + "\n", did: lines.find((l) => l.trim())?.trim().slice(0, 120) ?? null };
  const did = lines[at].replace(/^\s*\**DID:\**\s*/i, "").trim();
  lines.splice(at, 1);
  return { text: lines.join("\n").trimEnd() + "\n", did };
}

const jsonLines = (s) => s.split("\n").filter((l) => l.startsWith("{")).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
const lastLines = (r) => (r.timedOut ? "timed out" : (r.stderr || r.stdout).trim().split("\n").filter(Boolean).slice(-3).join(" ") || `exit ${r.code}`);

// Each runner: (candidate, { cwd, mode, prompt, timeoutMs, command, maxTurns }) => { ok, text?, error?, tokens? }
const runners = {
  async codex(c, o) {
    const sandbox = { read: "read-only", write: "workspace-write", full: "danger-full-access" }[o.mode];
    const dir = mkdtempSync(join(tmpdir(), "deputy-codex-"));
    const outFile = join(dir, "last.txt");
    const args = ["exec", "-m", c.model, "-s", sandbox, "-C", o.cwd, "--skip-git-repo-check", "--json", "-c", "approval_policy=never", "-o", outFile];
    if (c.effort) args.push("-c", `model_reasoning_effort=${c.effort}`);
    args.push("-");
    const r = await run(o.command, args, { input: o.prompt, cwd: o.cwd, timeoutMs: o.timeoutMs });
    const text = existsSync(outFile) ? readFileSync(outFile, "utf8") : "";
    rmSync(dir, { recursive: true, force: true });
    let tokens = 0;
    for (const j of jsonLines(r.stdout)) if (j.type === "turn.completed" && j.usage) tokens += (j.usage.input_tokens ?? 0) + (j.usage.output_tokens ?? 0);
    return r.code === 0 && text.trim() ? { ok: true, text, tokens } : { ok: false, error: lastLines(r), tokens };
  },
  async "command-code"(c, o) {
    const perm = { read: ["--permission-mode", "plan"], write: ["--permission-mode", "accept-edits", "--tools-all"], full: ["--yolo", "--tools-all"] }[o.mode];
    const args = ["-p", "-m", c.model, "--max-turns", String(o.maxTurns), "--output-format", "json", "--skip-onboarding", "--no-auto-update", "--no-session", ...perm];
    if (c.effort) args.push("--effort", c.effort);
    const r = await run(o.command, args, { input: o.prompt, cwd: o.cwd, timeoutMs: o.timeoutMs });
    const result = jsonLines(r.stdout).filter((j) => j.type === "result").pop();
    const u = result?.usage ?? {};
    const tokens = (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.outputTokens ?? 0);
    if (result?.subtype === "success" && result.finalText?.trim()) return { ok: true, text: result.finalText, tokens };
    return { ok: false, error: String(result?.error ?? lastLines(r)), tokens };
  },
  async opencode(c, o) {
    const perm = o.mode === "read" ? ["--agent", "plan"] : ["--auto"];
    const args = ["run", "--format", "json", "-m", c.model, "--dir", o.cwd, ...perm];
    if (c.effort) args.push("--variant", c.effort);
    // opencode refuses to read outside its folder unless told it may (docs, the run folder).
    const env = { ...process.env, OPENCODE_CONFIG_CONTENT: process.env.OPENCODE_CONFIG_CONTENT ?? JSON.stringify({ permission: { external_directory: "allow" } }) };
    const r = await run(o.command, args, { input: o.prompt, cwd: o.cwd, env, timeoutMs: o.timeoutMs });
    let text = "", tokens = 0, error = null;
    for (const j of jsonLines(r.stdout)) {
      if (j.type === "text" && j.part?.text) text += j.part.text;
      if (j.type === "step_finish") tokens += (j.part?.tokens?.input ?? 0) + (j.part?.tokens?.output ?? 0);
      if (j.type === "error") error = JSON.stringify(j.error ?? j).slice(0, 300);
    }
    return r.code === 0 && text.trim() && !error ? { ok: true, text, tokens } : { ok: false, error: error ?? lastLines(r), tokens };
  },
  async claude(c, o) {
    const perm = { read: ["--permission-mode", "plan"], write: ["--permission-mode", "acceptEdits"], full: ["--dangerously-skip-permissions"] }[o.mode];
    const args = ["-p", "--model", c.model, "--output-format", "json", "--max-turns", String(o.maxTurns), ...perm];
    const r = await run(o.command, args, { input: o.prompt, cwd: o.cwd, timeoutMs: o.timeoutMs });
    let j = null;
    try { j = JSON.parse(r.stdout.trim().split("\n").pop()); } catch {}
    const u = j?.usage ?? {};
    const tokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0);
    if (r.code === 0 && j && !j.is_error && j.result?.trim()) return { ok: true, text: j.result, tokens };
    return { ok: false, error: j?.result ?? lastLines(r), tokens };
  },
};

/**
 * Run the task on the first model that answers. Logs every attempt to the usage file.
 * @returns { ok, text, did, attempts }
 */
export async function askModel({ config, paths, prompt, tier, tool, model, effort, cwd = process.cwd(), mode = "read", label = null, timeoutSeconds = 900, maxTurns = 60, runner = runners, log = (l) => process.stderr.write(l + "\n") }) {
  if (!["read", "write", "full"].includes(mode)) throw new Error(`--mode must be read, write or full, not ${mode}`);
  const down = readJson(paths.down, {});
  const { usable, skipped } = planCandidates(config.models, { tier, tool, model, effort }, down);
  for (const s of skipped) log(`[deputy model] skipping ${s.tool} ${s.model}: ${s.why}`);
  const task = `${prompt.trimEnd()}\n\nWhen you're done, end your answer with one last line that starts with "DID:" and says in under 15 words what you did.\n`;
  const attempts = [];
  for (const c of usable) {
    const go = runner[c.tool];
    const started = Date.now();
    const r = go
      ? await go(c, { cwd, mode, prompt: task, timeoutMs: timeoutSeconds * 1000, maxTurns, command: config.models.tools?.[c.tool] ?? c.tool })
      : { ok: false, error: `unknown tool ${c.tool}; tools: ${TOOLS.join(", ")}` };
    const { text, did } = r.ok ? takeDidLine(r.text) : { text: null, did: null };
    const entry = { at: new Date().toISOString(), label, tier: tier ?? null, tool: c.tool, model: c.model, ok: r.ok, ms: Date.now() - started, tokens: r.tokens ?? null, did, error: r.ok ? null : String(r.error).slice(0, 300) };
    mkdirSync(dirname(paths.usage), { recursive: true });
    appendFileSync(paths.usage, JSON.stringify(entry) + "\n");
    attempts.push(entry);
    if (r.ok) {
      log(`[deputy model] ${c.tool} ${c.model} answered in ${Math.round(entry.ms / 1000)}s${attempts.length > 1 ? ` after ${attempts.length - 1} fallback(s)` : ""}`);
      return { ok: true, text, did, attempts };
    }
    log(`[deputy model] ${c.tool} ${c.model} failed: ${entry.error}`);
    const until = downUntil(entry.error);
    if (until) { down[c.tool] = { until, why: entry.error.slice(0, 120) }; writeJson(paths.down, down); }
  }
  // A judging tier with no model left: the agent run does the stage itself. A model limit never
  // stops the work.
  const judgeUnavailable = Boolean(tier && isJudgingTier(config.models, tier));
  return { ok: false, text: null, did: null, attempts, judgeUnavailable };
}

/** `deputy usage --since <iso|24h|7d>`: one line, or a short table, of what the models did. */
export function usageSummary(entries, since) {
  const recent = entries.filter((e) => Date.parse(e.at) >= since);
  const byModel = new Map();
  for (const e of recent) {
    const m = byModel.get(e.model) ?? { model: e.model, tool: e.tool, ok: 0, failed: 0, tokens: 0 };
    e.ok ? m.ok++ : m.failed++;
    m.tokens += e.tokens ?? 0;
    byModel.set(e.model, m);
  }
  const k = (n) => (n >= 1_000_000 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  const parts = [...byModel.values()].map((m) => `${m.model} ×${m.ok}${m.failed ? ` (+${m.failed} failed)` : ""} (${k(m.tokens)} tokens)`);
  return { runs: recent.length, line: recent.length ? `Models: ${parts.join(", ")}.` : "Models: none used.", recent };
}

export function readUsage(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
}

export function sinceOf(s, now = Date.now()) {
  if (!s || s === "today") { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); }
  if (s === "all") return 0;
  const m = String(s).match(/^(\d+)([mhd])$/);
  if (m) return now - Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]];
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error(`unknown --since ${s}`);
  return t;
}
