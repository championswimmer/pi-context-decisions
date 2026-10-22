import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerContextDecisions } from "../src/extension/runtime.ts";
import { defaultSettings } from "../src/settings.ts";
import { simHost } from "./helpers/pi-sim.ts";

const probe = "pi-subagent-manager:diagnostic:probe";
const channel = "pi-subagent-manager:diagnostic";
for (const mode of ["hosted", "absent", "old", "malformed", "unknown-version-shape", "undefined-argument", "legacy", "duplicate", "send-throws", "probe-throws", "async"] as const) {
  test(`automatic headless diagnostics: ${mode}`, async (t) => {
    const stderr: string[] = [], reports: unknown[] = [];
    t.mock.method(console, "error", (...args: unknown[]) => stderr.push(args.join(" ")));
    const h = simHost(); let probes = 0, respondLater: (() => void) | undefined;
    const events = { on() { return () => {}; }, emit(name: string, data: unknown) {
      if (name === probe) {
        probes++;
        const respond = (data as { respond: (...args: unknown[]) => void }).respond;
        if (mode === "probe-throws") throw new Error("PRIVATE");
        if (mode === "hosted" || mode === "send-throws") respond({ version: "1.1.0", protocol: 1 });
        if (mode === "old") respond({ version: "1.0.0", protocol: 1 });
        if (mode === "malformed") respond({ version: "banana", hosted: true });
        if (mode === "unknown-version-shape") respond({ version: "1.0.0" });
        if (mode === "undefined-argument") respond(undefined);
        if (mode === "legacy") respond();
        if (mode === "duplicate") { respond({ version: "1.1.0", protocol: 1 }); respond({ version: "1.1.0", protocol: 1 }); }
        if (mode === "async") respondLater = respond;
      } else if (name === channel) {
        if (mode === "send-throws") throw new Error("PRIVATE");
        reports.push(data);
      }
    } };
    Object.assign(h.pi, { events });
    registerContextDecisions(h.pi, { settingsPath: "/unused", agentDir: "/unused", async load() {
      return { settings: defaultSettings(), warnings: ["SAFE_WARNING", "SAFE_WARNING"], error: "SAFE_CONFIG_ERROR" };
    } });
    const ctx = { hasUI: false, mode: "print", ui: {}, modelRegistry: {} } as ExtensionContext;
    await h.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    respondLater?.(); // Late responses must not turn a cached miss into a live host.
    assert.equal(probes, 1);
    if (mode === "hosted") {
      assert.deepEqual(reports, [
        { source: "pi-context-decisions", level: "error", message: "Settings error: SAFE_CONFIG_ERROR; skill advertisements fail closed until repaired" },
        { source: "pi-context-decisions", level: "warning", message: "SAFE_WARNING" },
      ]);
      assert.deepEqual(stderr, []);
    } else {
      assert.deepEqual(reports, []);
      assert.equal(stderr.length, 2);
      assert.match(stderr[0]!, /SAFE_CONFIG_ERROR/);
      assert.match(stderr[1]!, /SAFE_WARNING/);
      assert.doesNotMatch(stderr.join("\n"), /PRIVATE/);
    }
    await h.command("status", ctx);
    assert.match(stderr.at(-1)!, /Context decisions:/, "explicit reports keep stderr even with a host");
    assert.equal(probes, 1, "explicit reports do not probe");
    await h.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
    await h.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    // Duplicates retain existing instance semantics; probe is lazy after the reset.
    assert.equal(probes, 1);
    assert.deepEqual(h.calls, { getAllTools: 0, setActiveTools: 0 });
  });
}

test("session start/shutdown reset the cached host; sends stay bounded", async (t) => {
  const stderr: string[] = [], reports: { message: string }[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => stderr.push(args.join(" ")));
  const h = simHost(); let hosted = true, probes = 0, warning = "A".repeat(1200);
  Object.assign(h.pi, { events: { on() { return () => {}; }, emit(name: string, data: unknown) {
    if (name === probe) { probes++; if (hosted) (data as { respond: (capability: unknown) => void }).respond({ version: "1.1.0", protocol: 1 }); }
    else if (name === channel) reports.push(data as { message: string });
  } } });
  registerContextDecisions(h.pi, { settingsPath: "/unused", agentDir: "/unused", async load() {
    return { settings: defaultSettings(), warnings: [warning] };
  }, async loadProjectAllowlist() { return { names: [], tools: [], mcpServers: [], warnings: ["SAFE_PROJECT"] }; } });
  const ctx = { hasUI: false, mode: "print", ui: {}, modelRegistry: {} } as ExtensionContext;
  const start = () => h.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await start(); assert.equal(reports[0]!.message.length, 1000); assert.deepEqual(stderr, []);
  hosted = false; warning = "SAFE_SECOND";
  await start(); assert.equal(probes, 2); assert.match(stderr.at(-1)!, /SAFE_SECOND/);
  await h.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
  // A warning before another start must not use the previous session's cached miss.
  hosted = true;
  await h.emit("before_agent_start", { type: "before_agent_start", messageType: "user", prompt: "task",
    systemPromptOptions: { skills: [] } }, { ...ctx, cwd: "/fixture" });
  assert.equal(probes, 3, "shutdown resets the cached miss even before another start");
  assert.equal(reports.at(-1)!.message, "SAFE_PROJECT");
  warning = "SAFE_THIRD"; await start(); assert.equal(probes, 4);
  assert.equal(reports.at(-1)!.message, "SAFE_THIRD");
});

for (const injected of [false, true]) test(`UI and injected sinks bypass host protocol: ${injected}`, async () => {
  const h = simHost(), messages: string[] = [];
  Object.assign(h.pi, { events: { on() { return () => {}; }, emit() { throw new Error("must not probe"); } } });
  registerContextDecisions(h.pi, { settingsPath: "/unused", agentDir: "/unused", async load() {
    return { settings: defaultSettings(), warnings: ["SAFE_WARNING"] };
  }, ...(injected ? { report(_ctx, message) { messages.push(message); } } : {}) });
  const ctx = { hasUI: !injected, mode: injected ? "print" : "rpc", modelRegistry: {}, ui: {
    notify(message: string) { messages.push(message); }, setStatus() {},
  } } as unknown as ExtensionContext;
  await h.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  assert.deepEqual(messages, ["SAFE_WARNING"]);
});


import { compatibleManagerCapability, MIN_SUBAGENT_MANAGER_DIAGNOSTICS_VERSION } from "../src/extension/manager-diagnostics.ts";
test("minimum manager capability rejects absent, old, malformed and prerelease identities", () => {
  assert.equal(MIN_SUBAGENT_MANAGER_DIAGNOSTICS_VERSION, "1.1.0");
  for (const version of ["1.1.0", "1.1.1", "1.10.0", "2.0.0", "1.1.0+build.1"])
    assert.equal(compatibleManagerCapability({ version, protocol: 1 }), true, version);
  for (const version of ["1.0.0", "0.99.0", "1.1.0-rc.1", "2.0.0-rc.1", "v1.1.0", "01.1.0", "1.1", "1.1.0+", "999999999999999999.0.0", "1.1.0\n"])
    assert.equal(compatibleManagerCapability({ version, protocol: 1 }), false, version);
  for (const capability of [null, {}, { version: "1.1.0" }, { version: "1.1.0", protocol: 2 }, { version: "1.1.0", protocol: "1" }])
    assert.equal(compatibleManagerCapability(capability), false);
});

for (const capability of [undefined, { version: "1.0.0", protocol: 1 }, { version: "bad", protocol: 1 }, { version: "1.1.0", protocol: 1 }])
  test(`parent capability notice/status: ${JSON.stringify(capability)}`, async () => {
    const h = simHost(), notifications: string[] = [];
    let detected = true;
    Object.assign(h.pi, {
      getCommands: () => detected ? [{ name: "agents", sourceInfo: { source: "npm:pi-subagent-manager@1.1.0", path: "/pkg/src/index.ts", origin: "package", scope: "user" } }] : [],
      events: { on() { return () => {}; }, emit(name: string, payload: unknown) {
        if (name === "pi-subagent-manager:capabilities:probe" && capability)
          (payload as { respond(value: unknown): void }).respond(capability);
      } },
    });
    registerContextDecisions(h.pi, { settingsPath: "/unused", agentDir: "/unused", async load() { return { settings: defaultSettings(), warnings: [] }; } });
    const ctx = { mode: "tui", hasUI: true, modelRegistry: {}, ui: { setStatus() {}, notify(message: string) { notifications.push(message); } } } as unknown as ExtensionContext;
    const start = () => h.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    await start();
    const compatible = compatibleManagerCapability(capability);
    assert.equal(notifications.length, compatible ? 0 : 1);
    await h.emit("before_agent_start", { type: "before_agent_start", prompt: "task", messageType: "user", systemPromptOptions: { skills: [] } }, ctx);
    await h.command("status", ctx);
    const status = notifications.at(-1)!;
    assert.match(status, compatible ? /Subagent diagnostics: parent routing available/ : /Subagent diagnostics unavailable/);
    assert.match(status, /1\.1\.0/);
    if (!compatible) {
      assert.match(notifications[0]!, /fall back to stderr/);
      assert.equal(notifications.filter((text) => text.startsWith("pi-subagent-manager integration")).length, 1);
    }
    await start();
    assert.equal(notifications.filter((text) => text.startsWith("pi-subagent-manager integration")).length, compatible ? 0 : 2);
    detected = false;
    const before = notifications.length; await start(); assert.equal(notifications.length, before);
    assert.deepEqual(h.calls, { getAllTools: 0, setActiveTools: 0 });
  });
