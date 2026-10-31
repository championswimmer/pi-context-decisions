import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager, formatSkillsForPrompt, type Skill } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { historyBatchLines, historyReportLines, historyTurnLines, historyTurnSummary, qualifyingMark, readDecisionsHistory, type DecisionsHistory } from "../src/extension/decisions-history.ts";
import { classifyTools } from "../src/apps/tool-inventory.ts";
import { readToolLedger } from "../src/extension/tool-ledger.ts";
import { SKILLS_BASE_ENTRY, SKILLS_MESSAGE_TYPE, buildSkillsDelta } from "../src/extension/skill-ledger.ts";
import { TOOLS_LEDGER_ENTRY, TOOLS_NOTICE_TYPE, toolRecords, buildToolNotice } from "../src/extension/tool-ledger.ts";

const batches = (history: DecisionsHistory) => history.turns.flatMap((turn) => turn.batches);
const session = () => SessionManager.inMemory("/virtual");
const assistant = (s: SessionManager) => s.appendMessage(fauxAssistantMessage([fauxText("PRIVATE assistant text")]));
const user = (s: SessionManager) => s.appendMessage({ role: "user", content: "PRIVATE user text", timestamp: 0 });
const delta = (s: SessionManager, added: string[], redelivered: string[] = []) => s.appendCustomMessageEntry(SKILLS_MESSAGE_TYPE, "PRIVATE descriptions and paths", false, { v: 1, added, redelivered });
const record = (s: SessionManager, data: unknown) => s.appendCustomEntry(TOOLS_LEDGER_ENTRY, data);

test("history groups user prompts, retaining internal response boundaries and separating delivery from availability", () => {
  const s = session();
  record(s, { v: 1, tools: ["direct"], groups: ["mcp__srv", "ext__pkg"], withheld: ["no"], considered: ["not-picked"], initialTask: "PRIVATE task" });
  user(s); delta(s, ["alpha", "alpha"]);
  s.appendCustomMessageEntry(TOOLS_NOTICE_TYPE, "Names only", false, { v: 1, tools: ["indirect"], groups: ["mcp__srv"] });
  assistant(s); assistant(s); // no additions before the second response
  s.appendMessage({ role: "toolResult", toolName: "PRIVATE", toolCallId: "call", content: [{ type: "text", text: "PRIVATE result" }], isError: false, timestamp: 0 });
  delta(s, ["beta"]); delta(s, ["beta"], ["alpha"]);
  record(s, { v: 1, tools: ["direct", "late"], groups: ["mcp__srv"], released: ["not-new"] });
  user(s); // queued steering follows its delta: stays in the same batch
  assistant(s);
  record(s, { v: 1, tools: ["direct"], withheld: ["no"], considered: ["x"] });
  s.appendCustomMessageEntry(TOOLS_NOTICE_TYPE, "none", false, { v: 1, tools: [], groups: [] });
  const h = readDecisionsHistory(s);
  assert.deepEqual(batches(h).map((b) => [b.turn, b.answered]), [[1, true], [3, true]]);
  assert.deepEqual(batches(h)[0].items, { skills: ["alpha"], pinned: [], base: [], redelivered: [], tools: ["direct"], groups: ["mcp__srv", "ext__pkg"], noticeTools: ["indirect"], noticeGroups: ["mcp__srv"] });
  assert.deepEqual(batches(h)[1].items.skills, ["beta"]);
  assert.deepEqual(batches(h)[1].items.redelivered, ["alpha"]);
  assert.deepEqual(batches(h)[1].items.tools, ["late"]);
  assert.doesNotMatch(historyReportLines(h).join("\n"), /PRIVATE|not-picked|not-new/);
});

test("Turn 1 and Turn 20 identify user prompts, with tool rounds nested and no notice text or member-tool expansion", () => {
  const s = session();
  record(s, { v: 1, groups: ["mcp__exa"] }); // before_agent_start records before the user
  s.appendCustomEntry(SKILLS_BASE_ENTRY, { v: 1, names: ["base"] });
  user(s); delta(s, ["first"]);
  s.appendMessage({ role: "system", content: "PRIVATE", sections: { skills: formatSkillsForPrompt([skillNamed("base")]) }, timestamp: 0 });
  const notice = buildToolNotice([], ["mcp__exa"], true)!;
  s.appendCustomMessageEntry(notice.customType, notice.content, notice.display, notice.details);
  // Declarations are not additions: members must not be expanded from the live/recorded tool list.
  s.appendMessage({ role: "system", content: "", toolsAdded: [{ name: "exa_member", description: "PRIVATE", parameters: {} }], timestamp: 0 });
  assistant(s);
  delta(s, ["internal"], ["first"]);
  record(s, { v: 1, groups: ["ext__notes", "ext__notes"] });
  assistant(s);
  for (let i = 2; i < 19; i++) assistant(s); // still only one user-driven prompt
  record(s, { v: 1, tools: ["single-tool"] }); // before the next native prompt
  user(s); delta(s, ["followup"]); assistant(s);
  const length = s.getBranch().length;
  const h = readDecisionsHistory(s);
  assert.deepEqual(h.turns.map((turn) => [turn.turn, turn.batches.map((batch) => batch.turn)]), [[1, [1, 2]], [20, [20]]]);
  assert.equal(historyTurnSummary(h.turns[0]), "3 skills, 2 tools/MCPs added", "base counts once; re-delivery and notices are not additions");
  assert.equal(historyTurnSummary(h.turns[1]), "1 skills, 1 tools/MCPs added");
  const details = historyTurnLines(h.turns[0]);
  assert.equal(details[0], "Turn 1: (3 skills, 2 tools/MCPs added)");
  assert.ok(details.includes("Internal turn 2"));
  assert.ok(details.includes("  + mcp__exa  unknown (no recorded pick) · notice"));
  assert.ok(details.includes("  + ext__notes  unknown (no recorded pick)"));
  assert.equal(details.filter((line) => line.includes("+ mcp__exa")).length, 1, "notice membership is inline, not a duplicate addition");
  assert.ok(details.includes("Skills re-delivered (not new) (1):"));
  const report = historyReportLines(h).join("\n");
  assert.match(report, /Turn 20: \(1 skills, 1 tools\/MCPs added\)/);
  assert.ok(report.indexOf("Turn 20:") < report.indexOf("Turn 1:"), "report shares newest-user-prompt-first order");
  assert.doesNotMatch(report, /PRIVATE|Tool availability \(pi-context-decisions\)|among the MCP servers|exa_member/);
  assert.equal(s.getBranch().length, length, "history does not persist anything");
});

test("empty prompts do not steal earlier additions, but later internal additions keep their owning prompt", () => {
  const s = session();
  user(s); delta(s, ["first"]); assistant(s);
  user(s); assistant(s); // empty second prompt, not necessarily an empty run
  s.appendCustomMessageEntry("foreign", "PRIVATE", true); // not a native user prompt
  delta(s, ["later"]); assistant(s);
  user(s); assistant(s); // entirely empty prompt omitted
  user(s); user(s); delta(s, [], ["first"]); // queued native messages before the same response share a row
  const h = readDecisionsHistory(s);
  assert.deepEqual(h.turns.map((turn) => [turn.turn, turn.batches.map((batch) => batch.turn)]), [[1, [1]], [2, [3]], [5, [5]]]);
  assert.equal(historyTurnSummary(h.turns[2]), "0 skills, 0 tools/MCPs added", "re-delivery-only prompts remain browsable without inventing additions");
  assert.ok(historyTurnLines(h.turns[2]).includes("Internal turn 5 (no response yet)"));
});

test("notice-only context membership is retained without counting it as new ledger availability", () => {
  const s = session(); user(s);
  record(s, { v: 1, groups: ["ext__notes"] }); assistant(s);
  const notice = buildToolNotice([], ["ext__notes"], false)!;
  s.appendCustomMessageEntry(notice.customType, notice.content, notice.display, notice.details);
  assistant(s);
  user(s);
  s.appendCustomMessageEntry(TOOLS_NOTICE_TYPE, "PRIVATE availability text", false, { v: 1, tools: ["notice-only"], groups: [] });
  const h = readDecisionsHistory(s);
  assert.equal(historyTurnSummary(h.turns[0]), "0 skills, 1 tools/MCPs added");
  assert.equal(historyTurnSummary(h.turns[1]), "0 skills, 0 tools/MCPs added");
  assert.ok(historyTurnLines(h.turns[0]).includes("MCP/extension notice only (not a declaration) (1):"));
  assert.ok(historyTurnLines(h.turns[1]).includes("  + notice-only  unknown (no recorded pick)"));
  assert.doesNotMatch(historyReportLines(h).join("\n"), /PRIVATE/);
});

test("legacy writer records collapse only snapshot-confirmed members beside their group, including notices", () => {
  const s = session(); user(s);
  const inv = classifyTools([{ name: "plug_one", sourceInfo: { source: "extension", path: "/PRIVATE/plug.ts" } },
    { name: "mcp__docs__q", namespace: { name: "mcp__docs" } }]);
  const membership = new Map(inv.tools.map((tool) => [tool.name, tool.group!]));
  // The canonical writer still accepts old individual + whole-group grants; the ledger reader must too.
  const tools = ["plug_one", "mcp__docs__q", "mcp__docs__unknown", "unrelated"];
  const groups = ["ext__plug", "mcp__docs"];
  for (const data of toolRecords({ tools, groups, allowlisted: [...tools, ...groups] })) record(s, data);
  const notice = buildToolNotice(tools, groups, true)!;
  s.appendCustomMessageEntry(notice.customType, notice.content, notice.display, notice.details);
  assistant(s);
  const raw = readToolLedger(s);
  assert.deepEqual([...raw.tools], tools, "presentation never mutates old ledger grants");
  assert.deepEqual([...raw.groups], groups);
  const h = readDecisionsHistory(s, membership);
  assert.deepEqual(batches(h)[0].items.tools, ["mcp__docs__unknown", "unrelated"]);
  assert.deepEqual(batches(h)[0].items.noticeTools, ["mcp__docs__unknown", "unrelated"]);
  assert.equal(historyTurnSummary(h.turns[0]), "0 skills, 4 tools/MCPs added");
  const details = historyTurnLines(h.turns[0]).join("\n");
  assert.doesNotMatch(details, /\+ (plug_one|mcp__docs__q)/);
  assert.match(details, /\+ ext__plug  pinned \(allowlist\) · notice/);
  assert.match(details, /\+ mcp__docs  pinned \(allowlist\) · notice/);
  assert.match(details, /\+ mcp__docs__unknown/, "a plausible tool-name prefix is NOT membership evidence");
  assert.doesNotMatch(historyReportLines(h).join("\n"), /PRIVATE|Tool availability/);
  const withoutSnapshot = readDecisionsHistory(s);
  assert.equal(historyTurnSummary(withoutSnapshot.turns[0]), "0 skills, 6 tools/MCPs added", "unknown old membership stays explicit rather than guessed");
});

test("legacy chunked records collapse known members across chunks at one boundary, not earlier tools-mode grants", () => {
  const s = session(); user(s);
  for (const data of toolRecords({ tools: ["earlier"] })) record(s, data);
  assistant(s); user(s);
  const tools = ["member", ...Array.from({ length: 1000 }, (_, n) => `standalone-${n}`)];
  const groups = [...Array.from({ length: 1000 }, (_, n) => `ext__group_${n}`), "ext__plug"];
  const records = toolRecords({ tools, groups, allowlisted: ["ext__plug"] });
  assert.equal(records.length, 2);
  assert.ok(records[0].tools!.includes("member")); assert.ok(records[1].groups!.includes("ext__plug"));
  for (const data of records) record(s, data);
  const h = readDecisionsHistory(s, new Map([["earlier", "ext__plug"], ["member", "ext__plug"]]));
  assert.deepEqual(h.turns[0].batches[0].items.tools, ["earlier"], "a later whole-group grant must not erase earlier history");
  assert.equal(h.turns[1].batches[0].items.tools.length, 1000);
  assert.ok(!h.turns[1].batches[0].items.tools.includes("member"));
  assert.equal(h.turns[1].batches[0].marks?.groups?.get("ext__plug"), "pinned (allowlist)");
});

test("a base record is not context delivery: require the actual committed Pi skills section and exclude already advertised names", () => {
  const s = session();
  const name = `skill<&\"'`;
  s.appendCustomEntry(SKILLS_BASE_ENTRY, { v: 1, names: [name, "overwritten", "delta-first"] });
  assert.equal(batches(readDecisionsHistory(s)).length, 0);
  delta(s, ["delta-first"]);
  const skills = [name, "not-recorded", "delta-first"].map((name) => ({ name, description: "PRIVATE", filePath: "/PRIVATE/SKILL.md", disableModelInvocation: false } as Skill));
  s.appendMessage({ role: "system", content: "", sections: { skills: formatSkillsForPrompt(skills) }, timestamp: 0 });
  assistant(s);
  s.appendMessage({ role: "system", content: "", sections: { skills: formatSkillsForPrompt(skills) }, timestamp: 0 });
  assistant(s);
  const h = readDecisionsHistory(s);
  assert.equal(batches(h).length, 1);
  assert.deepEqual(batches(h)[0].items.base, [name]);
  assert.deepEqual(batches(h)[0].items.skills, ["delta-first"]);
  assert.doesNotMatch(historyReportLines(h).join("\n"), /PRIVATE|overwritten|not-recorded/);
});

test("history is branch-derived, survives compaction/edits, and includes re-delivery-only batches without inventing new picks", () => {
  const s = session();
  user(s); const original = delta(s, ["old"]); const fork = assistant(s);
  delta(s, ["abandoned"]); assistant(s);
  s.branch(fork);
  const keep = user(s);
  s.appendCompaction("PRIVATE SUMMARY", keep, 100);
  delta(s, [], ["old"]); assistant(s);
  s.appendContextEdit(original, null);
  delta(s, [], ["old"]); assistant(s);
  const h = readDecisionsHistory(s);
  assert.deepEqual(h.turns.map((turn) => [turn.turn, turn.batches.map((b) => b.turn)]), [[1, [1]], [2, [2, 3]]]);
  assert.deepEqual(batches(h).map((b) => b.items.skills), [["old"], [], []]);
  assert.deepEqual(batches(h).map((b) => b.items.redelivered), [[], ["old"], ["old"]]);
  assert.doesNotMatch(historyReportLines(h).join("\n"), /abandoned|PRIVATE/);
  s.branch(fork);
  assert.equal(batches(readDecisionsHistory(s)).length, 1, "navigation recomputes the snapshot, no transient history leaks");
});

test("pending batches are explicit; malformed / foreign / empty entries never produce rows", () => {
  const s = session();
  for (const data of [null, "x", { v: 2, tools: ["future"] }, { v: 1, tools: "bad" }, { v: 1, tools: [null, 1, "", "x".repeat(257)] }]) record(s, data);
  s.appendCustomEntry("foreign", { v: 1, tools: ["foreign"] });
  s.appendCustomMessageEntry(SKILLS_MESSAGE_TYPE, "", false, { v: 1, added: ["no-content"] });
  s.appendCustomMessageEntry(SKILLS_MESSAGE_TYPE, "bad", false, { v: 1, added: "bad" });
  s.appendCustomMessageEntry(TOOLS_NOTICE_TYPE, "bad", false, { v: 2, tools: ["future"] });
  assert.equal(batches(readDecisionsHistory(s)).length, 0);
  assert.match(historyReportLines(readDecisionsHistory(s)).at(-1)!, /No committed additions/);
  delta(s, ["pending"]);
  const h = readDecisionsHistory(s);
  assert.equal(batches(h)[0].answered, false);
  assert.match(historyBatchLines(batches(h)[0])[0], /Internal turn 1 \(no response yet\)/);
});

test("chunked ledgers keep every addition in the viewer while RPC/print reports are sanitized and bounded", () => {
  const s = session();
  const tools = Array.from({ length: 2501 }, (_, n) => `tool-${n}-${"界".repeat(120)}`);
  for (const data of toolRecords({ tools })) record(s, data);
  delta(s, ["bad\x1b[31m\n\r\x07\u202e"]);
  const h = readDecisionsHistory(s);
  assert.equal(batches(h)[0].items.tools.length, 2501);
  assert.match(historyBatchLines(batches(h)[0]).at(-1)!, /tool-2500/);
  const text = historyReportLines(h).join("\n");
  assert.ok(text.length < 24_200); assert.ok(text.split("\n").length <= 241);
  assert.doesNotMatch(text, /\x1b|\r|\x07|\u202e/);
  assert.match(text, /report truncated/);
});

test("notice membership and availability are distinct even when a long notice summarizes its names", () => {
  const s = session();
  const tools = Array.from({ length: 101 }, (_, n) => `t${n}`);
  record(s, { v: 1, tools });
  const notice = buildToolNotice(tools, [], true)!;
  assert.doesNotMatch(notice.content, /t100/);
  s.appendCustomMessageEntry(notice.customType, notice.content, notice.display, notice.details);
  const h = readDecisionsHistory(s);
  assert.equal(batches(h)[0].items.noticeTools.length, 101);
  assert.match(historyBatchLines(batches(h)[0]).join("\n"), /· notice/);
});

const oversizedSkills = (): Skill[] => Array.from({ length: 1001 }, (_, n) => ({
  name: `oversized-${n}`, description: "PRIVATE description", filePath: `/PRIVATE/${n}/SKILL.md`, baseDir: `/PRIVATE/${n}`,
  sourceInfo: { path: `/PRIVATE/${n}/SKILL.md`, source: "fixture", scope: "project", origin: "top-level" }, disableModelInvocation: false,
}));

test("oversized unfiltered skill bases retain every validated name once confirmed in the committed system section", () => {
  const s = session();
  const skills = oversizedSkills(); const expected = skills.map((skill) => skill.name);
  // Disabled/unconfigured filtering writes the full base inventory in ONE record, not tool-style chunks.
  s.appendCustomEntry(SKILLS_BASE_ENTRY, { v: 1, names: [null, "", ...expected, "x".repeat(257)] });
  s.appendMessage({ role: "system", content: "", sections: { skills: formatSkillsForPrompt(skills) }, timestamp: 0 });
  assistant(s);
  const h = readDecisionsHistory(s);
  assert.equal(batches(h).length, 1);
  assert.deepEqual(batches(h)[0].items.base, expected);
  assert.equal(historyBatchLines(batches(h)[0]).at(-1), "  + oversized-1000  base (unfiltered)", "the viewer retains names beyond the report limit");
  const report = historyReportLines(h);
  assert.ok(report.length <= 241); assert.ok(report.join("\n").length < 24_200);
  assert.match(report.at(-1)!, /report truncated/);
});

test("oversized fail-open skill deltas and re-deliveries retain every name emitted by the canonical writer", () => {
  const s = session();
  const skills = oversizedSkills(); const expected = skills.map((skill) => skill.name);
  user(s);
  const added = buildSkillsDelta(skills, [], "read")!;
  assert.equal(added.details.added.length, 1001, "explicit fail-open can advertise the entire remaining inventory");
  s.appendCustomMessageEntry(added.customType, added.content, added.display, added.details);
  assistant(s);
  user(s);
  const redelivered = buildSkillsDelta([], skills, "read")!;
  s.appendCustomMessageEntry(redelivered.customType, redelivered.content, redelivered.display, redelivered.details);
  assistant(s);
  const h = readDecisionsHistory(s);
  assert.equal(batches(h).length, 2);
  assert.deepEqual(batches(h)[0].items.skills, expected);
  assert.deepEqual(batches(h)[1].items.redelivered, expected);
  assert.equal(historyBatchLines(batches(h)[0]).at(-1), "  + oversized-1000  unknown (no recorded pick)", "fail-open adds have no recorded pick");
  assert.equal(historyBatchLines(batches(h)[1]).at(-1), "  + oversized-1000  re-delivered", "re-delivery is marked without a new score");
  assert.match(historyReportLines(h).at(-1)!, /report truncated/, "report bounds stay independent of the complete model");
});

const skillNamed = (name: string) => ({ name, description: "PRIVATE", filePath: `/PRIVATE/${name}/SKILL.md`, disableModelInvocation: false } as Skill);

test("added items show raw score / ≥ minimum from recorded picks; pinned (allowlist) show no number; a pick with no record is unscored", () => {
  const s = session();
  s.appendCustomMessageEntry(SKILLS_MESSAGE_TYPE, "PRIVATE descriptions", false, { v: 1, added: ["scored", "unrecorded"], redelivered: [], picks: { scored: { score: 1.6, threshold: 0.375 } } });
  s.appendCustomEntry(SKILLS_BASE_ENTRY, { v: 1, names: ["always"], pinned: true });
  s.appendMessage({ role: "system", content: "", sections: { skills: formatSkillsForPrompt([skillNamed("always")]) }, timestamp: 0 });
  record(s, { v: 1, tools: ["t-score", "t-allow", "t-none"], groups: ["mcp__srv"], picks: { "t-score": { score: 0, threshold: 0.375 }, mcp__srv: { score: 2, threshold: 0.5 } }, allowlisted: ["t-allow"] });
  assistant(s);
  const h = readDecisionsHistory(s);
  const lines = historyBatchLines(batches(h)[0]);
  for (const line of ["  + scored  score 1.6 / ≥0.75", "  + unrecorded  unknown (no recorded pick)", "  + always  pinned (allowlist)", "  + t-score  score 0 / ≥0.75", "  + t-allow  pinned (allowlist)", "  + t-none  unknown (no recorded pick)", "  + mcp__srv  score 2 / ≥1"]) {
    assert.ok(lines.includes(line), `missing line: ${line}`);
  }
  assert.ok(historyReportLines(h).includes("  + scored  score 1.6 / ≥0.75"), "RPC/print report shows the same values");
  for (const line of lines) assert.doesNotMatch(line, /PRIVATE|label|beat|threshold|score:/, "added lines carry only the numbers, never labels");
});

test("canonical skill and tool writers produce the exact score shown in details and bounded reports", () => {
  const s = session(); user(s);
  const skill = skillNamed("selected");
  const delta = buildSkillsDelta([skill], [skillNamed("returning")], "read", new Map([[skill.name, { score: 1.6, threshold: 0.375 }]]))!;
  s.appendCustomMessageEntry(delta.customType, delta.content, delta.display, delta.details);
  const group = "mcp__agent_browser";
  for (const data of toolRecords({ groups: [group], picks: new Map([[group, { score: 1.6, threshold: 0.375 }]]) })) record(s, data);
  assistant(s);
  const notice = buildToolNotice([], [group], false)!;
  s.appendCustomMessageEntry(notice.customType, notice.content, notice.display, notice.details);
  const h = readDecisionsHistory(s);
  const lines = historyTurnLines(h.turns[0]);
  assert.ok(lines.includes("  + selected  score 1.6 / ≥0.75"));
  assert.ok(lines.includes("  + returning  re-delivered"));
  assert.ok(lines.includes("  + mcp__agent_browser  score 1.6 / ≥0.75"));
  assert.equal(batches(h)[1].marks?.noticeGroups?.get(group), "score 1.6 / ≥0.75", "a later notice reuses the committed group pick, not a fresh score");
  assert.equal(historyTurnSummary(h.turns[0]), "1 skills, 1 tools/MCPs added");
  assert.doesNotMatch(historyReportLines(h).join("\n"), /PRIVATE|Tool availability/);
  assert.ok(lines.filter((line) => line.startsWith("  + ")).every((line) => !line.includes("unknown")), "every rendered name has its recorded score or re-delivery label");
});

test("notice-before-grant at one boundary gets its recorded score, but a future boundary cannot retroactively score an old notice", () => {
  const s = session(); user(s);
  const notice = buildToolNotice([], ["mcp__agent_browser"], true)!;
  s.appendCustomMessageEntry(notice.customType, notice.content, notice.display, notice.details);
  assistant(s);
  for (const data of toolRecords({ groups: ["mcp__agent_browser"], picks: new Map([["mcp__agent_browser", { score: 1.6, threshold: 0.375 }]]) })) record(s, data);
  const h = readDecisionsHistory(s);
  assert.equal(batches(h)[0].marks?.noticeGroups?.get("mcp__agent_browser"), "unknown (no recorded pick)");
  assert.equal(batches(h)[1].marks?.groups?.get("mcp__agent_browser"), "score 1.6 / ≥0.75");
  const same = session(); user(same);
  same.appendCustomMessageEntry(notice.customType, notice.content, notice.display, notice.details);
  for (const data of toolRecords({ groups: ["mcp__agent_browser"], picks: new Map([["mcp__agent_browser", { score: 1.6, threshold: 0.375 }]]) })) record(same, data);
  const together = readDecisionsHistory(same);
  assert.equal(batches(together)[0].marks?.noticeGroups?.get("mcp__agent_browser"), "score 1.6 / ≥0.75");
});

test("malformed or unexpected pick records never produce a number", () => {
  const s = session();
  record(s, { v: 1, tools: ["constructor", "bad-score", "bad-threshold", "string-score", "nan", "ok"], picks: JSON.parse('{"constructor": 1, "bad-score": {"score": 3, "threshold": 0.375}, "bad-threshold": {"score": 1, "threshold": 2}, "string-score": {"score": "1", "threshold": 0.375}, "nan": {"score": null, "threshold": 0.375}, "ok": {"score": 1, "threshold": 0.375, "extra": "PRIVATE"}}') });
  assistant(s);
  const lines = historyBatchLines(batches(readDecisionsHistory(s))[0]);
  for (const name of ["constructor", "bad-score", "bad-threshold", "string-score", "nan"]) assert.ok(lines.includes(`  + ${name}  unknown (no recorded pick)`), name);
  assert.ok(lines.includes("  + ok  score 1 / ≥0.75"));
  assert.doesNotMatch(lines.join("\n"), /PRIVATE/);
});

test("raw score and twice the stored threshold use exact numbers on the same scale", () => {
  assert.equal(qualifyingMark(1.6, 0.375), "score 1.6 / ≥0.75");
  assert.equal(qualifyingMark(0.75, 0.375), "score 0.75 / ≥0.75", "threshold equality qualifies");
  assert.equal(qualifyingMark(0, 0.375), "score 0 / ≥0.75");
  assert.equal(qualifyingMark(2, 1), "score 2 / ≥2");
  assert.equal(qualifyingMark(0.6668, 0.3333), "score 0.6668 / ≥0.6666");
  assert.equal(qualifyingMark(0.6664, 0.3333), "score 0.6664 / ≥0.6666", "no rounded tie");
  assert.equal(qualifyingMark(1.4166666666666667, 0.375), "score 1.4166666666666667 / ≥0.75", "no precision is discarded");
});

test("tool picks travel with the chunk record that lists their name, so chunked ledgers keep every value", () => {
  const s = session();
  const tools = Array.from({ length: 1001 }, (_, n) => `p${n}`);
  const picks = new Map<string, { score: number; threshold: number }>(tools.slice(999).map((name): [string, { score: number; threshold: number }] => [name, { score: 1, threshold: 0.375 }]));
  const records = toolRecords({ tools, picks, allowlisted: ["p1000"] });
  assert.deepEqual(records.map((data) => Object.keys(data.picks ?? {})), [["p999"], ["p1000"]]);
  assert.deepEqual(records[1].allowlisted, ["p1000"]);
  for (const data of records) record(s, data);
  const lines = historyBatchLines(batches(readDecisionsHistory(s))[0]);
  assert.ok(lines.includes("  + p999  score 1 / ≥0.75"));
  assert.ok(lines.includes("  + p1000  pinned (allowlist)"));
  assert.ok(lines.includes("  + p0  unknown (no recorded pick)"));
});
