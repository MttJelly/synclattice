const { EventEmitter } = require("node:events");
const { execFile, spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { findExecutable, userExecutableCandidates } = require("./cli-discovery");

const CLAUDE_EXE = findExecutable({
  override: process.env.CHATSWITCH_CLAUDE_EXE,
  candidates: userExecutableCandidates("claude"),
  commands: ["claude.exe", "claude"],
  winget: { packagePrefix: "Anthropic.ClaudeCode_", executable: "claude.exe" },
});
const ISOLATED_STORE = Boolean(process.env.CHATSWITCH_STORE_ROOT);

function claudeAuthEnvironment(configDir) {
  return {
    ...process.env,
    ...(configDir ? { CLAUDE_CONFIG_DIR: configDir } : {}),
  };
}

function claudeAuthStatus(configDir) {
  if (!CLAUDE_EXE || !fs.existsSync(CLAUDE_EXE)) {
    throw new Error("未找到 Claude Code CLI。请先安装 Claude Code。");
  }
  return new Promise((resolve, reject) => {
    execFile(CLAUDE_EXE, ["auth", "status", "--json"], {
      env: claudeAuthEnvironment(configDir),
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    }, (error, stdout) => {
      if (error) {
        reject(new Error("无法读取 Claude Code 登录状态，请重试。"));
        return;
      }
      try {
        resolve(JSON.parse(String(stdout || "{}")));
      } catch {
        reject(new Error("Claude Code 返回了无法识别的登录状态。"));
      }
    });
  });
}

function readJsonLines(file) {
  const records = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {}
  }
  return records;
}

async function forEachJsonLineAsync(file, visitor) {
  const lines = readline.createInterface({
    input: fs.createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      try {
        visitor(JSON.parse(line));
      } catch {}
    }
  } finally {
    lines.close();
  }
}

function readJsonLineSample(file, sampleBytes = 256 * 1024) {
  const stats = fs.statSync(file);
  if (stats.size <= sampleBytes * 2) return readJsonLines(file);
  const descriptor = fs.openSync(file, "r");
  try {
    const readChunk = (start, length) => {
      const buffer = Buffer.alloc(length);
      const bytesRead = fs.readSync(descriptor, buffer, 0, length, start);
      return buffer.subarray(0, bytesRead).toString("utf8");
    };
    const first = readChunk(0, sampleBytes);
    const lastStart = Math.max(0, stats.size - sampleBytes);
    const last = readChunk(lastStart, stats.size - lastStart);
    const firstComplete = first.includes("\n") ? first.slice(0, first.lastIndexOf("\n")) : first;
    const lastComplete = last.includes("\n") ? last.slice(last.indexOf("\n") + 1) : last;
    const records = [];
    for (const line of `${firstComplete}\n${lastComplete}`.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch {}
    }
    return records;
  } finally {
    fs.closeSync(descriptor);
  }
}

function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part?.type === "text").map((part) => part.text || "").join("\n");
}

function claudePermissionArgs(mode = "ask") {
  if (mode === "full") {
    return ["--permission-mode", "bypassPermissions", "--dangerously-skip-permissions"];
  }
  return ["--permission-mode", mode === "auto" ? "auto" : "manual"];
}

function timestampSeconds(value, fallback = Date.now()) {
  const parsed = Date.parse(value || "");
  return Math.floor((Number.isFinite(parsed) ? parsed : fallback) / 1000);
}

function toolItem(block) {
  const input = block.input || {};
  if (block.name === "Bash") {
    return { id: block.id, type: "commandExecution", command: input.command || "Bash", status: "inProgress" };
  }
  if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(block.name)) {
    return { id: block.id, type: "fileChange", path: input.file_path || input.notebook_path || block.name, status: "inProgress" };
  }
  if (block.name === "WebSearch") {
    return { id: block.id, type: "webSearch", query: input.query || "Web search", status: "inProgress" };
  }
  return { id: block.id, type: "dynamicToolCall", tool: block.name || "Claude tool", status: "inProgress" };
}

class ClaudeServer extends EventEmitter {
  constructor(provider) {
    super();
    this.provider = provider;
    this.ready = false;
    this.processes = new Map();
    this.pendingThreads = new Map();
    this.actualModel = null;
    this.configDir = provider.claudeConfigDir;
    this.localProjectsRoot = path.join(this.configDir, "projects");
    this.globalProjectsRoot = ISOLATED_STORE ? null : path.join(os.homedir(), ".claude", "projects");
    this.namesFile = path.join(this.configDir, "chatswitch-thread-names.json");
    this.settingsFile = null;
  }

  async start() {
    if (!CLAUDE_EXE || !fs.existsSync(CLAUDE_EXE)) {
      throw new Error("未找到 Claude Code CLI。请先安装 Claude Code，并确保 claude 命令已加入 PATH。");
    }
    fs.mkdirSync(this.configDir, { recursive: true });
    if (this.provider.authMode === "oauth") {
      const status = await claudeAuthStatus(this.configDir);
      if (!status?.loggedIn) throw new Error("尚未登录 Claude Code 官方账号，请先完成 Anthropic 官方登录。");
    } else if (!this.provider.env?.[this.provider.envKey]) {
      throw new Error(`${this.provider.envKey} 未配置。`);
    }
    if (new URL(this.provider.baseUrl).hostname.toLowerCase() === "ai.hexuan.cc") {
      if (ISOLATED_STORE) {
        throw new Error("隔离模式不会读取用户级 Claude 设置。");
      }
      const globalSettings = path.join(os.homedir(), ".claude", "settings.json");
      if (!fs.existsSync(globalSettings)) {
        throw new Error("Hexuan Claude 连接需要 C:\\Users\\PC\\.claude\\settings.json 中的模型映射。");
      }
      this.settingsFile = globalSettings;
    }
    this.ready = true;
  }

  threadFiles() {
    const filesById = new Map();
    for (const root of [this.localProjectsRoot, this.globalProjectsRoot].filter(Boolean)) {
      for (const file of this.filesUnder(root)) {
        const id = path.basename(file, ".jsonl");
        if (!filesById.has(id)) filesById.set(id, file);
      }
    }
    return [...filesById.values()];
  }

  filesUnder(root) {
    if (!root) return [];
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
    return files;
  }

  findThreadFile(threadId) {
    return this.threadFiles().find((file) => path.basename(file, ".jsonl") === threadId) || null;
  }

  findLocalThreadFile(threadId) {
    return this.filesUnder(this.localProjectsRoot)
      .find((file) => path.basename(file, ".jsonl") === threadId) || null;
  }

  importThreadForResume(threadId) {
    const local = this.findLocalThreadFile(threadId);
    if (local) return local;
    if (!this.globalProjectsRoot) return null;
    const source = this.filesUnder(this.globalProjectsRoot)
      .find((file) => path.basename(file, ".jsonl") === threadId) || null;
    if (!source) return null;
    const relative = path.relative(this.globalProjectsRoot, source);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Claude 会话记录路径无效，无法安全导入。");
    }
    const target = path.join(this.localProjectsRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    return target;
  }

  names() {
    try {
      return JSON.parse(fs.readFileSync(this.namesFile, "utf8"));
    } catch {
      return {};
    }
  }

  writeNames(names) {
    fs.mkdirSync(this.configDir, { recursive: true });
    const temporary = `${this.namesFile}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(names, null, 2)}\n`, "utf8");
    fs.renameSync(temporary, this.namesFile);
  }

  async parseThread(file) {
    const id = path.basename(file, ".jsonl");
    const names = this.names();
    const turns = [];
    let current = null;
    let cwd = null;
    let model = this.provider.model;
    let firstText = "";
    let firstTimestamp = null;
    let lastTimestamp = null;
    await forEachJsonLineAsync(file, (record) => {
      if (record.isSidechain) return;
      cwd ||= record.cwd || null;
      if (record.timestamp) {
        firstTimestamp ||= record.timestamp;
        lastTimestamp = record.timestamp;
      }
      if (record.type === "user") {
        const text = textContent(record.message?.content);
        if (!text) return;
        firstText ||= text;
        current = { id: record.uuid || crypto.randomUUID(), status: "completed", items: [] };
        current.items.push({
          id: record.uuid || crypto.randomUUID(),
          type: "userMessage",
          content: [{ type: "text", text }],
        });
        turns.push(current);
        return;
      }
      if (record.type !== "assistant") return;
      model = record.message?.model && record.message.model !== "<synthetic>" ? record.message.model : model;
      if (!current) {
        current = { id: record.uuid || crypto.randomUUID(), status: "completed", items: [] };
        turns.push(current);
      }
      for (const block of record.message?.content || []) {
        if (block.type === "text" && block.text) {
          current.items.push({ id: `${record.uuid}:text`, type: "agentMessage", text: block.text });
        } else if (block.type === "thinking" && block.thinking) {
          current.items.push({ id: `${record.uuid}:thinking`, type: "reasoning", content: [block.thinking], summary: [] });
        } else if (block.type === "tool_use") {
          current.items.push(toolItem(block));
        }
      }
    });
    const stats = fs.statSync(file);
    const createdAt = timestampSeconds(firstTimestamp, stats.birthtimeMs);
    const updatedAt = timestampSeconds(lastTimestamp, stats.mtimeMs);
    return {
      id,
      name: names[id] || null,
      preview: firstText.split(/\r?\n/)[0].slice(0, 120) || "Claude 会话",
      modelProvider: `claude:${model}`,
      model,
      cwd,
      createdAt,
      updatedAt,
      recencyAt: updatedAt,
      turns,
      _historyEngine: "claude",
    };
  }

  parseThreadSummary(file, names = this.names()) {
    const records = readJsonLineSample(file).filter((record) => !record.isSidechain);
    const id = path.basename(file, ".jsonl");
    let cwd = null;
    let model = this.provider.model;
    let firstText = "";
    let firstTimestamp = null;
    for (const record of records) {
      cwd ||= record.cwd || null;
      firstTimestamp ||= record.timestamp || null;
      if (record.type === "user" && !firstText) firstText = textContent(record.message?.content);
      if (record.type === "assistant" && record.message?.model && record.message.model !== "<synthetic>") {
        model = record.message.model;
      }
    }
    const stats = fs.statSync(file);
    const createdAt = timestampSeconds(firstTimestamp, stats.birthtimeMs);
    const updatedAt = Math.floor(stats.mtimeMs / 1000);
    return {
      id,
      name: names[id] || null,
      preview: firstText.split(/\r?\n/)[0].slice(0, 120) || "Claude 会话",
      modelProvider: `claude:${model}`,
      model,
      cwd,
      createdAt,
      updatedAt,
      recencyAt: updatedAt,
      turns: [],
      _historyEngine: "claude",
    };
  }

  async listThreads(searchTerm = "", archived = false) {
    if (archived) return { data: [], nextCursor: null, backwardsCursor: null };
    const query = String(searchTerm || "").trim().toLowerCase();
    const names = this.names();
    const data = this.threadFiles()
      .map((file) => this.parseThreadSummary(file, names))
      .filter((thread) => !query || `${thread.name || ""} ${thread.preview}`.toLowerCase().includes(query))
      .sort((left, right) => right.recencyAt - left.recencyAt);
    return { data, nextCursor: null, backwardsCursor: null };
  }

  async readThread(threadId) {
    const file = this.findThreadFile(threadId);
    if (file) return { thread: await this.parseThread(file) };
    const pending = this.pendingThreads.get(threadId);
    if (pending) return { thread: pending };
    throw new Error("未找到 Claude 会话记录。");
  }

  async startThread(cwd, model = null) {
    const id = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const selectedModel = model || this.provider.model;
    const thread = {
      id,
      name: null,
      preview: "Claude 新会话",
      modelProvider: `claude:${selectedModel}`,
      model: selectedModel,
      cwd,
      createdAt: now,
      updatedAt: now,
      recencyAt: now,
      turns: [],
    };
    this.pendingThreads.set(id, thread);
    return { thread };
  }

  readThreadForResume(threadId) {
    return this.readThread(threadId);
  }

  resumeThread(threadId) {
    return this.readThread(threadId);
  }

  async renameThread(threadId, name) {
    const value = String(name || "").trim();
    if (!value) throw new Error("会话名称不能为空。");
    const names = this.names();
    names[threadId] = value;
    this.writeNames(names);
    const pending = this.pendingThreads.get(threadId);
    if (pending) pending.name = value;
    return {};
  }

  async deleteThread(threadId) {
    const file = this.findThreadFile(threadId);
    if (file) fs.unlinkSync(file);
    this.pendingThreads.delete(threadId);
    const names = this.names();
    if (Object.hasOwn(names, threadId)) {
      delete names[threadId];
      this.writeNames(names);
    }
    return {};
  }

  startTurn(threadId, text, cwd, clientUserMessageId = null, options = {}) {
    if (this.processes.has(threadId)) return Promise.reject(new Error("该 Claude 会话仍在运行。"));
    const turnId = crypto.randomUUID();
    const existing = Boolean(this.importThreadForResume(threadId));
    const selectedModel = options.model || this.provider.model;
    const effort = options.effort || "high";
    const approvalMode = ["ask", "auto", "full"].includes(options.approvalMode)
      ? options.approvalMode
      : "ask";
    const imagePaths = (options.imageInputs || [])
      .map((image) => String(image?.path || "").trim())
      .filter(Boolean);
    const prompt = imagePaths.length
      ? `${String(text || "").trim()}\n\n请查看并分析以下本地图片：\n${imagePaths.map((file) => `- ${file}`).join("\n")}`.trim()
      : text;
    const args = [
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--model", selectedModel,
      "--effort", effort,
      ...claudePermissionArgs(approvalMode),
      ...(this.settingsFile ? ["--settings", this.settingsFile] : []),
      existing ? "--resume" : "--session-id", threadId,
      prompt,
    ];
    const env = {
      ...process.env,
      ANTHROPIC_BASE_URL: this.provider.baseUrl,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
      CLAUDE_CONFIG_DIR: this.configDir,
    };
    const authToken = this.provider.env?.[this.provider.envKey];
    if (authToken) env.ANTHROPIC_AUTH_TOKEN = authToken;
    const processHandle = spawn(CLAUDE_EXE, args, {
      cwd: cwd || process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.processes.set(threadId, {
      process: processHandle,
      turnId,
      requestedModel: selectedModel,
      completed: false,
      stderr: "",
    });
    this.emit("notification", {
      method: "turn/started",
      params: { threadId, turn: { id: turnId, status: "inProgress" } },
    });
    const userItem = {
      id: crypto.randomUUID(),
      type: "userMessage",
      clientId: clientUserMessageId,
      content: [{ type: "text", text }],
    };
    this.emit("notification", { method: "item/started", params: { threadId, turnId, item: userItem } });
    this.emit("notification", { method: "item/completed", params: { threadId, turnId, item: userItem } });

    const lines = readline.createInterface({ input: processHandle.stdout });
    lines.on("line", (line) => this.handleStreamLine(threadId, turnId, line));
    processHandle.stderr.on("data", (chunk) => {
      const message = chunk.toString().trim();
      const active = this.processes.get(threadId);
      if (message && active) active.stderr = `${active.stderr || ""}\n${message}`.trim().slice(-2000);
    });
    processHandle.on("error", (error) => this.finishTurn(threadId, turnId, "failed", error.message));
    processHandle.on("exit", (code) => {
      const active = this.processes.get(threadId);
      if (active && !active.completed) {
        const detail = active.stderr ? `：${active.stderr}` : "";
        this.finishTurn(
          threadId,
          turnId,
          code === 0 ? "completed" : "failed",
          code === 0 ? null : `Claude Code exited with code ${code}${detail}`,
        );
      }
    });
    return Promise.resolve({ turn: { id: turnId, status: "inProgress" } });
  }

  handleStreamLine(threadId, turnId, line) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (event.type === "system" && event.subtype === "init") {
      this.actualModel = event.model || this.actualModel;
      const requestedModel = this.processes.get(threadId)?.requestedModel || this.provider.model;
      this.emit("notification", {
        method: "provider/model-resolved",
        params: { threadId, requestedModel, actualModel: this.actualModel },
      });
      return;
    }
    if (event.type === "assistant") {
      for (const block of event.message?.content || []) {
        if (block.type === "text" && block.text) {
          const item = { id: `${event.uuid}:text`, type: "agentMessage", text: block.text };
          this.emit("notification", { method: "item/started", params: { threadId, turnId, item } });
          this.emit("notification", { method: "item/completed", params: { threadId, turnId, item } });
        } else if (block.type === "thinking" && block.thinking) {
          const item = { id: `${event.uuid}:thinking`, type: "reasoning", content: [block.thinking], summary: [] };
          this.emit("notification", { method: "item/completed", params: { threadId, turnId, item } });
        } else if (block.type === "tool_use") {
          this.emit("notification", { method: "item/started", params: { threadId, turnId, item: toolItem(block) } });
        }
      }
      return;
    }
    if (event.type === "user") {
      for (const block of event.message?.content || []) {
        if (block.type !== "tool_result" || !block.tool_use_id) continue;
        const output = textContent(block.content) || String(block.content || "");
        const item = {
          id: block.tool_use_id,
          type: "dynamicToolCall",
          tool: "Claude tool",
          status: block.is_error ? "failed" : "completed",
          aggregatedOutput: output,
        };
        this.emit("notification", { method: "item/completed", params: { threadId, turnId, item } });
      }
      return;
    }
    if (event.type === "result") {
      this.finishTurn(
        threadId,
        turnId,
        event.is_error ? "failed" : "completed",
        event.is_error ? event.result : null,
        event.usage || event.modelUsage || null,
      );
    }
  }

  finishTurn(threadId, turnId, status, diagnostic = null, usage = null) {
    const active = this.processes.get(threadId);
    if (!active || active.turnId !== turnId || active.completed) return;
    active.completed = true;
    this.processes.delete(threadId);
    this.pendingThreads.delete(threadId);
    this.emit("notification", {
      method: "turn/completed",
      params: {
        threadId,
        turn: {
          id: turnId,
          status,
          ...(diagnostic && status === "failed" ? { error: { message: String(diagnostic).slice(0, 1000) } } : {}),
          ...(usage ? { usage } : {}),
        },
      },
    });
  }

  request(method, params = {}) {
    if (method === "turn/interrupt") {
      const active = this.processes.get(params.threadId);
      if (!active) return Promise.resolve({});
      active.process.kill();
      this.finishTurn(params.threadId, active.turnId, "interrupted");
      return Promise.resolve({});
    }
    return Promise.reject(new Error(`Claude engine does not support ${method}.`));
  }

  respond() {}

  stop() {
    this.ready = false;
    for (const [threadId, active] of this.processes) {
      active.process.kill();
      this.finishTurn(threadId, active.turnId, "interrupted");
    }
  }
}

module.exports = { ClaudeServer, CLAUDE_EXE, claudeAuthEnvironment, claudeAuthStatus, claudePermissionArgs, readJsonLines };
