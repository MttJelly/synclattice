const fs = require("node:fs");
const path = require("node:path");

const THREAD_ID_PATTERN = /^[a-zA-Z0-9_-]{8,160}$/;
const INTERRUPTED_TOOL_OUTPUT = "Tool execution was interrupted before ChatSwitch recorded a result. Treat this call as cancelled and do not infer that it succeeded.";

function sessionFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(target);
    }
  }
  return files;
}

function rolloutFilesForThread(codexHome, threadId) {
  const normalizedThreadId = String(threadId || "").trim();
  if (!codexHome || !THREAD_ID_PATTERN.test(normalizedThreadId)) return [];
  return ["sessions", "archived_sessions"]
    .flatMap((name) => sessionFiles(path.join(codexHome, name)))
    .filter((file) => path.basename(file, ".jsonl").endsWith(`-${normalizedThreadId}`));
}

function parseRecords(content) {
  return String(content || "").split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return [];
    try {
      return [{ index, value: JSON.parse(line) }];
    } catch {
      return [];
    }
  });
}

function isLaterTurnBoundary(record) {
  const payload = record?.payload;
  return record?.type === "turn_context"
    || (record?.type === "event_msg" && payload?.type === "task_started")
    || (record?.type === "response_item" && payload?.type === "message" && payload?.role === "user");
}

function interruptedToolCalls(content) {
  const records = parseRecords(content);
  const calls = new Map();
  const outputs = new Set();
  for (const record of records) {
    const payload = record.value?.payload;
    if (record.value?.type !== "response_item") continue;
    if (payload?.type === "custom_tool_call" && payload.call_id) {
      calls.set(payload.call_id, {
        callId: payload.call_id,
        name: payload.name || "custom tool",
        index: record.index,
        metadata: payload.internal_chat_message_metadata_passthrough || null,
      });
    } else if (payload?.type === "custom_tool_call_output" && payload.call_id) {
      outputs.add(payload.call_id);
    }
  }
  return [...calls.values()].filter((call) => !outputs.has(call.callId)
    && records.some((record) => record.index > call.index && isLaterTurnBoundary(record.value)));
}

function repairInterruptedToolCallsInFile(file, now = () => new Date()) {
  const before = fs.readFileSync(file, "utf8");
  const interrupted = interruptedToolCalls(before);
  if (!interrupted.length) return [];
  const timestamp = now().toISOString();
  const repairLines = interrupted.map((call) => JSON.stringify({
    timestamp,
    type: "response_item",
    payload: {
      type: "custom_tool_call_output",
      call_id: call.callId,
      output: [{ type: "input_text", text: INTERRUPTED_TOOL_OUTPUT }],
      ...(call.metadata ? { internal_chat_message_metadata_passthrough: call.metadata } : {}),
    },
  }));
  const prefix = before.endsWith("\n") || before.length === 0 ? "" : "\n";
  fs.appendFileSync(file, `${prefix}${repairLines.join("\n")}\n`, "utf8");
  return interrupted.map(({ callId, name }) => ({ callId, name }));
}

function repairInterruptedToolCallsForThread(codexHome, threadId, now) {
  return rolloutFilesForThread(codexHome, threadId).flatMap((file) => (
    repairInterruptedToolCallsInFile(file, now).map((repair) => ({ ...repair, file }))
  ));
}

module.exports = {
  INTERRUPTED_TOOL_OUTPUT,
  interruptedToolCalls,
  repairInterruptedToolCallsInFile,
  repairInterruptedToolCallsForThread,
  rolloutFilesForThread,
};
