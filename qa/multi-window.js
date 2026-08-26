const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const electron = require("electron");
const { CODEX_HOME } = require("../src/codex-server");

const root = path.resolve(__dirname, "..");
const outputDirectory = path.join(__dirname, "multi-window-artifacts");
const profileDirectory = path.join(__dirname, ".electron-qa-profile");
const storeDirectory = fs.mkdtempSync(path.join(__dirname, ".multi-window-store-"));
const conversationDirectory = path.join(storeDirectory, "conversations");
const emptySkillDirectory = path.join(storeDirectory, "empty-skills");
fs.mkdirSync(path.join(conversationDirectory, "openai-compatible-conversations"), { recursive: true });
fs.mkdirSync(emptySkillDirectory, { recursive: true });
const sourceAuth = path.join(CODEX_HOME, "auth.json");
if (fs.existsSync(sourceAuth)) fs.copyFileSync(sourceAuth, path.join(conversationDirectory, "auth.json"));
process.on("exit", () => fs.rmSync(storeDirectory, { recursive: true, force: true }));

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

const result = spawnSync(electron, [
  `--user-data-dir=${profileDirectory}`,
  root,
], {
  cwd: root,
  encoding: "utf8",
  timeout: 90000,
  windowsHide: true,
  env: {
    ...process.env,
    CHATSWITCH_QA: "1",
    CHATSWITCH_QA_OFFICIAL_AUTHENTICATED: "1",
    CHATSWITCH_QA_PROVIDER: "official",
    CHATSWITCH_QA_MULTI_PROVIDER: "1",
    CHATSWITCH_QA_OUTPUT_DIR: outputDirectory,
    CHATSWITCH_STORE_ROOT: storeDirectory,
    CHATSWITCH_SKILL_SOURCES: emptySkillDirectory,
    CHATSWITCH_QA_HEXUAN_TOKEN: "qa-placeholder-not-a-secret",
  },
});

if (result.error) throw result.error;
if (result.status !== 0) throw new Error(result.stderr || result.stdout || `Electron exited with ${result.status}.`);
assert.doesNotMatch(result.stderr, /Error occurred in handler for 'provider:claude-models'/);
assert.doesNotMatch(result.stderr, /Error occurred in handler/);
const line = result.stdout.split(/\r?\n/).find((value) => value.startsWith('{"ok":true'));
if (!line) throw new Error(`Multi-window result was not found.\n${result.stdout}\n${result.stderr}`);
const summary = JSON.parse(line);
assert.equal(summary.appUserModelId, "com.chatswitch.desktop.dev");
assert.equal(summary.runtimeIconAvailable, true);
assert.equal(summary.windowCount, 2);
assert.equal(summary.serverCount, 2);
assert.equal(summary.providerReturn, true);
assert.equal(summary.claudeConfigurationReturn, true);
assert.equal(summary.recordHomeReturn, true);
assert.equal(summary.projectConfigurationReturn, true);
assert.match(summary.unavailableProviderError, /尚未配置可用的 API Key/);
assert.equal(summary.unavailableCredentialVisible, true);
assert.match(summary.unavailableConnection, /已连接/);
assert.deepEqual(summary.internalProviders, ["official", "hexuan"]);
assert.equal(summary.windows[0].providerName, "OpenAI 官方");
assert.equal(summary.windows[1].providerName, "Hexuan");
assert.equal(summary.windows[0].selectedEffort, "medium");
assert.ok(summary.windows.every((window) => window.providerBrand === "OpenAI"));
assert.ok(summary.windows.every((window) => window.modelOptionCount > 0 && !window.modelDisabled));
assert.ok(summary.windows.every((window) => window.selectedModel && window.selectedEffort));
assert.ok(summary.windows.every((window) => window.connection.includes("已连接")));
assert.ok(summary.windows.every((window) => window.overlayHidden));

const after = {
  active: jsonlFiles(path.join(CODEX_HOME, "sessions")),
  archived: jsonlFiles(path.join(CODEX_HOME, "archived_sessions")),
};
assert.deepEqual(after, before, "Multi-window QA changed the official conversation file set.");
console.log(JSON.stringify({
  ...summary,
  activeRecords: after.active.length,
  archivedRecords: after.archived.length,
  screenshots: [
    path.join(outputDirectory, "multi-window-1.png"),
    path.join(outputDirectory, "multi-window-2.png"),
    path.join(outputDirectory, "provider-connections.png"),
    path.join(outputDirectory, "claude-config.png"),
    path.join(outputDirectory, "record-home.png"),
    path.join(outputDirectory, "project-create.png"),
  ],
}));
