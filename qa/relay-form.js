const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const electron = require("electron");

const root = path.resolve(__dirname, "..");
const profile = path.join(__dirname, ".relay-form-profile");
const store = path.join(__dirname, ".relay-form-store");
const screenshot = path.join(__dirname, "multi-window-artifacts", "relay-form.png");

fs.rmSync(store, { recursive: true, force: true });
const result = spawnSync(electron, [`--user-data-dir=${profile}`, root], {
  cwd: root,
  encoding: "utf8",
  timeout: 45000,
  windowsHide: true,
  env: {
    ...process.env,
    CHATSWITCH_STORE_ROOT: store,
    CHATSWITCH_QA_SCENARIO: "relay-form",
    CHATSWITCH_QA_SCREENSHOT: screenshot,
    CHATSWITCH_QA_DELAY: "11000",
    CHATSWITCH_QA_WIDTH: "1000",
    CHATSWITCH_QA_HEIGHT: "720",
  },
});

try {
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `Electron exited with ${result.status}.`);
  assert.doesNotMatch(result.stderr, /Cannot read properties of null \(reading 'reset'\)/);
  assert.doesNotMatch(result.stderr, /Unknown provider:/);
  const line = result.stdout.split(/\r?\n/).find((value) => value.startsWith('{"title":'));
  if (!line) throw new Error(`Relay form QA result was not found.\n${result.stdout}\n${result.stderr}`);
  const summary = JSON.parse(line);
  assert.ok(summary.relayForm);
  assert.equal(summary.relayForm.fatal, undefined);
  assert.equal(summary.relayForm.providerAdded, true);
  assert.equal(summary.relayForm.providerEdited, true);
  assert.equal(summary.relayForm.formReset, true);
  assert.equal(summary.relayForm.providerDeleted, true);
  assert.equal(summary.relayForm.error, null);
  assert.equal(summary.recordHome, path.join(store, "conversations"));
  const metadata = JSON.parse(fs.readFileSync(path.join(store, "providers.json"), "utf8"));
  const credentials = JSON.parse(fs.readFileSync(path.join(store, "credentials.json"), "utf8"));
  assert.equal(metadata.relays.some((provider) => provider.id === summary.relayForm.providerId), false);
  assert.equal(Object.hasOwn(credentials, summary.relayForm.providerId), false);
  assert.equal(fs.existsSync(screenshot), true);
  console.log(JSON.stringify({
    ok: true,
    ...summary.relayForm,
    screenshot,
  }));
} finally {
  fs.rmSync(store, { recursive: true, force: true });
}
