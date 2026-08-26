const { app } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

app.setName("ChatSwitch Relay QA");
process.env.CHATSWITCH_STORE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "chatswitch-relay-"));
const testRecordHome = path.join(process.env.CHATSWITCH_STORE_ROOT, "records");
fs.mkdirSync(testRecordHome);

const { CodexServer } = require("../src/codex-server");
const { ProviderStore } = require("../src/provider-store");

async function run() {
  await app.whenReady();
  const store = new ProviderStore();
  assert.throws(() => store.setConversationHome(""), /有效的聊天记录目录/);
  assert.equal(store.setConversationHome(testRecordHome), testRecordHome);
  assert.equal(store.resolve("official").codexHome, testRecordHome);
  assert.throws(() => store.addRelay({
    label: "Bad query",
    baseUrl: "https://relay.example/v1?tenant=one",
    model: "gpt-test",
    apiKey: "secret",
  }), /query/);

  const created = store.addRelay({
    label: "QA Relay",
    baseUrl: "https://relay.example/v1/",
    model: "gpt-test",
    protocol: "responses",
    apiKey: "first-secret",
  });
  assert.equal(created.keyConfigurable, true);
  assert.equal(created.hasStoredKey, true);
  assert.equal(created.baseUrl, "https://relay.example/v1");

  let resolved = store.resolve(created.id);
  assert.equal(resolved.env.CHATSWITCH_RELAY_API_KEY, "first-secret");
  assert.equal(resolved.engine, "codex-isolated");
  assert.equal(resolved.bundledRuntimeOnly, true);
  assert.equal(Array.isArray(resolved.args), true);

  store.saveProviderKey(created.id, "updated-secret");
  resolved = store.resolve(created.id);
  assert.equal(resolved.env.CHATSWITCH_RELAY_API_KEY, "updated-secret");
  assert.equal(resolved.env.CHATSWITCH_RELAY_API_KEY, "updated-secret");

  const server = new CodexServer(resolved, {});
  try {
    await server.start();
    assert.equal(server.ready, true);
    assert.equal(Boolean(server.process), true);
    assert.equal(server.runtimeKind, "chatswitch-bundled");
  } finally {
    server.stop();
  }
  const account = store.addAccount({ label: "QA Account" });
  const resolvedAccount = store.resolve(account.id);
  const accountAuth = path.join(resolvedAccount.home, "auth.json");
  fs.writeFileSync(accountAuth, "qa-auth", "utf8");
  const removedAccount = store.removeConnection(account.id);
  assert.equal(removedAccount.type, "account");
  assert.equal(fs.existsSync(accountAuth), false);
  assert.equal(fs.existsSync(path.join(resolvedAccount.home, "sessions")), true);
  assert.equal(fs.existsSync(testRecordHome), true);

  const removedRelay = store.removeConnection(created.id);
  assert.equal(removedRelay.type, "relay");
  assert.equal(store.list().some((provider) => provider.id === created.id), false);
  assert.equal(store.hasRelayKey(created.id), false);
  assert.throws(() => store.removeConnection("official"), /内置连接不能删除/);

  console.log(JSON.stringify({
    ok: true,
    encryptedKeyStored: created.hasStoredKey,
    keyUpdateSupported: true,
    responsesProtocol: resolved.protocol === "responses",
    isolatedToolRuntimeInitialized: true,
    runtimeKind: server.runtimeKind,
    deletionSupported: true,
    sharedRecordsPreserved: fs.existsSync(testRecordHome),
  }));
}

run()
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(() => app.quit());
