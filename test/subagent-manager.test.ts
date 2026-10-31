import assert from "node:assert/strict";
import { test } from "node:test";
import { subagentManagerPresent } from "../src/extension/subagent-manager.ts";
test("manager detection uses public provenance, never agent tool names alone", () => {
  assert.equal(subagentManagerPresent([{ name: "agent_spawn", sourceInfo: { path: "<sdk:agent_spawn>", source: "sdk" } }]), false);
  for (const sourceInfo of [
    { path: "/pkg/src/index.ts", source: "npm:pi-subagent-manager@0.29.3", origin: "package" },
    { path: "/repo/pi-subagent-manager/src/index.ts", source: "local", origin: "top-level" },
    { path: "<subagent-inherited-tools>", source: "subagent-inherited-tools" },
  ]) assert.equal(subagentManagerPresent([{ name: "anything", sourceInfo }]), true);
  assert.equal(subagentManagerPresent([{ name: "agent_spawn", sourceInfo: { source: "npm:pi-subagent-manager-other", origin: "package" } }]), false);
});

test("explicit unrelated npm identity cannot fall back to a manager basename or path", () => {
  assert.equal(subagentManagerPresent([{ name: "agent_spawn", sourceInfo: {
    source: "npm:@acme/pi-subagent-manager@1.0.0", origin: "package",
    baseDir: "/node_modules/@acme/pi-subagent-manager", path: "/node_modules/@acme/pi-subagent-manager/src/index.ts",
  } }]), false);
});

test("npm identity rejects unrelated packages even when provenance path resembles a local checkout", () => {
  assert.equal(subagentManagerPresent([{ name: "agents", sourceInfo: { source: "npm:unrelated@1.0.0", path: "/repo/pi-subagent-manager/src/index.ts", origin: "top-level" } }]), false);
});
