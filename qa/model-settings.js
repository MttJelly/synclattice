const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const electron = require("electron");
const { CODEX_HOME } = require("../src/codex-server");

const root = path.resolve(__dirname, "..");
const profile = path.join(__dirname, ".model-settings-profile");
const store = path.join(__dirname, ".model-settings-store");
const screenshot = path.join(__dirname, "multi-window-artifacts", "model-settings.png");

function jsonlFiles(directory) {
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
  return files.sort();
}

const before = {
  active: jsonlFiles(path.join(CODEX_HOME, "sessions")),
  archived: jsonlFiles(path.join(CODEX_HOME, "archived_sessions")),
};

fs.rmSync(store, { recursive: true, force: true });
const modelFixtureSource = before.active[0] || before.archived[0];
if (!modelFixtureSource) throw new Error("Model settings QA requires one existing read-only conversation fixture.");
const modelFixtureTarget = path.join(store, "conversations", "sessions", "qa", path.basename(modelFixtureSource));
fs.mkdirSync(path.dirname(modelFixtureTarget), { recursive: true });
fs.copyFileSync(modelFixtureSource, modelFixtureTarget);
const result = spawnSync(electron, [`--user-data-dir=${profile}`, root], {
  cwd: root,
  encoding: "utf8",
  timeout: 90000,
  windowsHide: true,
  env: {
    ...process.env,
    CHATSWITCH_QA: "1",
    CHATSWITCH_QA_OFFICIAL_AUTHENTICATED: "1",
    CHATSWITCH_STORE_ROOT: store,
    CHATSWITCH_QA_PROVIDER: "official",
    CHATSWITCH_QA_SCENARIO: "model-settings",
    CHATSWITCH_QA_SCREENSHOT: screenshot,
    CHATSWITCH_QA_DELAY: "16000",
    CHATSWITCH_QA_WIDTH: "900",
    CHATSWITCH_QA_HEIGHT: "720",
  },
});

try {
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `Electron exited with ${result.status}.`);
  const line = result.stdout.split(/\r?\n/).find((value) => value.startsWith('{"title":'));
  if (!line) throw new Error(`Model settings QA result was not found.\n${result.stdout}\n${result.stderr}`);
  const summary = JSON.parse(line);
  assert.ok(summary.modelSettings);
  assert.equal(summary.modelSettings.fatal, undefined);
  assert.deepEqual(summary.modelSettings.restored, summary.modelSettings.expected);
  assert.equal(summary.modelSettings.approvalMenuVisible, true);
  assert.equal(summary.modelSettings.modeVisible, true);
  assert.equal(summary.modelSettings.composerOverflow, false);
  assert.equal(summary.modelSettings.error, null);
  assert.equal(summary.view.composerDisabled, false);
  assert.equal(fs.existsSync(screenshot), true);
  const after = {
    active: jsonlFiles(path.join(CODEX_HOME, "sessions")),
    archived: jsonlFiles(path.join(CODEX_HOME, "archived_sessions")),
  };
  assert.deepEqual(after, before, "Model settings QA changed the official conversation file set.");
  console.log(JSON.stringify({
    ok: true,
    ...summary.modelSettings,
    activeRecords: after.active.length,
    archivedRecords: after.archived.length,
    screenshot,
  }));
} finally {
  fs.rmSync(store, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
}
