const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { BASE_PROVIDERS, CodexServer } = require("../src/codex-server");

function waitForTurn(server, threadId, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.off("notification", onNotification);
      reject(new Error(`Compatible turn timed out after ${timeoutMs} ms.`));
    }, timeoutMs);
    const onNotification = (message) => {
      if (message.method !== "turn/completed" || message.params?.threadId !== threadId) return;
      clearTimeout(timer);
      server.off("notification", onNotification);
      resolve(message.params.turn);
    };
    server.on("notification", onNotification);
  });
}

async function main() {
  const key = String(process.env.HEXUAN_API_KEY || "").trim();
  if (!key) throw new Error("HEXUAN_API_KEY is not configured.");
  const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chatswitch-hexuan-smoke-"));
  const provider = {
    ...BASE_PROVIDERS.hexuan,
    env: { HEXUAN_API_KEY: key },
    codexHome: storeRoot,
    discoveredModels: [BASE_PROVIDERS.hexuan.model],
  };
  const server = new CodexServer(provider);
  const observed = { agentText: "", commandExecutions: 0, serverRequests: 0 };
  server.on("notification", (message) => {
    const item = message.params?.item;
    if (["item/started", "item/completed"].includes(message.method) && item?.type === "agentMessage" && item.text) {
      observed.agentText = item.text;
    }
    if (item?.type === "commandExecution") observed.commandExecutions += 1;
  });
  server.on("server-request", () => { observed.serverRequests += 1; });

  try {
    await server.start();
    const started = await server.startThread(process.cwd(), provider.model);
    const completion = waitForTurn(server, started.thread.id);
    await server.startTurn(
      started.thread.id,
      "Reply with exactly SMOKE_OK and nothing else.",
      process.cwd(),
      crypto.randomUUID(),
      { model: provider.model, effort: "low" },
    );
    const turn = await completion;
    if (turn.status !== "completed") throw new Error(`Unexpected turn status: ${turn.status}`);
    if (observed.agentText.trim() !== "SMOKE_OK") throw new Error(`Unexpected agent response: ${observed.agentText}`);
    if (!server.process || server.runtimeKind !== "chatswitch-bundled") {
      throw new Error(`Hexuan did not use the isolated ChatSwitch runtime: ${server.runtimeKind}`);
    }
    console.log(JSON.stringify({
      ok: true,
      provider: provider.id,
      transport: "responses",
      response: observed.agentText.trim(),
      selectedModel: provider.model,
      selectedEffort: "low",
      codexChildProcess: true,
      runtimeKind: server.runtimeKind,
      commandExecutions: observed.commandExecutions,
      serverRequests: observed.serverRequests,
    }));
  } finally {
    server.stop();
    fs.rmSync(storeRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
