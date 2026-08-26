const { app, net } = require("electron");
const assert = require("node:assert/strict");
const path = require("node:path");
const { ClaudeServer } = require("../src/claude-server");
const { fetchClaudeModels } = require("../src/claude-models");
const { ProviderStore } = require("../src/provider-store");

app.setName("ChatSwitch");

async function run() {
  await app.whenReady();
  const setupKey = String(process.env.CHATSWITCH_CLAUDE_SETUP_TOKEN || "").trim();
  delete process.env.CHATSWITCH_CLAUDE_SETUP_TOKEN;
  const store = new ProviderStore();
  if (setupKey) store.saveProviderKey("claude", setupKey);
  const provider = store.resolve("claude");
  const apiKey = provider.env?.[provider.envKey];
  if (!apiKey) throw new Error("No encrypted Claude token is available.");

  const catalog = await fetchClaudeModels(provider.baseUrl, apiKey, net.fetch);
  const testProvider = {
    ...provider,
    claudeConfigDir: path.join(__dirname, ".claude-live-profile"),
  };
  const server = new ClaudeServer(testProvider);
  let actualModel = null;
  let agentText = "";
  const diagnostics = [];
  server.on("diagnostic", (message) => diagnostics.push(message));
  const completion = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Claude live turn timed out.")), 90000);
    server.on("notification", (message) => {
      if (message.method === "provider/model-resolved") actualModel = message.params.actualModel;
      if (message.method === "item/completed" && message.params?.item?.type === "agentMessage") {
        agentText = message.params.item.text;
      }
      if (message.method === "turn/completed") {
        clearTimeout(timer);
        resolve(message.params.turn);
      }
    });
  });
  try {
    await server.start();
    const started = await server.startThread(process.cwd());
    await server.startTurn(
      started.thread.id,
      "Reply with exactly CLAUDE_LIVE_OK and nothing else. Do not use tools.",
      process.cwd(),
      null,
      { model: "fable", effort: "low" },
    );
    const turn = await completion;
    if (turn.status !== "completed") {
      throw new Error(`Claude turn ended with ${turn.status}: ${diagnostics.at(-1) || "no diagnostic"}`);
    }
  } finally {
    server.stop();
  }

  assert.ok(catalog.models.length > 0, "Claude model discovery returned no models.");
  assert.ok(catalog.routes.some((route) => route.id === provider.model), "The configured Claude route is unavailable.");
  assert.ok(actualModel, "Claude did not report the resolved upstream model.");
  assert.equal(agentText.trim(), "CLAUDE_LIVE_OK");

  console.log(JSON.stringify({
    ok: true,
    encryptedKeyStored: store.hasStoredProviderKey("claude"),
    modelCount: catalog.models.length,
    selectedRouteAvailable: catalog.routes.some((route) => route.id === provider.model),
    routeMappings: catalog.routes.map(({ id, actualModel: actual }) => ({ id, actualModel: actual })),
    actualModel,
    selectedEffort: "low",
    agentResponseMatches: agentText.trim() === "CLAUDE_LIVE_OK",
  }));
}

run()
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(() => app.quit());
