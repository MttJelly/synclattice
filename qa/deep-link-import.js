const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const electron = require("electron");

const root = path.resolve(__dirname, "..");
const store = path.join(__dirname, ".deep-link-store");
const profile = path.join(__dirname, ".deep-link-profile");
const screenshot = path.join(__dirname, "multi-window-artifacts", "deep-link-import.png");
const link = "chatswitch://import?type=provider&label=Deep%20Link%20QA&baseUrl=https%3A%2F%2Fapi.example.test%2Fv1&model=qa-model&preset=custom";

fs.rmSync(store, { recursive: true, force: true });
fs.rmSync(profile, { recursive: true, force: true });
const result = spawnSync(electron, [`--user-data-dir=${profile}`, root, link], {
  cwd: root,
  encoding: "utf8",
  timeout: 45000,
  windowsHide: true,
  env: {
    ...process.env,
    CHATSWITCH_STORE_ROOT: store,
    CHATSWITCH_QA_SCREENSHOT: screenshot,
    CHATSWITCH_QA_DELAY: "4500",
  },
});

try {
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `Electron exited with ${result.status}.`);
  const line = result.stdout.split(/\r?\n/).find((value) => value.startsWith('{"title":'));
  if (!line) throw new Error(`Deep Link QA result was not found.\n${result.stdout}\n${result.stderr}`);
  const summary = JSON.parse(line);
  assert.equal(summary.deepLinkImport.visible, true);
  assert.equal(summary.deepLinkImport.title, "导入模型供应商");
  assert.equal(summary.deepLinkImport.rows, 4);
  assert.match(summary.deepLinkImport.safety, /敏感信息不会从链接导入/);
  assert.equal(summary.deepLinkImport.confirmDisabled, false);
  assert.equal(summary.windowCount, 1);
  assert.equal(fs.existsSync(screenshot), true);
  const metadata = JSON.parse(fs.readFileSync(path.join(store, "providers.json"), "utf8"));
  const credentialsFile = path.join(store, "credentials.json");
  const credentials = fs.existsSync(credentialsFile)
    ? JSON.parse(fs.readFileSync(credentialsFile, "utf8"))
    : {};
  assert.equal(metadata.relays.length, 0, "Preview-only Deep Link modified providers.");
  assert.deepEqual(credentials, {}, "Preview-only Deep Link modified credentials.");
  console.log(JSON.stringify({ ok: true, ...summary.deepLinkImport, screenshot }));
} finally {
  fs.rmSync(store, { recursive: true, force: true });
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
