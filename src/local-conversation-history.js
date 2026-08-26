const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");

const MAX_LINE_CHARS = 2_000_000;
const MAX_TEXT_CHARS = 100_000;
const MAX_PREVIEW_MESSAGES = 600;
const MAX_FILES_PER_SOURCE = 20_000;

function cleanText(value, limit = MAX_TEXT_CHARS) {
  const text = String(value || "")
    .replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, "")
    .replace(/\u0000/g, "")
    .trim();
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, limit)}\n\n[内容过长，已截断]` : text;
}

function contentText(content) {
  if (typeof content === "string") return cleanText(content);
  if (!Array.isArray(content)) return "";
  return cleanText(content
    .filter((block) => block && typeof block === "object")
    .filter((block) => ["text", "input_text", "output_text", "summary_text"].includes(block.type))
    .map((block) => block.text || block.content || "")
    .filter(Boolean)
    .join("\n\n"));
}

function reasoningSummary(summary) {
  if (typeof summary === "string") return cleanText(summary);
  if (!Array.isArray(summary)) return "";
  return cleanText(summary
    .map((item) => typeof item === "string" ? item : item?.text || item?.summary || "")
    .filter(Boolean)
    .join("\n\n"));
}

function timestampMs(value) {
  const parsed = typeof value === "number" ? value : Date.parse(String(value || ""));
  if (!Number.isFinite(parsed)) return 0;
  return parsed < 10_000_000_000 ? parsed * 1000 : parsed;
}

function likelyInjectedCodexText(text) {
  const value = String(text || "").trimStart().toLowerCase();
  return [
    "<permissions instructions>",
    "<environment_context>",
    "<collaboration_mode>",
    "<skills_instructions>",
    "<apps_instructions>",
    "<plugins_instructions>",
  ].some((prefix) => value.startsWith(prefix));
}

function meaningfulClaudeText(text, record) {
  if (record?.isMeta) return false;
  const value = String(text || "").trimStart().toLowerCase();
  return value
    && !value.startsWith("<local-command-")
    && !value.startsWith("<command-name>")
    && !value.startsWith("<system-reminder>");
}

function titleText(value) {
  const compact = cleanText(value, 500).replace(/\s+/g, " ").trim();
  return compact.length > 80 ? `${compact.slice(0, 79)}…` : compact;
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function pathExists(target) {
  try {
    await fsp.access(target, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function enumerateJsonl(root, base, output) {
  if (output.length >= MAX_FILES_PER_SOURCE || !await pathExists(root)) return;
  const entries = await fsp.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (output.length >= MAX_FILES_PER_SOURCE) break;
    if (entry.isSymbolicLink()) continue;
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) await enumerateJsonl(fullPath, base, output);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) {
      output.push({ fullPath, relativePath: path.relative(base, fullPath) });
    }
  }
}

function createCollector(includeMessages) {
  const first = [];
  const tail = [];
  let count = 0;
  const add = (message) => {
    if (!message?.text) return;
    count += 1;
    if (!includeMessages) return;
    if (first.length < 50) first.push(message);
    else {
      tail.push(message);
      if (tail.length > MAX_PREVIEW_MESSAGES - 50) tail.shift();
    }
  };
  return {
    add,
    count: () => count,
    messages: () => [...first, ...tail],
    truncated: () => count > first.length + tail.length,
  };
}

async function parseConversationFile(filePath, sourceId, includeMessages = false) {
  const collector = createCollector(includeMessages);
  const fallback = createCollector(includeMessages);
  let title = "";
  let cwd = "";
  let model = "";
  let sessionId = "";
  let createdAt = 0;
  let updatedAt = 0;
  let responseMessageCount = 0;
  let lineCount = 0;
  let metadataTruncated = false;

  const input = fs.createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    lineCount += 1;
    if (!includeMessages && lineCount > 500) {
      metadataTruncated = true;
      lines.close();
      input.destroy();
      break;
    }
    if (!line || line.length > MAX_LINE_CHARS) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const recordTime = timestampMs(record.timestamp || record.payload?.timestamp);
    if (recordTime) {
      createdAt = createdAt ? Math.min(createdAt, recordTime) : recordTime;
      updatedAt = Math.max(updatedAt, recordTime);
    }

    if (sourceId.startsWith("codex")) {
      if (record.type === "session_meta") {
        sessionId ||= String(record.payload?.id || record.payload?.session_id || "");
        cwd ||= String(record.payload?.cwd || "");
        model ||= String(record.payload?.model_provider || "");
      } else if (record.type === "turn_context") {
        cwd ||= String(record.payload?.cwd || "");
        model = String(record.payload?.model || model || "");
      } else if (record.type === "response_item" && record.payload?.type === "message") {
        const role = record.payload.role;
        const text = contentText(record.payload.content);
        if (!["user", "assistant"].includes(role) || !text || (role === "user" && likelyInjectedCodexText(text))) continue;
        responseMessageCount += 1;
        if (!title && role === "user") title = titleText(text);
        collector.add({ role, text, timestamp: recordTime || null });
      } else if (record.type === "response_item" && record.payload?.type === "reasoning") {
        const text = reasoningSummary(record.payload.summary);
        if (text) collector.add({ role: "reasoning", text, timestamp: recordTime || null });
      } else if (record.type === "event_msg") {
        const eventType = record.payload?.type;
        const role = eventType === "user_message" ? "user" : eventType === "agent_message" ? "assistant" : null;
        const text = cleanText(record.payload?.message || record.payload?.text || "");
        if (role && text && !(role === "user" && likelyInjectedCodexText(text))) {
          if (!title && role === "user") title = titleText(text);
          fallback.add({ role, text, timestamp: recordTime || null });
        }
      }
      continue;
    }

    sessionId ||= String(record.sessionId || "");
    cwd ||= String(record.cwd || "");
    if (record.type === "ai-title" && record.aiTitle) title = titleText(record.aiTitle);
    if (!["user", "assistant"].includes(record.type)) continue;
    const role = record.message?.role || record.type;
    const text = contentText(record.message?.content);
    if (!text || (role === "user" && !meaningfulClaudeText(text, record))) continue;
    if (role === "assistant" && record.message?.model) model = String(record.message.model);
    if (!title && role === "user") title = titleText(text);
    collector.add({ role, text, timestamp: recordTime || null });
  }

  const useFallback = sourceId.startsWith("codex") && responseMessageCount === 0 && fallback.count() > 0;
  return {
    sessionId,
    title: title || "未命名会话",
    cwd,
    model,
    createdAt,
    updatedAt,
    messageCount: useFallback ? fallback.count() : collector.count(),
    messages: useFallback ? fallback.messages() : collector.messages(),
    truncated: useFallback ? fallback.truncated() : collector.truncated(),
    messageCountApproximate: metadataTruncated,
  };
}

function encodeConversationId(sourceId, relativePath) {
  return Buffer.from(JSON.stringify({ sourceId, relativePath }), "utf8").toString("base64url");
}

function decodeConversationId(value) {
  try {
    const parsed = JSON.parse(Buffer.from(String(value || ""), "base64url").toString("utf8"));
    if (!parsed || typeof parsed.sourceId !== "string" || typeof parsed.relativePath !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

function createLocalHistoryReader({ homeDirectory = os.homedir(), codexHomes = [] } = {}) {
  const sourceDefinitions = [];
  const definitions = new Map();
  const normalizedHomes = new Set();
  function addSource(source) {
    if (!source?.id || !source.base) return null;
    const normalized = path.resolve(source.base).toLocaleLowerCase();
    if (normalizedHomes.has(normalized)) return definitions.get(source.id) || null;
    normalizedHomes.add(normalized);
    const definition = { ...source, base: path.resolve(source.base) };
    sourceDefinitions.push(definition);
    definitions.set(definition.id, definition);
    return definition;
  }
  addSource({
    id: "codex",
    label: "Codex",
    description: "Codex CLI 与桌面客户端",
    base: path.join(homeDirectory, ".codex"),
    roots: ["sessions", "archived_sessions"],
  });
  let appIndex = 0;
  for (const base of Array.isArray(codexHomes) ? codexHomes : [codexHomes]) {
    const resolved = String(base || "").trim();
    if (!resolved) continue;
    addSource({
      id: `codex-app-${++appIndex}`,
      label: "Codex App",
      description: "Codex App 本地会话（只读）",
      base: resolved,
      roots: ["sessions", "archived_sessions"],
    });
  }
  addSource({
    id: "claude",
    label: "Claude Code",
    description: "Claude Code 本地项目会话",
    base: path.join(homeDirectory, ".claude"),
    roots: ["projects"],
  });
  const cache = new Map();

  async function sources() {
    return Promise.all(sourceDefinitions.map(async (source) => ({
      id: source.id,
      label: source.label,
      description: source.description,
      available: (await Promise.all(source.roots.map((root) => pathExists(path.join(source.base, root))))).some(Boolean),
    })));
  }

  async function sourceFiles(source) {
    const files = [];
    for (const root of source.roots) await enumerateJsonl(path.join(source.base, root), source.base, files);
    return files;
  }

  async function safeFile(source, relativePath) {
    if (!relativePath || path.isAbsolute(relativePath) || path.extname(relativePath).toLowerCase() !== ".jsonl") {
      throw new Error("本地会话标识无效。");
    }
    const target = path.resolve(source.base, relativePath);
    const allowedRoots = source.roots.map((root) => path.resolve(source.base, root));
    if (!allowedRoots.some((root) => inside(root, target))) throw new Error("不允许读取该位置。");
    const [realTarget, realRoots] = await Promise.all([
      fsp.realpath(target),
      Promise.all(allowedRoots.map(async (root) => await pathExists(root) ? fsp.realpath(root) : null)),
    ]);
    if (!realRoots.filter(Boolean).some((root) => inside(root, realTarget))) throw new Error("不允许读取该位置。");
    return realTarget;
  }

  async function parsed(source, file, includeMessages = false) {
    const stat = await fsp.stat(file.fullPath);
    const cacheKey = `${stat.size}:${stat.mtimeMs}`;
    const existing = cache.get(file.fullPath);
    if (existing?.key === cacheKey && (!includeMessages || existing.full)) return existing.value;
    const value = await parseConversationFile(file.fullPath, source.id, includeMessages);
    value.updatedAt = Math.max(value.updatedAt || 0, stat.mtimeMs);
    value.createdAt ||= value.updatedAt;
    const result = {
      ...value,
      id: encodeConversationId(source.id, file.relativePath),
      sourceId: source.id,
      sourceLabel: source.label,
      archived: source.id.startsWith("codex") && file.relativePath.split(path.sep)[0] === "archived_sessions",
    };
    cache.set(file.fullPath, { key: cacheKey, full: includeMessages, value: result });
    return result;
  }

  async function list({ sourceId = "codex", search = "", limit = 500, all = false } = {}) {
    const source = definitions.get(String(sourceId));
    if (!source) throw new Error("不支持的本地会话来源。");
    const files = await sourceFiles(source);
    const results = [];
    const concurrency = 6;
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, async () => {
      while (cursor < files.length) {
        const index = cursor;
        cursor += 1;
        try {
          results.push(await parsed(source, files[index], false));
        } catch {
          // A partially written or inaccessible session should not hide the remaining local history.
        }
      }
    }));
    const query = String(search || "").trim().toLocaleLowerCase("zh-CN");
    const visibleResults = results.filter((item) => item.messageCount > 0);
    const filtered = query ? visibleResults.filter((item) => (
      [item.title, item.cwd, item.model, item.sessionId]
        .some((value) => String(value || "").toLocaleLowerCase("zh-CN").includes(query))
    )) : visibleResults;
    filtered.sort((a, b) => b.updatedAt - a.updatedAt);
    const safeLimit = Math.max(1, Math.min(all ? MAX_FILES_PER_SOURCE : 2000, Number(limit) || (all ? MAX_FILES_PER_SOURCE : 500)));
    return {
      sourceId: source.id,
      total: filtered.length,
      scanned: files.length,
      conversations: filtered.slice(0, safeLimit).map(({ messages, truncated, ...item }) => item),
    };
  }

  async function read({ conversationId } = {}) {
    const decoded = decodeConversationId(conversationId);
    const source = decoded && definitions.get(decoded.sourceId);
    if (!source) throw new Error("本地会话标识无效。");
    const fullPath = await safeFile(source, decoded.relativePath);
    return parsed(source, { fullPath, relativePath: decoded.relativePath }, true);
  }

  return {
    sources,
    list,
    read,
    addCodexSource(base, id = null) {
      const value = String(base || "").trim();
      if (!value) return null;
      const source = addSource({
        id: id || `codex-app-${++appIndex}`,
        label: "Codex App",
        description: "Codex App 本地会话（只读）",
        base: value,
        roots: ["sessions", "archived_sessions"],
      });
      cache.clear();
      return source?.id || null;
    },
  };
}

module.exports = {
  createLocalHistoryReader,
  parseConversationFile,
};
