import assert from "node:assert/strict";
import { test } from "node:test";
import { buildToolNotice, readToolLedger } from "../src/extension/tool-ledger.ts";

for (const legacy of [false, true]) {
  test(`tool notice ledger distinguishes additive delivery from baseline delivery (${legacy ? "legacy" : "current"} records)`, () => {
    const additive = buildToolNotice(["tool_b"], [], false)!;
    const baseline = buildToolNotice(["tool_a", "tool_b"], [], true)!;
    const entry = (notice: typeof additive) => {
      const { baseline: discriminator, ...oldDetails } = notice.details;
      return { type: "custom_message", ...notice, details: legacy ? oldDetails : { ...oldDetails, baseline: discriminator } };
    };
    const entries = [entry(additive)];
    const session = { getBranch: () => entries };
    const first = readToolLedger(session);
    assert.equal(first.noticed, true);
    assert.equal(first.baselineNoticed, false);
    assert.deepEqual([...first.announced], ["tool_b"]);
    entries.push(entry(baseline));
    const second = readToolLedger(session);
    assert.equal(second.baselineNoticed, true);
    assert.deepEqual([...second.announced].sort(), ["tool_a", "tool_b"]);
    entries.pop();
    assert.equal(readToolLedger(session).baselineNoticed, false, "baseline status is branch-derived, not transient cached state");
  });
}

test("explicit additive discriminator takes precedence over legacy wording", () => {
  const notice = buildToolNotice([], ["mcp__a"], true)!;
  const ledger = readToolLedger({ getBranch: () => [{ type: "custom_message", ...notice, details: { ...notice.details, baseline: false } }] });
  assert.equal(ledger.baselineNoticed, false);
  assert.deepEqual([...ledger.announced], ["mcp__a"]);
});
