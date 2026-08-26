const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");
const { OpenAICompatibleServer } = require("../src/openai-compatible-server");

const root = path.resolve(__dirname, "..");
const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chatswitch-logical-branch-store-"));
const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chatswitch-logical-branch-profile-"));
process.env.CHATSWITCH_STORE_ROOT = storeRoot;
process.env.CHATSWITCH_QA = "1";
app.setPath("userData", profileRoot);
process.on("exit", () => {
  try { fs.rmSync(storeRoot, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(profileRoot, { recursive: true, force: true }); } catch {}
});

const requests = [];
const originalCompatibleReadThread = OpenAICompatibleServer.prototype.readThread;
let compatibleReadCalls = 0;
OpenAICompatibleServer.prototype.readThread = function countedReadThread(...args) {
  compatibleReadCalls += 1;
  return originalCompatibleReadThread.apply(this, args);
};
const mockServer = http.createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const vendor = request.url.startsWith("/a/") ? "A" : "B";
    if (request.method === "GET" && request.url.endsWith("/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: `mock-${vendor.toLowerCase()}` }] }));
      return;
    }
    if (request.method === "POST" && request.url.endsWith("/chat/completions")) {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push({ vendor, body });
      const count = requests.filter((entry) => entry.vendor === vendor).length;
      if (JSON.stringify(body.messages.at(-1)?.content || "").includes("interrupt me")) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n\n`);
        const timer = setTimeout(() => response.end("data: [DONE]\n\n"), 10000);
        response.on("close", () => clearTimeout(timer));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: `mock-${vendor.toLowerCase()}-${count}` } }] }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "not found" } }));
  });
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(action, predicate, timeoutMs = 15000) {
  const startedAt = Date.now();
  let lastValue;
  while (Date.now() - startedAt < timeoutMs) {
    lastValue = await action();
    if (predicate(lastValue)) return lastValue;
    await delay(80);
  }
  throw new Error(`Timed out waiting for logical branch state: ${JSON.stringify(lastValue)}`);
}

function invoke(window, method, argument) {
  return window.webContents.executeJavaScript(
    `window.chatSwitch[${JSON.stringify(method)}](${JSON.stringify(argument)})`,
  );
}

function userTexts(thread) {
  return (thread.turns || []).flatMap((turn) => (turn.items || [])
    .filter((item) => item.type === "userMessage")
    .map((item) => (item.content || []).filter((part) => part.type === "text").map((part) => part.text).join("\n")));
}

async function run() {
  await new Promise((resolve, reject) => {
    mockServer.once("error", reject);
    mockServer.listen(0, "127.0.0.1", resolve);
  });
  await app.whenReady();
  const { ProviderStore } = require("../src/provider-store");
  const store = new ProviderStore();
  const port = mockServer.address().port;
  const providerA = store.addRelay({
    label: "Mock A",
    baseUrl: `http://127.0.0.1:${port}/a/v1`,
    model: "mock-a",
    apiKey: "qa-key-a",
    preset: "custom",
    protocol: "chat_completions",
  });
  const providerB = store.addRelay({
    label: "Mock B",
    baseUrl: `http://127.0.0.1:${port}/b/v1`,
    model: "mock-b",
    apiKey: "qa-key-b",
    preset: "custom",
    protocol: "chat_completions",
  });
  const logicalId = "019f1111-2222-7333-8444-555566667777";
  const source = path.join(
    store.conversationHome(),
    "sessions", "2026", "08", "02",
    `rollout-${logicalId}.jsonl`,
  );
  fs.mkdirSync(path.dirname(source), { recursive: true });
  const original = [
    JSON.stringify({
      timestamp: "2026-08-02T01:00:00.000Z",
      type: "session_meta",
      payload: { id: logicalId, timestamp: "2026-08-02T01:00:00.000Z", cwd: root, model_provider: "openai" },
    }),
    JSON.stringify({
      timestamp: "2026-08-02T01:00:01.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "original question" },
    }),
    JSON.stringify({
      timestamp: "2026-08-02T01:00:02.000Z",
      type: "event_msg",
      payload: { type: "agent_message", message: "original answer", phase: "final_answer" },
    }),
    "",
  ].join("\n");
  fs.writeFileSync(source, original, "utf8");

  require("../src/main");
  const window = await waitUntil(
    async () => BrowserWindow.getAllWindows().find((item) => !item.isDestroyed()) || null,
    Boolean,
  );
  await waitUntil(
    () => window.webContents.executeJavaScript("Boolean(window.chatSwitch && window.chatSwitchVue)"),
    Boolean,
  );
  await window.webContents.executeJavaScript(`(() => {
    window.__logicalBranchEvents = [];
    window.chatSwitch.onEvent((message) => window.__logicalBranchEvents.push(message));
  })()`);

  await invoke(window, "connect", providerA.id);
  const beforeSend = await invoke(window, "resumeThread", { threadId: logicalId, cwd: root });
  assert.equal(beforeSend.thread._crossModelReadOnly, false);
  assert.deepEqual(store.threadBranches()[logicalId], undefined, "Opening a shared thread created a branch before send.");
  await invoke(window, "startTurn", {
    threadId: logicalId,
    text: "question from A",
    displayText: "question from A",
    cwd: root,
    clientUserMessageId: "client-a-1",
    model: "mock-a",
  });
  const afterA = await waitUntil(
    () => invoke(window, "readThread", logicalId),
    (result) => result.thread.turns.length === 2 && result.thread.turns.at(-1).status === "completed",
  );
  const branchA = store.threadBranch(logicalId, providerA.id);
  assert.ok(branchA?.threadId && branchA.threadId !== logicalId);
  assert.equal((await invoke(window, "listThreads", { search: "", archived: false })).data.some((thread) => thread.id === branchA.threadId), false);

  await invoke(window, "connect", providerB.id);
  const seenByB = await invoke(window, "resumeThread", { threadId: logicalId, cwd: root });
  assert.deepEqual(userTexts(seenByB.thread), ["original question", "question from A"]);
  await invoke(window, "startTurn", {
    threadId: logicalId,
    text: "question from B",
    displayText: "question from B",
    cwd: root,
    clientUserMessageId: "client-b-1",
    model: "mock-b",
  });
  await waitUntil(
    () => invoke(window, "readThread", logicalId),
    (result) => result.thread.turns.length === 3 && result.thread.turns.at(-1).status === "completed",
  );

  await invoke(window, "connect", providerA.id);
  await invoke(window, "resumeThread", { threadId: logicalId, cwd: root });
  await invoke(window, "startTurn", {
    threadId: logicalId,
    text: "back to A",
    displayText: "back to A",
    cwd: root,
    clientUserMessageId: "client-a-2",
    model: "mock-a",
  });
  const finalThread = await waitUntil(
    () => invoke(window, "readThread", logicalId),
    (result) => result.thread.turns.length === 4 && result.thread.turns.at(-1).status === "completed",
  );
  assert.deepEqual(userTexts(finalThread.thread), [
    "original question",
    "question from A",
    "question from B",
    "back to A",
  ]);
  const interrupted = await invoke(window, "startTurn", {
    threadId: logicalId,
    text: "interrupt me",
    displayText: "interrupt me",
    cwd: root,
    clientUserMessageId: "client-a-stop",
    model: "mock-a",
  });
  await waitUntil(async () => requests.length, (count) => count === 4);
  await invoke(window, "interruptTurn", { threadId: logicalId, turnId: interrupted.turn.id });
  await waitUntil(
    () => window.webContents.executeJavaScript(`window.__logicalBranchEvents.find((event) =>
      event.method === 'turn/completed'
      && event.params?.threadId === ${JSON.stringify(logicalId)}
      && event.params?.turn?.id === ${JSON.stringify(interrupted.turn.id)}
      && event.params?.turn?.status === 'interrupted') || null`),
    Boolean,
  );
  const afterInterrupt = await invoke(window, "readThread", logicalId);
  assert.equal(afterInterrupt.thread.turns.at(-1).status, "interrupted");
  assert.equal(userTexts(afterInterrupt.thread).at(-1), "interrupt me");
  assert.doesNotMatch(JSON.stringify(finalThread.thread), /<shared_conversation>/);
  assert.match(JSON.stringify(requests.find((entry) => entry.vendor === "A")?.body), /original question/);
  assert.match(JSON.stringify(requests.find((entry) => entry.vendor === "B")?.body), /mock-a-1/);
  assert.match(JSON.stringify(requests.filter((entry) => entry.vendor === "A").at(-1)?.body), /mock-b-1/);
  assert.equal(fs.readFileSync(source, "utf8"), original, "Logical branch QA modified the source Codex JSONL.");
  assert.equal(store.threadTimeline(logicalId).length, 4);
  const usage = store.providerUsage();
  assert.equal(usage.requestCount, 4);
  assert.equal(usage.completedCount, 3);
  assert.equal(usage.interruptedCount, 1);
  assert.equal(store.providerUsage(providerB.id).requestCount, 1);
  const eventThreadIds = await window.webContents.executeJavaScript(`window.__logicalBranchEvents
    .flatMap((event) => [event.params?.threadId, event.params?.conversationId, event.params?.thread?.id])
    .filter(Boolean)`);
  const branchIds = Object.values(store.threadBranches()[logicalId]).map((branch) => branch.threadId);
  assert.ok(eventThreadIds.includes(logicalId));
  assert.equal(eventThreadIds.some((threadId) => branchIds.includes(threadId)), false, "A native branch ID leaked to the renderer.");

  const native = await invoke(window, "startThread", { cwd: root, model: "mock-a" });
  const readsBeforeNativeTurn = compatibleReadCalls;
  const nativeTurn = await invoke(window, "startTurn", {
    threadId: native.thread.id,
    text: "native fast path",
    displayText: "native fast path",
    cwd: root,
    clientUserMessageId: "client-native-fast-path",
    model: "mock-a",
  });
  await waitUntil(
    () => window.webContents.executeJavaScript(`window.__logicalBranchEvents.find((event) =>
      event.method === 'turn/completed'
      && event.params?.threadId === ${JSON.stringify(native.thread.id)}
      && event.params?.turn?.id === ${JSON.stringify(nativeTurn.turn.id)}) || null`),
    Boolean,
  );
  assert.equal(compatibleReadCalls, readsBeforeNativeTurn, "Native turn re-read the full thread before sending.");

  console.log(JSON.stringify({
    ok: true,
    logicalThreadId: logicalId,
    providers: [providerA.id, providerB.id],
    branchIds,
    turnOrder: finalThread.thread.turns.map((turn) => turn.id),
    requestVendors: requests.map((entry) => entry.vendor),
    usageRequests: usage.requestCount,
    sourcePreserved: true,
  }));
  mockServer.closeAllConnections?.();
  mockServer.close();
  OpenAICompatibleServer.prototype.readThread = originalCompatibleReadThread;
  app.exit(0);
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
  mockServer.closeAllConnections?.();
  mockServer.close();
  app.exit(1);
}).finally(() => mockServer.close());
