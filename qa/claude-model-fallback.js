const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const electron = require("electron");

const root = path.resolve(__dirname, "..");
const profile = path.join(__dirname, ".claude-fallback-profile");
const store = path.join(__dirname, ".claude-fallback-store");
const screenshot = path.join(__dirname, "multi-window-artifacts", "claude-model-fallback.png");

fs.rmSync(store, { recursive: true, force: true });
const result = spawnSync(electron, [`--user-data-dir=${profile}`, root], {
  cwd: root,
  encoding: "utf8",
  timeout: 45000,
  windowsHide: true,
  env: {
    ...process.env,
    CHATSWITCH_STORE_ROOT: store,
    CHATSWITCH_QA_CLAUDE_TOKEN: "chatswitch-invalid-qa-token",
    CHATSWITCH_QA_SCENARIO: "claude-model-fallback",
    CHATSWITCH_QA_SCREENSHOT: screenshot,
    CHATSWITCH_QA_DELAY: "9000",
    CHATSWITCH_QA_WIDTH: "1000",
    CHATSWITCH_QA_HEIGHT: "720",
  },
});

try {
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `Electron exited with ${result.status}.`);
  assert.doesNotMatch(result.stderr, /Error occurred in handler for 'provider:claude-models'/);
  const line = result.stdout.split(/\r?\n/).find((value) => value.startsWith('{"title":'));
  if (!line) throw new Error(`Claude fallback QA result was not found.\n${result.stdout}\n${result.stderr}`);
  const summary = JSON.parse(line);
  assert.equal(summary.claudeConfig.visible, true);
  assert.match(summary.claudeConfig.status, /Token 无法读取模型/);
  assert.match(summary.claudeConfig.status, /内置路由/);
  assert.ok(summary.claudeConfig.optionCount >= 4);
  assert.ok(summary.claudeConfig.selectedModel);
  assert.equal(summary.recordHome, path.join(store, "conversations"));
  assert.equal(fs.existsSync(screenshot), true);
  console.log(JSON.stringify({
    ok: true,
    ...summary.claudeConfig,
    handlerErrorLogged: false,
    screenshot,
  }));
} finally {
  fs.rmSync(store, { recursive: true, force: true });
}
