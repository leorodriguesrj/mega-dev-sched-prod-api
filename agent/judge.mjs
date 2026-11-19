// Mechanical half of the triage skill: pickup, ship lines, and whether to run again.
// The build / decline / ask choice stays in .agents/skills/triage/SKILL.md.

const SHIP = /^#(\d+)\s·\s([a-z]+)\s·\slive:\s(✓|✗)\s·\sopen risks:\s(.*)$/;

export function parseShip(text) {
  const map = new Map();
  for (const line of String(text || "").split("\n")) {
    const match = SHIP.exec(line.trim());
    if (!match) continue;
    map.set(Number(match[1]), {
      n: Number(match[1]),
      verb: match[2],
      live: match[3],
      risks: match[4].trim(),
    });
  }
  return map;
}

export function mentionsIssue(records, n) {
  const pattern = new RegExp(`issue:\\s*${n}\\b`);
  return (records || []).some((record) => pattern.test(record.text || ""));
}

export function needsPickup(issue, ship, hasRecord) {
  if (hasRecord) return false;
  if (ship?.has(issue.n)) return false;
  return !(issue.thread || []).some((entry) => entry.by === "agent");
}

export function lastAnswer(issue) {
  const answers = (issue.thread || []).filter(
    (entry) => entry.by === "owner" && /^\/answer\s+\d+\b/.test((entry.body || "").trim()),
  );
  return answers.at(-1) || null;
}

export function answerKey(issue) {
  const answer = lastAnswer(issue);
  return `${issue.n}:${answer ? answer.at : "open"}`;
}

// True when the skill still has a step to run. The caller runs each answer key at most twice.
export function shouldRun(issue, ship, hasRecord) {
  if (needsPickup(issue, ship, hasRecord)) return false;
  const row = ship.get(issue.n);
  if (!row) return true;
  if (row.verb === "asked") return !hasRecord || Boolean(lastAnswer(issue));
  if (row.verb === "waiting") return true;
  return row.verb === "shipped" && row.live !== "✓";
}

export function caughtUp(snapshot, ship) {
  if (!snapshot.lastIssueBy) return false;
  if (Date.parse(snapshot.now) < Date.parse(snapshot.lastIssueBy)) return false;
  return (snapshot.issues || []).every((issue) => {
    const row = ship.get(issue.n);
    if (!row) return false;
    if (row.verb === "asked" || row.verb === "waiting") return false;
    return !(row.verb === "shipped" && row.live !== "✓");
  });
}
