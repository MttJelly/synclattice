const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const electron = require("electron");
const { CODEX_HOME } = require("../src/codex-server");

const root = path.resolve(__dirname, "..");
const profile = fs.mkdtempSync(path.join(__dirname, ".thread-actions-profile-"));
const store = fs.mkdtempSync(path.join(__dirname, ".thread-actions-store-"));
const screenshot = path.join(__dirname, "multi-window-artifacts", "thread-actions.png");

function jsonlRecords(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(target);
    }
  };
  visit(directory);
  return files.sort().map((file) => ({
    file,
    sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
  }));
}

const before = {
  active: jsonlRecords(path.join(CODEX_HOME, "sessions")),
  archived: jsonlRecords(path.join(CODEX_HOME, "archived_sessions")),
};

const threadFixtureSource = before.active[0]?.file || before.archived[0]?.file;
if (!threadFixtureSource) throw new Error("Thread actions QA requires one existing read-only conversation fixture.");
const threadFixtureTarget = path.join(store, "conversations", "sessions", "qa", path.basename(threadFixtureSource));
fs.mkdirSync(path.dirname(threadFixtureTarget), { recursive: true });
fs.copyFileSync(threadFixtureSource, threadFixtureTarget);
const processLog = path.join(store, "thread-actions-process.log");
const processLogHandle = fs.openSync(processLog, "w");
const result = spawnSync(electron, [`--user-data-dir=${profile}`, root], {
  cwd: root,
  timeout: 45000,
  windowsHide: true,
  stdio: ["ignore", processLogHandle, processLogHandle],
  env: {
    ...process.env,
    CHATSWITCH_QA: "1",
    CHATSWITCH_QA_OFFICIAL_AUTHENTICATED: "1",
    CHATSWITCH_STORE_ROOT: store,
    CHATSWITCH_QA_PROVIDER: "official",
    CHATSWITCH_QA_SCENARIO: "thread-actions",
    CHATSWITCH_QA_SCREENSHOT: screenshot,
    CHATSWITCH_QA_DELAY: "16000",
    CHATSWITCH_QA_WIDTH: "1000",
    CHATSWITCH_QA_HEIGHT: "720",
  },
});
fs.closeSync(processLogHandle);
const processOutput = fs.readFileSync(processLog, "utf8");

try {
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(processOutput || `Electron exited with ${result.status}.`);
  const line = processOutput.split(/\r?\n/).find((value) => value.startsWith('{"title":'));
  if (!line) throw new Error(`Thread actions QA result was not found.\n${processOutput}`);
  const summary = JSON.parse(line);
  assert.ok(summary.threadActions);
  assert.equal(summary.threadActions.fatal, undefined);
  assert.equal(summary.threadActions.restored, true);
  assert.equal(summary.threadActions.immediateDeleted, true);
  assert.deepEqual(summary.threadActions.after, {
    active: summary.threadActions.before.active - 1,
    removed: summary.threadActions.before.removed,
  });
  assert.equal(summary.view.selected, "removed");
  assert.equal(fs.existsSync(screenshot), true);
  const after = {
    active: jsonlRecords(path.join(CODEX_HOME, "sessions")),
    archived: jsonlRecords(path.join(CODEX_HOME, "archived_sessions")),
  };
  assert.deepEqual(
    {
      active: after.active.map((item) => item.file),
      archived: after.archived.map((item) => item.file),
    },
    {
      active: before.active.map((item) => item.file),
      archived: before.archived.map((item) => item.file),
    },
    "Thread actions QA changed the official conversation file set.",
  );
  const beforeTarget = [...before.active, ...before.archived]
    .find((item) => item.file.includes(summary.threadActions.threadId));
  const afterTarget = [...after.active, ...after.archived]
    .find((item) => item.file.includes(summary.threadActions.threadId));
  assert.ok(beforeTarget && afterTarget, "The tested official conversation file was not found.");
  assert.equal(afterTarget.sha256, beforeTarget.sha256, "Remove/restore changed the tested official conversation content.");
  console.log(JSON.stringify({
    ok: true,
    ...summary.threadActions,
    activeRecords: after.active.length,
    archivedRecords: after.archived.length,
    screenshot,
  }));
} finally {
  try {
    fs.rmSync(store, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch (error) {
    console.error(`[qa-cleanup] ${error.message}`);
  }
}
