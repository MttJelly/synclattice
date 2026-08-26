const { EventEmitter } = require("node:events");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const IMAGE_MIME_TYPES = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, file);
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return fallback;
    throw error;
  }
}

function chatCompletionsEndpoint(baseUrl) {
  const parsed = new URL(String(baseUrl || "").trim());
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("模型供应商 Base URL 无效。");
  const normalized = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = normalized.endsWith("/chat/completions")
    ? normalized
    : `${normalized}/chat/completions`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function responsesEndpoint(baseUrl) {
  const parsed = new URL(String(baseUrl || "").trim());
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("模型供应商 Base URL 无效。");
  const normalized = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = normalized.endsWith("/responses") ? normalized : `${normalized}/responses`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function textFromUserItem(item) {
  return (item?.content || [])
    .filter((part) => part?.type === "text")
    .map((part) => part.text || "")
    .join("\n");
}

function imageDataUrl(file) {
  const resolved = path.resolve(String(file || ""));
  const mimeType = IMAGE_MIME_TYPES[path.extname(resolved).toLowerCase()];
  if (!mimeType) throw new Error(`不支持的图片格式：${path.basename(resolved)}`);
  const stats = fs.statSync(resolved);
  if (!stats.isFile()) throw new Error(`图片路径不是文件：${resolved}`);
  if (stats.size > 20 * 1024 * 1024) throw new Error(`图片超过 20 MB：${path.basename(resolved)}`);
  return `data:${mimeType};base64,${fs.readFileSync(resolved).toString("base64")}`;
}

function assistantMessageText(item) {
  return String(item?.text || "");
}

function appendReasoningSummaryDelta(item, delta) {
  const text = String(delta || "");
  if (!text) return;
  const current = item.summary.at(-1);
  if (current?.type === "summary_text") current.text = `${current.text || ""}${text}`;
  else item.summary.push({ type: "summary_text", text });
}

function reasoningSummaryLength(item) {
  return (item?.summary || []).reduce((total, part) => total + String(part?.text || part || "").length, 0);
}

function trimMessages(messages, maxCharacters = 100000) {
  const selected = [];
  let characters = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const length = typeof message.content === "string" ? message.content.length : 0;
    if (selected.length && characters + length > maxCharacters) break;
    selected.unshift(message);
    characters += length;
  }
  while (selected.length > 1 && selected[0].role === "assistant") selected.shift();
  return selected;
}

function messagesForThread(thread, imageInputs = []) {
  const messages = [];
  for (const turn of thread.turns || []) {
    for (const item of turn.items || []) {
      if (item.type === "userMessage") {
        const content = textFromUserItem(item);
        if (content) messages.push({ role: "user", content });
      } else if (item.type === "agentMessage" && assistantMessageText(item)) {
        messages.push({ role: "assistant", content: assistantMessageText(item) });
      }
    }
  }
  const trimmed = trimMessages(messages);
  if (imageInputs.length && trimmed.length) {
    const latest = trimmed.at(-1);
    if (latest.role === "user") {
      const text = latest.content;
      latest.content = [
        ...(text ? [{ type: "text", text }] : []),
        ...imageInputs.map((image) => ({
          type: "image_url",
          image_url: { url: imageDataUrl(image.path), detail: image.detail || "auto" },
        })),
      ];
    }
  }
  return trimmed;
}

function responsesInput(messages) {
  return messages.map((message) => ({
    role: message.role,
    content: Array.isArray(message.content)
      ? message.content.map((part) => {
        if (part?.type === "text") return { type: "input_text", text: part.text || "" };
        if (part?.type === "image_url") return { type: "input_image", image_url: part.image_url?.url || "" };
        return part;
      })
      : message.content,
  }));
}

function responseAnnotations(payload) {
  const annotations = [];
  for (const output of payload?.output || []) {
    for (const content of output?.content || []) {
      for (const annotation of content?.annotations || []) {
        const url = String(annotation?.url || annotation?.url_citation?.url || "").trim();
        if (!url) continue;
        annotations.push({ url, title: String(annotation?.title || annotation?.url_citation?.title || url).trim() });
      }
    }
  }
  return annotations;
}

function responseOutput(payload) {
  const result = { text: "", reasoning: "", query: "", annotations: responseAnnotations(payload) };
  for (const output of payload?.output || []) {
    if (output?.type === "message") {
      for (const content of output.content || []) {
        if (["output_text", "text"].includes(content?.type) && content.text) result.text += content.text;
      }
    } else if (output?.type === "reasoning") {
      for (const summary of output.summary || []) result.reasoning += summary?.text || "";
    } else if (output?.type === "web_search_call") {
      result.query ||= String(output.action?.query || output.query || "");
    }
  }
  result.text ||= String(payload?.output_text || "");
  return result;
}

function appendCitations(text, annotations) {
  const unique = [];
  const seen = new Set();
  for (const annotation of annotations || []) {
    if (!annotation?.url || seen.has(annotation.url)) continue;
    seen.add(annotation.url);
    unique.push(annotation);
  }
  if (!unique.length) return "";
  return `${text ? "\n\n" : ""}### 来源\n${unique.map((item, index) => `${index + 1}. [${item.title || item.url}](${item.url})`).join("\n")}`;
}

function jsonlFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) files.push(target);
    }
  };
  visit(directory);
  return files;
}

function parseJsonl(text) {
  const rows = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {}
  }
  return rows;
}

function eventMessage(row) {
  if (row?.type !== "event_msg") return null;
  const type = row.payload?.type;
  if (!['user_message', 'agent_message'].includes(type)) return null;
  const text = String(row.payload?.message || "").trim();
  if (!text) return null;
  return { role: type === "user_message" ? "user" : "assistant", text, phase: row.payload?.phase || null };
}

function responseMessage(row) {
  if (row?.type !== "response_item" || row.payload?.type !== "message") return null;
  if (!['user', 'assistant'].includes(row.payload?.role)) return null;
  const text = (Array.isArray(row.payload?.content) ? row.payload.content : [])
    .filter((part) => ["input_text", "output_text", "text"].includes(part?.type))
    .map((part) => String(part.text || ""))
    .join("\n")
    .trim();
  return text ? { role: row.payload.role, text, phase: null } : null;
}

function codexMetadata(rows) {
  return rows.find((row) => row?.type === "session_meta")?.payload || null;
}

function codexMessages(rows) {
  const events = rows.map(eventMessage).filter(Boolean);
  return events.length ? events : rows.map(responseMessage).filter(Boolean);
}

function codexThreadSummary(file, stat = fs.statSync(file), prefixBytes = 2 * 1024 * 1024) {
  const handle = fs.openSync(file, "r");
  let text = "";
  try {
    const buffer = Buffer.alloc(Math.min(stat.size, prefixBytes));
    const bytes = fs.readSync(handle, buffer, 0, buffer.length, 0);
    text = buffer.subarray(0, bytes).toString("utf8");
    if (bytes < stat.size) text = text.slice(0, Math.max(0, text.lastIndexOf("\n")));
  } finally {
    fs.closeSync(handle);
  }
  const rows = parseJsonl(text);
  const metadata = codexMetadata(rows);
  const id = String(metadata?.id || metadata?.session_id || "").trim();
  if (!id) return null;
  const firstUser = codexMessages(rows).find((message) => message.role === "user")?.text || "Codex 会话";
  const createdAt = Math.floor((Date.parse(metadata?.timestamp) || stat.birthtimeMs || stat.mtimeMs) / 1000);
  const updatedAt = Math.floor(stat.mtimeMs / 1000);
  return {
    id,
    name: null,
    preview: firstUser.split(/\r?\n/)[0].slice(0, 160),
    modelProvider: metadata?.model_provider || "codex",
    model: null,
    cwd: metadata?.cwd || null,
    createdAt,
    updatedAt,
    recencyAt: updatedAt,
    turns: [],
    _syncedFromCodex: true,
    _historyEngine: "codex",
  };
}

function parseCodexThreadFile(file) {
  const stat = fs.statSync(file);
  const rows = parseJsonl(fs.readFileSync(file, "utf8"));
  const summary = codexThreadSummary(file, stat);
  if (!summary) throw new Error("Codex 会话缺少有效的会话 ID。");
  const turns = [];
  let turn = null;
  let itemIndex = 0;
  for (const message of codexMessages(rows)) {
    if (message.role === "user") {
      turn = {
        id: `${summary.id}-imported-${turns.length + 1}`,
        status: "completed",
        items: [{
          id: `${summary.id}-item-${++itemIndex}`,
          type: "userMessage",
          content: [{ type: "text", text: message.text }],
        }],
      };
      turns.push(turn);
    } else if (turn) {
      turn.items.push({
        id: `${summary.id}-item-${++itemIndex}`,
        type: "agentMessage",
        text: message.text,
        phase: message.phase || "final_answer",
        sourceLabel: "Codex 历史",
      });
    }
  }
  return { ...summary, turns };
}

function importedLocalThread(conversation, now = Date.now()) {
  const sourceId = String(conversation?.id || "").trim();
  if (!sourceId) throw new Error("本地会话标识无效。");
  const fingerprint = crypto.createHash("sha256").update(sourceId).digest("hex").slice(0, 40);
  const id = `local-${fingerprint}`;
  const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
  const turns = [];
  let turn = null;
  let itemIndex = 0;
  const nextItemId = () => `${id}-item-${++itemIndex}`;
  for (const message of messages) {
    const text = String(message?.text || "").trim();
    if (!text) continue;
    if (message.role === "user") {
      turn = {
        id: `${id}-turn-${turns.length + 1}`,
        status: "completed",
        items: [{
          id: nextItemId(),
          type: "userMessage",
          content: [{ type: "text", text }],
        }],
      };
      turns.push(turn);
      continue;
    }
    if (!turn) {
      turn = { id: `${id}-turn-${turns.length + 1}`, status: "completed", items: [] };
      turns.push(turn);
    }
    if (message.role === "reasoning") {
      turn.items.push({
        id: nextItemId(),
        type: "reasoning",
        content: [],
        summary: [{ type: "summary_text", text }],
        sourceLabel: conversation.sourceLabel || "本地记录",
      });
    } else if (message.role === "assistant") {
      turn.items.push({
        id: nextItemId(),
        type: "agentMessage",
        text,
        phase: "final_answer",
        sourceLabel: conversation.sourceLabel || "本地记录",
      });
    }
  }
  if (!turns.length) throw new Error("该本地会话没有可复制的消息。");
  const importedAt = Math.floor(Number(now) / 1000);
  const sourceUpdatedAt = Math.floor((Number(conversation.updatedAt) || Number(now)) / 1000);
  const firstUserText = messages.find((message) => message?.role === "user" && String(message.text || "").trim())?.text || "";
  return {
    id,
    name: String(conversation.title || "未命名会话").trim().slice(0, 160),
    preview: String(firstUserText || conversation.title || "本地会话副本").split(/\r?\n/)[0].slice(0, 160),
    modelProvider: "chatswitch-import",
    model: String(conversation.model || "").trim() || null,
    cwd: String(conversation.cwd || "").trim() || null,
    createdAt: Math.floor((Number(conversation.createdAt) || Number(conversation.updatedAt) || Number(now)) / 1000),
    updatedAt: importedAt,
    recencyAt: importedAt,
    turns,
    _importedLocalHistory: {
      sourceConversationId: sourceId,
      sourceId: String(conversation.sourceId || "").trim() || null,
      sourceLabel: String(conversation.sourceLabel || "本地记录").trim(),
      sourceSessionId: String(conversation.sessionId || "").trim() || null,
      sourceUpdatedAt,
      importedAt,
      truncated: Boolean(conversation.truncated),
    },
  };
}

function parseSseBlock(block) {
  const data = block.split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data || data === "[DONE]") return data || null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

async function consumeSse(response, visitor) {
  if (!response.body) throw new Error("模型供应商没有返回流式响应体。");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let receivedDone = false;
  let eventCount = 0;
  let malformedBlocks = 0;
  const visitBlock = (block) => {
    const event = parseSseBlock(block);
    if (event === "[DONE]") {
      receivedDone = true;
      return true;
    }
    if (event) {
      eventCount += 1;
      visitor(event);
    } else if (block.split(/\r?\n/).some((line) => line.startsWith("data:") && line.slice(5).trim())) {
      malformedBlocks += 1;
    }
    return false;
  };
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || "";
    for (const block of blocks) {
      if (visitBlock(block)) return { receivedDone, eventCount, malformedBlocks };
    }
    if (done) break;
  }
  if (buffer.trim()) {
    visitBlock(buffer);
  }
  return { receivedDone, eventCount, malformedBlocks };
}

function responseError(status, statusText, text) {
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = {};
  }
  const detail = payload?.error?.message || payload?.message || text || statusText;
  const error = new Error(`模型接口返回 ${status}：${detail}`);
  error.status = status;
  const providerCode = String(payload?.error?.code || payload?.code || "").trim().toLowerCase();
  const normalizedDetail = String(detail).toLowerCase();
  if (providerCode === "model_not_found"
    || normalizedDetail.includes("no available channel")
    || normalizedDetail.includes("无可用渠道")) {
    error.code = "MODEL_UNAVAILABLE";
    error.modelUnavailable = true;
  }
  return error;
}

function emptyResponseError() {
  const error = new Error("模型接口返回了空响应。");
  error.code = "EMPTY_RESPONSE";
  return error;
}

function providerRequestId(response) {
  for (const name of ["x-request-id", "request-id", "x-amzn-requestid", "cf-ray"]) {
    const value = String(response?.headers?.get(name) || "").trim();
    if (value) return value.slice(0, 240);
  }
  return null;
}

function completionError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.requestId = details.requestId || null;
  error.finishReason = details.finishReason || null;
  return error;
}

function assertCompletionReason(finishReason, requestId) {
  const reason = String(finishReason || "").trim().toLowerCase();
  if (!reason || ["stop", "tool_calls", "function_call"].includes(reason)) return;
  if (reason === "length" || reason === "max_tokens") {
    throw completionError(
      "OUTPUT_TRUNCATED",
      "模型达到输出长度上限，回答没有完整结束。已保留当前内容，可点击“继续生成”。",
      { requestId, finishReason: reason },
    );
  }
  if (reason === "content_filter") {
    throw completionError(
      "CONTENT_FILTERED",
      "模型供应商因内容过滤提前结束了回答。已保留允许显示的部分内容。",
      { requestId, finishReason: reason },
    );
  }
  throw completionError(
    "INCOMPLETE_STREAM",
    `模型以未识别的结束原因“${reason}”停止，回答可能不完整。`,
    { requestId, finishReason: reason },
  );
}

class OpenAICompatibleServer extends EventEmitter {
  constructor(provider, fetchImpl = globalThis.fetch) {
    super();
    if (!provider?.id || !provider?.baseUrl || !provider?.apiKey) {
      throw new Error("Invalid OpenAI-compatible provider definition.");
    }
    this.provider = provider;
    this.fetchImpl = fetchImpl;
    this.ready = false;
    this.activeTurns = new Map();
    this.root = path.join(provider.codexHome, "openai-compatible-conversations");
    this.codexSummaryCache = new Map();
    this.codexFileIndex = new Map();
    this.fallbackProviders = Array.isArray(provider.fallbackProviders) ? provider.fallbackProviders : [];
    this.failover = provider.failover || null;
    this.providerHealth = new Map();
  }

  async start() {
    fs.mkdirSync(this.root, { recursive: true });
    this.ready = true;
  }

  threadFile(threadId) {
    const id = String(threadId || "").trim();
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(id)) throw new Error("无效的会话 ID。");
    return path.join(this.root, `${id}.json`);
  }

  loadThread(threadId) {
    const local = readJson(this.threadFile(threadId));
    if (local?.id && Array.isArray(local.turns)) return local;
    const source = this.findCodexThreadFile(threadId);
    if (!source) throw new Error("未找到共享会话记录。");
    return parseCodexThreadFile(source);
  }

  saveThread(thread) {
    writeJsonAtomic(this.threadFile(thread.id), thread);
  }

  importLocalConversation(conversation) {
    const imported = importedLocalThread(conversation);
    const existing = readJson(this.threadFile(imported.id));
    if (existing?.id && Array.isArray(existing.turns)) {
      return { imported: false, duplicate: true, thread: existing };
    }
    this.saveThread(imported);
    return { imported: true, duplicate: false, thread: imported };
  }

  createBranchThread(sourceThread, messageId, options = {}) {
    const source = sourceThread && typeof sourceThread === "object" ? sourceThread : null;
    let selectedId = String(messageId || "").trim();
    if (!source?.id || !selectedId) throw new Error("分支会话参数无效。");
    const sourceItems = (source.turns || []).flatMap((turn) => turn.items || []);
    if (!sourceItems.some((item) => String(item?.id || "") === selectedId)) {
      const expectedRole = String(options.role || "").trim();
      const expectedText = String(options.text || "");
      const matches = expectedText ? sourceItems.filter((item) => {
        const role = item?.type === "userMessage" ? "user" : item?.type === "agentMessage" ? "agent" : "";
        const text = role === "user"
          ? (item.content || []).filter((part) => part?.type === "text").map((part) => String(part.text || "")).join("\n")
          : role === "agent" ? String(item.text || "") : "";
        return text === expectedText && (!expectedRole || expectedRole === role);
      }) : [];
      if (matches.length === 1 && matches[0]?.id) selectedId = String(matches[0].id);
    }
    const turns = [];
    let selected = false;
    for (const originalTurn of Array.isArray(source.turns) ? source.turns : []) {
      const items = [];
      for (const item of Array.isArray(originalTurn.items) ? originalTurn.items : []) {
        items.push(structuredClone(item));
        if (String(item?.id || "") === selectedId) {
          selected = true;
          break;
        }
      }
      if (items.length) turns.push({ ...structuredClone(originalTurn), items, status: "completed" });
      if (selected) break;
    }
    if (!selected || !turns.length) throw new Error("未找到可以创建分支的消息。");
    const id = `branch-${crypto.randomUUID().replaceAll("-", "")}`;
    const now = Math.floor(Date.now() / 1000);
    const firstUserText = turns.flatMap((turn) => turn.items || [])
      .find((item) => item?.type === "userMessage")?.content?.find((part) => part?.type === "text")?.text || "";
    const sourceTitle = String(source.name || source.preview || "新会话").trim() || "新会话";
    const branch = {
      ...structuredClone(source),
      id,
      name: `${sourceTitle} · 分支`,
      preview: String(firstUserText || source.preview || sourceTitle).split(/\r?\n/)[0].slice(0, 160),
      modelProvider: "chatswitch-branch",
      createdAt: Number(source.createdAt) || now,
      updatedAt: now,
      recencyAt: now,
      turns,
      _historyEngine: "openai-compatible",
      _crossModelReadOnly: false,
      _branch: {
        parentThreadId: source.id,
        parentMessageId: selectedId,
        parentTitle: sourceTitle,
        createdAt: now,
        sourceModelProvider: source.modelProvider || null,
      },
    };
    this.saveThread(branch);
    return { imported: true, duplicate: false, thread: this.summary(branch) };
  }

  summary(thread) {
    return {
      id: thread.id,
      name: thread.name || null,
      preview: thread.preview || "新会话",
      modelProvider: thread.modelProvider || this.provider.id,
      model: thread.model || this.provider.model,
      cwd: thread.cwd || null,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      recencyAt: thread.updatedAt,
      turns: [],
      _syncedFromCodex: Boolean(thread._syncedFromCodex),
      _importedLocalHistory: thread._importedLocalHistory || null,
      _branch: thread._branch || null,
      _historyEngine: "openai-compatible",
    };
  }

  async listLocalThreads(searchTerm = "") {
    const query = String(searchTerm || "").trim().toLocaleLowerCase("zh-CN");
    const entries = fs.existsSync(this.root)
      ? fs.readdirSync(this.root, { withFileTypes: true })
      : [];
    const data = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => readJson(path.join(this.root, entry.name)))
      .filter((thread) => thread?.id && Array.isArray(thread.turns))
      .map((thread) => this.summary(thread))
      .filter((thread) => !query || `${thread.name || ""} ${thread.preview || ""}`
        .toLocaleLowerCase("zh-CN").includes(query))
      .sort((left, right) => right.recencyAt - left.recencyAt);
    return { data, nextCursor: null, backwardsCursor: null };
  }

  codexThreadFiles(archived = false) {
    const area = archived ? "archived_sessions" : "sessions";
    return jsonlFiles(path.join(this.provider.codexHome, area));
  }

  cachedCodexSummary(file) {
    const stat = fs.statSync(file);
    const cached = this.codexSummaryCache.get(file);
    if (cached?.size === stat.size && cached?.mtimeMs === stat.mtimeMs) return cached.summary;
    const summary = codexThreadSummary(file, stat);
    this.codexSummaryCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, summary });
    if (summary?.id) this.codexFileIndex.set(summary.id, file);
    return summary;
  }

  findCodexThreadFile(threadId) {
    const id = String(threadId || "").trim();
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(id)) return null;
    const indexed = this.codexFileIndex.get(id);
    if (indexed && fs.existsSync(indexed)) return indexed;
    for (const file of [...this.codexThreadFiles(false), ...this.codexThreadFiles(true)]) {
      const summary = this.cachedCodexSummary(file);
      if (summary?.id === id) return file;
    }
    return null;
  }

  async listThreads(searchTerm = "", archived = false) {
    const query = String(searchTerm || "").trim().toLocaleLowerCase("zh-CN");
    const entries = !archived && fs.existsSync(this.root)
      ? fs.readdirSync(this.root, { withFileTypes: true })
      : [];
    const local = archived ? [] : entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => readJson(path.join(this.root, entry.name)))
      .filter((thread) => thread?.id && Array.isArray(thread.turns))
      .map((thread) => this.summary(thread));
    const localIds = new Set(local.map((thread) => thread.id));
    const shared = this.codexThreadFiles(archived)
      .map((file) => this.cachedCodexSummary(file))
      .filter((thread) => thread?.id && !localIds.has(thread.id));
    const data = [...local, ...shared]
      .filter((thread) => !query || `${thread.name || ""} ${thread.preview || ""}`.toLocaleLowerCase("zh-CN").includes(query))
      .sort((left, right) => right.recencyAt - left.recencyAt);
    return { data, nextCursor: null, backwardsCursor: null };
  }

  async readThread(threadId) {
    return { thread: this.loadThread(threadId) };
  }

  async resumeThread(threadId) {
    return this.readThread(threadId);
  }

  async startThread(cwd, model = null) {
    const now = Math.floor(Date.now() / 1000);
    const thread = {
      id: crypto.randomUUID(),
      name: null,
      preview: "新会话",
      modelProvider: this.provider.id,
      model: model || this.provider.model,
      cwd: cwd || null,
      createdAt: now,
      updatedAt: now,
      recencyAt: now,
      turns: [],
    };
    this.saveThread(thread);
    this.emit("notification", { method: "thread/started", params: { thread } });
    return { thread };
  }

  async renameThread(threadId, name) {
    const value = String(name || "").trim();
    if (!value) throw new Error("会话名称不能为空。");
    const thread = this.loadThread(threadId);
    thread.name = value.slice(0, 160);
    thread.updatedAt = Math.floor(Date.now() / 1000);
    this.saveThread(thread);
    this.emit("notification", {
      method: "thread/name/updated",
      params: { threadId, threadName: thread.name },
    });
    return {};
  }

  async deleteThread(threadId) {
    const file = this.threadFile(threadId);
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return {};
  }

  async listModels() {
    const models = [...new Set((this.provider.discoveredModels || [])
      .map((model) => String(model || "").trim())
      .filter(Boolean))];
    return {
      data: models.map((model, index) => ({
        id: model,
        model,
        displayName: model,
        description: `${this.provider.label} · Chat Completions`,
        isDefault: index === 0,
        defaultReasoningEffort: null,
        supportedReasoningEfforts: [],
        reasoningCapabilitiesVerified: false,
      })),
      nextCursor: null,
    };
  }

  startTurn(threadId, text, cwd, clientUserMessageId = null, options = {}) {
    if (this.activeTurns.has(threadId)) return Promise.reject(new Error("该会话仍在生成回复。"));
    const prompt = String(text || "").trim();
    const imageInputs = Array.isArray(options.imageInputs) ? options.imageInputs : [];
    const fileInputs = Array.isArray(options.fileInputs) ? options.fileInputs : [];
    if (!prompt && !imageInputs.length && !fileInputs.length) return Promise.reject(new Error("消息内容不能为空。"));
    let thread;
    try {
      thread = this.loadThread(threadId);
    } catch (error) {
      return Promise.reject(error);
    }
    const turnId = crypto.randomUUID();
    const userItem = {
      id: crypto.randomUUID(),
      type: "userMessage",
      clientId: clientUserMessageId,
      content: [
        ...(prompt ? [{ type: "text", text: prompt }] : []),
        ...imageInputs.map((image) => ({ type: "localImage", path: image.path })),
        ...fileInputs.map((file) => ({ type: "localFile", path: file.path, fileName: file.fileName || String(file.path || "").split(/[\\\\/]/).pop() })),
      ],
    };
    const assistantItem = { id: crypto.randomUUID(), type: "agentMessage", text: "", phase: "final_answer" };
    const reasoningItem = { id: crypto.randomUUID(), type: "reasoning", content: [], summary: [] };
    const turn = {
      id: turnId,
      status: "inProgress",
      items: [userItem],
      effort: String(options.effort || "").trim() || null,
      webSearch: Boolean(options.webSearch),
    };
    thread.turns.push(turn);
    thread.cwd = cwd || thread.cwd;
    thread.model = options.model || thread.model || this.provider.model;
    thread.modelProvider = this.provider.id;
    thread.preview = thread.preview === "新会话"
      ? (prompt.split(/\r?\n/)[0].slice(0, 120) || "图片会话")
      : thread.preview;
    thread.updatedAt = Math.floor(Date.now() / 1000);
    thread.recencyAt = thread.updatedAt;
    this.saveThread(thread);

    const controller = new AbortController();
    this.activeTurns.set(threadId, { controller, turnId, completed: false });
    this.emit("notification", {
      method: "thread/settings/updated",
      params: {
        threadId,
        threadSettings: {
          model: thread.model,
          modelProvider: this.provider.id,
          effort: turn.effort,
          approvalPolicy: "never",
          approvalsReviewer: "user",
          sandboxPolicy: { type: "readOnly" },
        },
      },
    });
    this.emit("notification", { method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress" } } });
    this.emit("notification", { method: "item/started", params: { threadId, turnId, item: userItem } });
    this.emit("notification", { method: "item/completed", params: { threadId, turnId, item: userItem } });
    this.emit("notification", { method: "item/started", params: { threadId, turnId, item: assistantItem } });
    this.executeTurn(thread, turn, assistantItem, reasoningItem, imageInputs, controller).catch((error) => {
      this.finishTurn(thread, turn, assistantItem, reasoningItem, error?.name === "AbortError" ? "interrupted" : "failed", error);
    });
    return Promise.resolve({ turn: { id: turnId, status: "inProgress" } });
  }

  async executeTurn(thread, turn, assistantItem, reasoningItem, imageInputs, controller) {
    const configuredProviders = [this.provider, ...this.fallbackProviders];
    const now = Date.now();
    const availableProviders = configuredProviders.filter((provider) => (
      (this.providerHealth.get(provider.id)?.openUntil || 0) <= now
    ));
    const providers = availableProviders.length
      ? availableProviders
      : [configuredProviders.reduce((earliest, provider) => (
        (this.providerHealth.get(provider.id)?.openUntil || 0)
          < (this.providerHealth.get(earliest.id)?.openUntil || 0) ? provider : earliest
      ))];
    let lastError = null;
    for (let index = 0; index < providers.length; index += 1) {
      const provider = providers[index];
      const contentLength = assistantItem.text.length;
      const reasoningLength = reasoningSummaryLength(reasoningItem);
      const startedAt = Date.now();
      const isPrimary = provider.id === this.provider.id;
      turn.actualProviderId = provider.id;
      turn.actualModel = isPrimary ? thread.model || this.provider.model : provider.model;
      try {
        await this.executeProviderTurn(
          provider,
          isPrimary ? thread.model || this.provider.model : provider.model,
          thread,
          turn,
          assistantItem,
          reasoningItem,
          imageInputs,
          controller,
        );
        this.providerHealth.set(provider.id, {
          failures: 0,
          openUntil: 0,
          lastSuccessAt: Date.now(),
          latencyMs: Date.now() - startedAt,
          lastError: null,
          status: "healthy",
        });
        if (!isPrimary) {
          this.emit("notification", {
            method: "model/rerouted",
            params: {
              threadId: thread.id,
              fromModel: thread.model || this.provider.model,
              toModel: provider.model,
              fromProviderId: this.provider.id,
              toProviderId: provider.id,
              reason: "failover",
            },
          });
        }
        this.emitHealth(provider.id, thread.id);
        this.finishTurn(thread, turn, assistantItem, reasoningItem, "completed");
        return;
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        lastError = error;
        const retryable = this.retryableProviderError(error);
        this.markProviderFailure(provider.id, error, retryable);
        this.emitHealth(provider.id, thread.id);
        const emittedPartial = assistantItem.text.length > contentLength || reasoningSummaryLength(reasoningItem) > reasoningLength;
        if (!retryable || emittedPartial || index === providers.length - 1) throw error;
      }
    }
    throw lastError || new Error("没有可用的模型连接。");
  }

  async executeProviderTurn(provider, model, thread, turn, assistantItem, reasoningItem, imageInputs, controller) {
    if ((provider.protocol || "chat_completions") === "responses") {
      return this.executeResponsesTurn(provider, model, thread, turn, assistantItem, reasoningItem, imageInputs, controller);
    }
    const response = await this.fetchImpl(chatCompletionsEndpoint(provider.baseUrl), {
      method: "POST",
      headers: {
        Accept: "text/event-stream",
        Authorization: `Bearer ${provider.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: messagesForThread(thread, imageInputs),
        stream: true,
        ...(turn.effort ? { reasoning_effort: turn.effort } : {}),
        ...(turn.webSearch ? { web_search_options: { search_context_size: "medium" } } : {}),
      }),
      signal: controller.signal,
    });
    const requestId = providerRequestId(response);
    if (requestId) turn.requestId = requestId;
    if (!response.ok) throw responseError(response.status, response.statusText, await response.text());
    if (response.headers.get("content-type")?.includes("application/json")) {
      const payload = await response.json();
      if (payload?.usage && typeof payload.usage === "object") turn.usage = { ...payload.usage };
      const choice = payload?.choices?.[0] || {};
      const message = choice.message || choice.delta || {};
      const reasoning = message.reasoning_content || message.reasoning || "";
      const content = typeof message.content === "string" ? message.content : "";
      if (reasoning) {
        appendReasoningSummaryDelta(reasoningItem, reasoning);
        this.emit("notification", {
          method: "item/reasoning/summaryTextDelta",
          params: { threadId: thread.id, turnId: turn.id, itemId: reasoningItem.id, delta: reasoning },
        });
      }
      if (content) {
        assistantItem.text += content;
        this.emit("notification", {
          method: "item/agentMessage/delta",
          params: { threadId: thread.id, turnId: turn.id, itemId: assistantItem.id, delta: content },
        });
      }
      if (!content && !reasoning) throw emptyResponseError();
      turn.finishReason = choice.finish_reason || choice.finishReason || null;
      assertCompletionReason(turn.finishReason, requestId);
      return;
    }
    let finishReason = null;
    let streamResult;
    try {
      streamResult = await consumeSse(response, (event) => {
        if (event?.usage && typeof event.usage === "object") turn.usage = { ...event.usage };
        const choice = event?.choices?.[0] || {};
        if (choice.finish_reason !== undefined && choice.finish_reason !== null) finishReason = choice.finish_reason;
        if (choice.finishReason !== undefined && choice.finishReason !== null) finishReason = choice.finishReason;
        const delta = choice.delta || {};
        const reasoning = delta.reasoning_content || delta.reasoning || "";
        if (reasoning) {
          appendReasoningSummaryDelta(reasoningItem, reasoning);
          this.emit("notification", {
            method: "item/reasoning/summaryTextDelta",
            params: { threadId: thread.id, turnId: turn.id, itemId: reasoningItem.id, delta: reasoning },
          });
        }
        if (delta.content) {
          assistantItem.text += delta.content;
          this.emit("notification", {
            method: "item/agentMessage/delta",
            params: { threadId: thread.id, turnId: turn.id, itemId: assistantItem.id, delta: delta.content },
          });
        }
      });
    } catch (error) {
      if (error?.name === "AbortError" || finishReason && ["stop", "tool_calls", "function_call"].includes(String(finishReason).toLowerCase())) {
        if (error?.name === "AbortError") throw error;
      } else {
        throw completionError(
          "INCOMPLETE_STREAM",
          `模型流式连接在完成前中断。已保留当前内容，可点击“继续生成”。${error?.message ? `（${error.message}）` : ""}`,
          { requestId, finishReason },
        );
      }
    }
    if (!assistantItem.text && !reasoningItem.summary.length) throw emptyResponseError();
    turn.finishReason = finishReason || null;
    assertCompletionReason(turn.finishReason, requestId);
    if (!streamResult?.receivedDone && !turn.finishReason) {
      const detail = streamResult?.malformedBlocks
        ? `，并包含 ${streamResult.malformedBlocks} 个无法解析的数据块`
        : "";
      throw completionError(
        "INCOMPLETE_STREAM",
        `模型流式连接在完成标记前关闭${detail}。已保留当前内容，可点击“继续生成”。`,
        { requestId },
      );
    }
  }

  async executeResponsesTurn(provider, model, thread, turn, assistantItem, reasoningItem, imageInputs, controller) {
    const response = await this.fetchImpl(responsesEndpoint(provider.baseUrl), {
      method: "POST",
      headers: {
        Accept: "text/event-stream",
        Authorization: `Bearer ${provider.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: responsesInput(messagesForThread(thread, imageInputs)),
        stream: true,
        store: false,
        ...(turn.effort ? { reasoning: { effort: turn.effort } } : {}),
        ...(turn.webSearch ? { tools: [{ type: "web_search_preview" }] } : {}),
      }),
      signal: controller.signal,
    });
    const requestId = providerRequestId(response);
    if (requestId) turn.requestId = requestId;
    if (!response.ok) throw responseError(response.status, response.statusText, await response.text());
    const searchItem = turn.webSearch
      ? { id: crypto.randomUUID(), type: "webSearch", query: "联网搜索", status: "inProgress" }
      : null;
    let searchStarted = false;
    const startSearch = (query = "") => {
      if (!searchItem) return;
      if (query) searchItem.query = query;
      if (searchStarted) return;
      searchStarted = true;
      this.emit("notification", { method: "item/started", params: { threadId: thread.id, turnId: turn.id, item: { ...searchItem } } });
    };
    const completeSearch = () => {
      if (!searchItem || !searchStarted) return;
      searchItem.status = "completed";
      turn.items.push(searchItem);
      this.emit("notification", { method: "item/completed", params: { threadId: thread.id, turnId: turn.id, item: { ...searchItem } } });
    };
    if (response.headers.get("content-type")?.includes("application/json")) {
      const payload = await response.json();
      if (payload?.usage && typeof payload.usage === "object") turn.usage = { ...payload.usage };
      const output = responseOutput(payload);
      if (output.query || turn.webSearch) startSearch(output.query);
      if (output.reasoning) appendReasoningSummaryDelta(reasoningItem, output.reasoning);
      assistantItem.text += output.text;
      assistantItem.text += appendCitations(assistantItem.text, output.annotations);
      completeSearch();
      turn.finishReason = payload?.status || "completed";
      if (!assistantItem.text && !reasoningItem.summary.length) throw emptyResponseError();
      if (["failed", "incomplete", "cancelled"].includes(String(payload?.status || "").toLowerCase())) {
        throw completionError("INCOMPLETE_RESPONSE", "模型 Responses 请求未完整完成。", { requestId, finishReason: payload.status });
      }
      return;
    }
    let completedResponse = null;
    let failedResponse = null;
    let streamResult;
    try {
      streamResult = await consumeSse(response, (event) => {
        const type = String(event?.type || "");
        if (type === "response.output_text.delta" && event.delta) {
          assistantItem.text += event.delta;
          this.emit("notification", {
            method: "item/agentMessage/delta",
            params: { threadId: thread.id, turnId: turn.id, itemId: assistantItem.id, delta: event.delta },
          });
        } else if (["response.reasoning_summary_text.delta", "response.reasoning_text.delta"].includes(type) && event.delta) {
          appendReasoningSummaryDelta(reasoningItem, event.delta);
          this.emit("notification", {
            method: "item/reasoning/summaryTextDelta",
            params: { threadId: thread.id, turnId: turn.id, itemId: reasoningItem.id, delta: event.delta },
          });
        } else if (type.includes("web_search")) {
          startSearch(event.item?.action?.query || event.item?.query || event.query || "");
        } else if (type === "response.completed") {
          completedResponse = event.response || event;
        } else if (["response.failed", "response.incomplete", "error"].includes(type)) {
          failedResponse = event.response || event;
        }
      });
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      throw completionError(
        "INCOMPLETE_STREAM",
        `模型流式连接在完成前中断。已保留当前内容，可点击“继续生成”。${error?.message ? `（${error.message}）` : ""}`,
        { requestId },
      );
    }
    if (completedResponse?.usage && typeof completedResponse.usage === "object") turn.usage = { ...completedResponse.usage };
    const output = responseOutput(completedResponse);
    if (!assistantItem.text && output.text) assistantItem.text = output.text;
    const citations = appendCitations(assistantItem.text, output.annotations);
    if (citations) {
      assistantItem.text += citations;
      this.emit("notification", {
        method: "item/agentMessage/delta",
        params: { threadId: thread.id, turnId: turn.id, itemId: assistantItem.id, delta: citations },
      });
    }
    completeSearch();
    turn.finishReason = completedResponse?.status || null;
    if (failedResponse || ["failed", "incomplete", "cancelled"].includes(String(turn.finishReason || "").toLowerCase())) {
      throw completionError("INCOMPLETE_RESPONSE", "模型 Responses 请求未完整完成。", { requestId, finishReason: turn.finishReason });
    }
    if (!assistantItem.text && !reasoningItem.summary.length) throw emptyResponseError();
    if (!completedResponse && !streamResult?.receivedDone) {
      throw completionError("INCOMPLETE_STREAM", "模型流式连接在完成标记前关闭。已保留当前内容，可点击“继续生成”。", { requestId });
    }
  }

  retryableProviderError(error) {
    const status = Number(error?.status);
    return error instanceof TypeError
      || error?.code === "EMPTY_RESPONSE"
      || error?.code === "INCOMPLETE_STREAM"
      || [408, 409, 425, 429].includes(status)
      || status >= 500;
  }

  markProviderFailure(providerId, error, retryable) {
    const previous = this.providerHealth.get(providerId) || { failures: 0, openUntil: 0 };
    if (["OUTPUT_TRUNCATED", "CONTENT_FILTERED"].includes(error?.code)) {
      this.providerHealth.set(providerId, {
        ...previous,
        lastFailureAt: Date.now(),
        lastError: String(error?.message || error).slice(0, 500),
        status: error.code === "OUTPUT_TRUNCATED" ? "limited" : "content-filtered",
      });
      return;
    }
    const failures = retryable ? previous.failures + 1 : previous.failures;
    const threshold = Math.max(1, Number(this.failover?.failureThreshold) || 2);
    const cooldownMs = Math.max(5000, Number(this.failover?.cooldownMs) || 60000);
    const breakerEnabled = Boolean(this.failover && this.fallbackProviders.length);
    const openUntil = breakerEnabled && retryable && failures >= threshold ? Date.now() + cooldownMs : 0;
    this.providerHealth.set(providerId, {
      ...previous,
      failures,
      openUntil,
      lastFailureAt: Date.now(),
      lastError: String(error?.message || error).slice(0, 500),
      status: openUntil > Date.now() ? "open" : retryable ? "degraded" : "configuration-error",
    });
  }

  emitHealth(providerId, threadId) {
    const health = this.providerHealth.get(providerId) || { failures: 0, openUntil: 0 };
    this.emit("notification", {
      method: "provider/health-updated",
      params: {
        threadId,
        providerId,
        status: health.openUntil > Date.now() ? "open" : health.status || "unknown",
        ...health,
      },
    });
  }

  finishTurn(thread, turn, assistantItem, reasoningItem, status, error = null) {
    const active = this.activeTurns.get(thread.id);
    if (!active || active.turnId !== turn.id || active.completed) return;
    active.completed = true;
    this.activeTurns.delete(thread.id);
    if (reasoningItem.summary.length) {
      turn.items.push(reasoningItem);
      this.emit("notification", { method: "item/completed", params: { threadId: thread.id, turnId: turn.id, item: reasoningItem } });
    }
    if (assistantItem.text) turn.items.push(assistantItem);
    this.emit("notification", { method: "item/completed", params: { threadId: thread.id, turnId: turn.id, item: assistantItem } });
    turn.status = status;
    if (error && status === "failed") {
      turn.error = {
        message: error.message,
        code: error.code || null,
        requestId: error.requestId || turn.requestId || null,
        finishReason: error.finishReason || turn.finishReason || null,
      };
    }
    thread.updatedAt = Math.floor(Date.now() / 1000);
    thread.recencyAt = thread.updatedAt;
    this.saveThread(thread);
    this.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: thread.id,
        turn: {
          id: turn.id,
          status,
          model: turn.actualModel || thread.model || this.provider.model,
          providerId: turn.actualProviderId || this.provider.id,
          ...(turn.usage ? { usage: turn.usage } : {}),
          ...(turn.requestId ? { requestId: turn.requestId } : {}),
          ...(turn.finishReason ? { finishReason: turn.finishReason } : {}),
          ...(turn.error ? { error: turn.error } : {}),
        },
      },
    });
  }

  request(method, params = {}) {
    if (method !== "turn/interrupt") {
      return Promise.reject(new Error(`Chat Completions engine does not support ${method}.`));
    }
    const active = this.activeTurns.get(params.threadId);
    if (!active || (params.turnId && active.turnId !== params.turnId)) return Promise.resolve({});
    active.controller.abort();
    return Promise.resolve({});
  }

  respond() {}

  respondError() {}

  stop() {
    this.ready = false;
    for (const active of this.activeTurns.values()) active.controller.abort();
  }
}

module.exports = {
  OpenAICompatibleServer,
  chatCompletionsEndpoint,
  responsesEndpoint,
  responseOutput,
  consumeSse,
  messagesForThread,
  parseCodexThreadFile,
  parseSseBlock,
  importedLocalThread,
};
