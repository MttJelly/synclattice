const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, safeStorage } = require("electron");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "chatswitch-local-provider-electron-"));
const storeRoot = path.join(root, "store");
const sourceHome = path.join(root, "source-home");
const profile = path.join(root, "profile");
process.env.CHATSWITCH_STORE_ROOT = storeRoot;
app.setPath("userData", profile);

const { ProviderStore } = require("../src/provider-store");
const { createLocalProviderDiscovery } = require("../src/local-provider-discovery");

async function run() {
  await app.whenReady();
  assert.equal(safeStorage.isEncryptionAvailable(), true);
  const codexHome = path.join(sourceHome, ".codex");
  const claudeHome = path.join(sourceHome, ".claude");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(claudeHome, { recursive: true });
  const relayKey = "electron-relay-fixture-secret";
  const claudeKey = "electron-claude-fixture-secret";
  const codexConfig = [
    'model = "electron-model"',
    'model_provider = "electron"',
    '[model_providers.electron]',
    'name = "Electron Fixture Relay"',
    'base_url = "https://electron-relay.example.test/v1"',
    'env_key = "ELECTRON_FIXTURE_API_KEY"',
    'wire_api = "responses"',
    '',
  ].join("\n");
  const claudeSettings = JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: "https://electron-claude.example.test/v1",
      ANTHROPIC_AUTH_TOKEN: claudeKey,
      ANTHROPIC_MODEL: "claude-electron-fixture",
    },
  }, null, 2);
  fs.writeFileSync(path.join(codexHome, "config.toml"), codexConfig, "utf8");
  fs.writeFileSync(path.join(claudeHome, "settings.json"), claudeSettings, "utf8");

  const store = new ProviderStore();
  const discovery = createLocalProviderDiscovery({
    homeDirectory: sourceHome,
    environment: { ELECTRON_FIXTURE_API_KEY: relayKey },
    providerStore: store,
  });
  const scan = discovery.discover();
  assert.equal(scan.candidates.length, 2);
  assert.equal(JSON.stringify(scan).includes(relayKey), false);
  assert.equal(JSON.stringify(scan).includes(claudeKey), false);
  const results = discovery.importCandidates(scan.candidates.map((candidate) => candidate.id));
  assert.equal(results.every((result) => result.status === "imported"), true);
  const relay = store.list().find((provider) => provider.label === "Electron Fixture Relay");
  assert.ok(relay);
  assert.equal(store.resolve(relay.id).env.CHATSWITCH_RELAY_API_KEY, relayKey);
  assert.equal(store.resolve("claude").env.ANTHROPIC_AUTH_TOKEN, claudeKey);
  const credentials = fs.readFileSync(path.join(storeRoot, "credentials.json"), "utf8");
  assert.equal(credentials.includes(relayKey), false);
  assert.equal(credentials.includes(claudeKey), false);
  assert.equal(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8"), codexConfig);
  assert.equal(fs.readFileSync(path.join(claudeHome, "settings.json"), "utf8"), claudeSettings);
  console.log(JSON.stringify({ ok: true, candidates: scan.candidates.length, encrypted: true, sourceFilesUnchanged: true }));
}

let qaExitCode = 0;
run()
  .catch((error) => {
    console.error(error.stack || error.message);
    qaExitCode = 1;
  })
  .finally(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // QA artifacts are isolated in the system temp directory.
    }
    app.exit(qaExitCode);
  });
