const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, net, Notification, shell, Tray } = require("electron");
const { execFile, spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fileURLToPath, pathToFileURL } = require("node:url");
const { APP_VERSION, LATEST_RELEASE_API, USER_AGENT, updateFromRelease } = require("./app-version");
const {
  ApprovalRequestRegistry,
  approvalDecisionForNotificationAction,
  approvalDecisionResult,
  approvalNotificationSpec,
} = require("./approval-request");
const {
  ensureWindowsNotificationIdentity,
  notificationShortcutArguments,
  windowsTaskbarDetails,
} = require("./windows-notification-identity");

const WINDOWS_PACKAGED_APP_ID = "com.chatswitch.desktop";
const WINDOWS_APP_ID = app.isPackaged ? WINDOWS_PACKAGED_APP_ID : `${WINDOWS_PACKAGED_APP_ID}.dev`;
const WINDOWS_TOAST_ACTIVATOR_CLSID = "{E6B8F4D5-4A0D-4B9F-8E3B-3C0F5C3E6D21}";
app.setName("ChatSwitch");
// Upgrade existing installations into the new Electron profile. Copying the
// whole profile preserves the Windows safeStorage encryption context.
if (app.isPackaged) {
  const appDataRoot = app.getPath("appData");
  const chatSwitchUserData = path.join(appDataRoot, "ChatSwitch");
  if (!fs.existsSync(chatSwitchUserData)) {
    const previousProfiles = ["Synclattice", "Share Master"]
      .map((name) => path.join(appDataRoot, name));
    const legacyUserData = previousProfiles.find((directory) => fs.existsSync(directory));
    if (legacyUserData) {
      try {
        fs.cpSync(legacyUserData, chatSwitchUserData, { recursive: true, errorOnExist: false });
      } catch (error) {
        console.warn(`[migration] unable to copy previous profile: ${error.message}`);
      }
    }
  }
  fs.mkdirSync(chatSwitchUserData, { recursive: true });
  app.setPath("userData", chatSwitchUserData);
}
app.setAppUserModelId(WINDOWS_APP_ID);
if (process.platform === "win32") app.setToastActivatorCLSID(WINDOWS_TOAST_ACTIVATOR_CLSID);
if (app.isPackaged) {
  process.env.CHATSWITCH_PACKAGED = "1";
  // A packaged install owns its data directory. Do not let a stale developer
  // environment variable point the released app at another installation.
  process.env.CHATSWITCH_STORE_ROOT = path.join(app.getPath("userData"), "data");
  // Keep the bundled app-server state private to ChatSwitch. External Codex
  // credentials and sessions are discovered only through explicit import/read-only flows.
  process.env.CODEX_HOME = path.join(app.getPath("userData"), "data", "codex");
}

const { CodexServer, CODEX_EXE, CODEX_HOME } = require("./codex-server");
const { ClaudeServer, CLAUDE_EXE, claudeAuthEnvironment, claudeAuthStatus } = require("./claude-server");
const { OpenAICompatibleServer } = require("./openai-compatible-server");
const { fetchClaudeModels, fetchClaudeModelsSafely } = require("./claude-models");
const { fetchOpenAIModels } = require("./openai-models");
const { ProviderStore, providerApiKey, providerPresetCatalog, reasoningProfile } = require("./provider-store");
const { fetchRelayBalance } = require("./relay-balance");
const { executeScheduledTask, finalizeScheduledTask } = require("./scheduled-task-runner");
const { syncConversationMirrors } = require("./conversation-mirror");
const { createLocalHistoryReader } = require("./local-conversation-history");
const { createLocalProviderDiscovery } = require("./local-provider-discovery");
const { installSkillSource, listManagedSkills, syncManagedSkills } = require("./skill-mirror");
const { parseChatSwitchLink, chatSwitchLinkFromArgs } = require("./deep-link");
const {
  buildContinuationPrompt,
  mergeLogicalThread,
  remapBranchMessage,
} = require("./conversation-branches");
const { createStreamEventBatcher } = require("./stream-event-batcher");
const {
  isOfficialProvider,
  isAuthenticatedOfficialSnapshot,
  requireAuthenticatedOfficialSnapshot,
} = require("./openai-auth");
const { normalizeRateLimits, normalizeAccountUsage } = require("./openai-account-usage");

// OpenAI-compatible relays do not always expose reasoning metadata. Keep a conservative
// common set selectable and let the provider decide whether the request is honored.
const GENERIC_REASONING_EFFORTS = ["low", "medium", "high"].map((reasoningEffort) => ({
  reasoningEffort,
  description: "通用推理等级；是否生效取决于当前供应商和模型。",
}));

const hasSingleInstanceLock = app.requestSingleInstanceLock();
const servers = new Map();
const connectionGenerations = new Map();
const connectionAttempts = new Map();
const runningScheduledTasks = new Set();
const scheduledTaskRuns = new Map();
const pendingTurnDisplays = new Map();
const pendingSteerDisplays = new Map();
const activeLogicalTurns = new Map();
const activeLogicalTurnsById = new Map();
const pendingBranchCreations = new WeakMap();
const providerRequestRuns = new WeakMap();
const serverBranchLookups = new WeakMap();
const serverNativeThreads = new WeakMap();
const approvalRequestRegistry = new ApprovalRequestRegistry();
let conversationMirrorSync = null;
let conversationMirrorTimer = null;
let conversationMirrorLastResult = null;
let skillRefreshPromise = null;
const INTERACTIVE_SERVER_REQUESTS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
  "applyPatchApproval",
  "execCommandApproval",
]);
let providerStore;
let localProviderDiscovery;
let sharedHistoryHome = null;
let sharedCompatibleHistory = null;
let sharedClaudeHistory = null;
const sharedThreadSearchCache = new Map();
let skillSources = [];
let tray = null;
let quitting = false;
let lastActiveWindow = null;
const pendingDeepLinks = [];
const DEFAULT_RENDERER_THREAD_TURNS = 40;
const APPLICATION_ROOT = path.resolve(__dirname, "..");
const DEVELOPMENT_ICON = path.join(APPLICATION_ROOT, "build", "icon.ico");
const PACKAGED_ICON = path.join(process.resourcesPath, "icon.ico");
const DEFAULT_WORKSPACE = app.isPackaged ? os.homedir() : APPLICATION_ROOT;
const TITLE_BAR_OVERLAYS = Object.freeze({
  light: { color: "#fafbfc", symbolColor: "#273139", height: 48 },
  dark: { color: "#171c1f", symbolColor: "#edf1f3", height: 48 },
});
let applicationUpdateCheck = null;
const localHistoryReader = createLocalHistoryReader({ homeDirectory: os.homedir() });

function codexAppHistoryHomes() {
  if (process.platform !== "win32") return [];
  const roots = [];
  const localAppData = process.env.LOCALAPPDATA;
  const appData = process.env.APPDATA;
  if (localAppData) {
    roots.push(
      path.join(localAppData, "OpenAI", "Codex"),
      path.join(localAppData, "Codex"),
    );
    const packages = path.join(localAppData, "Packages");
    try {
      for (const entry of fs.readdirSync(packages, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.toLocaleLowerCase().startsWith("openai.codex_")) continue;
        const packageRoot = path.join(packages, entry.name);
        roots.push(
          path.join(packageRoot, "LocalState"),
          path.join(packageRoot, "LocalCache", "Local", "Codex"),
          path.join(packageRoot, "LocalCache", "Local", "OpenAI", "Codex"),
          path.join(packageRoot, "LocalCache", "Roaming", "Codex"),
          path.join(packageRoot, "LocalCache", "Roaming", "OpenAI", "Codex"),
        );
      }
    } catch {
      // The AppX package directory may be unavailable to a standard user.
    }
  }
  if (appData) roots.push(path.join(appData, "OpenAI", "Codex"), path.join(appData, "Codex"));
  return [...new Set(roots.map((value) => path.resolve(value)))];
}

for (const home of codexAppHistoryHomes()) localHistoryReader.addCodexSource(home);

function applicationIconPath() {
  if (!app.isPackaged) return DEVELOPMENT_ICON;
  return fs.existsSync(PACKAGED_ICON) ? PACKAGED_ICON : process.execPath;
}

function applicationIcon() {
  for (const source of [applicationIconPath(), process.execPath]) {
    try {
      const icon = nativeImage.createFromPath(source);
      if (!icon.isEmpty()) return icon;
    } catch {
      // Fall through to the executable resource when a standalone icon is unavailable.
    }
  }
  return null;
}

function applyWindowIdentity(window) {
  if (!window || window.isDestroyed()) return;
  const icon = applicationIcon();
  if (icon && typeof window.setIcon === "function") window.setIcon(icon);
  if (process.platform !== "win32") return;
  if (typeof window.setSkipTaskbar === "function") window.setSkipTaskbar(false);
  if (typeof window.setAppDetails === "function") {
    window.setAppDetails(windowsTaskbarDetails({
      isPackaged: app.isPackaged,
      userData: app.getPath("userData"),
      applicationRoot: APPLICATION_ROOT,
      appUserModelId: WINDOWS_APP_ID,
      target: process.execPath,
      icon: applicationIconPath(),
    }));
  }
}

function handleRendererIpc(channel, handler) {
  ipcMain.handle(channel, async (...args) => {
    try {
      return await handler(...args);
    } catch (error) {
      return {
        __chatSwitchIpcError: {
          message: String(error?.message || error || "未知错误").slice(0, 2000),
          code: error?.code || null,
          status: Number.isFinite(Number(error?.status)) ? Number(error.status) : null,
          requestId: error?.requestId || null,
          finishReason: error?.finishReason || null,
        },
      };
    }
  });
}

function focusApprovalWindow(sender) {
  if (!sender || sender.isDestroyed()) return;
  const owner = BrowserWindow.fromWebContents(sender);
  if (!owner || owner.isDestroyed()) return;
  if (owner.isMinimized()) owner.restore();
  owner.show();
  owner.focus();
}

function settleApprovalRequest(server, requestId, result, source = "renderer") {
  const request = approvalRequestRegistry.take(server, requestId);
  if (!request) return false;
  request.notification?.close();
  server.respond(request.message.id, result);
  request.send("codex:event", {
    method: "serverRequest/resolved",
    params: { requestId: request.message.id, source },
  });
  return true;
}

function discardApprovalRequest(server, requestId) {
  const request = approvalRequestRegistry.take(server, requestId);
  if (!request) return false;
  request.notification?.close();
  return true;
}

function clearApprovalRequests(server) {
  for (const request of approvalRequestRegistry.clear(server)) request.notification?.close();
}

function registerApprovalRequest(server, message, mappedMessage, sender, send) {
  const request = { message, mappedMessage, sender, send, notification: null };
  approvalRequestRegistry.replace(server, message.id, request)?.notification?.close();
  send("codex:approval", mappedMessage);
  if (!Notification.isSupported()) return request;

  const spec = approvalNotificationSpec(mappedMessage);
  const notification = new Notification({
    id: `approval-${crypto.randomUUID()}`,
    groupId: "threadlattice-approvals",
    groupTitle: "ChatSwitch 授权请求",
    title: spec.title,
    body: spec.body,
    actions: spec.actions,
    silent: false,
    timeoutType: "never",
  });
  request.notification = notification;
  notification.on("click", () => focusApprovalWindow(sender));
  notification.on("action", (event, legacyActionIndex) => {
    const actionIndex = Number.isInteger(event?.actionIndex) ? event.actionIndex : legacyActionIndex;
    const decision = approvalDecisionForNotificationAction(actionIndex);
    if (!decision) {
      focusApprovalWindow(sender);
      return;
    }
    settleApprovalRequest(
      server,
      message.id,
      approvalDecisionResult(message, decision),
      `notification:${decision}`,
    );
  });
  notification.on("failed", (_event, error) => {
    console.error(`[approval-notification] ${error}`);
  });
  notification.show();
  return request;
}

function loginItemOptions(openAtLogin = undefined) {
  if (app.isPackaged) {
    return {
      ...(typeof openAtLogin === "boolean" ? { openAtLogin } : {}),
      path: process.execPath,
      args: [],
    };
  }
  const launcher = path.join(path.resolve(__dirname, ".."), "Start ChatSwitch.cmd");
  return {
    ...(typeof openAtLogin === "boolean" ? { openAtLogin } : {}),
    path: process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe",
    args: ["/d", "/s", "/c", `"${launcher}"`],
  };
}

function rendererThreadWindow(result, requestedTurns = DEFAULT_RENDERER_THREAD_TURNS) {
  const thread = result?.thread;
  if (!thread || !Array.isArray(thread.turns)) return result;
  const totalTurns = thread.turns.length;
  const visibleTurns = Math.max(
    DEFAULT_RENDERER_THREAD_TURNS,
    Math.min(totalTurns, Number(requestedTurns) || DEFAULT_RENDERER_THREAD_TURNS),
  );
  return {
    ...result,
    thread: {
      ...thread,
      turns: thread.turns.slice(-visibleTurns),
      _totalTurnCount: totalTurns,
      _turnOffset: Math.max(0, totalTurns - visibleTurns),
    },
  };
}

const nextConnectionGeneration = (senderId) => {
  const generation = (connectionGenerations.get(senderId) || 0) + 1;
  connectionGenerations.set(senderId, generation);
  return generation;
};

function userEnvironmentVariable(name) {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-Command", `[Environment]::GetEnvironmentVariable('${name}','User')`],
      { windowsHide: true },
      (_error, stdout) => resolve(String(stdout || "").trim()),
    );
  });
}

function execFilePromise(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).trim()));
      else resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

async function providerEnvironment() {
  if (process.env.CHATSWITCH_STORE_ROOT) return {};
  const [niubi, hexuan] = await Promise.all([
    userEnvironmentVariable("NIUBI_API_KEY"),
    userEnvironmentVariable("HEXUAN_API_KEY"),
  ]);
  return {
    ...(niubi ? { NIUBI_API_KEY: niubi } : {}),
    ...(hexuan ? { HEXUAN_API_KEY: hexuan } : {}),
  };
}

async function checkApplicationUpdate() {
  if (applicationUpdateCheck) return applicationUpdateCheck;
  applicationUpdateCheck = (async () => {
    try {
      const response = await net.fetch(LATEST_RELEASE_API, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": USER_AGENT },
      });
      if (!response.ok) throw new Error(`GitHub Release 请求失败（HTTP ${response.status}）`);
      return { ...updateFromRelease(APP_VERSION, await response.json()), checkedAt: Date.now() };
    } catch (error) {
      return {
        status: "error",
        checkedAt: Date.now(),
        message: `无法检查更新：${String(error.message || error).replace(/https?:\/\/[^\s@]+@/g, "https://")}`.slice(0, 500),
      };
    }
  })();
  try { return await applicationUpdateCheck; } finally { applicationUpdateCheck = null; }
}

async function accountSnapshot(server) {
  if (!isOfficialProvider(server.provider)) {
    return { account: null, requiresOpenaiAuth: false, rateLimits: null };
  }
  if (process.env.CHATSWITCH_QA === "1" && process.env.CHATSWITCH_QA_OFFICIAL_AUTHENTICATED === "1") {
    return {
      account: { type: "chatgpt", email: "qa@chatswitch.test", planType: "plus" },
      requiresOpenaiAuth: true,
      rateLimits: { groups: [], resetCredits: 0 },
      accountUsage: null,
      rateLimitsError: null,
      accountUsageError: null,
    };
  }
  const account = await server.request("account/read", { refreshToken: false });
  let rateLimits = { groups: [], resetCredits: 0 };
  let accountUsage = null;
  let rateLimitsError = null;
  let accountUsageError = null;
  if (account.account?.type === "chatgpt") {
    const [limitsResult, usageResult] = await Promise.allSettled([
      server.request("account/rateLimits/read", {}),
      server.request("account/usage/read", {}),
    ]);
    if (limitsResult.status === "fulfilled") {
      rateLimits = normalizeRateLimits(limitsResult.value);
    } else {
      rateLimitsError = String(limitsResult.reason?.message || limitsResult.reason || "未知错误").slice(0, 500);
      server.emit("diagnostic", `无法读取账号额度：${rateLimitsError}`);
    }
    if (usageResult.status === "fulfilled") {
      accountUsage = normalizeAccountUsage(usageResult.value);
    } else {
      accountUsageError = String(usageResult.reason?.message || usageResult.reason || "未知错误").slice(0, 500);
      server.emit("diagnostic", `无法读取账号用量：${accountUsageError}`);
    }
  }
  return { ...account, rateLimits, accountUsage, rateLimitsError, accountUsageError };
}

async function loginOfficialAccount(provider) {
  const server = new CodexServer(provider, await providerEnvironment());
  let expectedLoginId = null;
  let earlyCompletion = null;
  let authenticated = false;
  let loginActive = true;
  let resolveCompletion;
  const completion = new Promise((resolve) => { resolveCompletion = resolve; });
  const onNotification = (message) => {
    if (message.method !== "account/login/completed") return;
    if (!expectedLoginId) earlyCompletion = message.params;
    else if (!message.params?.loginId || message.params.loginId === expectedLoginId) resolveCompletion(message.params);
  };
  server.on("notification", onNotification);
  try {
    await server.start();
    const started = await server.request("account/login/start", {
      type: "chatgpt",
      appBrand: "codex",
      codexStreamlinedLogin: true,
      useHostedLoginSuccessPage: true,
    }, 90000);
    if (started.type !== "chatgpt" || !started.authUrl || !started.loginId) {
      throw new Error("Codex 未返回可用的 ChatGPT 登录地址。");
    }
    expectedLoginId = started.loginId;
    if (earlyCompletion && (!earlyCompletion.loginId || earlyCompletion.loginId === expectedLoginId)) {
      resolveCompletion(earlyCompletion);
    }
    await shell.openExternal(started.authUrl);
    const timeoutMs = 5 * 60 * 1000;
    let timer;
    const pollForAuthentication = (async () => {
      while (loginActive) {
        await new Promise((resolve) => setTimeout(resolve, 750));
        if (!loginActive) return null;
        try {
          const identity = await server.request("account/read", { refreshToken: false });
          if (isAuthenticatedOfficialSnapshot(identity)) return { authenticated: true };
        } catch (error) {
          if (loginActive) throw error;
          return null;
        }
      }
      return null;
    })();
    const result = await Promise.race([
      completion.then((value) => ({ completion: value })),
      pollForAuthentication,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("登录等待超时，请重试。")), timeoutMs);
      }),
    ]).finally(() => {
      loginActive = false;
      clearTimeout(timer);
    });
    if (result.completion?.success === false) {
      throw new Error(result.completion.error || "Codex 官方登录失败。");
    }
    let snapshot = await accountSnapshot(server);
    if (!isAuthenticatedOfficialSnapshot(snapshot)) {
      for (let attempt = 0; attempt < 10 && !isAuthenticatedOfficialSnapshot(snapshot); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        snapshot = await accountSnapshot(server);
      }
    }
    requireAuthenticatedOfficialSnapshot(provider, snapshot, { afterLogin: true });
    authenticated = true;
    return snapshot;
  } finally {
    loginActive = false;
    server.off("notification", onNotification);
    if (expectedLoginId && !authenticated) {
      server.request("account/login/cancel", { loginId: expectedLoginId }, 5000).catch(() => {});
    }
    server.stop();
  }
}

async function loginClaudeOfficial(provider) {
  if (!CLAUDE_EXE || !fs.existsSync(CLAUDE_EXE)) {
    throw new Error("未找到 Claude Code CLI。请先安装 Claude Code，再使用 Claude 官方登录。此入口不会要求你填写账号或密码。");
  }
  const configDir = provider.claudeConfigDir;
  fs.mkdirSync(configDir, { recursive: true });
  const result = await new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_EXE, ["auth", "login", "--claudeai"], {
      env: claudeAuthEnvironment(configDir),
      windowsHide: true,
      stdio: "ignore",
    });
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };
    child.once("error", (error) => finish(new Error(`无法启动 Claude Code 官方登录：${error.message}`)));
    child.once("exit", (code) => {
      if (code === 0) finish(null, { code });
      else finish(new Error(`Claude Code 官方登录未完成（退出代码 ${code ?? "未知"}）。`));
    });
  });
  const status = await claudeAuthStatus(configDir);
  if (!status?.loggedIn) throw new Error("Claude Code 登录未完成，请在浏览器中完成 Anthropic 官方认证后重试。");
  const configured = providerStore.saveClaudeSettings({
    baseUrl: provider.baseUrl || "https://api.anthropic.com/v1",
    model: provider.model || "fable",
    vendorLabel: "Anthropic 官方",
    authMode: "oauth",
  });
  broadcastStoreSnapshot();
  return { provider: configured, status, result };
}

function createWindow(providerId = null, projectRoot = null, threadId = null, projectId = null, workspace = null) {
  const initialTitleBar = TITLE_BAR_OVERLAYS.light;
  const icon = applicationIcon();
  const window = new BrowserWindow({
    width: Number(process.env.CHATSWITCH_QA_WIDTH || 1380),
    height: Number(process.env.CHATSWITCH_QA_HEIGHT || 900),
    minWidth: 900,
    minHeight: 640,
    backgroundColor: initialTitleBar.color,
    ...(icon ? { icon } : {}),
    titleBarStyle: "hidden",
    titleBarOverlay: initialTitleBar,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  applyWindowIdentity(window);
  window.once("ready-to-show", () => applyWindowIdentity(window));
  window.webContents.once("did-finish-load", () => applyWindowIdentity(window));
  const webContentsId = window.webContents.id;
  lastActiveWindow = window;
  window.on("focus", () => { lastActiveWindow = window; });
  window.on("close", (event) => {
    if (quitting || process.env.CHATSWITCH_QA_SCREENSHOT || providerStore?.appSettings().closeToTray === false) return;
    event.preventDefault();
    window.hide();
    refreshTrayMenu();
  });
  window.loadFile(path.join(__dirname, "renderer", "index.html"), {
    query: {
      ...(providerId ? { provider: providerId } : {}),
      ...(projectRoot ? { project: projectRoot } : {}),
      ...(projectId ? { projectId } : {}),
      ...(workspace ? { workspace } : {}),
      ...(threadId ? { thread: threadId } : {}),
    },
  });
  if (process.env.CHATSWITCH_QA_SCREENSHOT) {
    window.webContents.on("console-message", (_event, level, message) => {
      if (level >= 2) console.error(`[renderer:${level}] ${message}`);
    });
    window.webContents.once("did-finish-load", () => {
      if (process.env.CHATSWITCH_QA_SCENARIO === "request-user-input") {
        setTimeout(() => {
          if (window.isDestroyed() || window.webContents.isDestroyed()) return;
          window.webContents.send("codex:approval", {
            id: "qa-request-user-input",
            method: "item/tool/requestUserInput",
            params: {
              questions: [
                {
                  id: "mode",
                  header: "运行模式",
                  question: "选择一种运行模式",
                  isOther: true,
                  isSecret: false,
                  options: [
                    { label: "安全", description: "只读检查" },
                    { label: "完整", description: "执行完整流程" },
                  ],
                },
                { id: "note", header: "备注", question: "补充说明", isOther: false, isSecret: true, options: null },
              ],
              autoResolutionMs: null,
            },
          });
        }, 1800);
      }
      if (process.env.CHATSWITCH_QA_SCENARIO === "mcp-form") {
        setTimeout(() => {
          if (window.isDestroyed() || window.webContents.isDestroyed()) return;
          window.webContents.send("codex:approval", {
            id: "qa-mcp-form",
            method: "mcpServer/elicitation/request",
            params: {
              serverName: "QA MCP",
              mode: "form",
              message: "填写测试参数",
              requestedSchema: {
                type: "object",
                required: ["name", "count"],
                properties: {
                  name: { type: "string", title: "名称" },
                  count: { type: "integer", title: "数量", minimum: 1, maximum: 10 },
                  enabled: { type: "boolean", title: "启用", default: true },
                  color: { type: "string", title: "颜色", enum: ["red", "green"] },
                  tags: { type: "array", title: "标签", items: { type: "string", enum: ["a", "b", "c"] } },
                },
              },
              _meta: null,
            },
          });
        }, 1800);
      }
      if (["view-archived", "view-removed"].includes(process.env.CHATSWITCH_QA_SCENARIO)) {
        setTimeout(() => {
          if (window.isDestroyed() || window.webContents.isDestroyed()) return;
          const view = process.env.CHATSWITCH_QA_SCENARIO === "view-archived" ? "archived" : "removed";
          window.webContents.executeJavaScript(`(async () => {
            document.querySelector('[data-thread-view="${view}"]').click();
            await new Promise((resolve) => setTimeout(resolve, 150));
            document.querySelector('.thread-item')?.click();
            await new Promise((resolve) => setTimeout(resolve, 2200));
          })()`).catch((error) => console.error(`[qa:${view}] ${error.message}`));
        }, 1800);
      }
      if (process.env.CHATSWITCH_QA_SCENARIO === "open-recorded-niubi") {
        setTimeout(() => {
          if (window.isDestroyed() || window.webContents.isDestroyed()) return;
          window.webContents.executeJavaScript(`(async () => {
            const target = [...document.querySelectorAll('.thread-item')].find((item) => item.querySelector('small')?.textContent.startsWith('niubi'));
            if (!target) throw new Error('No Niubi-recorded thread found.');
            target.click();
            await new Promise((resolve) => setTimeout(resolve, 3000));
          })()`).catch((error) => console.error(`[qa:open-recorded-niubi] ${error.message}`));
        }, 1800);
      }
      if (process.env.CHATSWITCH_QA_SCENARIO === "account-panel") {
        setTimeout(() => {
          if (window.isDestroyed() || window.webContents.isDestroyed()) return;
          window.webContents.executeJavaScript(`document.querySelector('#provider-switch').click()`)
            .catch((error) => console.error(`[qa:account-panel] ${error.message}`));
        }, 3500);
      }
      if (process.env.CHATSWITCH_QA_SCENARIO === "rename-dialog") {
        setTimeout(() => {
          if (window.isDestroyed() || window.webContents.isDestroyed()) return;
          window.webContents.executeJavaScript(`(() => {
            const more = document.querySelector('.thread-item .thread-more');
            if (!more) throw new Error('No thread available for rename dialog QA.');
            more.click();
            document.querySelector('#thread-menu [data-action="rename"]').click();
          })()`)
            .catch((error) => console.error(`[qa:rename-dialog] ${error.message}`));
        }, 3500);
      }
      if (process.env.CHATSWITCH_QA_SCENARIO === "claude-model-fallback") {
        setTimeout(() => {
          if (window.isDestroyed() || window.webContents.isDestroyed()) return;
          window.webContents.executeJavaScript(`document.querySelector('[data-provider="claude"]').click()`)
            .catch((error) => console.error(`[qa:claude-model-fallback] ${error.message}`));
        }, 1800);
      }
      if (process.env.CHATSWITCH_QA_SCENARIO === "relay-form") {
        setTimeout(() => {
          if (window.isDestroyed() || window.webContents.isDestroyed()) return;
          window.webContents.executeJavaScript(`(async () => {
            try {
              document.querySelector('#add-connection-button').click();
              const form = document.querySelector('#relay-form');
              form.elements.label.value = 'QA Relay Form';
              form.elements.baseUrl.value = 'https://relay.example/v1';
              const modelSelect = form.elements.model;
              window.chatSwitchState.probedProviderModels = ['gpt-test'];
              modelSelect.replaceChildren(new Option('gpt-test', 'gpt-test'));
              modelSelect.disabled = false;
              modelSelect.value = 'gpt-test';
              form.elements.apiKey.value = 'chatswitch-relay-qa-key';
              form.requestSubmit();
              const started = Date.now();
              while (Date.now() - started < 10000) {
                const option = [...document.querySelectorAll('.provider-option strong')]
                  .find((node) => node.textContent === 'QA Relay Form');
                const error = document.querySelector('#connection-error').textContent.trim();
                if (option && !error) {
                  const providerOption = option.closest('.provider-option');
                  const providerId = providerOption.dataset.provider;
                  while (Date.now() - started < 10000
                    && !document.querySelector('#connection-overlay').classList.contains('hidden')) {
                    await new Promise((resolve) => setTimeout(resolve, 50));
                  }
                  const formReset = ['id', 'label', 'baseUrl', 'model', 'apiKey']
                    .every((name) => !form.elements[name].value);
                  document.querySelector('[data-provider-row="' + CSS.escape(providerId) + '"] .provider-configure').click();
                  form.elements.label.value = 'QA Relay Edited';
                  form.requestSubmit();
                  while (Date.now() - started < 10000) {
                    if ([...document.querySelectorAll('.provider-option strong')]
                      .some((node) => node.textContent === 'QA Relay Edited')) break;
                    await new Promise((resolve) => setTimeout(resolve, 100));
                  }
                  document.querySelector('[data-provider-row="' + CSS.escape(providerId) + '"] .provider-delete').click();
                  while (Date.now() - started < 10000
                    && document.querySelector('#confirmation-overlay').classList.contains('hidden')) {
                    await new Promise((resolve) => setTimeout(resolve, 50));
                  }
                  document.querySelector('#confirmation-confirm').click();
                  while (Date.now() - started < 10000) {
                    if (!document.querySelector('[data-provider-row="' + CSS.escape(providerId) + '"]')) {
                      window.__relayFormQa = {
                        providerId,
                        providerAdded: true,
                        providerEdited: true,
                        formReset,
                        providerDeleted: true,
                        error: null
                      };
                      return;
                    }
                    await new Promise((resolve) => setTimeout(resolve, 100));
                  }
                  window.__relayFormQa = {
                    fatal: 'Timed out waiting for relay deletion.'
                  };
                  return;
                }
                if (error) throw new Error(error);
                await new Promise((resolve) => setTimeout(resolve, 100));
              }
              throw new Error('Timed out waiting for relay form submission.');
            } catch (error) {
              window.__relayFormQa = { fatal: error.message };
            }
          })()`).catch((error) => console.error(`[qa:relay-form] ${error.message}`));
        }, 1800);
      }
      if (process.env.CHATSWITCH_QA_SCENARIO === "model-settings") {
        setTimeout(() => {
          if (window.isDestroyed() || window.webContents.isDestroyed()) return;
          window.webContents.executeJavaScript(`(async () => {
            const waitUntil = async (predicate, timeout = 10000) => {
              const started = Date.now();
              while (Date.now() - started < timeout) {
                if (predicate()) return;
                await new Promise((resolve) => setTimeout(resolve, 100));
              }
              throw new Error('Timed out waiting for renderer state.');
            };
            try {
              await waitUntil(() => document.querySelector('.thread-item'));
              const firstThread = document.querySelector('.thread-item');
              if (!firstThread) throw new Error('No thread available for model settings QA.');
              const title = firstThread.querySelector('strong').textContent;
              firstThread.click();
              await waitUntil(() => (
                document.querySelector('.thread-item.active')?.querySelector('strong')?.textContent === title
                && !document.querySelector('#session-model').disabled
                && !document.querySelector('#chat-view').classList.contains('hidden')
              ));
              await new Promise((resolve) => setTimeout(resolve, 800));
              const model = document.querySelector('#session-model');
              const effort = document.querySelector('#session-effort');
              const alternative = [...model.options].find((option) => option.value !== model.value);
              if (!alternative) throw new Error('No alternative model is available.');
              model.value = alternative.value;
              model.dispatchEvent(new Event('change', { bubbles: true }));
              const preferredEffort = [...effort.options].find((option) => option.value === 'high')
                || [...effort.options].find((option) => option.value !== effort.value);
              if (preferredEffort) {
                effort.value = preferredEffort.value;
                effort.dispatchEvent(new Event('change', { bubbles: true }));
              }
              const autoApproval = document.querySelector('[data-approval-mode="auto"]');
              document.querySelector('#mode-badge').click();
              autoApproval.click();
              const expected = { model: model.value, effort: effort.value, approvalMode: 'auto' };
              await new Promise((resolve) => setTimeout(resolve, 900));
              document.querySelector('#new-chat-button').click();
              await waitUntil(() => document.querySelector('#chat-view').classList.contains('hidden'));
              const target = [...document.querySelectorAll('.thread-item')]
                .find((item) => item.querySelector('strong')?.textContent === title);
              if (!target) throw new Error('The selected thread disappeared.');
              target.click();
              await waitUntil(() => (
                document.querySelector('.thread-item.active')?.querySelector('strong')?.textContent === title
                && model.value === expected.model
                && effort.value === expected.effort
                && autoApproval.classList.contains('active')
              ));
              await new Promise((resolve) => setTimeout(resolve, 1200));
              if (model.value !== expected.model || effort.value !== expected.effort || !autoApproval.classList.contains('active')) {
                throw new Error('Session settings changed again after restoration.');
              }
              document.querySelector('#mode-badge').click();
              const composer = document.querySelector('.composer');
              window.__modelSettingsQa = {
                expected,
                restored: { model: model.value, effort: effort.value, approvalMode: 'auto' },
                applied: document.querySelector('#applied-settings').textContent,
                approvalMenuVisible: !document.querySelector('#approval-mode-menu').classList.contains('hidden'),
                modeVisible: document.querySelector('#mode-badge').offsetParent !== null,
                composerOverflow: composer.scrollWidth > composer.clientWidth,
                title: document.querySelector('#window-thread-title').textContent,
                error: null
              };
            } catch (error) {
              window.__modelSettingsQa = { fatal: error.message };
            }
          })()`).catch((error) => console.error(`[qa:model-settings] ${error.message}`));
        }, 3000);
      }
      if (process.env.CHATSWITCH_QA_SCENARIO === "thread-actions") {
        setTimeout(() => {
          if (window.isDestroyed() || window.webContents.isDestroyed()) return;
          window.webContents.executeJavaScript(`(async () => {
            const waitUntil = async (predicate, timeout = 10000) => {
              const started = Date.now();
              while (Date.now() - started < timeout) {
                if (predicate()) return;
                await new Promise((resolve) => setTimeout(resolve, 100));
              }
              throw new Error('Timed out waiting for renderer state.');
            };
            const count = (id) => Number(document.querySelector(id).textContent);
            try {
              await waitUntil(() => document.querySelector('.thread-item'));
              const target = [...document.querySelectorAll('.thread-item')].at(-1);
              const threadId = target.dataset.threadId;
              const title = target.querySelector('strong').textContent;
              const before = {
                active: count('#active-thread-count'),
                removed: count('#removed-thread-count')
              };
              target.querySelector('.thread-more').click();
              document.querySelector('#thread-menu [data-action="remove"]').click();
              await waitUntil(() => !document.querySelector('#confirmation-overlay').classList.contains('hidden'));
              document.querySelector('#confirmation-confirm').click();
              await waitUntil(() => (
                count('#active-thread-count') === before.active - 1
                && count('#removed-thread-count') === before.removed + 1
              ));
              document.querySelector('[data-thread-view="removed"]').click();
              await waitUntil(() => document.querySelector('.thread-item[data-thread-id="' + CSS.escape(threadId) + '"]'));
              const removedTarget = document.querySelector('.thread-item[data-thread-id="' + CSS.escape(threadId) + '"]');
              removedTarget.querySelector('.thread-more').click();
              document.querySelector('#thread-menu [data-action="restore"]').click();
              await waitUntil(() => (
                count('#active-thread-count') === before.active
                && count('#removed-thread-count') === before.removed
              ));
              document.querySelector('[data-thread-view="active"]').click();
              await waitUntil(() => document.querySelector('.thread-item[data-thread-id="' + CSS.escape(threadId) + '"]'));
              const activeTarget = document.querySelector('.thread-item[data-thread-id="' + CSS.escape(threadId) + '"]');
              activeTarget.querySelector('.thread-more').click();
              document.querySelector('#thread-menu [data-action="remove"]').click();
              await waitUntil(() => !document.querySelector('#confirmation-overlay').classList.contains('hidden'));
              document.querySelector('#confirmation-confirm').click();
              await waitUntil(() => (
                count('#active-thread-count') === before.active - 1
                && count('#removed-thread-count') === before.removed + 1
              ));
              document.querySelector('[data-thread-view="removed"]').click();
              await waitUntil(() => document.querySelector('.thread-item[data-thread-id="' + CSS.escape(threadId) + '"]'));
              const pendingTarget = document.querySelector('.thread-item[data-thread-id="' + CSS.escape(threadId) + '"]');
              pendingTarget.querySelector('.thread-more').click();
              document.querySelector('#thread-menu [data-action="delete-now"]').click();
              await waitUntil(() => !document.querySelector('#confirmation-overlay').classList.contains('hidden'));
              document.querySelector('#confirmation-confirm').click();
              await waitUntil(() => (
                count('#active-thread-count') === before.active - 1
                && count('#removed-thread-count') === before.removed
              ));
              window.__threadActionsQa = {
                threadId,
                title,
                before,
                after: {
                  active: count('#active-thread-count'),
                  removed: count('#removed-thread-count')
                },
                restored: true,
                immediateDeleted: true
              };
            } catch (error) {
              window.__threadActionsQa = { fatal: error.message };
            }
          })()`).catch((error) => console.error(`[qa:thread-actions] ${error.message}`));
        }, 3000);
      }
      setTimeout(async () => {
        if (window.isDestroyed() || window.webContents.isDestroyed()) return;
        try {
          window.show();
          if (window.isMinimized()) window.restore();
          window.focus();
          await new Promise((resolve) => setTimeout(resolve, 250));
          const image = await window.webContents.capturePage();
          const png = image.toPNG();
          if (!png.length) throw new Error("capturePage returned an empty image.");
          fs.writeFileSync(process.env.CHATSWITCH_QA_SCREENSHOT, png);
          const summary = await window.webContents.executeJavaScript(`({
            title: document.title,
            text: document.body.innerText.slice(0, 800),
            width: innerWidth,
            height: innerHeight,
            images: [...document.querySelectorAll('#chat-view img')].map((node) => ({ complete: node.complete, naturalWidth: node.naturalWidth, alt: node.alt })),
            view: {
              selected: document.querySelector('[data-thread-view].active')?.dataset.threadView || null,
              title: document.querySelector('#window-thread-title').textContent,
              chatHidden: document.querySelector('#chat-view').classList.contains('hidden'),
              composerDisabled: document.querySelector('#composer-input').disabled
            },
            provider: {
              name: document.querySelector('#provider-name').textContent,
              state: document.querySelector('#provider-state').textContent
            },
            recordHome: state.recordHome,
            approval: {
              hidden: document.querySelector('#approval-banner').classList.contains('hidden'),
              text: document.querySelector('#approval-banner').innerText,
              inputs: [...document.querySelectorAll('#approval-banner input, #approval-banner select')].map((node) => ({ type: node.type, name: node.name, required: node.required }))
            },
            claudeConfig: {
              visible: !document.querySelector('#claude-overlay').classList.contains('hidden'),
              status: document.querySelector('#claude-model-status').textContent,
              optionCount: document.querySelector('#claude-model').options.length,
              selectedModel: document.querySelector('#claude-model').value
            },
            relayForm: window.__relayFormQa || null,
            modelSettings: window.__modelSettingsQa || null,
            threadActions: window.__threadActionsQa || null,
            deepLinkImport: {
              visible: !document.querySelector('#deep-link-import-overlay').classList.contains('hidden'),
              title: document.querySelector('#import-preview-title').textContent,
              rows: document.querySelectorAll('#import-preview-details .import-preview-row').length,
              safety: document.querySelector('.import-safety-note').textContent,
              confirmDisabled: document.querySelector('#import-preview-confirm-button').disabled
            }
          })`);
          summary.windowCount = BrowserWindow.getAllWindows().length;
          console.log(JSON.stringify(summary));
        } catch (error) {
          console.error(`[qa] ${error.message}`);
        } finally {
          for (const server of servers.values()) server.stop();
          setTimeout(() => app.exit(0), 50);
        }
      }, Number(process.env.CHATSWITCH_QA_DELAY || 3500));
    });
  }
  window.on("closed", () => {
    if (lastActiveWindow === window) lastActiveWindow = null;
    const server = servers.get(webContentsId);
    if (server) {
      failScheduledTasksForServer(server, "任务窗口已关闭。");
      server.rendererEventBatcher?.stop(false);
      server.stop();
    }
    servers.delete(webContentsId);
    connectionAttempts.delete(webContentsId);
    nextConnectionGeneration(webContentsId);
  });
  return window;
}

function activeAppWindow() {
  if (lastActiveWindow && !lastActiveWindow.isDestroyed()) return lastActiveWindow;
  return BrowserWindow.getAllWindows().find((window) => !window.isDestroyed()) || null;
}

function showAppWindow() {
  const window = activeAppWindow() || createWindow();
  if (window.isMinimized()) window.restore();
  applyWindowIdentity(window);
  window.show();
  window.focus();
  lastActiveWindow = window;
  return window;
}

function navigateApp(payload) {
  const window = showAppWindow();
  const send = () => {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send("app:navigate", payload);
    }
  };
  if (window.webContents.isLoadingMainFrame()) window.webContents.once("did-finish-load", send);
  else send();
}

function openDeepLink(rawLink) {
  const link = parseChatSwitchLink(rawLink);
  if (!link) return false;
  if (!providerStore) {
    pendingDeepLinks.push(rawLink);
    return true;
  }
  if (link.action === "extensions") {
    navigateApp({ action: "extensions", tab: link.tab });
    return true;
  }
  if (link.action === "scheduled") {
    navigateApp({ view: "scheduled" });
    return true;
  }
  if (link.action === "import") {
    navigateApp({ action: "import-preview", importType: link.importType, config: link.config });
    return true;
  }
  const provider = link.provider && providerStore.list().some((item) => item.id === link.provider)
    ? link.provider
    : null;
  const project = link.projectId
    ? providerStore.listProjects().find((item) => item.id === link.projectId)
    : null;
  let workspace = project?.root || null;
  if (link.workspace) {
    try {
      if (fs.existsSync(link.workspace) && fs.statSync(link.workspace).isDirectory()) workspace = path.resolve(link.workspace);
    } catch {}
  }
  createWindow(
    provider,
    project?.root || null,
    link.action === "open" ? link.thread : null,
    project?.id || null,
    workspace,
  );
  return true;
}

function refreshTrayMenu() {
  if (!tray || !providerStore) return;
  const providers = providerStore.list();
  const tasks = providerStore.scheduledTasks();
  const runningCount = runningScheduledTasks.size;
  const enabledCount = tasks.filter((task) => task.enabled).length;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "显示 ChatSwitch", click: () => showAppWindow() },
    { label: "新会话", click: () => navigateApp({ action: "new-chat" }) },
    {
      label: `连接 (${providers.length})`,
      submenu: providers.map((provider) => ({
        label: provider.connectionLabel || provider.label,
        click: () => createWindow(provider.id),
      })),
    },
    {
      label: `已安排 (${enabledCount}${runningCount ? ` · ${runningCount} 运行中` : ""})`,
      click: () => navigateApp({ view: "scheduled" }),
    },
    { type: "separator" },
    {
      label: "退出 ChatSwitch",
      click: () => {
        quitting = true;
        for (const window of BrowserWindow.getAllWindows()) window.destroy();
        app.quit();
      },
    },
  ]));
}

async function createTray() {
  if (tray || process.env.CHATSWITCH_QA_SCREENSHOT) return;
  const icon = !app.isPackaged && fs.existsSync(DEVELOPMENT_ICON)
    ? nativeImage.createFromPath(DEVELOPMENT_ICON).resize({ width: 32, height: 32, quality: "best" })
    : await app.getFileIcon(process.execPath, { size: "small" });
  tray = new Tray(icon);
  tray.setToolTip("ChatSwitch");
  tray.on("click", () => showAppWindow());
  refreshTrayMenu();
}

function waitForQa(predicate, timeoutMs = 15000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const poll = async () => {
      try {
        const value = await predicate();
        if (value) return resolve(value);
      } catch {}
      if (Date.now() - startedAt >= timeoutMs) return reject(new Error(`QA condition timed out after ${timeoutMs} ms.`));
      setTimeout(poll, 100);
    };
    poll();
  });
}

async function waitForQaStep(label, predicate, timeoutMs = 15000) {
  try {
    return await waitForQa(predicate, timeoutMs);
  } catch (error) {
    throw new Error(`${label}: ${error.message}`);
  }
}

async function captureQaWindow(window, outputDirectory, filename) {
  if (!outputDirectory) return null;
  fs.mkdirSync(outputDirectory, { recursive: true });
  window.show();
  if (window.isMinimized()) window.restore();
  window.focus();
  await new Promise((resolve) => setTimeout(resolve, 250));
  const image = await window.webContents.capturePage();
  const buffer = image.toPNG();
  if (!buffer.length) throw new Error(`QA screenshot ${filename} was empty.`);
  const target = path.join(outputDirectory, filename);
  fs.writeFileSync(target, buffer);
  return target;
}

async function rendererWindowSummary(window) {
  return window.webContents.executeJavaScript(`({
    providerName: document.querySelector('#provider-name').textContent,
    providerBrand: document.querySelector('#provider-mark img')?.alt || null,
    providerState: document.querySelector('#provider-state').textContent,
    connection: document.querySelector('#connection-badge').textContent.trim(),
    threadCount: Number(document.querySelector('#active-thread-count').textContent || 0),
    overlayHidden: document.querySelector('#provider-overlay').classList.contains('hidden'),
    credentialVisible: !document.querySelector('#credential-overlay').classList.contains('hidden'),
    connectionConfigVisible: !document.querySelector('#connection-overlay').classList.contains('hidden'),
    relayApiKeyValue: document.querySelector('#relay-form [name="apiKey"]')?.value || '',
    relayApiKeyRequired: Boolean(document.querySelector('#relay-form [name="apiKey"]')?.required),
    relayApiKeyHelp: document.querySelector('#provider-api-key-help')?.textContent.trim() || '',
    claudeConfigVisible: !document.querySelector('#claude-overlay').classList.contains('hidden'),
    recordHomeVisible: !document.querySelector('#record-home-overlay').classList.contains('hidden'),
    projectConfigVisible: !document.querySelector('#project-overlay').classList.contains('hidden'),
    closeProviderHidden: document.querySelector('#close-provider-button').classList.contains('hidden'),
    providerError: document.querySelector('#provider-error').textContent.trim(),
    modelOptionCount: document.querySelector('#session-model').options.length,
    selectedModel: document.querySelector('#session-model').value,
    selectedEffort: document.querySelector('#session-effort').value,
    modelDisabled: document.querySelector('#session-model').disabled
  })`);
}

async function runMultiProviderWindowQa(firstWindow) {
  const outputDirectory = process.env.CHATSWITCH_QA_OUTPUT_DIR;
  try {
    await waitForQaStep("first window official connection", async () => {
      if (servers.get(firstWindow.webContents.id)?.provider.id !== "official") return false;
      const summary = await rendererWindowSummary(firstWindow);
      return summary.connection.includes("已连接") && summary.overlayHidden;
    }, 30000);
    await firstWindow.webContents.executeJavaScript(`document.querySelector('#provider-switch').click()`);
    await waitForQaStep("provider chooser can be opened", async () => {
      const summary = await rendererWindowSummary(firstWindow);
      return !summary.overlayHidden && !summary.closeProviderHidden;
    });
    await captureQaWindow(firstWindow, outputDirectory, "provider-connections.png");
    await firstWindow.webContents.executeJavaScript(`document.querySelector('[data-provider="claude"]').click()`);
    await waitForQaStep("Claude configuration can be opened", async () => (await rendererWindowSummary(firstWindow)).claudeConfigVisible);
    await captureQaWindow(firstWindow, outputDirectory, "claude-config.png");
    await firstWindow.webContents.executeJavaScript(`document.querySelector('#claude-close-button').click()`);
    await waitForQaStep("Claude configuration can return", async () => {
      const summary = await rendererWindowSummary(firstWindow);
      return !summary.claudeConfigVisible && !summary.overlayHidden;
    });
    await firstWindow.webContents.executeJavaScript(`document.querySelector('#record-home-button').click()`);
    await waitForQaStep("record home configuration can be opened", async () => (await rendererWindowSummary(firstWindow)).recordHomeVisible);
    await captureQaWindow(firstWindow, outputDirectory, "record-home.png");
    await firstWindow.webContents.executeJavaScript(`document.querySelector('#record-home-close-button').click()`);
    await waitForQaStep("record home configuration can return", async () => {
      const summary = await rendererWindowSummary(firstWindow);
      return !summary.recordHomeVisible && !summary.overlayHidden;
    });
    await firstWindow.webContents.executeJavaScript(`document.querySelector('#close-provider-button').click()`);
    await waitForQaStep("provider chooser can return", async () => (await rendererWindowSummary(firstWindow)).overlayHidden);
    await firstWindow.webContents.executeJavaScript(`document.querySelector('#add-project-button').click()`);
    await waitForQaStep("rootless project dialog can be opened", async () => {
      const summary = await rendererWindowSummary(firstWindow);
      return summary.projectConfigVisible;
    });
    const projectDialog = await firstWindow.webContents.executeJavaScript(`({
      nameRequired: document.querySelector('#project-name-input').required,
      rootRequired: document.querySelector('#project-root-input').required,
      rootValue: document.querySelector('#project-root-input').value,
      note: document.querySelector('#project-form .form-note').textContent
    })`);
    if (!projectDialog.nameRequired || projectDialog.rootRequired || projectDialog.rootValue) {
      throw new Error("Rootless Project dialog fields are invalid.");
    }
    await captureQaWindow(firstWindow, outputDirectory, "project-create.png");
    await firstWindow.webContents.executeJavaScript(`document.querySelector('#project-close-button').click()`);
    await waitForQaStep("rootless project dialog can return", async () => !(await rendererWindowSummary(firstWindow)).projectConfigVisible);
    await firstWindow.webContents.executeJavaScript(`document.querySelector('#new-window-button').click()`);
    const secondWindow = await waitForQaStep("second window creation", () => BrowserWindow.getAllWindows().find((item) => item !== firstWindow));
    await waitForQaStep("second window inherited official", async () => {
      if (servers.get(secondWindow.webContents.id)?.provider.id !== "official") return false;
      const summary = await rendererWindowSummary(secondWindow);
      return summary.connection.includes("已连接") && summary.overlayHidden;
    }, 30000);

    await secondWindow.webContents.executeJavaScript(`document.querySelector('[data-provider="hexuan"]').click()`);
    await waitForQaStep("second window switched to hexuan", () => servers.get(secondWindow.webContents.id)?.provider.id === "hexuan");
    await waitForQaStep("all renderer windows ready", async () => {
      const summaries = await Promise.all([firstWindow, secondWindow].map(rendererWindowSummary));
      return summaries.every((summary) => summary.connection.includes("已连接"));
    }, 30000);

    await firstWindow.webContents.executeJavaScript(`document.querySelector('#new-window-button').click()`);
    const unavailableWindow = await waitForQaStep("unavailable provider window creation", () => BrowserWindow.getAllWindows().find((item) => item !== firstWindow && item !== secondWindow));
    await waitForQaStep("unavailable provider window inherited official", async () => {
      const summary = await rendererWindowSummary(unavailableWindow);
      return servers.get(unavailableWindow.webContents.id)?.provider.id === "official" && summary.connection.includes("已连接");
    }, 30000);
    await unavailableWindow.webContents.executeJavaScript(`document.querySelector('[data-provider="niubi"]').click()`);
    const unavailableSummary = await waitForQaStep("missing NIUBI key opens configuration", async () => {
      const summary = await rendererWindowSummary(unavailableWindow);
      return summary.connectionConfigVisible
        && !summary.relayApiKeyValue
        && summary.relayApiKeyRequired
        && summary.relayApiKeyHelp.includes("尚未配置可用的 API Key")
        && summary.connection.includes("已连接")
        && servers.get(unavailableWindow.webContents.id)?.provider.id === "official"
        ? summary
        : false;
    });
    unavailableWindow.destroy();
    await waitForQaStep("unavailable provider window closed", () => BrowserWindow.getAllWindows().length === 2);

    const windows = [firstWindow, secondWindow];
    const summaries = await Promise.all(windows.map(rendererWindowSummary));
    if (outputDirectory) {
      for (let index = 0; index < windows.length; index += 1) {
        await captureQaWindow(windows[index], outputDirectory, `multi-window-${index + 1}.png`);
      }
    }
    console.log(JSON.stringify({
      ok: true,
      appUserModelId: WINDOWS_APP_ID,
      runtimeIconAvailable: Boolean(applicationIcon()),
      windowCount: windows.length,
      serverCount: servers.size,
      providerReturn: true,
      claudeConfigurationReturn: true,
      recordHomeReturn: true,
      projectConfigurationReturn: true,
      unavailableProviderError: unavailableSummary.relayApiKeyHelp,
      unavailableCredentialVisible: unavailableSummary.connectionConfigVisible,
      unavailableConnection: unavailableSummary.connection,
      internalProviders: windows.map((window) => servers.get(window.webContents.id)?.provider.id || null),
      windows: summaries,
    }));
  } catch (error) {
    console.error(`[qa:multi-provider-windows] ${error.stack || error.message}`);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
}

function serverFor(event) {
  const server = servers.get(event.sender.id);
  if (!server?.ready) throw new Error("请先在 ChatSwitch 中选择连接。");
  return server;
}

function serverEngine(server) {
  return server?.provider?.engine || "codex";
}

function sharedHistoryReaders() {
  const home = providerStore.conversationHome();
  if (sharedHistoryHome !== home || !sharedCompatibleHistory || !sharedClaudeHistory) {
    sharedHistoryHome = home;
    sharedCompatibleHistory = new OpenAICompatibleServer({
      id: "chatswitch-history",
      label: "ChatSwitch History",
      baseUrl: "https://history.invalid/v1",
      model: "history",
      apiKey: "history-reader",
      codexHome: home,
    }, net.fetch);
    sharedClaudeHistory = new ClaudeServer(providerStore.resolve("claude"));
  }
  return { compatible: sharedCompatibleHistory, claude: sharedClaudeHistory };
}

function historySources(server) {
  const currentEngine = serverEngine(server);
  const readers = sharedHistoryReaders();
  const sources = [{ engine: currentEngine, reader: server }];
  if (currentEngine !== "openai-compatible") {
    sources.push({ engine: "openai-compatible", reader: readers.compatible });
  }
  if (currentEngine !== "claude") sources.push({ engine: "claude", reader: readers.claude });
  return sources;
}

function currentProviderId(server) {
  return String(server?.provider?.id || "").trim();
}

function rememberNativeThread(server, threadId) {
  const id = String(threadId || "").trim();
  if (!id) return;
  let threads = serverNativeThreads.get(server);
  if (!threads) {
    threads = new Set();
    serverNativeThreads.set(server, threads);
  }
  threads.add(id);
}

function isRememberedNativeThread(server, threadId) {
  const id = String(threadId || "").trim();
  return Boolean(id && serverNativeThreads.get(server)?.has(id));
}

function eventBranchForServer(server, nativeThreadId) {
  const branchId = String(nativeThreadId || "").trim();
  if (!branchId) return { logicalId: null, branch: null };
  let lookup = serverBranchLookups.get(server);
  if (!lookup) {
    lookup = new Map();
    serverBranchLookups.set(server, lookup);
  }
  if (lookup.has(branchId)) return lookup.get(branchId);
  const providerId = currentProviderId(server);
  const logicalId = providerStore.logicalThreadIdForBranch(providerId, branchId);
  const value = {
    logicalId,
    branch: logicalId ? providerStore.threadBranch(logicalId, providerId) : null,
  };
  lookup.set(branchId, value);
  return value;
}

function rememberEventBranch(server, logicalId, branch) {
  if (!branch?.threadId) return;
  let lookup = serverBranchLookups.get(server);
  if (!lookup) {
    lookup = new Map();
    serverBranchLookups.set(server, lookup);
  }
  lookup.set(branch.threadId, { logicalId, branch: { ...branch } });
}

function logicalThreadId(server, nativeThreadId) {
  return providerStore.logicalThreadIdForBranch(currentProviderId(server), nativeThreadId)
    || providerStore.logicalThreadIdForAnyBranch(nativeThreadId)
    || nativeThreadId;
}

function branchForServer(server, logicalId) {
  return providerStore.threadBranch(logicalId, currentProviderId(server));
}

function threadIsNativeToServer(server, thread, sourceEngine) {
  const engine = serverEngine(server);
  if (sourceEngine !== engine) return false;
  if (engine !== "openai-compatible") return true;
  return thread?.modelProvider === currentProviderId(server);
}

async function readLogicalBaseThread(server, requestedThreadId) {
  const targetId = providerStore.logicalThreadIdForAnyBranch(requestedThreadId) || requestedThreadId;
  let lastError = null;
  for (const { engine, reader } of historySources(server)) {
    try {
      const response = await reader.readThread(targetId);
      const sourceEngine = response.thread?._historyEngine || engine;
      return {
        ...response,
        thread: { ...response.thread, _historyEngine: sourceEngine },
        sourceEngine,
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("未找到共享会话记录。");
}

async function readBranchThread(server, providerId, branch) {
  const readers = sharedHistoryReaders();
  const reader = providerId === currentProviderId(server)
    ? server
    : branch.engine === "claude" ? readers.claude : readers.compatible;
  const response = await reader.readThread(branch.threadId);
  return response.thread;
}

async function logicalBranchThreads(server, logicalId) {
  const allBranches = providerStore.threadBranches()[logicalId] || {};
  const labels = new Map(providerStore.list().map((provider) => [provider.id, provider.connectionLabel || provider.label]));
  const entries = await Promise.all(Object.entries(allBranches).map(async ([providerId, branch]) => {
    try {
      return {
        providerId,
        metadata: branch,
        thread: await readBranchThread(server, providerId, branch),
        label: labels.get(providerId) || providerId,
      };
    } catch (error) {
      console.error(`[shared-branch:${providerId}] ${error.message}`);
      return null;
    }
  }));
  return entries.filter(Boolean).sort((left, right) => (
    Number(left.metadata.createdAt) - Number(right.metadata.createdAt)
  ));
}

async function sharedListThreads(server, searchTerm = "", archived = false) {
  const results = await Promise.all(historySources(server).map(async ({ engine, reader }) => {
    try {
      const response = await reader.listThreads(searchTerm, archived);
      return (response.data || []).map((thread) => ({
        ...thread,
        _historyEngine: thread._historyEngine || engine,
      }));
    } catch (error) {
      console.error(`[shared-history:${engine}] ${error.message}`);
      return [];
    }
  }));
  const merged = new Map();
  const branchIds = new Set(providerStore.branchThreadIds());
  for (const threads of results) {
    for (const thread of threads) {
      if (branchIds.has(thread.id)) continue;
      if (!merged.has(thread.id)) merged.set(thread.id, thread);
    }
  }
  const branches = providerStore.threadBranches();
  for (const [logicalId, thread] of merged) {
    const branchUpdatedAt = Math.max(0, ...Object.values(branches[logicalId] || {}).map((branch) => (
      Number(branch.updatedAt) > 1e12 ? Number(branch.updatedAt) / 1000 : Number(branch.updatedAt) || 0
    )));
    if (branchUpdatedAt > Number(thread.recencyAt || thread.updatedAt || 0)) {
      merged.set(logicalId, { ...thread, updatedAt: branchUpdatedAt, recencyAt: branchUpdatedAt });
    }
  }
  const data = [...merged.values()].sort((left, right) => (
    Number(right.recencyAt || right.updatedAt) - Number(left.recencyAt || left.updatedAt)
  ));
  return { data, nextCursor: null, backwardsCursor: null };
}

async function sharedReadThread(server, threadId) {
  const targetId = providerStore.logicalThreadIdForAnyBranch(threadId) || threadId;
  const response = await readLogicalBaseThread(server, targetId);
  return assembleSharedThread(server, targetId, response);
}

async function assembleSharedThread(server, targetId, response) {
  const branches = await logicalBranchThreads(server, targetId);
  const merged = branches.length
    ? mergeLogicalThread(response.thread, branches, providerStore.threadTimeline(targetId))
    : { ...response.thread, _crossModelReadOnly: false };
  return {
    ...response,
    thread: {
      ...merged,
      id: targetId,
      _historyEngine: response.sourceEngine,
      _nativeForCurrentProvider: threadIsNativeToServer(server, response.thread, response.sourceEngine),
    },
  };
}

function searchableThreadText(thread) {
  const parts = [thread?.name || thread?.title || ""];
  for (const turn of thread?.turns || []) {
    for (const item of turn.items || []) {
      if (item.type === "userMessage") {
        for (const content of item.content || []) if (content?.type === "text") parts.push(content.text || "");
      } else if (item.type === "agentMessage" || item.type === "plan") {
        parts.push(item.text || "");
      } else if (item.type === "reasoning") {
        for (const summary of item.summary || []) parts.push(typeof summary === "string" ? summary : summary?.text || "");
      }
    }
  }
  return parts.join("\n").replace(/\s+/g, " ").trim();
}

async function searchSharedThreads(server, rawQuery) {
  const query = String(rawQuery || "").trim().toLocaleLowerCase("zh-CN").slice(0, 200);
  if (query.length < 2) return [];
  const [active, archived] = await Promise.all([
    sharedListThreads(server, "", false),
    sharedListThreads(server, "", true),
  ]);
  const merged = new Map([...active.data, ...archived.data].map((thread) => [thread.id, thread]));
  const candidates = [...merged.values()].slice(0, 250);
  const matches = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < candidates.length) {
      const index = cursor;
      cursor += 1;
      const summary = candidates[index];
      const revision = Number(summary.recencyAt || summary.updatedAt) || 0;
      const cacheKey = `${providerStore.conversationHome()}:${summary.id}`;
      let cached = sharedThreadSearchCache.get(cacheKey);
      if (!cached || cached.revision !== revision) {
        try {
          const response = await sharedReadThread(server, summary.id);
          cached = { revision, text: searchableThreadText(response.thread) };
          sharedThreadSearchCache.set(cacheKey, cached);
          while (sharedThreadSearchCache.size > 500) sharedThreadSearchCache.delete(sharedThreadSearchCache.keys().next().value);
        } catch {
          continue;
        }
      }
      const normalized = cached.text.toLocaleLowerCase("zh-CN");
      const hit = normalized.indexOf(query);
      if (hit < 0) continue;
      const start = Math.max(0, hit - 45);
      const end = Math.min(cached.text.length, hit + query.length + 90);
      matches.push({
        id: summary.id,
        snippet: `${start ? "..." : ""}${cached.text.slice(start, end)}${end < cached.text.length ? "..." : ""}`,
        rank: index,
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, worker));
  return matches.sort((left, right) => left.rank - right.rank).slice(0, 80).map(({ rank, ...match }) => match);
}

function rememberActiveLogicalTurn(server, input) {
  const record = { ...input, server };
  activeLogicalTurns.set(record.logicalId, record);
  activeLogicalTurnsById.set(record.turnId, record);
}

function forgetActiveLogicalTurn(turnId) {
  const record = activeLogicalTurnsById.get(turnId);
  if (!record) return null;
  activeLogicalTurnsById.delete(turnId);
  if (activeLogicalTurns.get(record.logicalId)?.turnId === turnId) activeLogicalTurns.delete(record.logicalId);
  return record;
}

function interruptActiveLogicalTurns(server, reason) {
  let changed = false;
  const recoveredAt = Date.now();
  for (const record of [...activeLogicalTurnsById.values()]) {
    if (record.server !== server) continue;
    providerStore.recordLogicalTurn(record.logicalId, {
      turnId: record.turnId,
      nativeThreadId: record.nativeThreadId,
      providerId: record.providerId,
      engine: record.engine,
      status: "interrupted",
      interruptionReason: reason || "server-exit",
      recoveredAt,
    });
    forgetActiveLogicalTurn(record.turnId);
    changed = true;
  }
  if (changed) broadcastStoreSnapshot();
}

function mappedServerMessage(server, message) {
  let nativeId = message?.params?.threadId
    || message?.params?.conversationId
    || message?.params?.thread?.id
    || null;
  const eventTurnId = message?.params?.turn?.id || message?.params?.turnId || null;
  const activeTurn = eventTurnId ? activeLogicalTurnsById.get(eventTurnId) || null : null;
  nativeId ||= activeTurn?.nativeThreadId || null;
  if (!nativeId) return message;
  const providerId = currentProviderId(server);
  const pendingKey = `${providerId}:${nativeId}`;
  const pending = pendingTurnDisplays.get(pendingKey) || null;
  const isUserItem = ["item/started", "item/completed"].includes(message.method)
    && message.params?.item?.type === "userMessage";
  const steerQueue = pendingSteerDisplays.get(pendingKey) || [];
  const pendingSteer = isUserItem ? steerQueue[0] || null : null;
  const pendingCreation = pendingBranchCreations.get(server) || null;
  const eventBranch = eventBranchForServer(server, nativeId);
  const logicalId = eventBranch.logicalId
    || activeTurn?.logicalId
    || pendingSteer?.logicalId
    || pending?.logicalId
    || pendingCreation?.logicalId
    || null;
  if (!logicalId) return message;
  const branch = eventBranch.logicalId === logicalId ? eventBranch.branch : null;
  if (message.method === "turn/completed") {
    providerStore.touchThreadBranch(logicalId, providerId);
    const turnId = message.params?.turn?.id;
    if (turnId) {
      providerStore.recordLogicalTurn(logicalId, {
        turnId,
        nativeThreadId: nativeId,
        providerId: currentProviderId(server),
        engine: serverEngine(server),
        status: message.params?.turn?.status || "completed",
      });
      forgetActiveLogicalTurn(turnId);
    }
  }
  const itemClientId = message.params?.item?.clientId || null;
  const visibleText = pendingSteer?.displayText ?? (pending
    && (!pending.clientUserMessageId || !itemClientId || pending.clientUserMessageId === itemClientId)
    ? pending.displayText
    : branch?.firstClientUserMessageId === itemClientId ? branch.firstUserText : null);
  const mapped = remapBranchMessage(
    message,
    nativeId,
    logicalId,
    typeof visibleText === "string" ? { firstUserText: visibleText } : null,
  );
  if (pendingSteer?.clientUserMessageId && mapped.params?.item?.type === "userMessage") {
    mapped.params.item.clientId = pendingSteer.clientUserMessageId;
  }
  if (message.method === "item/completed" && message.params?.item?.type === "userMessage" && pendingSteer) {
    steerQueue.shift();
    if (steerQueue.length) pendingSteerDisplays.set(pendingKey, steerQueue);
    else pendingSteerDisplays.delete(pendingKey);
  }
  if (message.method === "turn/completed") pendingSteerDisplays.delete(pendingKey);
  if (message.method === "turn/completed"
    || (message.method === "item/completed" && message.params?.item?.type === "userMessage")) {
    pendingTurnDisplays.delete(pendingKey);
  }
  return mapped;
}

function usageNumber(usage, ...keys) {
  for (const key of keys) {
    const value = key.split(".").reduce((current, part) => current?.[part], usage);
    if (Number.isFinite(Number(value))) return Math.max(0, Number(value));
  }
  return 0;
}

function trackProviderRequest(server, message) {
  if (!message?.method?.startsWith("turn/")) return;
  const nativeThreadId = message.params?.threadId || message.params?.conversationId || null;
  const turn = message.params?.turn || {};
  if (!nativeThreadId || !turn.id) return;
  let runs = providerRequestRuns.get(server);
  if (!runs) {
    runs = new Map();
    providerRequestRuns.set(server, runs);
  }
  const key = `${nativeThreadId}:${turn.id}`;
  if (message.method === "turn/started") {
    runs.set(key, Date.now());
    return;
  }
  if (message.method !== "turn/completed") return;
  const finishedAt = Date.now();
  const startedAt = runs.get(key) || finishedAt;
  runs.delete(key);
  const usage = turn.usage || turn.tokenUsage || {};
  const inputTokens = usageNumber(usage, "input_tokens", "inputTokens", "prompt_tokens", "input_tokens_total", "input");
  const outputTokens = usageNumber(usage, "output_tokens", "outputTokens", "completion_tokens", "output_tokens_total", "output");
  const cachedInputTokens = usageNumber(
    usage,
    "input_tokens_details.cached_tokens",
    "inputTokensDetails.cachedTokens",
    "prompt_tokens_details.cached_tokens",
    "cache_read_input_tokens",
    "cacheReadInputTokens",
  );
  try {
    providerStore.recordProviderRequest({
      providerId: turn.providerId || currentProviderId(server),
      engine: serverEngine(server),
      model: turn.model || usage.model || server.actualModel || server.provider.model,
      logicalThreadId: logicalThreadId(server, nativeThreadId),
      turnId: turn.id,
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt,
      status: turn.status,
      errorCode: turn.error?.code || null,
      errorMessage: turn.error?.message || (turn.status === "failed" ? "模型回答在完成前失败，服务端未提供详细原因。" : null),
      requestId: turn.error?.requestId || turn.requestId || null,
      finishReason: turn.error?.finishReason || turn.finishReason || null,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      totalTokens: usageNumber(usage, "total_tokens", "totalTokens") || inputTokens + outputTokens,
    });
  } catch (error) {
    console.error(`[provider-usage] ${error.message}`);
  }
}

async function resumeLogicalThread(server, payload = {}) {
  const logicalId = logicalThreadId(server, payload.threadId);
  const branch = branchForServer(server, logicalId);
  if (branch) {
    await server.resumeThread(
      branch.threadId,
      payload.cwd || null,
      payload.modelProvider || null,
      payload.model || null,
      { approvalMode: payload.approvalMode || "ask" },
    );
    return sharedReadThread(server, logicalId);
  }
  const base = await readLogicalBaseThread(server, logicalId);
  if (threadIsNativeToServer(server, base.thread, base.sourceEngine)) {
    await server.resumeThread(
      logicalId,
      payload.cwd || null,
      payload.modelProvider || null,
      payload.model || null,
      { approvalMode: payload.approvalMode || "ask" },
    );
    rememberNativeThread(server, logicalId);
  }
  return assembleSharedThread(server, logicalId, base);
}

async function startLogicalTurn(server, payload = {}) {
  const providerId = currentProviderId(server);
  const logicalId = logicalThreadId(server, payload.threadId);
  let branch = branchForServer(server, logicalId);
  let nativeThreadId = branch?.threadId || logicalId;
  let turnText = payload.text;
  const displayText = typeof payload.displayText === "string" ? payload.displayText : String(payload.text || "");
  let logical = null;

  if (!branch && !isRememberedNativeThread(server, nativeThreadId)) {
    logical = await sharedReadThread(server, logicalId);
    if (!logical.thread._nativeForCurrentProvider) {
      pendingBranchCreations.set(server, { logicalId });
      let created;
      try {
        created = await server.startThread(
          payload.cwd,
          payload.model || null,
          { approvalMode: payload.approvalMode || "ask" },
        );
        nativeThreadId = created.thread.id;
        branch = providerStore.saveThreadBranch(logicalId, providerId, nativeThreadId, {
          engine: serverEngine(server),
          sourceEngine: logical.thread._historyEngine,
          firstUserText: displayText,
          firstClientUserMessageId: payload.clientUserMessageId,
          seeded: false,
        });
        rememberEventBranch(server, logicalId, branch);
      } finally {
        pendingBranchCreations.delete(server);
      }
      turnText = buildContinuationPrompt(logical.thread, payload.text);
    } else {
      rememberNativeThread(server, nativeThreadId);
    }
  }

  const timeline = providerStore.threadTimeline(logicalId);
  let lastNativeTurnIndex = -1;
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    if (timeline[index].nativeThreadId === nativeThreadId) {
      lastNativeTurnIndex = index;
      break;
    }
  }
  const missedOtherModelTurns = timeline
    .slice(lastNativeTurnIndex + 1)
    .some((entry) => entry.nativeThreadId !== nativeThreadId);
  if ((branch && !branch.seeded) || missedOtherModelTurns) {
    logical ||= await sharedReadThread(server, logicalId);
    turnText = buildContinuationPrompt(logical.thread, payload.text);
  }
  if (branch && !branch.seeded) {
    branch = providerStore.saveThreadBranch(logicalId, providerId, nativeThreadId, {
      ...branch,
      engine: branch.engine || serverEngine(server),
      firstUserText: displayText,
      firstClientUserMessageId: payload.clientUserMessageId,
      seeded: false,
    });
    rememberEventBranch(server, logicalId, branch);
  }

  const pendingKey = `${providerId}:${nativeThreadId}`;
  pendingTurnDisplays.set(pendingKey, {
    logicalId,
    displayText,
    clientUserMessageId: payload.clientUserMessageId || null,
  });
  let result;
  try {
    result = await server.startTurn(
      nativeThreadId,
      turnText,
      payload.cwd,
      payload.clientUserMessageId,
      {
        model: payload.model || null,
        effort: payload.effort || null,
        approvalMode: payload.approvalMode || "ask",
        skillInputs: Array.isArray(payload.skillInputs) ? payload.skillInputs : [],
        imageInputs: Array.isArray(payload.imageInputs) ? payload.imageInputs : [],
        fileInputs: Array.isArray(payload.fileInputs) ? payload.fileInputs : [],
        webSearch: Boolean(payload.webSearch),
      },
    );
  } catch (error) {
    pendingTurnDisplays.delete(pendingKey);
    throw error;
  }
  if (branch) {
    branch = providerStore.saveThreadBranch(logicalId, providerId, nativeThreadId, {
      ...branch,
      engine: branch.engine || serverEngine(server),
      seeded: true,
    });
    rememberEventBranch(server, logicalId, branch);
  }
  if (result.turn?.id) {
    providerStore.recordLogicalTurn(logicalId, {
      turnId: result.turn.id,
      nativeThreadId,
      providerId,
      engine: serverEngine(server),
      startedAt: Date.now(),
      status: result.turn.status || "inProgress",
      displayText,
      clientUserMessageId: payload.clientUserMessageId,
    });
    rememberActiveLogicalTurn(server, {
      logicalId,
      turnId: result.turn.id,
      nativeThreadId,
      providerId,
      engine: serverEngine(server),
    });
  }
  return result;
}

async function steerLogicalTurn(server, payload = {}) {
  if (typeof server.steerTurn !== "function") throw new Error("当前模型连接不支持原生引导。");
  const providerId = currentProviderId(server);
  const logicalId = logicalThreadId(server, payload.threadId);
  const branch = branchForServer(server, logicalId);
  const nativeThreadId = branch?.threadId || logicalId;
  const expectedTurnId = String(payload.expectedTurnId || "").trim();
  if (!expectedTurnId) throw new Error("当前回复尚未开始，暂时无法引导。");
  const pendingKey = `${providerId}:${nativeThreadId}`;
  const pending = {
    logicalId,
    displayText: typeof payload.displayText === "string" ? payload.displayText : String(payload.text || ""),
    clientUserMessageId: payload.clientUserMessageId || null,
  };
  const queue = pendingSteerDisplays.get(pendingKey) || [];
  queue.push(pending);
  pendingSteerDisplays.set(pendingKey, queue);
  try {
    return await server.steerTurn(nativeThreadId, expectedTurnId, payload.text, {
      skillInputs: Array.isArray(payload.skillInputs) ? payload.skillInputs : [],
        imageInputs: Array.isArray(payload.imageInputs) ? payload.imageInputs : [],
        fileInputs: Array.isArray(payload.fileInputs) ? payload.fileInputs : [],
        webSearch: Boolean(payload.webSearch),
    });
  } catch (error) {
    const current = pendingSteerDisplays.get(pendingKey) || [];
    const index = current.indexOf(pending);
    if (index >= 0) current.splice(index, 1);
    if (current.length) pendingSteerDisplays.set(pendingKey, current);
    else pendingSteerDisplays.delete(pendingKey);
    if (/no active turn to steer/i.test(String(error?.message || error))) {
      return {
        steered: false,
        inactive: true,
        expectedTurnId,
      };
    }
    throw error;
  }
}

function publicStoreSnapshot() {
  const metadata = providerStore.metadata();
  return {
    openaiRuntimeAvailable: Boolean(CODEX_EXE),
    providers: providerStore.list(),
    providerPresets: providerPresetCatalog(),
    projects: metadata.projects.map(({ id, label, root, createdAt }) => ({
      id,
      label,
      root: typeof root === "string" && root ? root : null,
      createdAt,
    })),
    projectThreads: { ...metadata.projectThreads },
    hiddenProjectRoots: [...metadata.hiddenProjectRoots],
    threadSettings: { ...metadata.threadSettings },
    providerRoutes: structuredClone(metadata.providerRoutes),
    threadAliases: { ...metadata.threadAliases },
    threadDecorations: structuredClone(metadata.threadDecorations),
    hiddenThreadIds: [...metadata.hiddenThreads],
    deletedThreadIds: [...metadata.deletedThreads],
    localArchivedThreadIds: [...metadata.localArchivedThreads],
    pendingDeletions: metadata.pendingDeletions.map((entry) => ({ ...entry })),
    scheduledTasks: providerStore.scheduledTasks(),
    messageQueues: providerStore.messageQueues(),
    recoveredTurns: providerStore.recoverableInterruptedTurns(),
    promptTemplates: providerStore.promptTemplates(),
    mcpServers: providerStore.mcpServers(),
    runningTaskIds: [...runningScheduledTasks],
    recordHome: metadata.conversationHome,
  };
}

function skillLibraryRoot() {
  return path.join(providerStore.conversationHome(), "chatswitch-skill-library");
}

function activeSkillRoot() {
  return path.join(providerStore.conversationHome(), "skills");
}

function installedSkillSourceRoot() {
  return path.join(providerStore.conversationHome(), "chatswitch-installed-skill-sources");
}

async function refreshPrivateSkills() {
  if (skillRefreshPromise) return skillRefreshPromise;
  skillRefreshPromise = syncManagedSkills(
    [...skillSources, installedSkillSourceRoot()],
    skillLibraryRoot(),
    activeSkillRoot(),
    providerStore.disabledSkills(),
  );
  try {
    return await skillRefreshPromise;
  } finally {
    skillRefreshPromise = null;
  }
}

async function installPrivateSkill(input = {}) {
  const kind = ["folder", "zip", "github"].includes(input.kind) ? input.kind : null;
  const source = String(input.source || "").trim();
  if (!kind || !source) throw new Error("请选择 Skill 来源。");
  const temporaryParent = path.join(providerStore.conversationHome(), "tmp");
  fs.mkdirSync(temporaryParent, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(temporaryParent, "skill-install-"));
  let sourceDirectory = source;
  let sourceLabel = source;
  try {
    if (kind === "zip") {
      const archive = path.resolve(source);
      if (!fs.existsSync(archive) || !fs.statSync(archive).isFile() || path.extname(archive).toLowerCase() !== ".zip") {
        throw new Error("请选择有效的 ZIP Skill 包。");
      }
      const listing = await execFilePromise("tar.exe", ["-tf", archive]);
      const entries = listing.stdout.split(/\r?\n/).filter(Boolean);
      if (!entries.length || entries.length > 5000) throw new Error("ZIP Skill 包为空或文件过多。");
      for (const entry of entries) {
        const normalized = entry.replaceAll("\\", "/");
        if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)
          || normalized.split("/").some((part) => part === "..")) {
          throw new Error("ZIP Skill 包包含越界路径。");
        }
      }
      sourceDirectory = path.join(temporary, "archive");
      fs.mkdirSync(sourceDirectory, { recursive: true });
      await execFilePromise("tar.exe", ["-xf", archive, "-C", sourceDirectory]);
      sourceLabel = `ZIP · ${path.basename(archive)}`;
    } else if (kind === "github") {
      let parsed;
      try { parsed = new URL(source); } catch { parsed = null; }
      if (!parsed || parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com"
        || parsed.username || parsed.password || parsed.search || parsed.hash
        || !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?\/?$/.test(parsed.pathname)) {
        throw new Error("请输入 GitHub 仓库首页 URL。");
      }
      sourceDirectory = path.join(temporary, "repository");
      await execFilePromise("git.exe", ["clone", "--depth", "1", "--filter=blob:none", parsed.toString(), sourceDirectory], { timeout: 120000 });
      sourceLabel = parsed.toString();
    } else {
      sourceDirectory = path.resolve(source);
    }
    const installed = await installSkillSource(sourceDirectory, installedSkillSourceRoot(), sourceLabel);
    const result = await refreshPrivateSkills();
    broadcastStoreSnapshot();
    return { installed, result, ...(await privateExtensionSnapshot()) };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

async function privateExtensionSnapshot() {
  const installedRoot = path.resolve(installedSkillSourceRoot());
  return {
    skills: (await listManagedSkills(skillLibraryRoot(), providerStore.disabledSkills())).map((skill) => {
      const source = path.resolve(String(skill.source || ""));
      const relative = path.relative(installedRoot, source);
      return { ...skill, removable: Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative)) };
    }),
    prompts: providerStore.promptTemplates(),
    mcpServers: providerStore.mcpServers(),
  };
}

const CLIPBOARD_IMAGE_PATTERN = /\.(?:gif|jpe?g|png|webp)$/i;
const MAX_CLIPBOARD_IMAGE_BYTES = 25 * 1024 * 1024;
const OPENABLE_DOCUMENT_PATTERN = /\.(?:pdf|doc|docx|xls|xlsx|ppt|pptx|txt|md|csv|json|zip)$/i;
const MAX_FILE_PREVIEW_BYTES = 50 * 1024 * 1024;
const MAX_TEXT_PREVIEW_BYTES = 5 * 1024 * 1024;
const OFFICE_PREVIEW_MEMBERS = {
  ".docx": ["word/document.xml"],
  ".pptx": ["ppt/slides/slide1.xml"],
  ".xlsx": ["xl/sharedStrings.xml", "xl/worksheets/sheet1.xml"],
};

function resolveOpenableFile(target) {
  let value = String(target || "").trim();
  if (/^file:\/\//i.test(value)) {
    try { value = fileURLToPath(value); } catch { throw new Error("文件路径无效。"); }
  }
  if (/^sandbox:/i.test(value)) value = value.replace(/^sandbox:/i, "");
  if (!path.isAbsolute(value)) throw new Error("只允许打开本机生成的文件。");
  const filePath = path.resolve(value);
  if (!OPENABLE_DOCUMENT_PATTERN.test(filePath)) throw new Error("当前只支持打开 PDF、Word、Excel、PowerPoint、文本和压缩文件。");
  let stats;
  try { stats = fs.statSync(filePath); } catch { throw new Error("文件不存在或已被移动。"); }
  if (!stats.isFile()) throw new Error("目标不是文件。");
  if (stats.size > MAX_FILE_PREVIEW_BYTES) throw new Error("文件超过 50 MB，无法在应用内预览。");
  return { filePath, stats };
}

function officeXmlText(value) {
  return String(value || "")
    .replace(/<w:tab\s*\/?>/gi, "\t")
    .replace(/<w:(?:br|cr)\s*\/?>/gi, "\n")
    .replace(/<\/w:p>/gi, "\n")
    .replace(/<\/a:t>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function officePreviewText(filePath, extension) {
  const members = OFFICE_PREVIEW_MEMBERS[extension];
  if (!members) return "";
  for (const member of members) {
    try {
      const result = await execFilePromise("tar.exe", ["-xOf", filePath, member], { timeout: 12000, maxBuffer: MAX_TEXT_PREVIEW_BYTES });
      const text = officeXmlText(result.stdout);
      if (text) return text.slice(0, MAX_TEXT_PREVIEW_BYTES);
    } catch {
      // A legacy or malformed Office archive falls back to the system opener.
    }
  }
  return "";
}

async function previewFile(target) {
  const { filePath, stats } = resolveOpenableFile(target);
  const extension = path.extname(filePath).toLowerCase();
  const fileName = path.basename(filePath);
  const base = { filePath, fileName, extension, size: stats.size };
  if (extension === ".pdf") {
    return { ...base, kind: "pdf", url: pathToFileURL(filePath).toString() };
  }
  if ([".txt", ".md", ".csv", ".json"].includes(extension)) {
    if (stats.size > MAX_TEXT_PREVIEW_BYTES) throw new Error("文本文件超过 5 MB，无法在应用内预览。");
    const content = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
    if (content.includes("\u0000")) throw new Error("该文件不是可读文本，请使用系统程序打开。");
    return { ...base, kind: extension === ".md" ? "markdown" : "text", content };
  }
  if ([".docx", ".xlsx", ".pptx"].includes(extension)) {
    const content = await officePreviewText(filePath, extension);
    return { ...base, kind: content ? "office-text" : "office", content };
  }
  if (extension === ".zip") {
    try {
      const result = await execFilePromise("tar.exe", ["-tf", filePath], { timeout: 12000, maxBuffer: 512 * 1024 });
      const entries = result.stdout.split(/\r?\n/).filter(Boolean).slice(0, 500);
      return { ...base, kind: "archive", entries, truncated: result.stdout.split(/\r?\n/).filter(Boolean).length > entries.length };
    } catch {
      return { ...base, kind: "archive", entries: [] };
    }
  }
  return { ...base, kind: "office" };
}

async function clipboardImageFromPayload(payload = {}) {
  const localPath = String(payload.path || "").trim();
  const sourceUrl = String(payload.url || "").trim();
  if (localPath) {
    const stats = fs.statSync(localPath);
    if (!stats.isFile()) throw new Error("图片附件不存在。");
    if (stats.size > MAX_CLIPBOARD_IMAGE_BYTES) throw new Error("图片超过 25 MB，无法复制。");
    return nativeImage.createFromPath(localPath);
  }
  if (/^file:\/\//i.test(sourceUrl)) {
    const filePath = fileURLToPath(sourceUrl);
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) throw new Error("图片附件不存在。");
    if (stats.size > MAX_CLIPBOARD_IMAGE_BYTES) throw new Error("图片超过 25 MB，无法复制。");
    return nativeImage.createFromPath(filePath);
  }
  if (/^data:image\//i.test(sourceUrl)) {
    if (Buffer.byteLength(sourceUrl, "utf8") > MAX_CLIPBOARD_IMAGE_BYTES * 1.4) {
      throw new Error("图片超过 25 MB，无法复制。");
    }
    return nativeImage.createFromDataURL(sourceUrl);
  }
  if (/^https:\/\//i.test(sourceUrl)) {
    const response = await net.fetch(sourceUrl, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`图片下载失败（HTTP ${response.status}）。`);
    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (declaredLength > MAX_CLIPBOARD_IMAGE_BYTES) throw new Error("图片超过 25 MB，无法复制。");
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_CLIPBOARD_IMAGE_BYTES) throw new Error("图片超过 25 MB，无法复制。");
    return nativeImage.createFromBuffer(buffer);
  }
  throw new Error("不支持的图片来源。");
}

function clipboardImageFilePaths() {
  const paths = new Set();
  for (const format of clipboard.availableFormats()) {
    if (!/filename/i.test(format)) continue;
    try {
      const buffer = clipboard.readBuffer(format);
      if (!buffer?.length || buffer.length > 1024 * 1024) continue;
      const encoding = /filenamew/i.test(format) ? "utf16le" : "utf8";
      for (const value of buffer.toString(encoding).split(/\0|\r?\n/)) {
        const candidate = value.trim().replace(/^"|"$/g, "");
        if (!candidate || !path.isAbsolute(candidate) || !CLIPBOARD_IMAGE_PATTERN.test(candidate)) continue;
        try {
          if (fs.statSync(candidate).isFile()) paths.add(candidate);
        } catch {
          // Ignore clipboard entries that no longer exist.
        }
      }
    } catch {
      // Clipboard formats vary by application; unsupported formats are ignored.
    }
  }
  return [...paths].slice(0, 8);
}

function saveClipboardImage() {
  const image = clipboard.readImage();
  if (image.isEmpty()) return null;
  const size = image.getSize();
  if (!size.width || !size.height || size.width > 16384 || size.height > 16384) {
    throw new Error("剪贴板图片尺寸过大，无法作为附件添加。");
  }
  const png = image.toPNG();
  if (!png.length || png.length > 25 * 1024 * 1024) {
    throw new Error("剪贴板图片超过 25 MB，无法作为附件添加。");
  }
  const directory = path.join(providerStore.conversationHome(), "attachments", "clipboard");
  fs.mkdirSync(directory, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const target = path.join(directory, `clipboard-${timestamp}-${crypto.randomUUID().slice(0, 8)}.png`);
  fs.writeFileSync(target, png);
  return target;
}

function broadcastExtensionSnapshot(snapshot) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
    try {
      window.webContents.send("app:extensions-changed", snapshot);
    } catch (error) {
      if (!window.isDestroyed()) console.error(`[ipc:app:extensions-changed] ${error.message}`);
    }
  }
}

async function probeMcpServer(server) {
  const startedAt = Date.now();
  if (!server || typeof server !== "object") throw new Error("MCP 配置无效。");
  if (server.transport !== "stdio") {
    if (!String(server.url || "").trim()) throw new Error("MCP URL 不能为空。");
    const response = await net.fetch(server.url, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
      headers: { accept: "text/event-stream, application/json" },
    });
    await response.body?.cancel().catch(() => {});
    return { ok: true, latencyMs: Date.now() - startedAt, detail: `HTTP ${response.status}` };
  }
  const command = typeof server.command === "string" ? server.command.trim() : "";
  const args = Array.isArray(server.args) ? server.args : null;
  if (!command) throw new Error("MCP 启动命令不能为空。");
  if (command.includes("\u0000")) throw new Error("MCP 启动命令包含无效字符。");
  if (!args || args.some((item) => typeof item !== "string" || item.includes("\u0000"))) {
    throw new Error("MCP 参数必须是文本列表，且不能包含无效字符。");
  }
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
      cwd: providerStore.conversationHome(),
      env: { ...process.env, ...providerStore.mcpEnvironment(server.id) },
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (error) {
      reject(new Error(`无法启动 MCP：${error.code === "EINVAL" ? "启动命令或参数无效（Windows EINVAL）" : error.message}`));
      return;
    }
    let stderr = "";
    let settled = false;
    let timer = null;
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!child.killed) child.kill();
      if (error) reject(error);
      else resolve({ ok: true, latencyMs: Date.now() - startedAt, detail: "进程已成功启动" });
    };
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-500); });
    child.once("error", (error) => finish(new Error(`无法启动 MCP：${error.code === "EINVAL" ? "启动命令或参数无效（Windows EINVAL）" : error.message}`)));
    child.once("exit", (code) => {
      finish(new Error(`MCP 启动后过早退出（${code ?? "未知"}）：${stderr.trim() || "无错误输出"}`));
    });
    timer = setTimeout(() => finish(), 700);
  });
}

function broadcastStoreSnapshot() {
  const snapshot = publicStoreSnapshot();
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
    try {
      window.webContents.send("app:store-changed", snapshot);
    } catch (error) {
      if (!window.isDestroyed()) console.error(`[ipc:app:store-changed] ${error.message}`);
    }
  }
  refreshTrayMenu();
}

function broadcastThreadDeleted(threadId) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
    try {
      window.webContents.send("codex:event", {
        method: "thread/deleted",
        params: { threadId },
      });
    } catch (error) {
      if (!window.isDestroyed()) console.error(`[ipc:thread-deleted] ${error.message}`);
    }
  }
}

function runDueThreadDeletions() {
  if (!providerStore) return 0;
  const due = providerStore.dueThreadDeletions();
  for (const entry of due) {
    providerStore.completeThreadDeletion(entry.threadId);
    broadcastThreadDeleted(entry.threadId);
  }
  if (due.length) broadcastStoreSnapshot();
  return due.length;
}

function scheduledTaskServer(task, preferred = null) {
  const candidates = [...servers.values()].filter((server) => server.ready);
  if (task.providerId) return candidates.find((server) => server.provider.id === task.providerId) || null;
  if (preferred?.ready) return preferred;
  return candidates[0] || null;
}

function showScheduledTaskNotification(task, succeeded) {
  if (!task?.notifyOnCompletion || !Notification.isSupported()) return;
  const notification = new Notification({
    title: succeeded ? "已安排任务完成" : "已安排任务失败",
    body: succeeded ? task.title : `${task.title}：${task.lastError || "执行失败"}`,
    silent: false,
  });
  notification.on("click", () => {
    const window = BrowserWindow.getAllWindows().find((item) => !item.isDestroyed());
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  notification.show();
}

async function startScheduledTask(task, server, manual = false) {
  if (!server?.ready) throw new Error("任务所需连接尚未连接。");
  if (runningScheduledTasks.has(task.id)) throw new Error("任务正在执行，请等待本次运行结束。");
  const run = providerStore.beginScheduledTaskRun(task.id, manual);
  runningScheduledTasks.add(task.id);
  let threadId = null;
  try {
    const result = await executeScheduledTask(
      task,
      server,
      providerStore,
      crypto.randomUUID(),
      (createdThreadId) => {
        threadId = createdThreadId;
        scheduledTaskRuns.set(createdThreadId, {
          taskId: task.id,
          server,
          runId: run.id,
          manual,
        });
      },
    );
    broadcastStoreSnapshot();
    return { ...run, threadId: result.threadId };
  } catch (error) {
    if (threadId) scheduledTaskRuns.delete(threadId);
    runningScheduledTasks.delete(task.id);
    const updated = providerStore.failScheduledTask(task.id, error, Date.now(), { runId: run.id, manual });
    showScheduledTaskNotification(updated, false);
    broadcastStoreSnapshot();
    throw error;
  }
}

async function runDueScheduledTasks() {
  if (!providerStore) return;
  for (const task of providerStore.dueScheduledTasks()) {
    if (runningScheduledTasks.has(task.id)) continue;
    const server = scheduledTaskServer(task);
    if (!server) continue;
    try {
      await startScheduledTask(task, server, false);
    } catch (error) {
      console.error(`[scheduled-task:${task.id}] ${error.message}`);
    }
  }
}

function handleScheduledTaskNotification(server, message) {
  if (message?.method !== "turn/completed") return;
  const threadId = message.params?.threadId;
  const run = threadId ? scheduledTaskRuns.get(threadId) : null;
  if (!run || run.server !== server) return;
  try {
    const updated = finalizeScheduledTask(run.taskId, threadId, message.params?.turn, providerStore, {
      runId: run.runId,
      manual: run.manual,
    });
    showScheduledTaskNotification(updated, !updated?.lastError);
  } catch (error) {
    console.error(`[scheduled-task:${run.taskId}] 无法保存任务结果：${error.message}`);
  } finally {
    scheduledTaskRuns.delete(threadId);
    runningScheduledTasks.delete(run.taskId);
    broadcastStoreSnapshot();
  }
}

function failScheduledTasksForServer(server, reason) {
  let changed = false;
  for (const [threadId, run] of scheduledTaskRuns) {
    if (run.server !== server) continue;
    try {
      const updated = providerStore.failScheduledTask(run.taskId, reason, Date.now(), {
        runId: run.runId,
        manual: run.manual,
      });
      showScheduledTaskNotification(updated, false);
    } catch (error) {
      console.error(`[scheduled-task:${run.taskId}] 无法保存任务失败状态：${error.message}`);
    } finally {
      scheduledTaskRuns.delete(threadId);
      runningScheduledTasks.delete(run.taskId);
      changed = true;
    }
  }
  if (changed) broadcastStoreSnapshot();
}

function ensureScheduledTaskIdle(taskId) {
  const id = String(taskId || "").trim();
  if (id && runningScheduledTasks.has(id)) {
    throw new Error("任务正在执行，请等待本次运行结束。");
  }
}

async function runConversationMirror() {
  const configuredSource = providerStore?.conversationMirrorSource();
  if (!configuredSource) return null;
  const targetHome = path.resolve(providerStore.conversationHome());
  const isIndependent = (value) => {
    const sourceHome = path.resolve(value);
    const targetFromSource = path.relative(sourceHome, targetHome);
    const sourceFromTarget = path.relative(targetHome, sourceHome);
    return sourceHome.toLocaleLowerCase() !== targetHome.toLocaleLowerCase()
      && !(targetFromSource && !targetFromSource.startsWith("..") && !path.isAbsolute(targetFromSource))
      && !(sourceFromTarget && !sourceFromTarget.startsWith("..") && !path.isAbsolute(sourceFromTarget));
  };
  const nativeCodexHome = path.join(os.homedir(), ".codex");
  const sources = [...new Set([configuredSource, nativeCodexHome, CODEX_HOME]
    .filter(Boolean)
    .map((value) => path.resolve(value))
    .filter(isIndependent))];
  if (!sources.length) {
    conversationMirrorLastResult = {
      copied: 0,
      updated: 0,
      skipped: 0,
      conflicts: 0,
      bytes: 0,
      sourceHomes: [],
      warning: "未找到与 ChatSwitch 副本目录分离的聊天记录源目录。",
      completedAt: Date.now(),
    };
    return conversationMirrorLastResult;
  }
  if (conversationMirrorSync) return conversationMirrorSync;
  conversationMirrorSync = syncConversationMirrors(sources, targetHome);
  try {
    const result = await conversationMirrorSync;
    conversationMirrorLastResult = { ...result, completedAt: Date.now() };
    if (result.copied || result.updated) {
      for (const window of BrowserWindow.getAllWindows()) {
        if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
        window.webContents.send("codex:event", {
          method: "conversation/mirror/updated",
          params: result,
        });
      }
    }
    return result;
  } finally {
    conversationMirrorSync = null;
  }
}

function restartConversationMirrorTimer() {
  if (conversationMirrorTimer) clearInterval(conversationMirrorTimer);
  conversationMirrorTimer = null;
  const settings = providerStore?.conversationMirrorSettings?.();
  if (!settings?.enabled || !settings.source) return;
  conversationMirrorTimer = setInterval(() => {
    runConversationMirror().catch((error) => console.error(`[conversation-mirror] ${error.message}`));
  }, settings.intervalMs);
  conversationMirrorTimer.unref?.();
}

if (!hasSingleInstanceLock) app.quit();

app.on("second-instance", (_event, argv) => {
  if (!hasSingleInstanceLock) return;
  const link = chatSwitchLinkFromArgs(argv);
  app.whenReady().then(() => (link ? openDeepLink(link) : showAppWindow()));
});

app.on("open-url", (event, url) => {
  event.preventDefault();
  if (providerStore) openDeepLink(url);
  else pendingDeepLinks.push(url);
});

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  if (process.platform === "win32"
    && process.env.CHATSWITCH_QA !== "1"
    && !process.env.CHATSWITCH_QA_SCREENSHOT) {
    try {
      ensureWindowsNotificationIdentity({
        appData: app.getPath("appData"),
        appUserModelId: WINDOWS_APP_ID,
        toastActivatorClsid: WINDOWS_TOAST_ACTIVATOR_CLSID,
        target: process.execPath,
        args: notificationShortcutArguments({
          isPackaged: app.isPackaged,
          userData: app.getPath("userData"),
          applicationRoot: APPLICATION_ROOT,
        }),
        cwd: APPLICATION_ROOT,
        icon: applicationIconPath(),
        shellApi: shell,
      });
    } catch (error) {
      console.error(`[notification-identity] ${error.message}`);
    }
  }
  providerStore = new ProviderStore();
  // The original Codex App/CLI source is read independently of the optional app-server.
  // This keeps local history available on machines that do not have the CLI installed.
  localHistoryReader.addCodexSource(providerStore.conversationMirrorSource());
  localProviderDiscovery = createLocalProviderDiscovery({
    homeDirectory: os.homedir(),
    codexHomes: [CODEX_HOME, path.join(os.homedir(), ".codex")],
    providerStore,
  });
  if (app.isPackaged) app.setAsDefaultProtocolClient("chatswitch");
  await createTray();
  try {
    providerStore.createRotatingBackup();
  } catch (error) {
    console.error(`[backup] ${error.message}`);
  }
  if (providerStore.syncStatus().autoSync) {
    try {
      await providerStore.syncConfigured("auto", net.fetch);
    } catch (error) {
      console.error(`[sync] ${error.message}`);
    }
  }
  const backupTimer = setInterval(() => {
    try {
      providerStore.createRotatingBackup();
    } catch (error) {
      console.error(`[backup] ${error.message}`);
    }
  }, 6 * 60 * 60 * 1000);
  backupTimer.unref?.();
  const configuredSkillSources = String(process.env.CHATSWITCH_SKILL_SOURCES || "")
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
  skillSources = configuredSkillSources.length
    ? configuredSkillSources
    : process.env.CHATSWITCH_STORE_ROOT && process.env.CHATSWITCH_QA_SCREENSHOT
      ? []
      : [
      path.join(os.homedir(), ".agents", "skills"),
      path.join(os.homedir(), ".codex", "skills"),
      ];
  if (skillSources.length) {
    const skillRefreshTimer = setTimeout(() => {
      refreshPrivateSkills()
        .then(async (result) => {
          console.log(`[skills] copied ${result.copied} private skill directories`);
          broadcastExtensionSnapshot(await privateExtensionSnapshot());
        })
        .catch((error) => console.error(`[skills] ${error.message}`));
    }, 750);
    skillRefreshTimer.unref?.();
  }
  if (process.env.CHATSWITCH_MIRROR_SOURCE) {
    providerStore.setConversationMirrorSource(process.env.CHATSWITCH_MIRROR_SOURCE);
  }
  const scheduledTaskTimer = setInterval(() => {
    runDueScheduledTasks().catch((error) => console.error(`[scheduled-task] ${error.message}`));
  }, 30000);
  scheduledTaskTimer.unref?.();
  runDueThreadDeletions();
  const threadDeletionTimer = setInterval(runDueThreadDeletions, 30000);
  threadDeletionTimer.unref?.();
  if (process.env.CHATSWITCH_QA_CLAUDE_TOKEN && process.env.CHATSWITCH_STORE_ROOT) {
    providerStore.saveProviderKey("claude", process.env.CHATSWITCH_QA_CLAUDE_TOKEN);
    providerStore.saveClaudeSettings({
      vendorLabel: "Hexuan",
      baseUrl: "https://ai.hexuan.cc/v1",
      model: "fable",
    });
  }
  if (process.env.CHATSWITCH_QA_HEXUAN_TOKEN && process.env.CHATSWITCH_STORE_ROOT) {
    providerStore.saveProviderKey("hexuan", process.env.CHATSWITCH_QA_HEXUAN_TOKEN);
  }
  ipcMain.handle("app:bootstrap", async () => ({
    codexHome: providerStore.conversationHome(),
    defaultWorkspace: DEFAULT_WORKSPACE,
    ...publicStoreSnapshot(),
  }));
  ipcMain.handle("app:settings", () => ({
    ...providerStore.appSettings(),
    launchAtLogin: app.getLoginItemSettings(loginItemOptions()).openAtLogin,
    version: app.getVersion(),
  }));
  ipcMain.handle("app:save-settings", (_event, input = {}) => {
    const launchAtLogin = Boolean(input.launchAtLogin);
    app.setLoginItemSettings(loginItemOptions(launchAtLogin));
    return { ...providerStore.saveAppSettings(input), launchAtLogin };
  });
  ipcMain.handle("app:check-update", () => checkApplicationUpdate());
  ipcMain.handle("local-history:sources", () => localHistoryReader.sources());
  ipcMain.handle("local-history:list", (_event, input = {}) => localHistoryReader.list(input));
  ipcMain.handle("local-history:read", (_event, input = {}) => localHistoryReader.read(input));
  ipcMain.handle("local-history:import", async (_event, input = {}) => {
    const conversation = await localHistoryReader.read(input);
    const result = sharedHistoryReaders().compatible.importLocalConversation(conversation);
    return {
      ...result,
      thread: {
        ...result.thread,
        turns: [],
        _historyEngine: "openai-compatible",
      },
      sourceLabel: conversation.sourceLabel,
      truncated: Boolean(conversation.truncated),
    };
  });
  ipcMain.handle("local-history:import-all", async (_event, input = {}) => {
    const requestedSourceIds = Array.isArray(input.sourceIds)
      ? input.sourceIds.map((value) => String(value || "").trim()).filter(Boolean)
      : [String(input.sourceId || "").trim()].filter(Boolean);
    const sourceIds = requestedSourceIds.length
      ? requestedSourceIds
      : (await localHistoryReader.sources()).filter((source) => source.available).map((source) => source.id);
    if (!sourceIds.length) throw new Error("没有发现可导入的本地记录来源。");
    const result = { total: 0, imported: 0, duplicate: 0, failed: 0, sources: sourceIds, errors: [] };
    for (const sourceId of sourceIds) {
      const index = await localHistoryReader.list({
        sourceId,
        search: String(input.search || "").trim(),
        limit: 20000,
        all: true,
      });
      result.total += index.total;
      for (const summary of index.conversations) {
        try {
          const conversation = await localHistoryReader.read({ conversationId: summary.id });
          const imported = sharedHistoryReaders().compatible.importLocalConversation(conversation);
          if (imported.duplicate) result.duplicate += 1;
          else result.imported += 1;
        } catch (error) {
          result.failed += 1;
          if (result.errors.length < 8) result.errors.push(`${summary.title || summary.id}: ${error.message}`);
        }
      }
    }
    return result;
  });
  ipcMain.handle("codex:list-local", async (_event, query = {}) => (
    sharedHistoryReaders().compatible.listLocalThreads(query?.search || "")
  ));
  ipcMain.handle("codex:read-local", async (_event, threadId) => (
    rendererThreadWindow(await sharedHistoryReaders().compatible.readThread(threadId))
  ));
  ipcMain.handle("conversation-mirror:status", () => ({
    ...(providerStore.conversationMirrorSettings?.() || { source: null, target: providerStore.conversationHome(), intervalMs: 60000, enabled: false }),
    lastResult: conversationMirrorLastResult,
  }));
  ipcMain.handle("conversation-mirror:configure", (_event, input = {}) => {
    const settings = providerStore.setConversationMirrorSettings(input);
    if (settings.source) localHistoryReader.addCodexSource(settings.source);
    restartConversationMirrorTimer();
    return settings;
  });
  ipcMain.handle("conversation-mirror:run", async () => {
    if (!providerStore.conversationMirrorSettings?.().source) throw new Error("请先选择 Codex 原始记录目录。");
    const result = await runConversationMirror();
    restartConversationMirrorTimer();
    return result || conversationMirrorLastResult || { copied: 0, updated: 0, skipped: 0, conflicts: 0 };
  });
  ipcMain.handle("deep-link:confirm-import", async (_event, input = {}) => {
    const importType = String(input.importType || "").trim();
    const rawConfig = input.config && typeof input.config === "object" ? input.config : {};
    const encoded = Buffer.from(JSON.stringify({ type: importType, ...rawConfig }), "utf8").toString("base64url");
    const normalized = parseChatSwitchLink(`chatswitch://import?data=${encoded}`);
    if (!normalized || normalized.action !== "import") throw new Error("导入配置无效或包含敏感字段。");
    if (normalized.importType === "provider") return { importType, config: normalized.config, requiresApiKey: true };
    if (normalized.importType === "prompt") {
      const imported = providerStore.savePromptTemplate(normalized.config);
      broadcastStoreSnapshot();
      return { importType, imported };
    }
    if (normalized.importType === "mcp") {
      const imported = providerStore.saveMcpServer({
        ...normalized.config,
        env: Object.fromEntries(normalized.config.envKeys.map((key) => [key, ""])),
      });
      broadcastStoreSnapshot();
      return { importType, imported, requiresSecrets: normalized.config.envKeys.length > 0 };
    }
    const result = await installPrivateSkill({ kind: "github", source: normalized.config.source });
    return { importType, imported: result.installed, extensions: result };
  });
  ipcMain.handle("extension:list", () => privateExtensionSnapshot());
  ipcMain.handle("extension:refresh-skills", async () => {
    const result = await refreshPrivateSkills();
    broadcastStoreSnapshot();
    return { result, ...(await privateExtensionSnapshot()) };
  });
  ipcMain.handle("extension:install-skill", (_event, input) => installPrivateSkill(input));
  ipcMain.handle("extension:remove-skill", async (_event, requestedName) => {
    const name = String(requestedName || "").trim();
    if (!/^[\w.-]{1,100}$/i.test(name)) throw new Error("Skill 名称无效。");
    const root = path.resolve(installedSkillSourceRoot());
    const target = path.resolve(root, name);
    if (path.dirname(target) !== root || !fs.existsSync(path.join(target, "SKILL.md"))) {
      throw new Error("只能卸载通过 ChatSwitch 安装的 Skill。");
    }
    fs.rmSync(target, { recursive: true, force: true });
    const result = await refreshPrivateSkills();
    broadcastStoreSnapshot();
    return { removed: name, result, ...(await privateExtensionSnapshot()) };
  });
  ipcMain.handle("extension:set-skill-enabled", async (_event, input) => {
    const updated = providerStore.setSkillEnabled(input?.name, input?.enabled);
    await refreshPrivateSkills();
    broadcastStoreSnapshot();
    return { updated, ...(await privateExtensionSnapshot()) };
  });
  ipcMain.handle("prompt:save", (_event, input) => {
    const template = providerStore.savePromptTemplate(input);
    broadcastStoreSnapshot();
    return template;
  });
  ipcMain.handle("prompt:remove", (_event, id) => {
    const template = providerStore.removePromptTemplate(id);
    broadcastStoreSnapshot();
    return template;
  });
  ipcMain.handle("mcp:save", (_event, input) => {
    const server = providerStore.saveMcpServer(input);
    broadcastStoreSnapshot();
    return server;
  });
  ipcMain.handle("mcp:remove", (_event, id) => {
    const server = providerStore.removeMcpServer(id);
    broadcastStoreSnapshot();
    return server;
  });
  ipcMain.handle("mcp:test", async (_event, id) => {
    const server = providerStore.mcpServers().find((item) => item.id === String(id || "").trim());
    if (!server) throw new Error("MCP 配置不存在。");
    return probeMcpServer(server);
  });

  ipcMain.handle("window:new", (_event, payload = {}) => {
    createWindow(
      payload.provider || null,
      payload.projectRoot || null,
      null,
      payload.projectId || null,
      payload.workspace || null,
    );
    return true;
  });

  ipcMain.on("window:set-theme", (event, requestedTheme) => {
    const theme = requestedTheme === "dark" ? "dark" : "light";
    const overlay = TITLE_BAR_OVERLAYS[theme];
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner || owner.isDestroyed()) return;
    owner.setTitleBarOverlay(overlay);
    owner.setBackgroundColor(overlay.color);
  });

  ipcMain.handle("dialog:workspace", async (event, currentPath) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(owner, {
      title: "Choose working directory",
      defaultPath: currentPath || DEFAULT_WORKSPACE,
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle("dialog:record-home", async (event, currentPath) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(owner, {
      title: "选择聊天记录存放目录",
      defaultPath: currentPath || providerStore.conversationHome(),
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle("dialog:sync-directory", async (event, currentPath) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(owner, {
      title: "选择 ChatSwitch 同步目录",
      defaultPath: currentPath || undefined,
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle("dialog:images", async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(owner, {
      title: "选择图片附件",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
    });
    return result.canceled ? [] : result.filePaths;
  });
  ipcMain.handle("dialog:files", async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(owner, {
      title: "选择要发送给模型的文件",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "文档、表格与文本", extensions: ["pdf", "docx", "xlsx", "pptx", "txt", "md", "csv", "json"] }, { name: "所有文件", extensions: ["*"] }],
    });
    return result.canceled ? [] : result.filePaths;
  });
  ipcMain.handle("clipboard:images", () => {
    const filePaths = clipboardImageFilePaths();
    if (filePaths.length) return { paths: filePaths, source: "files" };
    const saved = saveClipboardImage();
    return { paths: saved ? [saved] : [], source: saved ? "image" : "empty" };
  });
  ipcMain.handle("dialog:skill-folder", async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(owner, { title: "选择 Skill 文件夹", properties: ["openDirectory"] });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle("dialog:skill-zip", async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(owner, {
      title: "选择 Skill ZIP 包",
      properties: ["openFile"],
      filters: [{ name: "ZIP", extensions: ["zip"] }],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle("app:notify", (event, payload = {}) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const title = String(payload.title || "ChatSwitch").slice(0, 120);
    const body = String(payload.body || "").slice(0, 300);
    if (Notification.isSupported()) {
      const notification = new Notification({ title, body, silent: false });
      notification.on("click", () => {
        if (!owner || owner.isDestroyed()) return;
        if (owner.isMinimized()) owner.restore();
        owner.show();
        owner.focus();
      });
      notification.show();
    }
    owner?.flashFrame(true);
    return true;
  });
  ipcMain.handle("app:copy-text", (_event, value) => {
    clipboard.writeText(String(value || "").slice(0, 500000));
    return true;
  });
  ipcMain.handle("app:copy-image", async (_event, payload = {}) => {
    const image = await clipboardImageFromPayload(payload);
    if (!image || image.isEmpty()) throw new Error("无法读取这张图片。");
    clipboard.writeImage(image);
    return true;
  });

  ipcMain.handle("provider:add-relay", (_event, input) => {
    const provider = providerStore.addRelay(input);
    broadcastStoreSnapshot();
    return provider;
  });
  ipcMain.handle("local-providers:discover", () => localProviderDiscovery.discover());
  ipcMain.handle("local-providers:import", (_event, candidateIds) => {
    const results = localProviderDiscovery.importCandidates(candidateIds, providerStore);
    if (results.some((result) => result.status === "imported")) broadcastStoreSnapshot();
    return { results, providers: providerStore.list() };
  });
  ipcMain.handle("provider:update-relay", (_event, input) => {
    const provider = providerStore.updateRelay(input);
    broadcastStoreSnapshot();
    return provider;
  });
  ipcMain.handle("provider:update-builtin-api", (_event, input) => {
    const provider = providerStore.updateBuiltinApi(input);
    broadcastStoreSnapshot();
    return provider;
  });
  ipcMain.handle("provider:save-route", (_event, input) => {
    const route = providerStore.saveProviderRoute(input);
    broadcastStoreSnapshot();
    return route;
  });
  handleRendererIpc("provider:probe-models", async (_event, input = {}) => {
    const providerId = String(input.providerId || "").trim();
    let provider = null;
    if (providerId) {
      provider = providerStore.resolve(providerId);
      if (provider.type !== "relay" && !["niubi", "hexuan"].includes(provider.id)) {
        throw new Error("只能测试 ChatSwitch 中添加的模型供应商。");
      }
    }
    const baseUrl = String(input.baseUrl || provider?.baseUrl || "").trim();
    const environment = provider ? await providerEnvironment() : {};
    const apiKey = String(input.apiKey || "").trim()
      || (provider ? providerApiKey(provider, environment) : null);
    const startedAt = Date.now();
    const models = await fetchOpenAIModels(baseUrl, apiKey, net.fetch);
    return { models, latencyMs: Math.max(0, Date.now() - startedAt) };
  });
  ipcMain.handle("provider:add-account", (_event, input) => {
    const provider = providerStore.addAccount(input);
    broadcastStoreSnapshot();
    return provider;
  });
  ipcMain.handle("provider:remove", (_event, providerId) => {
    const removed = providerStore.removeConnection(providerId);
    for (const [webContentsId, attempt] of connectionAttempts) {
      if (attempt.providerId === removed.id) nextConnectionGeneration(webContentsId);
    }
    for (const [webContentsId, server] of servers) {
      if (server.provider.id !== removed.id) continue;
      failScheduledTasksForServer(server, "任务使用的连接已删除。");
      server.stop();
      servers.delete(webContentsId);
      nextConnectionGeneration(webContentsId);
      const owner = BrowserWindow.getAllWindows()
        .find((window) => !window.isDestroyed() && window.webContents.id === webContentsId);
      if (owner && !owner.webContents.isDestroyed()) {
        owner.webContents.send("codex:disconnected", {
          code: null,
          reason: "provider-removed",
          providerId: removed.id,
        });
      }
    }
    broadcastStoreSnapshot();
    return removed;
  });
  ipcMain.handle("provider:reorder", (_event, providerIds) => {
    const providers = providerStore.reorderProviders(providerIds);
    broadcastStoreSnapshot();
    return providers;
  });
  ipcMain.handle("provider:save-key", (_event, input) => {
    const provider = providerStore.saveProviderKey(input?.providerId, input?.apiKey);
    broadcastStoreSnapshot();
    return provider;
  });
  ipcMain.handle("provider:claude-models", async (_event, input) => {
    const provider = providerStore.resolve("claude");
    const apiKey = String(input?.apiKey || "").trim() || provider.env?.[provider.envKey];
    return fetchClaudeModelsSafely(input?.baseUrl || provider.baseUrl, apiKey, net.fetch);
  });
  ipcMain.handle("provider:configure-claude", (_event, input) => {
    if (String(input?.apiKey || "").trim()) providerStore.saveProviderKey("claude", input.apiKey);
    const provider = providerStore.saveClaudeSettings(input);
    broadcastStoreSnapshot();
    return provider;
  });
  ipcMain.handle("provider:balance", async (_event, providerId) => {
    const provider = providerStore.resolve(providerId);
    if (!["api", "relay"].includes(provider.type)) throw new Error("该连接没有中转余额。");
    const environment = await providerEnvironment();
    const apiKey = providerApiKey(provider, environment);
    if (!apiKey) throw new Error(`${provider.envKey || "API Key"} 未配置，无法查询余额。`);
    return fetchRelayBalance(provider, apiKey, net.fetch);
  });
  ipcMain.handle("usage:get", (_event, input = {}) => providerStore.providerUsage(
    input?.providerId || null,
    input?.since || 0,
  ));
  ipcMain.handle("usage:clear", (_event, input = {}) => providerStore.clearProviderRequestLogs(
    input?.providerId || null,
  ));
  ipcMain.handle("usage:save-pricing", (_event, input = {}) => providerStore.saveModelPricing(input));
  ipcMain.handle("usage:pricing", () => providerStore.modelPricing());
  ipcMain.handle("config:export", async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showSaveDialog(owner, {
      title: "导出 ChatSwitch 配置",
      defaultPath: `chatswitch-config-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    const temporary = `${result.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(providerStore.exportConfiguration(), null, 2)}\n`, "utf8");
    fs.renameSync(temporary, result.filePath);
    return { canceled: false, filePath: result.filePath, containsCredentials: false };
  });
  ipcMain.handle("thread:export", async (event, input = {}) => {
    const threadId = String(input.threadId || "").trim();
    if (!threadId) throw new Error("无效的会话 ID。");
    const format = ["md", "html", "json", "pdf"].includes(input.format) ? input.format : "md";
    const server = servers.get(event.sender.id);
    let response;
    if (server?.ready) {
      try { response = await sharedReadThread(server, threadId); } catch { response = await sharedHistoryReaders().compatible.readThread(threadId); }
    } else response = await sharedHistoryReaders().compatible.readThread(threadId);
    const thread = response.thread || response;
    const title = String(thread.name || thread.preview || "ChatSwitch 会话").trim().slice(0, 80) || "ChatSwitch 会话";
    const safeTitle = title.replace(/[<>:"/\\\\|?*]+/g, "_");
    const rows = (thread.turns || []).flatMap((turn) => (turn.items || []).map((item) => {
      const role = item.type === "userMessage" ? "用户" : item.type === "reasoning" ? "推理摘要" : "助手";
      const text = item.type === "userMessage"
        ? (item.content || []).map((part) => part.text || "").join("\\n")
        : item.text || (item.summary || []).map((part) => part.text || "").join("\\n");
      return { role, text: String(text || "").trim() };
    }).filter((item) => item.text));
    const markdown = "# " + title + "\\n\\n" + rows.map((row) => "## " + row.role + "\\n\\n" + row.text).join("\\n\\n---\\n\\n") + "\\n";
    const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char]));
    const html = "<!doctype html><meta charset=\"utf-8\"><title>" + escape(title) + "</title><style>body{font:16px system-ui;max-width:860px;margin:40px auto;line-height:1.65;color:#1b2529}h1{border-bottom:1px solid #d6dfe0;padding-bottom:12px}h2{margin-top:28px;color:#087f68;white-space:pre-wrap}p{white-space:pre-wrap}</style><h1>" + escape(title) + "</h1>" + rows.map((row) => "<h2>" + escape(row.role) + "</h2><p>" + escape(row.text) + "</p>").join("");
    const owner = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showSaveDialog(owner, { title: "导出会话", defaultPath: safeTitle + "." + format, filters: [{ name: format.toUpperCase(), extensions: [format] }] });
    if (result.canceled || !result.filePath) return { canceled: true };
    if (format === "json") fs.writeFileSync(result.filePath, JSON.stringify(thread, null, 2) + "\\n", "utf8");
    else if (format === "html") fs.writeFileSync(result.filePath, html, "utf8");
    else if (format === "md") fs.writeFileSync(result.filePath, markdown, "utf8");
    else {
      const printWindow = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
      try {
        await printWindow.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
        fs.writeFileSync(result.filePath, await printWindow.webContents.printToPDF({ printBackground: true, pageSize: "A4" }));
      } finally { if (!printWindow.isDestroyed()) printWindow.destroy(); }
    }
    return { canceled: false, filePath: result.filePath, format };
  });
  ipcMain.handle("config:import", async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(owner, {
      title: "导入 ChatSwitch 配置",
      properties: ["openFile"],
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    let bundle;
    try {
      bundle = JSON.parse(fs.readFileSync(result.filePaths[0], "utf8"));
    } catch (error) {
      throw new Error(`无法读取配置文件：${error.message}`);
    }
    providerStore.createRotatingBackup(10, 0);
    const imported = providerStore.importConfiguration(bundle);
    broadcastStoreSnapshot();
    return { canceled: false, filePath: result.filePaths[0], ...imported };
  });
  ipcMain.handle("backup:list", () => providerStore.listConfigurationBackups());
  ipcMain.handle("backup:create", () => providerStore.createRotatingBackup(10, 0));
  ipcMain.handle("sync:status", () => providerStore.syncStatus());
  ipcMain.handle("sync:configure", (_event, input) => providerStore.configureSync(input));
  ipcMain.handle("sync:configure-webdav", (_event, input) => providerStore.configureWebdavSync(input));
  ipcMain.handle("sync:run", async (_event, mode) => {
    const result = await providerStore.syncConfigured(mode, net.fetch);
    if (!result.conflict && result.result?.direction === "pull") broadcastStoreSnapshot();
    return result;
  });
  ipcMain.handle("backup:restore", (_event, name) => {
    const restored = providerStore.restoreConfigurationBackup(name);
    for (const [webContentsId, server] of servers) {
        failScheduledTasksForServer(server, "ChatSwitch 配置已从备份恢复。");
      server.stop();
      servers.delete(webContentsId);
      nextConnectionGeneration(webContentsId);
    }
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send("codex:disconnected", { code: null, reason: "backup-restored" });
      }
    }
    broadcastStoreSnapshot();
    return restored;
  });
  ipcMain.handle("project:add", (_event, input) => {
    const project = providerStore.addProject(input);
    broadcastStoreSnapshot();
    return project;
  });
  ipcMain.handle("project:rename", (_event, input) => {
    const project = providerStore.renameProject(input?.projectId, input?.label);
    broadcastStoreSnapshot();
    return project;
  });
  ipcMain.handle("project:delete", (_event, input) => {
    const result = providerStore.deleteProject(input);
    broadcastStoreSnapshot();
    return result;
  });
  ipcMain.handle("project:assign-thread", (_event, input) => {
    const projectThreads = providerStore.assignThreadToProject(input?.threadId, input?.projectId);
    broadcastStoreSnapshot();
    return projectThreads;
  });
  ipcMain.handle("thread:save-settings", (_event, input) => {
    const threadSettings = providerStore.saveThreadSettings(
      input?.threadId,
      input?.providerId,
      { model: input?.model, effort: input?.effort, approvalMode: input?.approvalMode },
    );
    broadcastStoreSnapshot();
    return threadSettings;
  });
  ipcMain.handle("settings:set-record-home", (_event, directory) => {
    const recordHome = providerStore.setConversationHome(directory);
    return refreshPrivateSkills().then(() => {
      broadcastStoreSnapshot();
      return recordHome;
    });
  });
  ipcMain.handle("thread:hide", (_event, input) => {
    const payload = typeof input === "string" ? { threadId: input } : input || {};
    const pendingDeletion = providerStore.scheduleThreadDeletion(
      payload.threadId,
      payload.engine,
      payload.providerId,
    );
    broadcastStoreSnapshot();
    return {
      hiddenThreadIds: providerStore.hiddenThreads(),
      pendingDeletion,
      pendingDeletions: providerStore.pendingDeletions(),
    };
  });
  ipcMain.handle("thread:restore", (_event, threadId) => {
    const hiddenThreadIds = providerStore.restoreThread(threadId);
    broadcastStoreSnapshot();
    return hiddenThreadIds;
  });
  ipcMain.handle("thread:rename-local", (_event, input) => {
    const aliases = providerStore.renameThreadLocal(input?.threadId, input?.name);
    broadcastStoreSnapshot();
    return aliases;
  });
  ipcMain.handle("thread:set-decoration", (_event, input = {}) => (
    providerStore.setThreadDecoration(input.threadId, input)
  ));
  ipcMain.handle("thread:archive-local", (_event, threadId) => {
    const archivedIds = providerStore.archiveThreadLocal(threadId);
    broadcastStoreSnapshot();
    return archivedIds;
  });
  ipcMain.handle("thread:unarchive-local", (_event, threadId) => {
    const archivedIds = providerStore.unarchiveThreadLocal(threadId);
    broadcastStoreSnapshot();
    return archivedIds;
  });
  ipcMain.handle("thread:delete-now", (_event, threadId) => {
    const deletedIds = providerStore.deleteThreadNow(threadId);
    broadcastStoreSnapshot();
    broadcastThreadDeleted(threadId);
    return deletedIds;
  });
  ipcMain.handle("thread:save-message-queue", (_event, input) => {
    const messages = providerStore.saveMessageQueue(input?.threadId, input?.messages);
    broadcastStoreSnapshot();
    return messages;
  });
  ipcMain.handle("thread:claim-message-queue", (_event, input) => {
    const threadId = String(input?.threadId || "").trim();
    if (activeLogicalTurns.has(threadId)) {
      return { busy: true, message: null, messages: providerStore.messageQueues()[threadId] || [] };
    }
    const claimed = providerStore.claimMessageQueue(threadId, input?.clientUserMessageId);
    broadcastStoreSnapshot();
    return { busy: false, ...claimed };
  });
  ipcMain.handle("thread:restore-message-queue", (_event, input) => {
    const messages = providerStore.restoreClaimedMessage(input?.threadId, input?.message);
    broadcastStoreSnapshot();
    return messages;
  });
  ipcMain.handle("task:save", (_event, input) => {
    ensureScheduledTaskIdle(input?.id);
    const task = providerStore.saveScheduledTask(input);
    broadcastStoreSnapshot();
    runDueScheduledTasks().catch((error) => console.error(`[scheduled-task] ${error.message}`));
    return task;
  });
  ipcMain.handle("task:remove", (_event, taskId) => {
    ensureScheduledTaskIdle(taskId);
    const task = providerStore.removeScheduledTask(taskId);
    broadcastStoreSnapshot();
    return task;
  });
  ipcMain.handle("task:set-enabled", (_event, input) => {
    ensureScheduledTaskIdle(input?.taskId);
    const task = providerStore.setScheduledTaskEnabled(input?.taskId, input?.enabled);
    broadcastStoreSnapshot();
    if (task.enabled) runDueScheduledTasks().catch((error) => console.error(`[scheduled-task] ${error.message}`));
    return task;
  });
  ipcMain.handle("task:run-now", async (event, taskId) => {
    ensureScheduledTaskIdle(taskId);
    const task = providerStore.scheduledTasks().find((item) => item.id === String(taskId || "").trim());
    if (!task) throw new Error("已安排任务不存在。");
    const preferred = servers.get(event.sender.id) || null;
    const server = scheduledTaskServer(task, preferred);
    if (!server) {
      const label = task.providerId
        ? providerStore.list().find((item) => item.id === task.providerId)?.connectionLabel || "指定连接"
        : "任一模型连接";
      throw new Error(`请先连接${label}，再运行此任务。`);
    }
    const run = await startScheduledTask(task, server, true);
    return { run, task: providerStore.scheduledTasks().find((item) => item.id === task.id) };
  });

  ipcMain.handle("auth:official-login", async (_event, providerId = "official") => {
    const provider = providerStore.resolve(providerId);
    if (!["official", "account"].includes(provider.type)) throw new Error("该连接不是 Codex 官方账号。");
    const snapshot = await loginOfficialAccount(provider);
    if (providerId === "official") providerStore.markOfficialConfigured();
    broadcastStoreSnapshot();
    return snapshot;
  });
  ipcMain.handle("auth:claude-login", async (_event) => {
    const provider = providerStore.resolve("claude");
    return loginClaudeOfficial(provider);
  });

  ipcMain.handle("url:open", async (_event, target) => {
    let url;
    try {
      url = new URL(String(target || ""));
    } catch {
      throw new Error("无效的外部链接。");
    }
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("仅允许打开 HTTP 或 HTTPS 链接。");
    await shell.openExternal(url.toString());
    return true;
  });
  ipcMain.handle("file:open", async (_event, target) => {
    const { filePath } = resolveOpenableFile(target);
    const failure = await shell.openPath(filePath);
    if (failure) throw new Error(failure);
    return { opened: true, filePath };
  });
  ipcMain.handle("file:preview", async (_event, target) => previewFile(target));
  ipcMain.handle("file:extract-text", async (_event, targets) => {
    const files = Array.isArray(targets) ? targets : [targets];
    const results = [];
    for (const target of files.slice(0, 8)) {
      const resolved = resolveOpenableFile(target);
      const extension = path.extname(resolved.filePath).toLowerCase();
      if ([".txt", ".md", ".csv", ".json", ".docx", ".xlsx", ".pptx"].includes(extension)) {
        const preview = await previewFile(resolved.filePath);
        if (!preview.content) throw new Error(`${path.basename(resolved.filePath)} 没有可提取的文本。`);
        results.push({ fileName: path.basename(resolved.filePath), content: preview.content.slice(0, 120000) });
        continue;
      }
      if (extension === ".pdf") {
        try {
          const extracted = await execFilePromise("pdftotext.exe", ["-layout", resolved.filePath, "-"], { timeout: 20000, maxBuffer: 8 * 1024 * 1024 });
          if (!extracted.stdout.trim()) throw new Error("PDF 没有可提取文本");
          results.push({ fileName: path.basename(resolved.filePath), content: extracted.stdout.slice(0, 120000) });
        } catch (error) {
          throw new Error(`${path.basename(resolved.filePath)} 暂时无法提取文本：请确认 PDF 包含文字层。`);
        }
        continue;
      }
      throw new Error(`${path.basename(resolved.filePath)} 暂不支持作为模型上下文上传。`);
    }
    return results;
  });

  handleRendererIpc("codex:connect", async (event, providerId) => {
    const sender = event.sender;
    const senderId = sender.id;
    const pendingAttempt = connectionAttempts.get(senderId);
    if (pendingAttempt?.providerId === providerId) return pendingAttempt.promise;

    const task = (async () => {
      const generation = nextConnectionGeneration(senderId);
      const previous = servers.get(senderId);
      if (previous) {
        clearApprovalRequests(previous);
        failScheduledTasksForServer(previous, "任务使用的连接已切换。");
        previous.rendererEventBatcher?.stop(false);
        previous.stop();
      }
      servers.delete(senderId);
      let provider = providerStore.resolve(providerId);
      const environment = await providerEnvironment();
      const requiredEnvironmentKey = provider.envKey || null;
      if (requiredEnvironmentKey && !provider.env?.[requiredEnvironmentKey] && !environment[requiredEnvironmentKey]) {
        throw new Error(`${requiredEnvironmentKey} 未配置，无法连接 ${provider.label}。`);
      }
      let modelWarning = null;
      if (["api", "relay"].includes(provider.type)) {
        const apiKey = providerApiKey(provider, environment);
        try {
          const models = await fetchOpenAIModels(provider.baseUrl, apiKey, net.fetch);
          if (provider.type === "relay") {
            providerStore.updateRelay({
              id: provider.id,
              label: provider.label,
              baseUrl: provider.baseUrl,
              model: provider.model,
              protocol: provider.protocol,
              preset: provider.preset,
              discoveredModels: models,
            });
          }
          provider = providerStore.withModelCatalog(provider, models);
        } catch (error) {
          if (provider.engine === "openai-compatible" && [401, 403].includes(error.status)) {
            throw new Error(`API Key 无效或没有模型权限：${error.message}`);
          }
          modelWarning = error.message;
        }
      }
      let serverProvider = provider;
      if (provider.engine === "openai-compatible") {
        const route = providerStore.providerRoute(provider.id);
        const fallbackProviders = route?.enabled
          ? (route.fallbackProviderIds || []).flatMap((fallbackId) => {
            try {
              const fallback = providerStore.resolve(fallbackId);
              return fallback.engine === "openai-compatible" && fallback.apiKey ? [fallback] : [];
            } catch {
              return [];
            }
          })
          : [];
        serverProvider = {
          ...provider,
          fallbackProviders,
          failover: route?.enabled ? route : null,
        };
      }
      const server = provider.engine === "claude"
        ? new ClaudeServer(serverProvider)
        : provider.engine === "openai-compatible"
          ? new OpenAICompatibleServer(serverProvider, net.fetch)
          : new CodexServer(serverProvider, environment);
      const requestIsCurrent = () => !sender.isDestroyed()
        && connectionGenerations.get(senderId) === generation;
      if (!requestIsCurrent()) {
        server.stop();
        return { superseded: true };
      }
      const isCurrent = () => requestIsCurrent()
        && servers.get(senderId) === server;
      const send = (channel, value) => {
        if (!isCurrent()) return;
        try {
          sender.send(channel, value);
        } catch (error) {
          if (!sender.isDestroyed()) console.error(`[ipc:${channel}] ${error.message}`);
        }
      };
      const eventBatcher = createStreamEventBatcher((value) => send("codex:event", value));
      server.rendererEventBatcher = eventBatcher;
      servers.set(senderId, server);
      server.on("notification", (message) => {
        if (message.method === "serverRequest/resolved") {
          discardApprovalRequest(server, message.params?.requestId);
        }
        trackProviderRequest(server, message);
        handleScheduledTaskNotification(server, message);
        eventBatcher.push(mappedServerMessage(server, message));
      });
      server.on("server-request", (message) => {
        if (!isCurrent()) return;
        eventBatcher.flush();
        if (message.method === "currentTime/read") {
          server.respond(message.id, { currentTimeAt: Math.floor(Date.now() / 1000) });
          return;
        }
        if (INTERACTIVE_SERVER_REQUESTS.has(message.method)) {
          registerApprovalRequest(server, message, mappedServerMessage(server, message), sender, send);
          return;
        }
        server.respondError(message.id, -32601, `ChatSwitch does not support ${message.method}.`);
        send("codex:diagnostic", `已安全取消不支持的 Codex 请求：${message.method}`);
      });
      server.on("diagnostic", (message) => {
        eventBatcher.flush();
        send("codex:diagnostic", message);
      });
      server.on("exit", (code, detail = null) => {
        eventBatcher.flush();
        clearApprovalRequests(server);
        interruptActiveLogicalTurns(server, "server-exit");
        failScheduledTasksForServer(server, `连接已断开（退出代码 ${code ?? "未知"}）。`);
        if (!isCurrent()) return;
        send("codex:disconnected", {
          code,
          reason: "server-exit",
          providerId: currentProviderId(server),
          detail: detail ? String(detail).slice(0, 1000) : null,
          reconnectable: true,
        });
        servers.delete(senderId);
      });
      try {
        await server.start();
        if (provider.type === "claude") {
          try {
            await fetchClaudeModels(
              provider.baseUrl,
              provider.env?.[provider.envKey],
              net.fetch,
            );
          } catch (error) {
            if ([401, 403].includes(error.status)) {
              throw new Error(`Claude Token 无效或已失去权限：${error.message}`);
            }
          }
        }
      } catch (error) {
        const wasCurrentRequest = requestIsCurrent();
        if (servers.get(senderId) === server) servers.delete(senderId);
        server.stop();
        if (!wasCurrentRequest) return { superseded: true };
        throw error;
      }
      if (!isCurrent()) {
        server.stop();
        return { superseded: true };
      }
      let account;
      try {
        account = await accountSnapshot(server);
        requireAuthenticatedOfficialSnapshot(provider, account);
      } catch (error) {
        if (servers.get(senderId) === server) servers.delete(senderId);
        server.stop();
        if (!requestIsCurrent()) return { superseded: true };
        throw error;
      }
      runDueScheduledTasks().catch((error) => console.error(`[scheduled-task] ${error.message}`));
      if (!isCurrent()) {
        server.stop();
        return { superseded: true };
      }
      let publicProvider;
      try {
        publicProvider = providerStore.publicProvider(providerId);
      } catch (error) {
        if (!isCurrent()) return { superseded: true };
        throw error;
      }
      return {
        provider: providerId,
        label: publicProvider.connectionLabel,
        brand: publicProvider.brand,
        vendorLabel: provider.vendorLabel || null,
        providerPreset: publicProvider.preset || null,
        providerType: provider.type,
        providerEngine: provider.engine || "codex",
        runtimeKind: server.runtimeKind || null,
        modelProvider: provider.modelProvider,
        modelSource: provider.discoveredModels?.length ? "provider" : "configured",
        modelWarning,
        ...account,
      };
    })();

    const attempt = { providerId, promise: task };
    connectionAttempts.set(senderId, attempt);
    try {
      return await task;
    } finally {
      if (connectionAttempts.get(senderId) === attempt) connectionAttempts.delete(senderId);
    }
  });

  handleRendererIpc("codex:list", (event, query) => sharedListThreads(
    serverFor(event),
    query?.search,
    Boolean(query?.archived),
  ));
  handleRendererIpc("codex:models", async (event) => {
    const server = serverFor(event);
    if (server.provider.type !== "claude") {
      const response = await server.listModels();
      if (server.provider.type === "relay" && !server.provider.discoveredModels?.length) {
        return { ...response, data: [] };
      }
      if (!["api", "relay"].includes(server.provider.type)) return response;
      return {
        ...response,
        data: (response.data || []).map((model) => {
          const profile = reasoningProfile(model.model || model.id);
          if (profile) return { ...model, reasoningCapabilitiesVerified: true };
          const declared = Array.isArray(model.supportedReasoningEfforts)
            ? model.supportedReasoningEfforts
            : [];
          if (declared.length) {
            return {
              ...model,
              defaultReasoningEffort: model.defaultReasoningEffort || "medium",
              reasoningCapabilitiesVerified: model.reasoningCapabilitiesVerified !== false,
            };
          }
          return {
            ...model,
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: GENERIC_REASONING_EFFORTS,
            reasoningCapabilitiesVerified: false,
          };
        }),
      };
    }
    const apiKey = server.provider.env?.[server.provider.envKey];
    const catalog = await fetchClaudeModelsSafely(server.provider.baseUrl, apiKey, net.fetch);
    const efforts = ["low", "medium", "high", "xhigh", "max"]
      .map((reasoningEffort) => ({ reasoningEffort, description: "" }));
    const seen = new Set();
    const data = [];
    for (const route of catalog.routes) {
      seen.add(route.id);
      data.push({
        id: route.id,
        model: route.id,
        displayName: route.label,
        description: `${route.id} → ${route.actualModel}`,
        isDefault: route.id === server.provider.model,
        defaultReasoningEffort: "high",
        supportedReasoningEfforts: efforts,
      });
    }
    for (const model of catalog.models) {
      if (seen.has(model.id)) continue;
      data.push({
        id: model.id,
        model: model.id,
        displayName: model.label,
        description: model.id,
        isDefault: model.id === server.provider.model,
        defaultReasoningEffort: "high",
        supportedReasoningEfforts: efforts,
      });
    }
    if (!data.length) {
      data.push({
        id: server.provider.model,
        model: server.provider.model,
        displayName: server.provider.model,
        description: "当前配置模型",
        isDefault: true,
        defaultReasoningEffort: "high",
        supportedReasoningEfforts: efforts,
      });
    }
    return { data, nextCursor: null, warning: catalog.warning, status: catalog.status };
  });
  handleRendererIpc("codex:skills", async (event, payload = {}) => {
    const server = serverFor(event);
    if (server.provider.engine === "claude") return { data: [], warning: "Claude 连接不使用 Codex Skills。" };
    if (server.provider.engine === "openai-compatible") {
      return { data: [], warning: "Chat Completions 连接不提供 Codex 本地工具或 Skills。" };
    }
    const response = await server.request("skills/list", {
      cwds: [payload.cwd || providerStore.conversationHome()],
      forceReload: Boolean(payload.forceReload),
    });
    const disabled = new Set(providerStore.disabledSkills().map((name) => name.toLocaleLowerCase("en-US")));
    return {
      ...response,
      data: (response?.data || []).map((group) => ({
        ...group,
        skills: (group?.skills || []).filter((skill) => !disabled.has(String(skill?.name || "").toLocaleLowerCase("en-US"))),
      })),
    };
  });
  handleRendererIpc("codex:read", async (event, threadId) => (
    rendererThreadWindow(await sharedReadThread(serverFor(event), threadId))
  ));
  handleRendererIpc("codex:search", (event, query) => searchSharedThreads(serverFor(event), query));
  handleRendererIpc("codex:read-window", async (event, payload) => (
    rendererThreadWindow(
      await sharedReadThread(serverFor(event), payload?.threadId),
      payload?.turnCount,
    )
  ));
  handleRendererIpc("codex:account-status", (event) => accountSnapshot(serverFor(event)));
  handleRendererIpc("codex:resume", async (event, payload) => {
    const server = serverFor(event);
    try {
      return rendererThreadWindow(await resumeLogicalThread(server, payload));
    } catch {
      return rendererThreadWindow(await sharedReadThread(server, payload.threadId));
    }
  });
  handleRendererIpc("thread:branch", async (event, payload) => {
    const server = serverFor(event);
    const threadId = String(payload?.threadId || "").trim();
    const messageId = String(payload?.messageId || "").trim();
    if (!threadId || !messageId) throw new Error("请选择要分支的消息。");
    const source = await sharedReadThread(server, threadId);
    const result = sharedHistoryReaders().compatible.createBranchThread(source.thread, messageId);
    broadcastStoreSnapshot();
    return result;
  });
  handleRendererIpc("codex:start-thread", async (event, payload) => {
    const server = serverFor(event);
    const result = await server.startThread(
      payload?.cwd,
      payload?.model || null,
      { approvalMode: payload?.approvalMode || "ask" },
    );
    rememberNativeThread(server, result.thread?.id);
    return result;
  });
  handleRendererIpc("codex:start-turn", (event, payload) => startLogicalTurn(serverFor(event), payload));
  handleRendererIpc("codex:steer", (event, payload) => steerLogicalTurn(serverFor(event), payload));
  handleRendererIpc("codex:rename", (event, payload) => {
    const server = serverFor(event);
    const logicalId = logicalThreadId(server, payload.threadId);
    const nativeThreadId = branchForServer(server, logicalId)?.threadId || logicalId;
    return server.renameThread(nativeThreadId, payload.name);
  });
  handleRendererIpc("codex:interrupt", (event, payload) => {
    const server = serverFor(event);
    const logicalId = logicalThreadId(server, payload.threadId);
    const nativeThreadId = branchForServer(server, logicalId)?.threadId || logicalId;
    return server.request("turn/interrupt", { ...payload, threadId: nativeThreadId });
  });
  handleRendererIpc("codex:approval-response", (event, payload) => {
    const resolved = settleApprovalRequest(serverFor(event), payload.id, payload.result, "renderer");
    return { resolved, alreadyResolved: !resolved };
  });

  const initialDeepLink = chatSwitchLinkFromArgs(process.argv);
  const initialWindow = initialDeepLink ? null : createWindow(
    process.env.CHATSWITCH_OPEN_PROVIDER || process.env.CHATSWITCH_QA_PROVIDER || null,
    process.env.CHATSWITCH_OPEN_PROJECT || process.env.CHATSWITCH_QA_PROJECT || null,
    process.env.CHATSWITCH_OPEN_THREAD || process.env.CHATSWITCH_QA_THREAD || null,
    process.env.CHATSWITCH_OPEN_PROJECT_ID || null,
  );
  for (const link of [initialDeepLink, ...pendingDeepLinks.splice(0)].filter(Boolean)) openDeepLink(link);
  if (providerStore.conversationMirrorSettings?.().enabled) {
    runConversationMirror().catch((error) => console.error(`[conversation-mirror] ${error.message}`));
    restartConversationMirrorTimer();
  }
  if (process.env.CHATSWITCH_QA_MULTI_PROVIDER === "1") runMultiProviderWindowQa(initialWindow);
  app.on("activate", () => {
    showAppWindow();
  });
});

app.on("window-all-closed", () => {
  for (const server of servers.values()) {
    clearApprovalRequests(server);
    failScheduledTasksForServer(server, "ChatSwitch 已关闭。");
    server.stop();
  }
  if ((quitting || process.env.CHATSWITCH_QA_SCREENSHOT || !tray || providerStore?.appSettings().closeToTray === false)
    && process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => { quitting = true; });
app.on("will-quit", () => {
  tray?.destroy();
  tray = null;
});
