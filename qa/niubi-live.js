const { app, net } = require("electron");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { CodexServer } = require("../src/codex-server");
const { ProviderStore } = require("../src/provider-store");
const { fetchRelayBalance } = require("../src/relay-balance");
const { USER_AGENT } = require("../src/app-version");

app.setName("ChatSwitch");

function responseError(payload, fallback = "request rejected") {
  if (typeof payload?.error === "string") return payload.error;
  return String(payload?.message || payload?.error?.message || fallback);
}

async function run() {
  await app.whenReady();
  const setupKey = String(process.env.CHATSWITCH_SETUP_API_KEY || "").trim();
  delete process.env.CHATSWITCH_SETUP_API_KEY;

  const store = new ProviderStore();
  if (setupKey) store.saveProviderKey("niubi", setupKey);
  const provider = store.resolve("niubi");
  const apiKey = provider.env?.[provider.envKey];
  if (!apiKey) throw new Error("No encrypted Niubi key is available.");

  const modelsResponse = await net.fetch(`${provider.baseUrl}/models`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
  });
  const modelsPayload = await modelsResponse.json().catch(() => null);
  const modelIds = Array.isArray(modelsPayload?.data)
    ? modelsPayload.data.map((item) => item?.id).filter(Boolean)
    : [];

  const balance = await fetchRelayBalance(provider, apiKey, net.fetch);

  let directResponse = { status: null, created: false, error: null };
  try {
    const responseRequest = await net.fetch(`${provider.baseUrl}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({
        model: provider.model,
        input: "Reply exactly OK.",
        max_output_tokens: 16,
        store: false,
      }),
    });
    const responsePayload = await responseRequest.json().catch(() => null);
    directResponse = {
      status: responseRequest.status,
      created: responseRequest.ok && Boolean(responsePayload?.id),
      error: responseRequest.ok
        ? null
        : responseError(responsePayload),
      server: responseRequest.headers.get("server"),
    };
  } catch (error) {
    directResponse.error = error.cause?.code || error.message;
  }

  const server = new CodexServer(provider);
  const diagnostics = [];
  let agentText = "";
  let turnStatus = null;
  let startedThread = null;
  let runtimeKind = null;
  let codexChildProcess = false;
  const threadSettings = [];
  const reroutes = [];
  server.on("diagnostic", (message) => diagnostics.push(message));
  server.on("notification", (message) => {
    if (message.method === "thread/settings/updated") threadSettings.push(message.params);
    if (message.method === "model/rerouted") reroutes.push(message.params);
    const item = message.params?.item;
    if (["item/started", "item/completed"].includes(message.method) && item?.type === "agentMessage" && item.text) {
      agentText = item.text;
    }
  });
  try {
    await server.start();
    runtimeKind = server.runtimeKind;
    codexChildProcess = Boolean(server.process);
    const started = await server.startThread(process.cwd(), provider.model);
    startedThread = started.thread;
    const completion = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Niubi turn timed out.")), 90000);
      const onNotification = (message) => {
        if (message.method !== "turn/completed" || message.params?.threadId !== started.thread.id) return;
        clearTimeout(timer);
        server.off("notification", onNotification);
        resolve(message.params.turn);
      };
      server.on("notification", onNotification);
    });
    await server.startTurn(
      started.thread.id,
      "Reply with exactly NIUBI_OK and nothing else. Do not use tools.",
      process.cwd(),
      crypto.randomUUID(),
      { model: provider.model, effort: "low" },
    );
    const turn = await completion;
    turnStatus = turn.status;
  } finally {
    server.stop();
  }

  assert.equal(modelsResponse.ok, true, `Niubi model discovery failed: ${responseError(modelsPayload)}`);
  assert.equal(directResponse.created, true, `Niubi Responses API failed: ${directResponse.error}`);
  assert.equal(balance.supported, true, `Niubi balance lookup failed: ${balance.message}`);
  assert.equal(balance.unlimited, false, "A numeric Niubi account balance must not be shown as unlimited.");
  assert.equal(startedThread?.modelProvider, "niubi", "Isolated runtime used an unexpected model provider.");
  assert.equal(codexChildProcess, true, "Niubi must start the isolated ChatSwitch runtime.");
  assert.equal(runtimeKind, "chatswitch-bundled");
  assert.equal(turnStatus, "completed");
  assert.equal(agentText.trim(), "NIUBI_OK");

  console.log(JSON.stringify({
    ok: true,
    encryptedKeyStored: store.hasStoredProviderKey("niubi"),
    modelsStatus: modelsResponse.status,
    modelsError: modelsResponse.ok ? null : responseError(modelsPayload),
    modelsServer: modelsResponse.headers.get("server"),
    modelCount: modelIds.length,
    configuredModelAvailable: modelIds.includes(provider.model),
    responseStatus: directResponse.status,
    responseCreated: directResponse.created,
    responseError: directResponse.error,
    balance: balance.supported ? {
      supported: true,
      displayType: balance.displayType,
      available: balance.balance,
      used: balance.used,
      granted: balance.granted,
      unlimited: balance.unlimited,
      expiresAt: balance.expiresAt,
    } : { supported: false, status: balance.status, message: balance.message },
    isolatedRuntimeInitialized: true,
    codexChildProcess,
    runtimeKind,
    isolatedRuntimeThread: startedThread ? {
      model: startedThread.model,
      modelProvider: startedThread.modelProvider,
    } : null,
    confirmedSettings: threadSettings.at(-1)?.threadSettings || null,
    reroutes,
    turnStatus,
    agentResponseMatches: agentText.trim() === "NIUBI_OK",
    diagnostics,
  }));
}

run()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => app.quit());
