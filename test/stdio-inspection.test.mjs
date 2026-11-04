import assert from "node:assert/strict";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { inspectStdio } from "../dist/stdio-inspect.js";
import { definition, temporaryDirectory } from "./helpers.mjs";

const server = resolve("test/stdio-inspection-server.mjs");

/** Build a literal local fixture command with explicitly declared consumer variables. */
function target(mode = "normal", args = []) {
  return definition("stdio", { capabilities: [], connection: { transport: "stdio", command: process.execPath,
    args: [server, mode, ...args], envVars: ["INSPECTION_EVENTS", "INSPECTION_TOKEN"] } });
}

/** Read local fixture event records; they are never protocol output or publication evidence. */
async function events(path) {
  return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

/** Treat a terminated Linux zombie as stopped while waiting for the OS to reap descendant records. */
async function alive(pid) {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      const state = await readFile("/proc/" + pid + "/stat", "utf8");
      if (/\) Z /u.test(state)) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** Give native process teardown a bounded scheduling window before asserting that no fixture keeps executing. */
async function stopped(pids) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if ((await Promise.all(pids.map(alive))).every((value) => !value)) {
      return;
    }
    await delay(20);
  }
  assert.fail("The owned fixture process tree must stop.");
}

test("stdio inspection requires explicit authorization and variables before process startup", async (t) => {
  const directory = await temporaryDirectory(t);
  const path = join(directory, "events.jsonl");
  await assert.rejects(inspectStdio(target(), { allow: false }, { INSPECTION_EVENTS: path, INSPECTION_TOKEN: "secret" }), /requires/);
  await assert.rejects(inspectStdio(target(), { allow: true }, { INSPECTION_EVENTS: path }), /missing/);
  await assert.rejects(stat(path), { code: "ENOENT" });
});

test("stdio initialization lists tools without calls, inherits only declared credentials, and keeps arguments literal", async (t) => {
  const directory = await temporaryDirectory(t);
  const path = join(directory, "events.jsonl");
  const literal = "literal $HOME; `never execute`";
  const report = await inspectStdio(target("normal", [literal]), { allow: true, cwd: directory }, {
    ...process.env, INSPECTION_EVENTS: path, INSPECTION_TOKEN: "private-fixture-token", AGENT_TCDH_TOKEN: "private-hub-token",
  });
  assert.equal(report.capabilities[0].name, "read_metadata_0");
  const log = await events(path);
  assert.equal(await realpath(log[0].cwd), await realpath(directory));
  assert.equal(log[0].hubTokenInherited, false);
  assert.equal(log[0].token, "private-fixture-token");
  assert.deepEqual(log[0].args, [literal]);
  assert.equal(log.some((entry) => entry.event === "tool-called"), false);
  assert.doesNotMatch(JSON.stringify(report), /private-fixture-token|private-hub-token/);
  await stopped([log[0].pid]);
});

test("stdio teardown stops owned descendants after success and an overall deadline", async (t) => {
  const directory = await temporaryDirectory(t);
  for (const mode of ["descendant", "hang"]) {
    const path = join(directory, mode + ".jsonl");
    const run = inspectStdio(target(mode), { allow: true, timeoutMs: mode === "hang" ? 2000 : 10_000 }, {
      ...process.env, INSPECTION_EVENTS: path, INSPECTION_TOKEN: "private-fixture-token",
    });
    if (mode === "hang") {
      await assert.rejects(run, /Unable to inspect/);
    } else {
      await run;
    }
    const log = await events(path);
    await stopped(log.filter((entry) => entry.pid).map((entry) => entry.pid));
  }
});

test("invalid output, stderr floods, cursor cycles and oversized tool lists fail without reflecting server data", async (t) => {
  const directory = await temporaryDirectory(t);
  for (const mode of ["bad-json", "flood", "cursor", "oversized"]) {
    const path = join(directory, mode + ".jsonl");
    let error;
    try {
      await inspectStdio(target(mode), { allow: true }, { ...process.env, INSPECTION_EVENTS: path, INSPECTION_TOKEN: "private-token" });
    } catch (failure) {
      error = failure;
    }
    assert.ok(error);
    assert.doesNotMatch(String(error), /private-protocol-output|private-stderr-output|private-token/);
    await stopped((await events(path)).filter((entry) => entry.pid).map((entry) => entry.pid));
  }
});

if (process.platform === "win32") {
  test("Windows command shims remain usable for opt-in metadata collection", async (t) => {
    const directory = await temporaryDirectory(t);
    const path = join(directory, "events.jsonl");
    const shim = join(directory, "fixture shim.cmd");
    await writeFile(shim, '@"' + process.execPath + '" "' + server + '" normal %*\r\n');
    const local = target();
    local.connection.command = shim;
    local.connection.args = ["literal argument"];
    assert.equal((await inspectStdio(local, { allow: true }, { ...process.env, INSPECTION_EVENTS: path, INSPECTION_TOKEN: "token" })).capabilities.length, 1);
    assert.deepEqual((await events(path))[0].args, ["literal argument"]);
  });
}
