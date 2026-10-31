import test from "node:test";
import assert from "node:assert/strict";
import { formatSkillsForPrompt, type Skill } from "@earendil-works/pi-coding-agent";
import { SKILLS_BASE_ENTRY, SKILLS_MESSAGE_TYPE, buildSkillsDelta, readLedger, skillReader } from "../src/extension/skill-ledger.ts";
import { SimSession } from "./helpers/pi-sim.ts";

const skill = (name: string, over: Partial<Skill> = {}): Skill => ({
  name, description: `Description of ${name} <&>`, filePath: `/skills/${name}/SKILL.md`, baseDir: `/skills/${name}`,
  sourceInfo: { path: `/skills/${name}/SKILL.md`, source: "fixture", scope: "project", origin: "top-level" }, disableModelInvocation: false, ...over,
});
const delta = (names: string[], redelivered: string[] = []) => ({ customType: SKILLS_MESSAGE_TYPE, content: `text ${names.join()}`, display: false, details: { v: 1, added: names, redelivered } });

test("the ledger is derived from the active branch: base records and delta messages, nothing else", () => {
  const session = new SimSession();
  session.appendMessage("user", "hi");
  session.appendCustom(SKILLS_BASE_ENTRY, { v: 1, names: ["pin"] });
  session.appendCustom(SKILLS_BASE_ENTRY, { v: 1, names: ["all"] });
  session.appendCustomMessage(delta(["a", "b"]));
  session.appendCustomMessage({ customType: "other", content: "x", display: true, details: { v: 1, added: ["intruder"] } });
  session.appendCustom("unrelated", { v: 1, names: ["intruder2"] });
  const ledger = readLedger(session);
  assert.deepEqual([...ledger.base].sort(), ["all", "pin"]);
  assert.deepEqual([...ledger.added].sort(), ["a", "b"]);
  assert.deepEqual([...ledger.visible].sort(), ["a", "b"]);
  assert.deepEqual(ledger.lost, []);
});
test("malformed or foreign entries are ignored, never trusted", () => {
  const session = new SimSession();
  session.appendCustom(SKILLS_BASE_ENTRY, { v: 2, names: ["future"] });
  session.appendCustom(SKILLS_BASE_ENTRY, { v: 1, names: ["ok", 5, "", "x".repeat(300)] });
  session.appendCustom(SKILLS_BASE_ENTRY, "string");
  session.appendCustomMessage({ ...delta(["bad"]), details: { v: 1, added: "not-an-array" } });
  session.appendCustomMessage({ ...delta(["bad2"]), details: null });
  const ledger = readLedger(session);
  assert.deepEqual([...ledger.base], ["ok"]); assert.deepEqual([...ledger.added], []);
});
test("compaction summarizes older deltas away: they become lost (re-delivered, never re-scored); kept ones stay visible", () => {
  const session = new SimSession();
  session.appendMessage("user", "one");
  session.appendCustomMessage(delta(["old"]));
  const keep = session.appendMessage("user", "two");
  session.appendCustomMessage(delta(["recent"]));
  assert.deepEqual(readLedger(session).lost, []);
  session.compact(keep.id);
  const ledger = readLedger(session);
  assert.deepEqual([...ledger.added].sort(), ["old", "recent"], "the ledger itself is unchanged by compaction");
  assert.deepEqual([...ledger.visible], ["recent"]);
  assert.deepEqual(ledger.lost, ["old"]);
  // Re-delivery after the compaction restores visibility without changing what counts as added.
  session.appendCustomMessage(delta([], ["old"]));
  const restored = readLedger(session);
  assert.deepEqual(restored.lost, []); assert.deepEqual([...restored.added].sort(), ["old", "recent"]);
});
test("a context edit that omits or rewrites a delta makes its skills lost", () => {
  for (const replacement of [null, { content: "rewritten" }]) {
    const session = new SimSession();
    const entry = session.appendCustomMessage(delta(["gone"]));
    session.appendCustomMessage(delta(["stays"]));
    session.edit(entry.id, replacement);
    const ledger = readLedger(session);
    assert.deepEqual(ledger.lost, ["gone"], JSON.stringify(replacement));
    assert.deepEqual([...ledger.visible], ["stays"]);
  }
});
test("base names are never lost, even when no delta mentions them", () => {
  const session = new SimSession();
  session.appendCustomMessage(delta(["x"]));
  session.appendCustom(SKILLS_BASE_ENTRY, { v: 1, names: ["x"] });
  const keep = session.appendMessage("user", "after");
  session.compact(keep.id);
  assert.deepEqual(readLedger(session).lost, [], "x is in the stable system-prompt base now");
});
test("branches: fork copies the ledger, navigation follows the active branch, abandoned branches are ignored", () => {
  const session = new SimSession();
  const root = session.appendMessage("user", "root");
  session.appendCustomMessage(delta(["shared"]));
  const fork = session.fork();
  fork.appendCustomMessage(delta(["only-fork"]));
  assert.deepEqual([...readLedger(fork).added].sort(), ["only-fork", "shared"]);
  assert.deepEqual([...readLedger(session).added], ["shared"], "the original is untouched by the fork");
  session.appendCustomMessage(delta(["branch-a"]));
  session.navigate(root.id); // abandon: back before every delta
  assert.deepEqual([...readLedger(session).added], [], "skills added on the abandoned path are candidates again");
  session.appendCustomMessage(delta(["branch-b"]));
  assert.deepEqual([...readLedger(session).added], ["branch-b"]);
  assert.deepEqual([...readLedger(new SimSession()).added], [], "a new session starts empty");
});
test("a projection failure never re-delivers or re-scores: everything added stays visible", () => {
  const session = new SimSession();
  session.appendCustomMessage(delta(["a"]));
  const broken = { getBranch: () => session.getBranch(), buildSessionProjection: () => { throw new Error("boom"); } };
  const ledger = readLedger(broken);
  assert.deepEqual(ledger.lost, []); assert.deepEqual([...ledger.visible], ["a"]);
});
test("the reader follows Pi's rule over the active tools; with no reader nothing can be delivered", () => {
  assert.equal(skillReader(["bash", "read"]), "read");
  assert.equal(skillReader(["bash"]), "bash");
  assert.equal(skillReader(["edit", "write"]), undefined);
  assert.equal(skillReader([]), undefined);
});
test("the delta is Pi's canonical block for ONLY the new skills plus re-delivered ones; names only in details; hidden", () => {
  const added = [skill("b"), skill("c", { description: "Handles <xml> & \"quotes\"" })];
  const redelivered = [skill("old")];
  const built = buildSkillsDelta(added, redelivered, "read")!;
  assert.equal(built.display, false); assert.equal(built.customType, SKILLS_MESSAGE_TYPE);
  assert.deepEqual(built.details, { v: 1, added: ["b", "c"], redelivered: ["old"] });
  const canonical = formatSkillsForPrompt([...added, ...redelivered], "read").trim();
  assert.equal(built.content, `Additional skills are now available; previously listed skills remain available.\n\n${canonical}`);
  assert.match(built.content, /<name>b<\/name>/); assert.match(built.content, /<location>\/skills\/b\/SKILL\.md<\/location>/);
  assert.match(built.content, /&lt;xml&gt; &amp;/, "descriptions are escaped by Pi's formatter");
  assert.doesNotMatch(built.content, /previously-advertised-skill/);
  assert.match(built.content, /Use the read tool/);
  assert.match(buildSkillsDelta(added, [], "bash")!.content, /Use bash to load/);
  assert.doesNotMatch(JSON.stringify(built.details), /SKILL\.md|Description/);
});
test("manual-only skills are never advertised by a delta, and an empty delta is undefined", () => {
  assert.equal(buildSkillsDelta([], [], "read"), undefined);
  assert.equal(buildSkillsDelta([skill("manual", { disableModelInvocation: true })], [], "read"), undefined);
  const mixed = buildSkillsDelta([skill("manual", { disableModelInvocation: true }), skill("auto")], [], "read")!;
  assert.deepEqual(mixed.details.added, ["auto"]); assert.doesNotMatch(mixed.content, /manual/);
});
test("picks (numbers only) are recorded for newly added skills; re-deliveries and unscored adds carry none", () => {
  const picks = new Map([["b", { score: 1.6, threshold: 0.375 }], ["old", { score: 2, threshold: 0.375 }]]);
  const built = buildSkillsDelta([skill("b"), skill("c")], [skill("old")], "read", picks)!;
  assert.deepEqual(built.details, { v: 1, added: ["b", "c"], redelivered: ["old"], picks: { b: { score: 1.6, threshold: 0.375 } } });
  assert.doesNotMatch(JSON.stringify(built.details), /SKILL\.md|Description|PRIVATE/);
  assert.equal(buildSkillsDelta([skill("x")], [], "read", new Map())!.details.picks, undefined);
});
