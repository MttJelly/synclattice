const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { CodexServer, BASE_PROVIDERS, CODEX_HOME } = require("../src/codex-server");

function userEnvironmentVariable(name) {
  return execFileSync(
    "powershell.exe",
    ["-NoProfile", "-Command", `[Environment]::GetEnvironmentVariable('${name}','User')`],
    { encoding: "utf8", windowsHide: true },
  ).trim();
}

function jsonlFiles(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(target);
    }
  };
  visit(root);
  return files.sort();
}

function snapshotOfficialRecords() {
  return {
    active: jsonlFiles(path.join(CODEX_HOME, "sessions")),
    archived: jsonlFiles(path.join(CODEX_HOME, "archived_sessions")),
  };
}

function sameFiles(left, right) {
  return left.length === right.length && left.every((file, index) => file === right[index]);
}

function waitForTurn(server, threadId, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.off("notification", onNotification);
      reject(new Error(`Ephemeral turn timed out after ${timeoutMs} ms.`));
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

function waitForNotification(server, predicate, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.off("notification", onNotification);
      reject(new Error(`Expected notification timed out after ${timeoutMs} ms.`));
    }, timeoutMs);
    const onNotification = (message) => {
      if (!predicate(message)) return;
      clearTimeout(timer);
      server.off("notification", onNotification);
      resolve(message);
    };
    server.on("notification", onNotification);
  });
}

async function main() {
  const key = process.env.HEXUAN_API_KEY || userEnvironmentVariable("HEXUAN_API_KEY");
  if (!key) throw new Error("HEXUAN_API_KEY is not configured.");

  const before = snapshotOfficialRecords();
  const server = new CodexServer(BASE_PROVIDERS.hexuan, { HEXUAN_API_KEY: key });
  const observed = {
    clientIds: [],
    agentText: "",
    diagnostics: [],
    userInputRequests: 0,
    threadSettings: [],
    reroutes: [],
  };
  let firstResponse = "";
  let confirmedSettings = null;

  server.on("diagnostic", (message) => observed.diagnostics.push(message));
  server.on("notification", (message) => {
    if (message.method === "thread/settings/updated") observed.threadSettings.push(message.params);
    if (message.method === "model/rerouted") observed.reroutes.push(message.params);
    if (["item/started", "item/completed"].includes(message.method)) {
      const item = message.params?.item;
      if (item?.type === "userMessage" && item.clientId) observed.clientIds.push(item.clientId);
      if (item?.type === "agentMessage" && item.text) observed.agentText = item.text;
    }
  });
  server.on("server-request", (request) => {
    if (request.method === "currentTime/read") {
      server.respond(request.id, { currentTimeAt: Math.floor(Date.now() / 1000) });
    } else if (request.method === "item/tool/requestUserInput") {
      observed.userInputRequests += 1;
      const answers = {};
      for (const question of request.params?.questions || []) {
        answers[question.id] = { answers: [question.options?.[0]?.label || "Smoke answer"] };
      }
      server.respond(request.id, { answers });
    } else {
      server.respondError(request.id, -32601, `Smoke test does not support ${request.method}.`);
    }
  });

  try {
    await server.start();
    const started = await server.request("thread/start", {
      cwd: process.cwd(),
      model: "gpt-5.6-sol",
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
      sandbox: "workspace-write",
      personality: "pragmatic",
      ephemeral: true,
      sessionStartSource: "startup",
    }, 90000);
    const threadId = started.thread.id;
    const clientUserMessageId = crypto.randomUUID();
    const completion = waitForTurn(server, threadId);
    await server.request("turn/start", {
      threadId,
      cwd: process.cwd(),
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
      personality: "pragmatic",
      model: "gpt-5.6-sol",
      effort: "low",
      clientUserMessageId,
      input: [{ type: "text", text: "Reply with exactly SMOKE_OK and nothing else. Do not use tools." }],
    }, 90000);
    const turn = await completion;
    if (turn.status !== "completed") throw new Error(`Unexpected turn status: ${turn.status}`);
    if (!observed.clientIds.includes(clientUserMessageId)) throw new Error("clientUserMessageId was not preserved.");
    if (observed.agentText.trim() !== "SMOKE_OK") throw new Error(`Unexpected agent response: ${observed.agentText}`);
    const applied = observed.threadSettings
      .filter((item) => item.threadId === threadId)
      .map((item) => item.threadSettings)
      .findLast((settings) => settings.model === "gpt-5.6-sol" && settings.effort === "low");
    if (!applied) throw new Error("App-server did not confirm the selected model and effort.");
    if (applied.approvalsReviewer !== "auto_review") {
      throw new Error(`Unexpected approvals reviewer: ${applied.approvalsReviewer}`);
    }
    const sandboxPolicy = applied.sandboxPolicy;
    const workspaceWrite = sandboxPolicy?.type === "workspaceWrite";
    const runtimeReadOnly = sandboxPolicy?.type === "readOnly"
      && sandboxPolicy.networkAccess === false;
    if (!workspaceWrite && !runtimeReadOnly) {
      throw new Error(`Unexpected sandbox policy: ${JSON.stringify(sandboxPolicy)}`);
    }
    confirmedSettings = applied;
    firstResponse = observed.agentText.trim();

    const interruptCompletion = waitForTurn(server, threadId);
    const commandStarted = waitForNotification(server, (message) => (
      message.method === "item/started"
      && message.params?.threadId === threadId
      && message.params?.item?.type === "commandExecution"
    ));
    const interruptStarted = await server.request("turn/start", {
      threadId,
      cwd: process.cwd(),
      approvalPolicy: "never",
      personality: "pragmatic",
      clientUserMessageId: crypto.randomUUID(),
      input: [{
        type: "text",
        text: "Run this exact terminal command and wait for it: powershell.exe -NoProfile -Command Start-Sleep -Seconds 30. Do not replace it with another command.",
      }],
    }, 90000);
    await commandStarted;
    await server.request("turn/interrupt", { threadId, turnId: interruptStarted.turn.id }, 30000);
    const interruptedTurn = await interruptCompletion;
    if (interruptedTurn.status !== "interrupted") {
      throw new Error(`Unexpected interrupted turn status: ${interruptedTurn.status}`);
    }

    const inputCompletion = waitForTurn(server, threadId);
    await server.request("turn/start", {
      threadId,
      cwd: process.cwd(),
      approvalPolicy: "never",
      personality: "pragmatic",
      collaborationMode: {
        mode: "plan",
        settings: { model: "gpt-5.6-sol", reasoning_effort: "high", developer_instructions: null },
      },
      clientUserMessageId: crypto.randomUUID(),
      input: [{
        type: "text",
        text: "You must call request_user_input once with one question and two options before answering. After receiving the answer, reply exactly INPUT_OK.",
      }],
    }, 90000);
    const inputTurn = await inputCompletion;
    if (inputTurn.status !== "completed") throw new Error(`Unexpected input turn status: ${inputTurn.status}`);
    if (observed.userInputRequests !== 1) throw new Error(`Expected one user input request, got ${observed.userInputRequests}.`);
    if (observed.agentText.trim() !== "INPUT_OK") throw new Error(`Unexpected input response: ${observed.agentText}`);
  } finally {
    server.stop();
  }

  const after = snapshotOfficialRecords();
  if (!sameFiles(before.active, after.active) || !sameFiles(before.archived, after.archived)) {
    throw new Error("Ephemeral smoke test changed the official conversation file set.");
  }
  console.log(JSON.stringify({
    ok: true,
    response: firstResponse,
    selectedModel: "gpt-5.6-sol",
    selectedEffort: "low",
    appliedModel: confirmedSettings?.model || null,
    appliedEffort: confirmedSettings?.effort || null,
    appliedApprovalsReviewer: confirmedSettings?.approvalsReviewer || null,
    sandboxPolicy: confirmedSettings?.sandboxPolicy || null,
    reroutes: observed.reroutes,
    interrupt: "interrupted",
    requestUserInput: observed.userInputRequests,
    activeRecords: after.active.length,
    archivedRecords: after.archived.length,
    diagnostics: observed.diagnostics.length,
    diagnosticMessages: observed.diagnostics,
  }));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
