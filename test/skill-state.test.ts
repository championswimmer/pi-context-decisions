import assert from "node:assert/strict";
import { test } from "node:test";
import { advertisedSkillNames, skillNamesFromSection } from "../src/extension/skill-state.ts";

test("extracts canonical names and XML entities only", () => {
  assert.deepEqual(skillNamesFromSection("<skills><skill><name>a&amp;b</name><description>private</description></skill><skill><name>two</name></skill></skills>"), ["a&b", "two"]);
});

test("reads committed native sections and legacy delivery, not base metadata", () => {
  const session = { getBranch: () => [
    { type: "message", message: { role: "system", sections: { skills: "<skill><name>native</name></skill>" } } },
    { type: "custom", customType: "context-decisions-base", data: { v: 1, names: ["unproved"] } },
    { type: "custom_message", customType: "context-decisions-skills", details: { v: 1, added: ["legacy"], redelivered: ["again"] } },
    { type: "custom_message", customType: "context-decisions-skills", details: { v: 2, added: ["unknown-version"] } },
  ] };
  assert.deepEqual([...advertisedSkillNames(session as never)], ["native", "legacy", "again"]);
});
