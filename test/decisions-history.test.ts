import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager, formatSkillsForPrompt, type Skill } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { historyBatchLines, historyReportLines, readDecisionsHistory } from "../src/extension/decisions-history.ts";
import { SKILLS_BASE_ENTRY, SKILLS_MESSAGE_TYPE, buildSkillsDelta } from "../src/extension/skill-ledger.ts";
import { TOOLS_LEDGER_ENTRY, TOOLS_NOTICE_TYPE, toolRecords, buildToolNotice } from "../src/extension/tool-ledger.ts";

const session = () => SessionManager.inMemory("/virtual");
const assistant = (s: SessionManager) => s.appendMessage(fauxAssistantMessage([fauxText("PRIVATE assistant text")]));
const user = (s: SessionManager) => s.appendMessage({ role: "user", content: "PRIVATE user text", timestamp: 0 });
const delta = (s: SessionManager, added: string[], redelivered: string[] = []) => s.appendCustomMessageEntry(SKILLS_MESSAGE_TYPE, "PRIVATE descriptions and paths", false, { v: 1, added, redelivered });
const record = (s: SessionManager, data: unknown) => s.appendCustomEntry(TOOLS_LEDGER_ENTRY, data);

test("history groups committed additions before assistant responses, skips empty turns and separates delivery from availability", () => {
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
  assert.deepEqual(h.batches.map((b) => [b.turn, b.answered]), [[1, true], [3, true]]);
  assert.deepEqual(h.batches[0].items, { skills: ["alpha"], base: [], redelivered: [], tools: ["direct"], groups: ["mcp__srv", "ext__pkg"], noticeTools: ["indirect"], noticeGroups: ["mcp__srv"] });
  assert.deepEqual(h.batches[1].items.skills, ["beta"]);
  assert.deepEqual(h.batches[1].items.redelivered, ["alpha"]);
  assert.deepEqual(h.batches[1].items.tools, ["late"]);
  assert.doesNotMatch(historyReportLines(h).join("\n"), /PRIVATE|not-picked|not-new/);
});

test("a base record is not context delivery: require the actual committed Pi skills section and exclude already advertised names", () => {
  const s = session();
  const name = `skill<&\"'`;
  s.appendCustomEntry(SKILLS_BASE_ENTRY, { v: 1, names: [name, "overwritten", "delta-first"] });
  assert.equal(readDecisionsHistory(s).batches.length, 0);
  delta(s, ["delta-first"]);
  const skills = [name, "not-recorded", "delta-first"].map((name) => ({ name, description: "PRIVATE", filePath: "/PRIVATE/SKILL.md", disableModelInvocation: false } as Skill));
  s.appendMessage({ role: "system", content: "", sections: { skills: formatSkillsForPrompt(skills) }, timestamp: 0 });
  assistant(s);
  s.appendMessage({ role: "system", content: "", sections: { skills: formatSkillsForPrompt(skills) }, timestamp: 0 });
  assistant(s);
  const h = readDecisionsHistory(s);
  assert.equal(h.batches.length, 1);
  assert.deepEqual(h.batches[0].items.base, [name]);
  assert.deepEqual(h.batches[0].items.skills, ["delta-first"]);
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
  assert.deepEqual(h.batches.map((b) => b.turn), [1, 2, 3]);
  assert.deepEqual(h.batches.map((b) => b.items.skills), [["old"], [], []]);
  assert.deepEqual(h.batches.map((b) => b.items.redelivered), [[], ["old"], ["old"]]);
  assert.doesNotMatch(historyReportLines(h).join("\n"), /abandoned|PRIVATE/);
  s.branch(fork);
  assert.equal(readDecisionsHistory(s).batches.length, 1, "navigation recomputes the snapshot, no transient history leaks");
});

test("pending batches are explicit; malformed / foreign / empty entries never produce rows", () => {
  const s = session();
  for (const data of [null, "x", { v: 2, tools: ["future"] }, { v: 1, tools: "bad" }, { v: 1, tools: [null, 1, "", "x".repeat(257)] }]) record(s, data);
  s.appendCustomEntry("foreign", { v: 1, tools: ["foreign"] });
  s.appendCustomMessageEntry(SKILLS_MESSAGE_TYPE, "", false, { v: 1, added: ["no-content"] });
  s.appendCustomMessageEntry(SKILLS_MESSAGE_TYPE, "bad", false, { v: 1, added: "bad" });
  s.appendCustomMessageEntry(TOOLS_NOTICE_TYPE, "bad", false, { v: 2, tools: ["future"] });
  assert.equal(readDecisionsHistory(s).batches.length, 0);
  assert.match(historyReportLines(readDecisionsHistory(s)).at(-1)!, /No committed additions/);
  delta(s, ["pending"]);
  const h = readDecisionsHistory(s);
  assert.equal(h.batches[0].answered, false);
  assert.match(historyBatchLines(h.batches[0])[0], /Before turn 1 \(no response yet\)/);
});

test("chunked ledgers keep every addition in the viewer while RPC/print reports are sanitized and bounded", () => {
  const s = session();
  const tools = Array.from({ length: 2501 }, (_, n) => `tool-${n}-${"界".repeat(120)}`);
  for (const data of toolRecords({ tools })) record(s, data);
  delta(s, ["bad\x1b[31m\n\r\x07\u202e"]);
  const h = readDecisionsHistory(s);
  assert.equal(h.batches[0].items.tools.length, 2501);
  assert.match(historyBatchLines(h.batches[0]).at(-1)!, /tool-2500/);
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
  assert.equal(h.batches[0].items.noticeTools.length, 101);
  assert.match(historyBatchLines(h.batches[0]).join("\n"), /notice; long lists summarized/);
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
  assert.equal(h.batches.length, 1);
  assert.deepEqual(h.batches[0].items.base, expected);
  assert.equal(historyBatchLines(h.batches[0]).at(-1), "  oversized-1000", "the viewer retains names beyond the report limit");
  const report = historyReportLines(h);
  assert.ok(report.length <= 241); assert.ok(report.join("\n").length < 24_200);
  assert.match(report.at(-1)!, /report truncated/);
});

test("oversized fail-open skill deltas and re-deliveries retain every name emitted by the canonical writer", () => {
  const s = session();
  const skills = oversizedSkills(); const expected = skills.map((skill) => skill.name);
  const added = buildSkillsDelta(skills, [], "read")!;
  assert.equal(added.details.added.length, 1001, "explicit fail-open can advertise the entire remaining inventory");
  s.appendCustomMessageEntry(added.customType, added.content, added.display, added.details);
  assistant(s);
  const redelivered = buildSkillsDelta([], skills, "read")!;
  s.appendCustomMessageEntry(redelivered.customType, redelivered.content, redelivered.display, redelivered.details);
  assistant(s);
  const h = readDecisionsHistory(s);
  assert.equal(h.batches.length, 2);
  assert.deepEqual(h.batches[0].items.skills, expected);
  assert.deepEqual(h.batches[1].items.redelivered, expected);
  for (const batch of h.batches) assert.equal(historyBatchLines(batch).at(-1), "  oversized-1000");
  assert.match(historyReportLines(h).at(-1)!, /report truncated/, "report bounds stay independent of the complete model");
});
