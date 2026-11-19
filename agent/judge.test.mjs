import { test } from "node:test";
import assert from "node:assert/strict";
import { answerKey, caughtUp, mentionsIssue, needsPickup, parseShip, shouldRun } from "./judge.mjs";

test("mentionsIssue counts only records with a whole header", () => {
  const good = "---\nid: 0008\ntitle: x\nissue: 6\nstatus: proposed\nsigned-by:\n---\n\n## Ask\n";
  const broken = "---\nid: 0008\ntitle: x\nissue: 6\nstatus: proposed\n\n## Ask\n";
  assert.equal(mentionsIssue([{ text: good }], 6), true);
  assert.equal(mentionsIssue([{ text: broken }], 6), false);
});

const shipText = [
  "#1 · asked · live: ✗ · open risks: #1 owner",
  "#2 · shipped · live: ✓ · open risks: none",
].join("\n");

test("parseShip keeps the newest line per issue", () => {
  const ship = parseShip(`#2 · waiting · live: ✗ · open risks: none\n${shipText}`);
  assert.equal(ship.get(2).verb, "shipped");
  assert.equal(ship.get(1).live, "✗");
});

test("needsPickup until an agent mark or a ship line exists", () => {
  const ship = parseShip(shipText);
  const fresh = { n: 3, thread: [] };
  assert.equal(needsPickup(fresh, ship, false), true);
  assert.equal(needsPickup({ n: 3, thread: [{ by: "agent", kind: "comment" }] }, ship, false), false);
  assert.equal(needsPickup({ n: 2, thread: [] }, ship, false), false);
  assert.equal(needsPickup(fresh, ship, true), false);
});

test("shouldRun waits on the owner, then runs once the answer is in", () => {
  const ship = parseShip(shipText);
  const asked = {
    n: 1,
    thread: [{ by: "agent", at: "2026-11-19T16:00:00.000Z", kind: "comment", body: "Picked up #1." }],
  };
  assert.equal(shouldRun(asked, ship, true), false);
  assert.equal(shouldRun(asked, ship, false), true);
  assert.equal(shouldRun({ n: 5, thread: [{ by: "agent" }] }, parseShip("#5 · shipped · live: ✗ · open risks: none"), false), true);
  const answered = {
    ...asked,
    thread: [
      ...asked.thread,
      { by: "owner", at: "2026-11-19T16:10:00.000Z", kind: "comment", body: "/answer 2" },
    ],
  };
  assert.equal(shouldRun(answered, ship, true), true);
  assert.equal(answerKey(answered), "1:2026-11-19T16:10:00.000Z");
  assert.equal(shouldRun({ n: 2, thread: [] }, ship, false), false);
});

test("caughtUp is true only after the last issue time and every final verb", () => {
  const ship = parseShip("#1 · declined · live: ✗ · open risks: none\n#2 · closed · live: ✗ · open risks: none");
  const snapshot = {
    now: "2026-11-19T16:40:00.000Z",
    lastIssueBy: "2026-11-19T16:30:00.000Z",
    issues: [{ n: 1 }, { n: 2 }],
  };
  assert.equal(caughtUp(snapshot, ship), true);
  assert.equal(caughtUp({ ...snapshot, now: "2026-11-19T16:20:00.000Z" }, ship), false);
  assert.equal(caughtUp(snapshot, parseShip("#1 · asked · live: ✗ · open risks: #1 owner")), false);
});
