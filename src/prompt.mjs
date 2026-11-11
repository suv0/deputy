// Turning prompts/review-prompt.md and the config into the prompt one review run gets.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEPUTY_BIN, ROOT } from "./config.mjs";

/**
 * A tiny template language. Pure.
 *   {{KEY}}               the value
 *   {{#KEY}}...{{/KEY}}   kept when the value is truthy
 *   {{^KEY}}...{{/KEY}}   kept when the value is falsy
 * Unknown keys render as empty text.
 */
export function renderTemplate(template, vars) {
  let out = template.replace(/\{\{([#^])(\w+)\}\}([\s\S]*?)\{\{\/\2\}\}/g, (_, kind, key, inner) =>
    (kind === "#") === Boolean(vars[key]) ? inner : "");
  out = out.replace(/\{\{(\w+)\}\}/g, (_, key) => (vars[key] == null ? "" : String(vars[key])));
  return out;
}

function q(p) {
  return /\s/.test(p) ? `"${p}"` : p;
}

export function promptVars(config, pending, job = "pr-review") {
  const draft = config.posting !== "auto";
  return {
    JOB: job,
    LOGIN: config.github.login,
    DEPUTY: `node ${q(DEPUTY_BIN.replace(/\\/g, "/"))}${config.file ? ` --config ${q(config.file.replace(/\\/g, "/"))}` : ""}`,
    POSTING: draft ? "draft" : "auto",
    DRAFT_MODE: draft,
    PENDING_JSON: JSON.stringify(pending, null, 2),
    SKIP_APPROVED: config.skipApprovedByOthers,
    IMPORTANT_TOPICS: config.important.topics.join(", "),
    IMPORTANT_PATHS: config.important.paths.map((p) => `\`${p}\``).join(", "),
    CHECKLIST: config.context.checklist,
    REVIEWER_RULES: config.context.reviewerRules,
    DOCS: config.context.docsDir,
    TEAM: config.context.teamFile,
    VOICE: config.context.voiceFile,
    EXTRA: config.context.extraInstructions,
  };
}

export function buildPrompt(config, pending, job = "pr-review", templateFile = join(ROOT, "prompts", "review-prompt.md")) {
  return renderTemplate(readFileSync(templateFile, "utf8"), promptVars(config, pending, job)).replace(/\n{3,}/g, "\n\n");
}
