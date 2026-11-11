// The verdict rules, enforced in code so a prompt can't talk its way past them.
//
// Reviews approve by default. A fix that must land first rides on the approval as a red
// "> [!CAUTION]" alert; a non-blocking risk as a yellow "> [!WARNING]". REQUEST_CHANGES is for a
// proven serious break, and what happens to one is your call: hold it for you, soften it, or allow it.

export const EVENTS = ["APPROVE", "REQUEST_CHANGES", "COMMENT"];

export const SOFTEN_PREFIX =
  "> [!CAUTION]\n> **Do not merge until the points in this review are fixed.**\n>\n> The approach is fine; these fixes are still needed before merging.\n\n";

/**
 * Apply the verdict policy to a drafted review.
 * @param payload  { event, body, comments }
 * @param policy   { approveEvent: "APPROVE"|"COMMENT", requestChanges: "hold"|"soften"|"allow" }
 * @returns { payload, hold: string|null, notes: string[] }  (the input is never changed)
 */
export function applyVerdictPolicy(payload, policy) {
  const out = structuredClone(payload);
  const notes = [];
  let hold = null;
  if (!EVENTS.includes(out.event)) return { payload: out, hold: `unknown event "${out.event}"`, notes };

  if (out.event === "REQUEST_CHANGES") {
    if (policy.requestChanges === "hold") hold = "the draft requests changes, and verdict.requestChanges is \"hold\"";
    else if (policy.requestChanges === "soften") {
      out.event = "APPROVE";
      if (!/^>\s*\[!CAUTION\]/m.test(out.body ?? "")) out.body = SOFTEN_PREFIX + (out.body ?? "");
      notes.push("REQUEST_CHANGES softened to an approval with a CAUTION alert");
    }
  }
  if (out.event === "APPROVE" && policy.approveEvent === "COMMENT") {
    out.event = "COMMENT";
    notes.push("approval sent as a COMMENT (verdict.approveEvent)");
  }
  return { payload: out, hold, notes };
}

/** The alerts a body carries, for the one-line summaries in status and notifications. */
export function alertsIn(body = "") {
  return {
    caution: /^>\s*\[!CAUTION\]/m.test(body),
    warning: /^>\s*\[!WARNING\]/m.test(body),
  };
}

export function verdictLabel(payload) {
  const a = alertsIn(payload.body);
  if (payload.event === "REQUEST_CHANGES") return "changes requested";
  const base = payload.event === "APPROVE" ? "approved" : "commented";
  return a.caution ? `${base}, do not merge yet` : a.warning ? `${base} with a warning` : base;
}

/** Shape checks on a payload before anything talks to GitHub. */
export function checkShape(p) {
  const problems = [];
  if (!/^[\w.-]+\/[\w.-]+$/.test(p._repo ?? "")) problems.push("_repo must be owner/name");
  if (!Number.isInteger(p._number)) problems.push("_number must be the PR number");
  if (!/^[0-9a-f]{40}$/.test(p.commit_id ?? "")) problems.push("commit_id must be the PR head's full sha");
  if (p._head_sha && p._head_sha !== p.commit_id) problems.push("_head_sha and commit_id differ");
  if (!EVENTS.includes(p.event)) problems.push(`event must be one of ${EVENTS.join(", ")}`);
  if (!p.body?.trim()) problems.push("empty body");
  if (p.comments != null && !Array.isArray(p.comments)) problems.push("comments must be a list");
  for (const r of p._thread_replies ?? []) if (!Number.isInteger(r.in_reply_to) || !r.body?.trim()) problems.push("each thread reply needs in_reply_to and body");
  return problems;
}
