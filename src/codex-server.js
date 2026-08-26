const { EventEmitter } = require("node:events");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const readline = require("node:readline");
const path = require("node:path");
const {
  bundledCodexCandidates,
  findExecutable,
  isBundledCodexExecutable,
  packagedCodexCandidates,
  userExecutableCandidates,
} = require("./cli-discovery");
const { repairInterruptedToolCallsForThread } = require("./conversation-integrity");
const { APP_VERSION } = require("./app-version");

const LEGACY_CODEX_HOME = "G:\\FIle\\codex-file";
const CODEX_HOME = process.env.CODEX_HOME
  || (process.env.CHATSWITCH_PACKAGED !== "1" && fs.existsSync(LEGACY_CODEX_HOME)
    ? LEGACY_CODEX_HOME
    : path.join(os.homedir(), ".codex"));
const CODEX_EXE = findExecutable({
  override: process.env.CHATSWITCH_CODEX_EXE,
  candidates: [
    ...packagedCodexCandidates(),
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs", "OpenAI", "Codex", "bin", "codex.exe") : null,
    ...userExecutableCandidates("codex"),
    ...bundledCodexCandidates(),
  ],
  commands: ["codex.exe", "codex"],
});
const BUILTIN_MODEL_CATALOG = path.join(__dirname, "model-catalog.json");
const STARTUP_TIMEOUT_MS = 120000;
const ANSI_ESCAPE_PATTERN = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

function codexRuntimeRoot() {
  return process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "ChatSwitch", "runtime", "codex")
    : path.join(os.tmpdir(), "chatswitch-runtime", "codex");
}

async function executableForStart(source) {
  if (!isBundledCodexExecutable(source)) return { executable: source, runtimeKind: "codex-cli" };
  const normalized = path.normalize(String(source)).toLowerCase();
  if (normalized.includes(`${path.sep}codex-runtime${path.sep}`)) {
    return { executable: source, runtimeKind: "chatswitch-bundled" };
  }
  let stat;
  try {
    stat = await fs.promises.stat(source);
  } catch (error) {
    throw new Error(`无法读取 ChatGPT 应用内置 Codex 运行时：${error.message}`);
  }
  const cacheKey = `${stat.size}-${Math.floor(stat.mtimeMs)}`;
  const targetDir = path.join(codexRuntimeRoot(), cacheKey);
  const target = path.join(targetDir, "codex.exe");
  try {
    const cached = await fs.promises.stat(target);
    if (cached.size === stat.size) return { executable: target, runtimeKind: "chatgpt-app" };
  } catch {}
  await fs.promises.mkdir(targetDir, { recursive: true });
  const temporary = path.join(targetDir, `codex-${process.pid}-${Date.now()}.tmp`);
  try {
    await fs.promises.copyFile(source, temporary);
    try {
      await fs.promises.rename(temporary, target);
    } catch (error) {
      try {
        const cached = await fs.promises.stat(target);
        if (cached.size !== stat.size) throw error;
        await fs.promises.rm(temporary, { force: true });
      } catch {
        throw error;
      }
    }
  } catch (error) {
    await fs.promises.rm(temporary, { force: true }).catch(() => {});
    throw new Error(`无法准备 ChatGPT 应用内置 Codex 运行时：${error.message}`);
  }
  return { executable: target, runtimeKind: "chatgpt-app" };
}

function normalizeDiagnostic(value) {
  return String(value || "")
    .replace(ANSI_ESCAPE_PATTERN, "")
    .replace(/\r/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();
}

const APPROVAL_MODES = {
  ask: {
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
  },
  auto: {
    approvalPolicy: "on-request",
    approvalsReviewer: "auto_review",
    sandbox: "workspace-write",
  },
  full: {
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: "danger-full-access",
  },
};

function approvalSettings(mode = "ask") {
  return { ...(APPROVAL_MODES[mode] || APPROVAL_MODES.ask) };
}

function terminateProcessTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32" && Number.isInteger(child.pid)) {
    const result = spawnSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
      windowsHide: true,
      stdio: "ignore",
      timeout: 5000,
    });
    if (!result.error) return;
  }
  try {
    child.kill();
  } catch {}
}

const BASE_PROVIDERS = {
  official: {
    id: "official",
    modelProvider: "openai",
    label: "OpenAI account",
    type: "official",
    args: [
      "-c", "model_provider=\"openai\"",
      "-c", "cli_auth_credentials_store=\"file\"",
      "-c", "features.apps=false",
      "-c", "features.remote_plugin=false",
      "app-server",
    ],
  },
  niubi: {
    id: "niubi",
    modelProvider: "niubi",
    label: "Niubi API",
    type: "api",
    baseUrl: "https://www.niubiapi.com/v1",
    model: "gpt-5.6-sol",
    envKey: "NIUBI_API_KEY",
    balanceType: "new-api",
    args: [
      "-c", "model_provider=\"niubi\"",
      "-c", "model=\"gpt-5.6-sol\"",
      "-c", "model_reasoning_effort=\"high\"",
      "-c", `model_catalog_json=${JSON.stringify(BUILTIN_MODEL_CATALOG)}`,
      "-c", "disable_response_storage=true",
      "-c", "features.apps=false",
      "-c", "features.remote_plugin=false",
      "-c", "model_providers.niubi.name=\"Niubi API\"",
      "-c", "model_providers.niubi.base_url=\"https://www.niubiapi.com/v1\"",
      "-c", "model_providers.niubi.wire_api=\"responses\"",
      "-c", "model_providers.niubi.env_key=\"NIUBI_API_KEY\"",
      "app-server",
    ],
  },
  hexuan: {
    id: "hexuan",
    modelProvider: "hexuan",
    label: "Hexuan API",
    type: "api",
    baseUrl: "https://ai.hexuan.cc/v1",
    model: "gpt-5.6-sol",
    envKey: "HEXUAN_API_KEY",
    args: [
      "-c", "model_provider=\"hexuan\"",
      "-c", "model=\"gpt-5.6-sol\"",
      "-c", "model_reasoning_effort=\"high\"",
      "-c", `model_catalog_json=${JSON.stringify(BUILTIN_MODEL_CATALOG)}`,
      "-c", "disable_response_storage=true",
      "-c", "features.apps=false",
      "-c", "features.remote_plugin=false",
      "-c", "model_providers.hexuan.name=\"Hexuan relay\"",
      "-c", "model_providers.hexuan.base_url=\"https://ai.hexuan.cc/v1\"",
      "-c", "model_providers.hexuan.wire_api=\"responses\"",
      "-c", "model_providers.hexuan.env_key=\"HEXUAN_API_KEY\"",
      "app-server",
    ],
  },
  claude: {
    id: "claude",
    modelProvider: "claude",
    label: "Claude Code",
    type: "claude",
    engine: "claude",
    baseUrl: "https://api.anthropic.com/v1",
    model: "fable",
    envKey: "ANTHROPIC_AUTH_TOKEN",
  },
};

class CodexServer extends EventEmitter {
  constructor(provider, env = {}) {
    super();
    if (!provider?.id || !Array.isArray(provider.args)) throw new Error("Invalid provider definition.");
    this.provider = provider;
    this.env = {
      ...process.env,
      ...env,
      ...(provider.env || {}),
      CODEX_HOME: provider.codexHome || CODEX_HOME,
      ...(provider.sqliteHome ? { CODEX_SQLITE_HOME: provider.sqliteHome } : {}),
    };
    this.process = null;
    this.lines = null;
    this.pending = new Map();
    this.nextId = 1;
    this.ready = false;
    this.diagnostics = [];
    this.integrityCheckedThreads = new Set();
    this.runtimeKind = "codex-cli";
    this.executable = null;
  }

  async start() {
    if (this.process) return;
    if (!CODEX_EXE) {
      throw new Error("未找到可用的 OpenAI 运行时。请安装 ChatGPT 官方应用，或安装 Codex CLI 后重试。");
    }
    const runtime = await executableForStart(CODEX_EXE);
    this.executable = runtime.executable;
    this.runtimeKind = runtime.runtimeKind;
    this.process = spawn(runtime.executable, this.provider.args, {
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.lines = readline.createInterface({ input: this.process.stdout });
    this.lines.on("line", (line) => this.handleLine(line));
    this.process.stderr.on("data", (chunk) => {
      const text = normalizeDiagnostic(chunk);
      if (text) this.recordDiagnostic(text);
    });
    this.process.on("error", (error) => this.failAll(error));
    this.process.on("exit", (code) => {
      this.ready = false;
      const detail = this.diagnostics.at(-1);
      this.failAll(new Error(`Codex app-server exited with code ${code}${detail ? `: ${detail}` : ""}`));
      this.emit("exit", code, detail || null);
    });

    await this.request("initialize", {
      clientInfo: { name: "chatswitch", title: "ChatSwitch", version: APP_VERSION },
      capabilities: { experimentalApi: true },
    }, STARTUP_TIMEOUT_MS);
    this.notify("initialized", {});
    this.ready = true;
  }

  recordDiagnostic(value) {
    const text = normalizeDiagnostic(value);
    if (!text) return;
    this.diagnostics.push(text);
    this.diagnostics = this.diagnostics.slice(-5);
    this.emit("server-log", text);
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      const diagnostic = normalizeDiagnostic(line);
      if (diagnostic) this.recordDiagnostic(diagnostic);
      return;
    }
    if (message.id !== undefined && !message.method) {
      const waiter = this.pending.get(String(message.id));
      if (!waiter) return;
      clearTimeout(waiter.timer);
      this.pending.delete(String(message.id));
      if (message.error) waiter.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else waiter.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      this.emit("server-request", message);
      return;
    }
    if (message.method) this.emit("notification", message);
  }

  request(method, params = {}, timeoutMs = 45000) {
    if (!this.process?.stdin?.writable) return Promise.reject(new Error("Codex app-server is not running."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(String(id), { resolve, reject, timer });
      this.process.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    });
  }

  notify(method, params = {}) {
    if (this.process?.stdin?.writable) {
      this.process.stdin.write(`${JSON.stringify({ method, params })}\n`);
    }
  }

  respond(id, result) {
    if (this.process?.stdin?.writable) {
      this.process.stdin.write(`${JSON.stringify({ id, result })}\n`);
    }
  }

  respondError(id, code, message) {
    if (this.process?.stdin?.writable) {
      this.process.stdin.write(`${JSON.stringify({ id, error: { code, message } })}\n`);
    }
  }

  failAll(error) {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
  }

  stop() {
    this.ready = false;
    this.lines?.close();
    if (this.process?.stdin?.writable) this.process.stdin.end();
    terminateProcessTree(this.process);
    this.process = null;
  }

  async listThreads(searchTerm = "", archived = false) {
    const data = [];
    const seenCursors = new Set();
    let cursor = null;
    let backwardsCursor = null;
    do {
      const page = await this.request("thread/list", {
        archived,
        cursor,
        limit: 200,
        modelProviders: [],
        searchTerm: searchTerm || null,
        sortKey: "recency_at",
        sortDirection: "desc",
      });
      data.push(...(page.data || []));
      backwardsCursor ||= page.backwardsCursor || null;
      cursor = page.nextCursor || null;
      if (cursor && seenCursors.has(cursor)) throw new Error("thread/list returned a repeated pagination cursor.");
      if (cursor) seenCursors.add(cursor);
    } while (cursor);
    return { data, nextCursor: null, backwardsCursor };
  }

  async listModels() {
    const data = [];
    const seenCursors = new Set();
    let cursor = null;
    do {
      const page = await this.request("model/list", { cursor, limit: 100, includeHidden: false });
      data.push(...(page.data || []));
      cursor = page.nextCursor || null;
      if (cursor && seenCursors.has(cursor)) throw new Error("model/list returned a repeated pagination cursor.");
      if (cursor) seenCursors.add(cursor);
    } while (cursor);
    return { data, nextCursor: null };
  }

  readThread(threadId) {
    return this.request("thread/read", { threadId, includeTurns: true }, 90000);
  }

  renameThread(threadId, name) {
    const value = String(name || "").trim();
    if (!threadId || !value) return Promise.reject(new Error("会话名称不能为空。"));
    return this.request("thread/name/set", { threadId, name: value }, 30000);
  }

  deleteThread(threadId) {
    if (!threadId) return Promise.reject(new Error("无效的会话 ID。"));
    return this.request("thread/delete", { threadId }, 30000);
  }

  async resumeThread(threadId, cwd = null, modelProvider = null, model = null, options = {}) {
    this.integrityCheckedThreads ||= new Set();
    const privateHome = this.provider?.codexHome;
    if (privateHome && !this.integrityCheckedThreads.has(threadId)) {
      try {
        const repaired = repairInterruptedToolCallsForThread(privateHome, threadId);
        this.integrityCheckedThreads.add(threadId);
        if (repaired.length) this.emit("diagnostic", `已修复 ${repaired.length} 条因上次退出而中断的工具调用。`);
      } catch (error) {
        this.emit("diagnostic", `会话完整性检查失败，已继续恢复：${error.message}`);
      }
    }
    return this.request("thread/resume", {
      threadId,
      cwd,
      ...(modelProvider ? { modelProvider } : {}),
      ...(model ? { model } : {}),
      ...approvalSettings(options.approvalMode),
      personality: "pragmatic",
    }, 90000);
  }

  startThread(cwd, model = null, options = {}) {
    return this.request("thread/start", {
      cwd,
      ...(model ? { model } : {}),
      ...approvalSettings(options.approvalMode),
      personality: "pragmatic",
      ephemeral: false,
      sessionStartSource: "startup",
    }, 90000);
  }

  startTurn(threadId, text, cwd, clientUserMessageId = null, options = {}) {
    const input = this.turnInput(text, options);
    if (!input.length) return Promise.reject(new Error("消息内容不能为空。"));
    return this.request("turn/start", {
      threadId,
      cwd,
      ...(options.model ? { model: options.model } : {}),
      ...(options.effort ? { effort: options.effort } : {}),
      ...approvalSettings(options.approvalMode),
      personality: "pragmatic",
      input,
      ...(clientUserMessageId ? { clientUserMessageId } : {}),
    }, 90000);
  }

  turnInput(text, options = {}) {
    const skillInputs = (options.skillInputs || [])
      .filter((skill) => skill && typeof skill.name === "string" && typeof skill.path === "string")
      .map((skill) => ({ type: "skill", name: skill.name, path: skill.path }));
    const imageInputs = (options.imageInputs || [])
      .filter((image) => image && typeof image.path === "string" && image.path.trim())
      .map((image) => ({ type: "localImage", path: image.path, detail: image.detail || "auto" }));
    const prompt = String(text || "").trim();
    const input = [
      ...skillInputs,
      ...imageInputs,
      ...(prompt ? [{ type: "text", text: prompt }] : []),
    ];
    return input;
  }

  steerTurn(threadId, expectedTurnId, text, options = {}) {
    const input = this.turnInput(text, options);
    if (!input.length) return Promise.reject(new Error("引导内容不能为空。"));
    if (!String(expectedTurnId || "").trim()) return Promise.reject(new Error("当前回复尚未开始，暂时无法引导。"));
    return this.request("turn/steer", {
      threadId,
      expectedTurnId,
      input,
    }, 90000);
  }
}

module.exports = {
  CodexServer,
  BASE_PROVIDERS,
  CODEX_HOME,
  CODEX_EXE,
  executableForStart,
  APPROVAL_MODES,
  approvalSettings,
  normalizeDiagnostic,
};
