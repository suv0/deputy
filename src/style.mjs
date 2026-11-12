// Checks on the text a review posts, so it reads like a teammate typed it. All configurable in
// `style`; a problem stops the post, and the run rewrites the text.
//
//   noDashes            no em or en dashes
//   maxSentences        a paragraph holds at most this many sentences (0 turns it off)
//   maxParagraphChars   and at most this many characters, link targets not counted (0 turns it off)
//   team                { "Maya": "maya" } or { "Maya": { "login": "maya", "honorific": "ji" } }:
//                       a team member is named only as their @login, which also notifies them.
//                       The optional honorific may follow that member's tag ("@maya ji"), and no one else's.
// Code blocks, inline code, list lines and an alert's first line are left alone.

export const DEFAULT_STYLE = { noDashes: true, maxSentences: 3, maxParagraphChars: 350, team: {} };

const stripCode = (t) => t.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "x");
const stripLinkTargets = (t) => t.replace(/\]\([^)]*\)/g, "]");
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function members(team = {}) {
  return Object.entries(team).map(([name, v]) => (typeof v === "string" ? { name, login: v, honorific: null } : { name, login: v.login, honorific: v.honorific ?? null }));
}

/** Problems with one piece of posted text. Pure. */
export function styleProblems(where, text, style = DEFAULT_STYLE) {
  const s = { ...DEFAULT_STYLE, ...style };
  const problems = [];
  const src = String(text ?? "");
  if (s.noDashes && /[—–]/.test(stripCode(src))) problems.push(`${where}: has an em or en dash; rewrite without it`);

  if (s.maxSentences || s.maxParagraphChars) {
    for (const raw of src.replace(/```[\s\S]*?```/g, "").split(/\n\s*\n/)) {
      const para = raw.split("\n")
        .filter((l) => !/^\s*([-*+]|\d+\.)\s/.test(l) && !/^>\s*\[!/.test(l))
        .map((l) => l.replace(/^>\s?/, "")).join(" ").trim();
      if (!para) continue;
      const sentences = para.replace(/`[^`]*`/g, "x").replace(/\([^)]*\)/g, "").split(/(?<=[.?!])\s+(?=[A-Z@])/).filter((x) => x.trim()).length;
      const len = stripLinkTargets(para).length;
      if ((s.maxSentences && sentences > s.maxSentences) || (s.maxParagraphChars && len > s.maxParagraphChars))
        problems.push(`${where}: a paragraph runs ${sentences} sentences / ${len} characters; split it into short paragraphs (one idea, at most ${s.maxSentences || "a few"} short sentences, a blank line between)`);
    }
  }

  const team = members(s.team);
  if (team.length) {
    const prose = stripLinkTargets(stripCode(src));
    for (const m of team) {
      if (new RegExp(`(?<![@\\w])${escapeRe(m.name)}(?!\\w)`).test(prose)) problems.push(`${where}: names ${m.name} without the tag; write @${m.login}`);
    }
    const honorifics = [...new Set(team.map((m) => m.honorific).filter(Boolean))];
    for (const h of honorifics) {
      for (const hit of prose.matchAll(new RegExp(`@([\\w-]+)\\s+${escapeRe(h)}(?!\\w)`, "g"))) {
        const who = team.find((m) => m.login.toLowerCase() === hit[1].toLowerCase());
        if (who?.honorific !== h) problems.push(`${where}: "${h}" belongs only after ${team.filter((m) => m.honorific === h).map((m) => `@${m.login}`).join(", ")}, not @${hit[1]}`);
      }
    }
  }
  return problems;
}

/** Every posted piece of a review payload: the body, each inline comment, each thread reply. Pure. */
export function payloadStyleProblems(payload, style) {
  return [
    ["body", payload.body ?? ""],
    ...(payload.comments ?? []).map((c) => [`comment ${c.path}:${c.line}`, c.body ?? ""]),
    ...(payload._thread_replies ?? []).map((r) => [`reply to ${r.in_reply_to}`, r.body ?? ""]),
  ].flatMap(([where, text]) => styleProblems(where, text, style));
}
