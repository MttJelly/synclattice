const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");
const { APP_VERSION } = require("../src/app-version");

const root = path.resolve(__dirname, "..");
const artifactRoot = path.join(__dirname, "multi-window-artifacts");
const desktopScreenshot = path.join(artifactRoot, "vue-renderer-desktop.png");
const lightDesktopScreenshot = path.join(artifactRoot, "vue-renderer-desktop-light.png");
const accountUsageScreenshot = path.join(artifactRoot, "vue-renderer-account-usage.png");
const compactScreenshot = path.join(artifactRoot, "vue-renderer-compact.png");
const conversationScreenshot = path.join(artifactRoot, "vue-renderer-conversation.png");
const attachmentScreenshot = path.join(artifactRoot, "vue-renderer-attachment.png");
const localHistoryScreenshot = path.join(artifactRoot, "vue-renderer-local-history.png");
const filePreviewScreenshot = path.join(artifactRoot, "vue-renderer-file-preview.png");
const localProviderScreenshot = path.join(artifactRoot, "vue-renderer-local-providers.png");
const usageScreenshot = path.join(artifactRoot, "vue-renderer-usage.png");
const usageCompactScreenshot = path.join(artifactRoot, "vue-renderer-usage-compact.png");
const backupScreenshot = path.join(artifactRoot, "vue-renderer-backup.png");
const syncScreenshot = path.join(artifactRoot, "vue-renderer-sync.png");
const appSettingsScreenshot = path.join(artifactRoot, "vue-renderer-app-settings.png");
const importPreviewScreenshot = path.join(artifactRoot, "vue-renderer-import-preview.png");
const healthScreenshot = path.join(artifactRoot, "vue-renderer-health.png");
const extensionsScreenshot = path.join(artifactRoot, "vue-renderer-extensions.png");
const skillInstallScreenshot = path.join(artifactRoot, "vue-renderer-skill-install.png");
const darkExtensionsScreenshot = path.join(artifactRoot, "vue-renderer-extensions-dark.png");
const confirmationScreenshot = path.join(artifactRoot, "vue-renderer-confirmation.png");
const interactiveLayoutAudits = [];
app.setPath("userData", path.join(__dirname, ".vue-renderer-profile"));

async function rendererSnapshot(window) {
  return window.webContents.executeJavaScript(`(() => {
    const providerRows = [...document.querySelectorAll('.provider-option-row')];
    const providerActionLayout = providerRows.map((row) => {
      const controls = [...row.querySelectorAll('.provider-trailing, .provider-configure, .provider-delete')];
      const boxes = controls.map((control) => {
        const rect = control.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      });
      return {
        actions: row.querySelectorAll('.provider-row-actions').length,
        overlaps: boxes.some((box, index) => boxes.slice(index + 1).some((other) => !(
          box.right <= other.left || other.right <= box.left || box.bottom <= other.top || other.bottom <= box.top
        )))
      };
    });
    return {
    vueMounted: Boolean(window.chatSwitchVue),
    wordmarkIconLoaded: Boolean(document.querySelector('.wordmark-icon')?.complete && document.querySelector('.wordmark-icon')?.naturalWidth),
    stateExposed: Boolean(window.chatSwitchState),
    pending: document.querySelector('#app').classList.contains('vue-pending'),
    providerDialogVisible: !document.querySelector('#provider-overlay').classList.contains('hidden'),
    connectionDialogVisible: !document.querySelector('#connection-overlay').classList.contains('hidden'),
    composerOverflow: document.querySelector('.composer').scrollWidth > document.querySelector('.composer').clientWidth,
    bodyOverflow: document.body.scrollWidth > document.body.clientWidth || document.body.scrollHeight > document.body.clientHeight,
    sidebarWidth: Math.round(document.querySelector('.sidebar').getBoundingClientRect().width),
    relayColumns: getComputedStyle(document.querySelector('#relay-form')).gridTemplateColumns,
    formActionsBackground: getComputedStyle(document.querySelector('#relay-form .form-actions')).backgroundColor,
    providerGroups: [...document.querySelectorAll('.provider-group-label')].map((node) => node.textContent),
    actionGroups: [...document.querySelectorAll('.dialog-action-group-title')].map((node) => node.textContent),
    selectedProviderRows: document.querySelectorAll('.provider-option-row.is-selected').length,
    providerActionLayout,
    fatal: document.querySelector('.renderer-fatal')?.textContent || null
    };
  })()`);
}

async function capturePageWithRetry(window) {
  await window.webContents.executeJavaScript(`new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      document.documentElement.getBoundingClientRect();
      resolve();
    }));
  })`);
  interactiveLayoutAudits.push(await window.webContents.executeJavaScript(`(() => {
    const visible = (node) => {
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      for (let current = node; current; current = current.parentElement) {
        const style = getComputedStyle(current);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) <= 0) return false;
      }
      return true;
    };
    const overlays = [...document.querySelectorAll('.overlay:not(.hidden)')].filter(visible);
    const scope = overlays.at(-1) || document;
    const controls = [...new Set(scope.querySelectorAll('button, input, select, textarea, a[href], [role="button"]'))]
      .filter(visible)
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return {
          node,
          rect,
          name: node.id ? '#' + node.id : node.getAttribute('aria-label') || node.title || node.className || node.tagName
        };
      });
    const overlaps = [];
    for (let index = 0; index < controls.length; index += 1) {
      const left = controls[index];
      for (const right of controls.slice(index + 1)) {
        if (left.node.contains(right.node) || right.node.contains(left.node)) continue;
        const overlapWidth = Math.min(left.rect.right, right.rect.right) - Math.max(left.rect.left, right.rect.left);
        const overlapHeight = Math.min(left.rect.bottom, right.rect.bottom) - Math.max(left.rect.top, right.rect.top);
        if (overlapWidth > 1 && overlapHeight > 1) overlaps.push([left.name, right.name]);
      }
    }
    return {
      capture: ${interactiveLayoutAudits.length + 1},
      scope: scope.id ? '#' + scope.id : 'document',
      controls: controls.length,
      overlaps
    };
  })()`));
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const image = await window.webContents.capturePage();
      if (!image.isEmpty()) {
        if (attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, 35));
          continue;
        }
        return image;
      }
      lastError = new Error("capturePage returned an empty image.");
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw lastError;
}

async function run() {
  await app.whenReady();
  const extensionFixture = {
    skills: [
      { name: "nature-writing", description: "Draft and restructure technical writing", path: "F:\\private\\nature-writing\\SKILL.md", enabled: true, removable: true, source: "F:\\private\\installed\\nature-writing" },
      { name: "figure-designer", description: "Design submission-grade figures", path: "F:\\private\\figure-designer\\SKILL.md", enabled: false, source: "ChatSwitch 镜像库" },
    ],
    prompts: [
      { id: "prompt_fixture", name: "summarize", description: "提炼当前内容", content: "请提炼当前内容的关键结论。", createdAt: Date.now(), updatedAt: Date.now() },
    ],
    mcpServers: [
      { id: "mcp_fixture", name: "Local tools", transport: "stdio", command: "node", args: ["server.js"], envKeys: ["ACCESS_TOKEN"], enabled: true, hasSecrets: true },
    ],
  };
  const syncFixture = {
    backend: "webdav",
    directory: "F:\\ChatSwitch Sync",
    webdavUrl: "https://dav.example.test/chatswitch/",
    hasWebdavCredentials: true,
    autoSync: true,
    lastSyncedAt: Date.now() - 60000,
    remoteExists: true,
    history: [
      { id: "sync_1", at: Date.now() - 60000, status: "success", direction: "push", message: "已将本机配置写入同步目录。" },
      { id: "sync_2", at: Date.now() - 3600000, status: "conflict", direction: "none", message: "检测到配置冲突。" },
    ],
  };
  let localProviderImported = false;
  const steerRequests = [];
  const interruptRequests = [];
  const connectRequests = [];
  const startThreadRequests = [];
  const startTurnRequests = [];
  const copiedTexts = [];
  const copiedImages = [];
  const persistedQueues = [];
  const claimedQueues = [];
  const windowThemeRequests = [];
  const approvalResponses = [];
  const localHistoryImportRequests = [];
  const localHistoryBulkImportRequests = [];
  let clipboardPasteRequests = 0;
  let pendingSteerResolve = null;
  let importedLocalHistoryThread = null;
  let branchedThread = null;
  let accountStatusRequests = 0;
  let officialLoginRequests = 0;
  const officialLoginProviderIds = [];
  const accountAddRequests = [];
  const providerProbeRequests = [];
  let accountFixtureProviderId = null;
  let officialAuthenticated = false;
  ipcMain.handle("app:bootstrap", () => ({
    providerPresets: [
      { id: "deepseek", label: "DeepSeek", group: "国内模型", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", protocol: "chat_completions", note: "DeepSeek 兼容接口。" },
      { id: "qwen", label: "Qwen / DashScope", group: "国内模型", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus", protocol: "chat_completions", note: "Qwen 兼容接口。" },
      { id: "custom", label: "自定义模型供应商", group: "高级连接", baseUrl: "", model: "", protocol: "chat_completions", note: "OpenAI 兼容接口。" },
      { id: "responses", label: "Codex Responses 中转", group: "高级连接", baseUrl: "", model: "", protocol: "responses", note: "Responses 兼容接口。" },
    ],
    providers: [
      { id: "official", type: "official", brand: "openai", label: "OpenAI", connectionLabel: "OpenAI 官方" },
      { id: "deepseek-fixture", type: "relay", brand: "openai", preset: "deepseek", protocol: "chat_completions", label: "DeepSeek", connectionLabel: "DeepSeek", model: "deepseek-chat", baseUrl: "https://api.deepseek.com/v1", deletable: true, hasStoredKey: true },
      { id: "qwen-fixture", type: "relay", brand: "openai", preset: "qwen", protocol: "chat_completions", label: "Qwen", connectionLabel: "Qwen", model: "qwen-plus", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", deletable: true, hasStoredKey: true },
    ],
    projects: [],
    projectThreads: {},
    hiddenProjectRoots: [],
    threadSettings: {},
    threadAliases: {},
    providerRoutes: {
      "deepseek-fixture": {
        enabled: true,
        fallbackProviderIds: ["qwen-fixture"],
        failureThreshold: 2,
        cooldownMs: 60000,
      },
    },
    hiddenThreadIds: [],
    deletedThreadIds: [],
    localArchivedThreadIds: [],
    pendingDeletions: [],
    scheduledTasks: [],
    promptTemplates: extensionFixture.prompts,
    mcpServers: extensionFixture.mcpServers,
    runningTaskIds: [],
    recordHome: path.join(root, "chatswitch-data", "conversations"),
  }));
  ipcMain.on("window:set-theme", (_event, theme) => windowThemeRequests.push(theme));
  ipcMain.handle("extension:list", () => structuredClone(extensionFixture));
  ipcMain.handle("extension:refresh-skills", () => ({ result: { activated: 1 }, ...structuredClone(extensionFixture) }));
  ipcMain.handle("extension:install-skill", () => ({ installed: [{ name: "installed-skill" }], ...structuredClone(extensionFixture) }));
  ipcMain.handle("extension:remove-skill", (_event, name) => ({ removed: name, ...structuredClone(extensionFixture) }));
  ipcMain.handle("extension:set-skill-enabled", (_event, input) => {
    const skill = extensionFixture.skills.find((item) => item.name === input.name);
    if (skill) skill.enabled = Boolean(input.enabled);
    return { updated: input, ...structuredClone(extensionFixture) };
  });
  ipcMain.handle("prompt:save", (_event, input) => ({ ...input, id: input.id || "prompt_saved", updatedAt: Date.now() }));
  ipcMain.handle("prompt:remove", (_event, id) => ({ id }));
  ipcMain.handle("mcp:save", (_event, input) => ({ ...input, id: input.id || "mcp_saved", envKeys: Object.keys(input.env || {}), hasSecrets: true, updatedAt: Date.now() }));
  ipcMain.handle("mcp:remove", (_event, id) => ({ id }));
  ipcMain.handle("mcp:test", () => ({ ok: true, latencyMs: 24, detail: "进程已成功启动" }));
  ipcMain.handle("usage:get", (_event, input) => ({
    providerId: input?.providerId || null,
    requestCount: 3,
    completedCount: 1,
    failedCount: 1,
    interruptedCount: 1,
    inputTokens: 2500,
    outputTokens: 900,
    totalTokens: 3400,
    costUsd: 0.012345,
    averageDurationMs: 1280,
    daily: Array.from({ length: 14 }, (_, index) => {
      const date = new Date();
      date.setDate(date.getDate() - (13 - index));
      return {
        day: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`,
        requestCount: index % 4,
        totalTokens: index % 4 === 0 ? 0 : (index + 1) * 240,
        costUsd: index * 0.0003,
      };
    }),
    logs: [
      { providerId: "deepseek-fixture", model: "deepseek-chat", status: "completed", durationMs: 980, totalTokens: 1800, costUsd: 0.006, finishedAt: Date.now() },
      { providerId: "qwen-fixture", model: "qwen-plus", status: "interrupted", durationMs: 1450, totalTokens: 900, costUsd: 0.003, finishedAt: Date.now() - 60000 },
      { providerId: "deepseek-fixture", model: "deepseek-reasoner", status: "failed", durationMs: 1410, totalTokens: 700, costUsd: 0.003345, finishedAt: Date.now() - 120000 },
    ],
  }));
  ipcMain.handle("usage:pricing", () => ({}));
  ipcMain.handle("usage:save-pricing", (_event, input) => ({
    inputPerMillion: Number(input.inputPerMillion),
    cachedInputPerMillion: Number(input.cachedInputPerMillion),
    outputPerMillion: Number(input.outputPerMillion),
    updatedAt: Date.now(),
  }));
  ipcMain.handle("usage:clear", () => ({ removed: 3, providerId: null }));
  ipcMain.handle("provider:probe-models", (_event, input) => {
    providerProbeRequests.push(structuredClone(input || {}));
    return {
      models: [input.providerId === "qwen-fixture" ? "qwen-plus" : "deepseek-chat"],
      latencyMs: input.providerId === "qwen-fixture" ? 48 : 36,
    };
  });
  ipcMain.handle("codex:connect", (_event, providerId) => {
    connectRequests.push(providerId);
    if (providerId === "official" || providerId === accountFixtureProviderId) {
      return {
        provider: providerId,
        label: "OpenAI 官方",
        brand: "openai",
        providerType: "official",
        providerEngine: "codex",
        modelProvider: "openai",
        account: officialAuthenticated ? { type: "chatgpt", email: "tester@example.test", planType: "plus" } : null,
        requiresOpenaiAuth: true,
        rateLimits: officialAuthenticated ? { groups: [], resetCredits: 0 } : null,
      };
    }
    return {
      provider: providerId,
      label: "DeepSeek",
      brand: "openai",
      providerPreset: "deepseek",
      providerType: "relay",
      providerEngine: "openai-compatible",
      modelProvider: "deepseek",
    };
  });
  ipcMain.handle("provider:add-account", (_event, input) => {
    accountAddRequests.push(structuredClone(input || {}));
    accountFixtureProviderId = "account_fixture";
    const label = String(input?.label || "").trim() || "ChatGPT 官方账号";
    return {
      id: accountFixtureProviderId,
      type: "account",
      brand: "openai",
      label,
      connectionLabel: label,
      modelProvider: "openai",
      deletable: true,
    };
  });
  ipcMain.handle("auth:official-login", (_event, providerId) => {
    officialLoginRequests += 1;
    officialLoginProviderIds.push(providerId);
    if (officialLoginRequests === 1) throw new Error("ChatGPT 登录未完成，请在浏览器中完成认证后重试。");
    officialAuthenticated = true;
    return {
      account: { type: "chatgpt", email: "tester@example.test", planType: "plus" },
      requiresOpenaiAuth: true,
      rateLimits: { groups: [], resetCredits: 0 },
      accountUsage: null,
    };
  });
  ipcMain.handle("codex:account-status", () => {
    accountStatusRequests += 1;
    return {
      account: { type: "chatgpt", email: "tester@example.test", planType: "plus" },
      requiresOpenaiAuth: true,
      rateLimits: {
        groups: [{
          id: "codex-dynamic-id",
          name: "Codex",
          planType: "plus",
          windows: [
            { kind: "primary", usedPercent: 22.5, windowDurationMins: 300, resetsAt: 1786753800 },
            { kind: "secondary", usedPercent: 48, windowDurationMins: 10080, resetsAt: 1787013000 },
          ],
          credits: { hasCredits: true, unlimited: false, balance: "9.5" },
          individualLimit: null,
          reachedType: null,
        }],
        resetCredits: 1,
      },
      accountUsage: {
        lifetimeTokens: 1250000,
        peakDailyTokens: 250000,
        longestRunningTurnSec: 360,
        currentStreakDays: 7,
        longestStreakDays: 12,
      },
      rateLimitsError: null,
      accountUsageError: null,
    };
  });
  ipcMain.handle("codex:list", () => ({
    data: [importedLocalHistoryThread, branchedThread].filter(Boolean).map((thread) => structuredClone(thread)),
    nextCursor: null,
  }));
  ipcMain.handle("codex:list-local", () => ({
    data: importedLocalHistoryThread ? [structuredClone(importedLocalHistoryThread)] : [],
    nextCursor: null,
  }));
  ipcMain.handle("codex:read-local", (_event, threadId) => {
    if (threadId !== importedLocalHistoryThread?.id) throw new Error("未找到本地私有会话。");
    return { thread: structuredClone(importedLocalHistoryThread) };
  });
  ipcMain.handle("codex:models", () => ({
    data: [{ id: "deepseek-chat", model: "deepseek-chat", displayName: "DeepSeek Chat", isDefault: true, defaultReasoningEffort: "medium", supportedReasoningEfforts: ["low", "medium", "high"] }],
    nextCursor: null,
  }));
  ipcMain.handle("codex:skills", () => ({ data: [] }));
  ipcMain.handle("thread:save-settings", (_event, input) => ({
    [`${input.threadId}::${input.providerId}`]: {
      model: input.model,
      effort: input.effort,
      approvalMode: input.approvalMode,
      updatedAt: Date.now(),
    },
  }));
  ipcMain.handle("codex:start-thread", (_event, input) => {
    startThreadRequests.push(structuredClone(input));
    return { thread: { id: "unexpected-reconnect-thread", turns: [] } };
  });
  ipcMain.handle("codex:resume", (_event, input) => ({
    thread: input.threadId === importedLocalHistoryThread?.id
      ? { ...structuredClone(importedLocalHistoryThread), turns: [] }
      : input.threadId === branchedThread?.id
        ? structuredClone(branchedThread)
      : { id: input.threadId, name: "界面优化讨论", cwd: "F:\\codepro", turns: [] },
  }));
  ipcMain.handle("thread:branch", (_event, input) => {
    branchedThread = {
      id: "branch-vue-fixture",
      name: "界面优化讨论 · 分支",
      cwd: "F:\\codepro",
      model: "deepseek-chat",
      _historyEngine: "openai-compatible",
      turns: [{
        id: "branch-turn-1",
        status: "completed",
        items: [
          { id: "branch-user-1", type: "userMessage", content: [{ type: "text", text: "请分析当前界面，并给出可以立即实施的改进。" }] },
          { id: "branch-reasoning-1", type: "reasoning", summary: [{ type: "summary_text", text: "先检查信息层级。" }] },
          { id: "branch-agent-1", type: "agentMessage", text: "方案 A", phase: "final_answer" },
        ],
      }],
    };
    return { imported: true, duplicate: false, thread: { ...structuredClone(branchedThread), turns: [] } };
  });
  ipcMain.handle("codex:start-turn", (_event, input) => {
    startTurnRequests.push(structuredClone(input));
    return { turn: { id: "unexpected-reconnect-turn" } };
  });
  ipcMain.handle("codex:steer", (_event, input) => {
    steerRequests.push(structuredClone(input));
    if (/等待引导完成/.test(input.displayText || input.text || "")) {
      return new Promise((resolve) => { pendingSteerResolve = resolve; });
    }
    if (/竞态/.test(input.displayText || input.text || "")) {
      return { steered: false, inactive: true, expectedTurnId: input.expectedTurnId };
    }
    return { turnId: input.expectedTurnId };
  });
  ipcMain.handle("codex:interrupt", (_event, input) => {
    interruptRequests.push(structuredClone(input));
    return {};
  });
  ipcMain.handle("codex:approval-response", (_event, input) => {
    approvalResponses.push(structuredClone(input));
    return { resolved: true, alreadyResolved: false };
  });
  ipcMain.handle("app:copy-text", (_event, value) => {
    copiedTexts.push(String(value || ""));
    return true;
  });
  ipcMain.handle("app:copy-image", (_event, value) => {
    copiedImages.push(structuredClone(value));
    return true;
  });
  ipcMain.handle("clipboard:images", () => {
    clipboardPasteRequests += 1;
    return { paths: [conversationScreenshot], source: "image" };
  });
  ipcMain.handle("app:notify", () => true);
  ipcMain.handle("thread:save-message-queue", (_event, input) => {
    persistedQueues.push(structuredClone(input));
    return input.messages || [];
  });
  ipcMain.handle("thread:claim-message-queue", (_event, input) => {
    claimedQueues.push(structuredClone(input));
    return {
      busy: false,
      message: structuredClone(input.message),
      messages: structuredClone(input.remainingMessages || []),
    };
  });
  ipcMain.handle("thread:restore-message-queue", (_event, input) => [structuredClone(input.message)]);
  ipcMain.handle("codex:search", (_event, query) => ([{
    id: "vue-conversation-fixture",
    snippet: `消息正文命中：${query}`,
  }]));
  ipcMain.handle("backup:list", () => ([
    { name: "chatswitch-backup-latest.json", createdAt: Date.now(), size: 24576 },
    { name: "chatswitch-backup-previous.json", createdAt: Date.now() - 21600000, size: 23800 },
  ]));
  ipcMain.handle("backup:create", () => ({ created: true, name: "chatswitch-backup-latest.json", createdAt: Date.now() }));
  ipcMain.handle("backup:restore", (_event, name) => ({ restored: true, name, restoredAt: Date.now() }));
  ipcMain.handle("sync:status", () => structuredClone(syncFixture));
  ipcMain.handle("sync:configure", (_event, input) => ({ ...structuredClone(syncFixture), ...input }));
  ipcMain.handle("sync:configure-webdav", (_event, input) => ({ ...structuredClone(syncFixture), ...input, backend: "webdav", hasWebdavCredentials: true }));
  ipcMain.handle("sync:run", (_event, mode) => ({
    ...structuredClone(syncFixture),
    result: { status: "success", direction: mode === "pull" ? "pull" : "push", message: "同步完成。" },
    conflict: false,
  }));
  ipcMain.handle("app:settings", () => ({ launchAtLogin: false, closeToTray: true, version: APP_VERSION }));
  ipcMain.handle("app:save-settings", (_event, input) => ({ ...input }));
  ipcMain.handle("app:check-update", () => ({
    status: "available",
    currentVersion: APP_VERSION,
    latestVersion: "0.2.0",
    releaseUrl: "https://github.com/MttJelly/chatswitch/releases/tag/v0.2.0",
    message: `发现新版本 v0.2.0，当前为 v${APP_VERSION}。`,
  }));
  ipcMain.handle("file:preview", (_event, target) => ({
    filePath: String(target || "F:\\codepro\\notes.txt"),
    fileName: "notes.txt",
    extension: ".txt",
    size: 128,
    kind: "text",
    content: "ChatSwitch 文件预览测试\n不会调用系统默认程序。",
  }));
  ipcMain.handle("file:open", () => ({ opened: true }));
  ipcMain.handle("local-history:sources", () => ([
    { id: "codex", label: "Codex", description: "Codex CLI 与桌面客户端", available: true },
    { id: "claude", label: "Claude Code", description: "Claude Code 本地项目会话", available: true },
  ]));
  ipcMain.handle("local-history:list", (_event, input) => ({
    sourceId: input.sourceId,
    total: 2,
    scanned: 2,
    conversations: [
      { id: `${input.sourceId}-local-1`, sourceId: input.sourceId, sourceLabel: input.sourceId === "claude" ? "Claude Code" : "Codex", title: "本地记录功能迭代", cwd: "F:\\codepro", model: input.sourceId === "claude" ? "claude-opus-fixture" : "gpt-fixture", updatedAt: Date.now(), messageCount: 3, archived: false },
      { id: `${input.sourceId}-local-2`, sourceId: input.sourceId, sourceLabel: input.sourceId === "claude" ? "Claude Code" : "Codex", title: "旧版界面检查", cwd: "F:\\archive", model: "fixture-model", updatedAt: Date.now() - 86400000, messageCount: 1, archived: true },
    ],
  }));
  ipcMain.handle("local-history:read", (_event, input) => ({
    id: input.conversationId,
    sourceId: input.conversationId.startsWith("claude") ? "claude" : "codex",
    sourceLabel: input.conversationId.startsWith("claude") ? "Claude Code" : "Codex",
    title: "本地记录功能迭代",
    cwd: "F:\\codepro",
    model: "gpt-fixture",
    updatedAt: Date.now(),
    messageCount: 3,
    archived: false,
    truncated: false,
    messages: [
      { role: "user", text: "读取本地聊天记录", timestamp: Date.now() - 2000 },
      { role: "reasoning", text: "验证只读路径与解析结果", timestamp: Date.now() - 1000 },
      { role: "assistant", text: "本地记录已安全显示", timestamp: Date.now() },
    ],
  }));
  ipcMain.handle("local-history:import", (_event, input) => {
    localHistoryImportRequests.push(structuredClone(input));
    importedLocalHistoryThread = {
      id: "local-imported-history-fixture",
      name: "本地记录功能迭代",
      preview: "读取本地聊天记录",
      cwd: "F:\\codepro",
      model: "gpt-fixture",
      modelProvider: "chatswitch-import",
      createdAt: Math.floor(Date.now() / 1000) - 60,
      updatedAt: Math.floor(Date.now() / 1000),
      recencyAt: Math.floor(Date.now() / 1000),
      turns: [],
      _historyEngine: "openai-compatible",
    };
    return {
      imported: true,
      duplicate: false,
      sourceLabel: "Codex",
      truncated: false,
      thread: structuredClone(importedLocalHistoryThread),
    };
  });
  ipcMain.handle("local-history:import-all", (_event, input) => {
    localHistoryBulkImportRequests.push(structuredClone(input));
    return { total: 4, imported: 4, duplicate: 0, failed: 0, errors: [] };
  });
  ipcMain.handle("local-providers:discover", () => ({
    sources: ["Codex · 用户配置"],
    warnings: [],
    scannedAt: Date.now(),
    candidates: [
      { id: "local-ready", kind: "relay", source: "Codex · 用户配置", label: "Lab Relay", baseUrl: "https://relay.example.test/v1", model: "lab-model", protocol: "responses", preset: "custom", hasCredential: true, importable: true, duplicate: localProviderImported, duplicateProviderId: localProviderImported ? "local-imported" : null, discoveredModels: ["lab-model"] },
      { id: "local-existing", kind: "relay", source: "Codex · 用户配置", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", protocol: "chat_completions", preset: "deepseek", hasCredential: true, importable: true, duplicate: true, duplicateProviderId: "deepseek-fixture", discoveredModels: [] },
      { id: "local-missing", kind: "relay", source: "Codex · 用户配置", label: "No Key Relay", baseUrl: "https://missing.example.test/v1", model: "missing-model", protocol: "responses", preset: "custom", hasCredential: false, importable: false, duplicate: false, duplicateProviderId: null, discoveredModels: [] },
    ],
  }));
  ipcMain.handle("local-providers:import", (_event, ids) => {
    localProviderImported = ids.includes("local-ready");
    return {
      results: ids.map((id) => ({ id, status: id === "local-ready" ? "imported" : "duplicate" })),
      providers: [
        { id: "official", type: "official", brand: "openai", label: "OpenAI", connectionLabel: "OpenAI 官方" },
        { id: "deepseek-fixture", type: "relay", brand: "openai", preset: "deepseek", protocol: "chat_completions", label: "DeepSeek", connectionLabel: "DeepSeek", model: "deepseek-chat", baseUrl: "https://api.deepseek.com/v1", deletable: true, hasStoredKey: true },
        { id: "qwen-fixture", type: "relay", brand: "openai", preset: "qwen", protocol: "chat_completions", label: "Qwen", connectionLabel: "Qwen", model: "qwen-plus", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", deletable: true, hasStoredKey: true },
        { id: "local-imported", type: "relay", brand: "openai", preset: "custom", protocol: "responses", label: "Lab Relay", connectionLabel: "Lab Relay", model: "lab-model", baseUrl: "https://relay.example.test/v1", deletable: true, hasStoredKey: true },
      ],
    };
  });
  ipcMain.handle("deep-link:confirm-import", (_event, input) => ({ ...input, requiresApiKey: input.importType === "provider" }));
  const errors = [];
  const window = new BrowserWindow({
    show: false,
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 640,
    webPreferences: {
      preload: path.join(root, "src", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.on("console-message", (_event, level, message) => {
    if (level >= 2) errors.push(message);
  });
  await window.loadFile(path.join(root, "src", "renderer", "index.html"));
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (window.chatSwitchVue && document.querySelectorAll('.provider-option').length === 3) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > 10000) {
        clearInterval(timer);
        reject(new Error('Vue renderer initialization timed out.'));
      }
    }, 50);
  })`);
  const authGate = await window.webContents.executeJavaScript(`(async () => {
    document.querySelector('[data-provider="official"]').click();
    const started = Date.now();
    while (!document.querySelector('#provider-error').textContent.includes('尚未登录 ChatGPT')) {
      if (Date.now() - started > 3000) throw new Error('Official auth gate timed out.');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const beforeHistory = {
      connected: state.connected,
      provider: state.provider,
      providerType: state.providerType,
      providerOverlayVisible: !document.querySelector('#provider-overlay').classList.contains('hidden'),
      sendDisabled: document.querySelector('#send-button').disabled,
      error: document.querySelector('#provider-error').textContent,
      loginButtonVisible: !document.querySelector('#official-login-button').classList.contains('hidden'),
      loginButtonText: document.querySelector('#official-login-button').textContent.replace(/\s+/g, ' ').trim(),
      claudeOfficialEntryVisible: !document.querySelector('#claude-official-entry-button').classList.contains('hidden'),
      claudeOfficialEntryText: document.querySelector('#claude-official-entry-button').textContent.replace(/\s+/g, ' ').trim(),
      accountPanelText: document.querySelector('#account-panel').textContent.replace(/\s+/g, ' ').trim(),
      localHistoryEnabled: !document.querySelector('#local-history-button').disabled,
    };
    document.querySelector('#local-history-button').click();
    const historyStarted = Date.now();
    while (document.querySelector('#local-history-overlay').classList.contains('hidden')) {
      if (Date.now() - historyStarted > 3000) throw new Error('Disconnected local history did not open.');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const localHistoryVisible = !document.querySelector('#local-history-overlay').classList.contains('hidden');
    document.querySelector('#local-history-close-button').click();
    document.querySelector('#claude-official-entry-button').click();
    const claudeStarted = Date.now();
    while (document.querySelector('#claude-overlay').classList.contains('hidden')) {
      if (Date.now() - claudeStarted > 3000) throw new Error('Claude official entry did not open.');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const claudeOfficialFlow = {
      visible: true,
      buttonText: document.querySelector('#claude-official-login-button').textContent.replace(/\s+/g, ' ').trim(),
      tokenLabel: document.querySelector('#claude-api-key').previousElementSibling.textContent.trim(),
    };
    document.querySelector('#claude-close-button').click();
    return { ...beforeHistory, localHistoryVisible, claudeOfficialFlow };
  })()`);
  const loginFlow = await window.webContents.executeJavaScript(`(async () => {
    const login = document.querySelector('#official-login-button');
    login.click();
    let started = Date.now();
    while (!document.querySelector('#provider-error').textContent.includes('登录未完成')) {
      if (Date.now() - started > 3000) throw new Error('Incomplete login state timed out.');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const failed = {
      connected: state.connected,
      overlayVisible: !document.querySelector('#provider-overlay').classList.contains('hidden'),
      error: document.querySelector('#provider-error').textContent,
    };
    login.click();
    started = Date.now();
    while (!state.connected) {
      if (Date.now() - started > 3000) throw new Error('Successful login state timed out.');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const succeeded = {
      connected: state.connected,
      overlayHidden: document.querySelector('#provider-overlay').classList.contains('hidden'),
      accountEmail: state.account?.email || null,
    };
    state.connected = false;
    state.account = null;
    state.rateLimits = null;
    state.accountUsage = null;
    document.querySelector('#provider-overlay').classList.remove('hidden');
    setConnected(false);
    renderAccountPanel();
    return { failed, succeeded };
  })()`);
  const accountFormFlow = await window.webContents.executeJavaScript(`(async () => {
    document.querySelector('#add-connection-button').click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    document.querySelector('[data-connection-tab="account"]').click();
    const input = document.querySelector('#account-form [name="label"]');
    const submit = document.querySelector('#account-form button[type="submit"]');
    const before = {
      visible: !document.querySelector('#connection-overlay').classList.contains('hidden'),
      accountTabSelected: document.querySelector('[data-connection-tab="account"]').getAttribute('aria-selected'),
      labelRequired: input.required,
      labelValue: input.value,
      submitText: submit.textContent.replace(/\\s+/g, ' ').trim(),
      helperText: document.querySelector('#account-label-help').textContent,
    };
    input.value = '';
    submit.click();
    const started = Date.now();
    while (!(state.connected && state.provider === 'account_fixture')) {
      if (Date.now() - started > 5000) throw new Error('Account form login flow timed out.');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return {
      ...before,
      connected: state.connected,
      provider: state.provider,
      overlayHidden: document.querySelector('#connection-overlay').classList.contains('hidden'),
      providerOverlayHidden: document.querySelector('#provider-overlay').classList.contains('hidden'),
      accountEmail: state.account?.email || null,
    };
  })()`);
  accountFormFlow.addRequest = structuredClone(accountAddRequests.at(-1) || null);
  accountFormFlow.loginProviderId = officialLoginProviderIds.at(-1) || null;
  const relayModelFlow = await window.webContents.executeJavaScript(`(async () => {
    document.querySelector('#add-connection-button').click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    document.querySelector('[data-connection-tab="relay"]').click();
    const form = document.querySelector('#relay-form');
    form.elements.baseUrl.value = 'https://relay.example/v1';
    form.elements.apiKey.value = 'fixture-key';
    const probe = document.querySelector('#provider-load-models');
    probe.click();
    const started = Date.now();
    while (document.querySelectorAll('#provider-model-select option').length < 2) {
      if (Date.now() - started > 3000) throw new Error('Relay model discovery timed out.');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const select = document.querySelector('#provider-model-select');
    select.value = 'deepseek-chat';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    const result = {
      visible: !document.querySelector('#connection-overlay').classList.contains('hidden'),
      modelLabel: document.querySelector('#provider-model-select').closest('label').querySelector('span').textContent,
      modelDisabled: select.disabled,
      optionCount: select.querySelectorAll('option').length,
      selected: select.value,
      inputValue: form.elements.model.value,
      helper: document.querySelector('#provider-model-help').textContent,
    };
    document.querySelector('#close-connection-button').click();
    return result;
  })()`);
  const storedRelayKeyFlow = await window.webContents.executeJavaScript(`(async () => {
    document.querySelector('[data-provider-row="deepseek-fixture"] .provider-configure').click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const form = document.querySelector('#relay-form');
    const key = form.elements.apiKey;
    const before = {
      value: key.value,
      required: key.required,
      masked: key.dataset.maskedCredential,
      helper: document.querySelector('#provider-api-key-help').textContent.replace(/\s+/g, ' ').trim(),
    };
    document.querySelector('#provider-load-models').click();
    const started = Date.now();
    while (!document.querySelector('#provider-model-status').textContent.includes('连接成功')) {
      if (Date.now() - started > 3000) throw new Error('Stored relay key probe timed out.');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const result = {
      ...before,
      busyAfter: document.querySelector('#provider-load-models').hasAttribute('aria-busy'),
      error: document.querySelector('#connection-error').textContent,
    };
    document.querySelector('#close-connection-button').click();
    return result;
  })()`);
  storedRelayKeyFlow.probeRequest = structuredClone(providerProbeRequests.at(-1) || null);
  const accountStatusRequestOffset = accountStatusRequests;
  const accountUsage = await window.webContents.executeJavaScript(`(async () => {
    state.connected = true;
    state.provider = 'official';
    state.providerType = 'official';
    state.providerEngine = 'codex';
    state.modelProvider = 'openai';
    applyAccountSnapshot({
      account: { type: 'chatgpt', email: 'tester@example.test', planType: 'plus' },
      requiresOpenaiAuth: true,
      rateLimits: {
        groups: [{
          id: 'codex-dynamic-id', name: 'Codex', planType: 'plus',
          windows: [
            { kind: 'primary', usedPercent: 22.5, windowDurationMins: 300, resetsAt: 1786753800 },
            { kind: 'secondary', usedPercent: 48, windowDurationMins: 10080, resetsAt: 1787013000 },
          ],
          credits: { hasCredits: true, unlimited: false, balance: '9.5' },
        }],
        resetCredits: 1,
      },
      accountUsage: { lifetimeTokens: 1250000, peakDailyTokens: 250000, longestRunningTurnSec: 360, currentStreakDays: 7, longestStreakDays: 12 },
    });
    const panel = document.querySelector('#account-panel');
    const refresh = document.querySelector('#refresh-account-usage');
    refresh.click();
    const started = Date.now();
    while (state.accountRefreshPromise) {
      if (Date.now() - started > 3000) throw new Error('Account usage refresh timed out.');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const result = {
      text: panel.textContent.replace(/\s+/g, ' ').trim(),
      quotaRows: panel.querySelectorAll('.quota-row').length,
      progressBars: panel.querySelectorAll('[role="progressbar"]').length,
      progressValues: [...panel.querySelectorAll('[role="progressbar"]')].map((node) => node.getAttribute('aria-valuenow')),
      refreshLabel: panel.querySelector('#refresh-account-usage')?.getAttribute('aria-label') || '',
      refreshDisabled: panel.querySelector('#refresh-account-usage')?.disabled || false,
    };
    return result;
  })()`);
  accountUsage.refreshRequests = accountStatusRequests - accountStatusRequestOffset;
  fs.mkdirSync(artifactRoot, { recursive: true });
  fs.writeFileSync(accountUsageScreenshot, (await capturePageWithRetry(window)).toPNG());
  await window.webContents.executeJavaScript(`(() => {
    state.connected = false;
    state.account = null;
    state.rateLimits = null;
    state.accountUsage = null;
    state.provider = 'official';
    state.providerType = 'official';
    elements.overlay.classList.remove('hidden');
    setConnected(false);
    renderAccountPanel();
  })()`);
  await window.webContents.executeJavaScript("applyTheme('light')");
  await new Promise((resolve) => setTimeout(resolve, 150));
  const lightDesktop = await rendererSnapshot(window);
  fs.writeFileSync(lightDesktopScreenshot, (await capturePageWithRetry(window)).toPNG());
  await window.webContents.executeJavaScript("applyTheme('dark')");
  await new Promise((resolve) => setTimeout(resolve, 150));
  const desktop = await rendererSnapshot(window);
  fs.writeFileSync(desktopScreenshot, (await capturePageWithRetry(window)).toPNG());
  window.setSize(900, 640);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const compact = await rendererSnapshot(window);
  fs.writeFileSync(compactScreenshot, (await capturePageWithRetry(window)).toPNG());
  window.setSize(1200, 800);
  await window.webContents.executeJavaScript(`(() => {
    document.querySelectorAll('.overlay').forEach((node) => node.classList.add('hidden'));
    state.connected = true;
    state.provider = 'deepseek-fixture';
    state.providerType = 'relay';
    state.providerEngine = 'openai-compatible';
    state.modelCatalog = [{ id: 'deepseek-chat', model: 'deepseek-chat', displayName: 'DeepSeek Chat', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: ['low', 'medium', 'high'] }];
    const thread = {
      id: 'vue-conversation-fixture',
      name: '界面优化讨论',
      cwd: 'F:\\\\codepro',
      model: 'deepseek-chat',
      turns: [{
        id: 'turn-1',
        status: 'completed',
        items: [
          { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: '请分析当前界面，并给出可以立即实施的改进。' }] },
          { id: 'reasoning-1', type: 'reasoning', summary: [
            { type: 'summary_text', text: '先检查信息层级、' },
            { type: 'summary_text', text: '对比度和高频操作路径，再确定视觉调整。这个摘要故意写得更长，用于确认 DeepSeek、Codex、Claude 以及工具执行输出等过程卡片都能使用完整的会话宽度，而不会被挤成狭窄的小框。' },
            { type: 'summary_text', text: '\\n\\n第二段继续验证长文本换行、可读行高和暗色主题对比度。' },
          ] },
          { id: 'command-1', type: 'commandExecution', command: 'Get-ChildItem -Force "F:\\\\codepro\\\\src" | Select-Object -First 20', status: '已完成' },
          { id: 'file-change-1', type: 'fileChange', path: 'F:\\\\codepro\\\\src\\\\renderer\\\\app.js', diff: '@@ -1,2 +1,3 @@\\n+增加修改内容查看入口\\n-旧的占位文本', status: '已完成' },
          { id: 'agent-1', type: 'agentMessage', text: '## 优化重点\\n\\n- 收紧侧栏层级，让 Project 与会话更容易扫描。\\n- 保持输入区稳定，模型切换不应改变布局。\\n- 对运行中、已完成和错误状态使用明确但克制的提示。\\n\\n这些调整不会改变现有聊天记录或模型配置。' }
        ]
      }, {
        id: 'turn-interrupted',
        status: 'failed',
        error: { code: 'INCOMPLETE_STREAM', message: '模型流式连接在完成标记前关闭。已保留当前内容，可点击“继续生成”。', requestId: 'qa-request-1' },
        items: []
      }]
    };
    state.activeThread = thread;
    state.activeThreads = [thread];
    state.allThreads = [thread];
    state.threads = [thread];
    state.threadResumed = true;
    applyThreadSessionSettings(thread);
    renderConversation(thread);
    document.querySelector('#composer-input').value = '回复完成后继续处理下一条消息';
    state.runningThreads.set(thread.id, { turnId: 'turn-running', stopRequested: false, interruptingTurnId: null, startedAt: Date.now() });
    syncActiveRunState();
    syncComposerState();
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  fs.writeFileSync(conversationScreenshot, (await capturePageWithRetry(window)).toPNG());
  window.webContents.send("codex:approval", {
    id: "notification-approval-fixture",
    method: "item/permissions/requestApproval",
    params: {
      threadId: "vue-conversation-fixture",
      permissions: { network: { hosts: ["example.test"] } },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  const notificationApprovalSync = await window.webContents.executeJavaScript(`(() => ({
    visibleBeforeResolution: !document.querySelector('#approval-banner').classList.contains('hidden'),
    activeBeforeResolution: state.activeApproval?.id || null,
  }))()`);
  window.webContents.send("codex:event", {
    method: "serverRequest/resolved",
    params: { requestId: "notification-approval-fixture", source: "notification:accept" },
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  Object.assign(
    notificationApprovalSync,
    await window.webContents.executeJavaScript(`(() => ({
      hiddenAfterResolution: document.querySelector('#approval-banner').classList.contains('hidden'),
      activeAfterResolution: state.activeApproval?.id || null,
    }))()`),
    { rendererResponses: approvalResponses.length },
  );
  const conversation = await window.webContents.executeJavaScript(`(() => {
    const userBubble = document.querySelector('.message.user .message-body');
    const agentHeader = document.querySelector('.message.agent .message-header');
    const composer = document.querySelector('.composer');
    const activity = document.querySelector('.activity');
    const reasoningOutput = document.querySelector('.activity-reasoning .activity-output');
    const send = document.querySelector('#send-button');
    const stop = document.querySelector('#stop-button');
    const snapshot = {
      messages: document.querySelectorAll('.message').length,
      agentHeader: agentHeader?.textContent || '',
      userBubbleColor: userBubble ? getComputedStyle(userBubble).backgroundColor : '',
      composerWidth: Math.round(composer?.getBoundingClientRect().width || 0),
      chatOverflow: document.querySelector('#chat-view').scrollWidth > document.querySelector('#chat-view').clientWidth,
      activityWidth: Math.round(activity?.getBoundingClientRect().width || 0),
      reasoningOutputWidth: Math.round(reasoningOutput?.getBoundingClientRect().width || 0),
      reasoningLineHeight: reasoningOutput ? parseFloat(getComputedStyle(reasoningOutput).lineHeight) : 0,
      effortOptions: [...document.querySelector('#session-effort').options].map((option) => option.value),
      effortEnabled: !document.querySelector('#session-effort').disabled,
      reasoningText: reasoningOutput?.textContent || '',
      commandButtonVisible: Boolean(document.querySelector('.activity-command-toggle')),
      commandInitiallyHidden: document.querySelector('.activity-command')?.classList.contains('hidden') || false,
      changeButtonVisible: Boolean(document.querySelector('[data-activity-id="file-change-1"] .activity-command-toggle')),
      changeInitiallyHidden: document.querySelector('[data-activity-id="file-change-1"] .activity-command')?.classList.contains('hidden') || false,
      thinkingVisible: Boolean(document.querySelector('.thinking-indicator')),
      thinkingText: document.querySelector('.thinking-indicator')?.textContent.replace(/\s+/g, ' ').trim() || '',
      thinkingIsLast: document.querySelector('#chat-view').lastElementChild?.classList.contains('thinking-indicator') || false,
      thinkingWidth: Math.round(document.querySelector('.thinking-indicator')?.getBoundingClientRect().width || 0),
      thinkingHeight: Math.round(document.querySelector('.thinking-indicator')?.getBoundingClientRect().height || 0),
      interruptionVisible: Boolean(document.querySelector('.turn-interruption')),
      interruptionText: document.querySelector('.turn-interruption')?.textContent.replace(/\\s+/g, ' ').trim() || '',
      interruptionButtons: document.querySelectorAll('.continue-interrupted-turn').length,
      stopVisible: !stop.classList.contains('hidden'),
      actionTopDelta: Math.abs(Math.round(send.getBoundingClientRect().top - stop.getBoundingClientRect().top)),
      actionLaneWidth: Math.round(document.querySelector('.composer-submit').getBoundingClientRect().width),
      composerFooterOverflow: document.querySelector('.composer-footer').scrollWidth > document.querySelector('.composer-footer').clientWidth
    };
    setThreadRunning(state.activeThread.id, false);
    const commandButton = document.querySelector('.activity-command-toggle');
    commandButton?.click();
    snapshot.commandExpanded = document.querySelector('.activity-command')?.textContent || '';
    snapshot.commandToggleLabel = commandButton?.textContent.replace(/\\s+/g, ' ').trim() || '';
    commandButton?.click();
    const changeButton = document.querySelector('[data-activity-id="file-change-1"] .activity-command-toggle');
    changeButton?.click();
    snapshot.changeExpanded = document.querySelector('[data-activity-id="file-change-1"] .activity-command')?.textContent || '';
    snapshot.changeToggleLabel = changeButton?.textContent.replace(/\\s+/g, ' ').trim() || '';
    changeButton?.click();
    snapshot.thinkingHiddenAfterCompletion = !document.querySelector('.thinking-indicator');
    setThreadRunning(state.activeThread.id, true, 'turn-running');
    return snapshot;
  })()`);
  window.webContents.send("codex:event", {
    method: "item/fileChange/outputDelta",
    params: {
      threadId: "vue-conversation-fixture",
      turnId: "turn-1",
      itemId: "file-change-1",
      delta: "\\n+流式增量也被保留",
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  Object.assign(conversation, await window.webContents.executeJavaScript(`(() => {
    const row = document.querySelector('[data-activity-id="file-change-1"]');
    return {
      streamedChange: row?.querySelector('.activity-command')?.textContent || '',
      streamedLabel: row?.querySelector('code')?.textContent || '',
      streamedPath: row?.dataset.activityDetails || '',
    };
  })()`));
  window.setSize(900, 640);
  await new Promise((resolve) => setTimeout(resolve, 180));
  Object.assign(conversation, await window.webContents.executeJavaScript(`(() => {
    const send = document.querySelector('#send-button').getBoundingClientRect();
    const stop = document.querySelector('#stop-button').getBoundingClientRect();
    return {
      compactActionTopDelta: Math.abs(Math.round(send.top - stop.top)),
      compactFooterOverflow: document.querySelector('.composer-footer').scrollWidth > document.querySelector('.composer-footer').clientWidth,
      compactBodyOverflow: document.body.scrollWidth > document.body.clientWidth || document.body.scrollHeight > document.body.clientHeight,
      compactActivityWidth: Math.round(document.querySelector('.activity').getBoundingClientRect().width),
    };
  })()`));
  window.setSize(1200, 800);
  await new Promise((resolve) => setTimeout(resolve, 120));
  const permissionMode = await window.webContents.executeJavaScript(`(async () => {
    state.providerEngine = 'codex';
    state.connected = true;
    state.activeArchived = false;
    state.openingThread = false;
    setApprovalMode('ask', false);
    syncComposerState();
    const input = document.querySelector('#composer-input');
    const originalConfirm = window.confirm;
    let nativeConfirmCalls = 0;
    window.confirm = () => { nativeConfirmCalls += 1; return true; };

    document.querySelector('[data-approval-mode="full"]').click();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const overlay = document.querySelector('#confirmation-overlay');
    const modalVisible = !overlay.classList.contains('hidden');
    const modalTitle = document.querySelector('#confirmation-title').textContent;
    const modalDescription = document.querySelector('#confirmation-description').textContent;
    document.querySelector('#confirmation-cancel').click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const cancelMode = state.approvalMode;
    const cancelInputEnabled = !input.disabled;
    const cancelInputFocused = document.activeElement === input;

    document.querySelector('[data-approval-mode="full"]').click();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const dialog = document.querySelector('.app-confirm-dialog').getBoundingClientRect();
    const cancel = document.querySelector('#confirmation-cancel').getBoundingClientRect();
    const confirm = document.querySelector('#confirmation-confirm').getBoundingClientRect();
    const buttonsOverlap = !(cancel.right <= confirm.left || confirm.right <= cancel.left || cancel.bottom <= confirm.top || confirm.bottom <= cancel.top);
    document.querySelector('#confirmation-confirm').click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const confirmMode = state.approvalMode;
    const confirmInputEnabled = !input.disabled;
    const confirmInputFocused = document.activeElement === input;
    await new Promise((resolve) => setTimeout(resolve, 80));
    const delayedInputEnabled = !input.disabled;
    const delayedInputFocused = document.activeElement === input;
    window.confirm = originalConfirm;
    setApprovalMode('ask', false);
    return {
      modalVisible,
      modalTitle,
      modalDescription,
      nativeConfirmCalls,
      cancelMode,
      cancelInputEnabled,
      cancelInputFocused,
      confirmMode,
      confirmInputEnabled,
      confirmInputFocused,
      delayedInputEnabled,
      delayedInputFocused,
      dialogWithinViewport: dialog.left >= 0 && dialog.right <= innerWidth && dialog.top >= 0 && dialog.bottom <= innerHeight,
      buttonsOverlap,
      overlayHidden: overlay.classList.contains('hidden'),
      queueButtonRemoved: !document.querySelector('#queue-button'),
    };
  })()`);
  const confirmation = await window.webContents.executeJavaScript(`(async () => {
    window.__qaOriginalConfirm = window.confirm;
    window.__qaNativeConfirmCalls = 0;
    window.confirm = () => { window.__qaNativeConfirmCalls += 1; return true; };
    window.__qaConfirmationPromise = confirmAction({
      eyebrow: '会话管理',
      title: '从 ChatSwitch 中移除这个会话？',
      description: '移除后可在一小时内恢复，到期后会从 ChatSwitch 列表清除。',
      detail: '原始 ChatGPT、Codex 和 Claude 会话记录完全不变。',
      confirmLabel: '移除会话',
    });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const overlay = document.querySelector('#confirmation-overlay');
    const dialog = document.querySelector('.app-confirm-dialog').getBoundingClientRect();
    const cancel = document.querySelector('#confirmation-cancel').getBoundingClientRect();
    const confirm = document.querySelector('#confirmation-confirm').getBoundingClientRect();
    return {
      visible: !overlay.classList.contains('hidden'),
      title: document.querySelector('#confirmation-title').textContent,
      description: document.querySelector('#confirmation-description').textContent,
      detail: document.querySelector('#confirmation-detail').textContent,
      cancelFocused: document.activeElement === document.querySelector('#confirmation-cancel'),
      dialogWithinViewport: dialog.left >= 0 && dialog.right <= innerWidth && dialog.top >= 0 && dialog.bottom <= innerHeight,
      buttonsOverlap: !(cancel.right <= confirm.left || confirm.right <= cancel.left || cancel.bottom <= confirm.top || confirm.bottom <= cancel.top),
    };
  })()`);
  fs.writeFileSync(confirmationScreenshot, (await capturePageWithRetry(window)).toPNG());
  Object.assign(confirmation, await window.webContents.executeJavaScript(`(async () => {
    document.querySelector('#confirmation-cancel').click();
    const cancelResult = await window.__qaConfirmationPromise;
    window.__qaConfirmationPromise = confirmAction({
      eyebrow: '配置备份',
      title: '恢复配置备份？',
      description: '恢复前会先自动备份当前配置。',
      confirmLabel: '恢复备份',
      tone: 'neutral',
    });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const neutralTone = document.querySelector('.app-confirm-dialog').classList.contains('tone-neutral');
    document.querySelector('#confirmation-confirm').click();
    const confirmResult = await window.__qaConfirmationPromise;
    window.__qaConfirmationPromise = confirmAction({ title: 'Esc 取消测试' });
    await new Promise((resolve) => requestAnimationFrame(resolve));
    document.querySelector('#confirmation-cancel').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const escapeResult = await window.__qaConfirmationPromise;
    const nativeConfirmCalls = window.__qaNativeConfirmCalls;
    window.confirm = window.__qaOriginalConfirm;
    delete window.__qaOriginalConfirm;
    delete window.__qaNativeConfirmCalls;
    delete window.__qaConfirmationPromise;
    return {
      cancelResult,
      confirmResult,
      escapeResult,
      neutralTone,
      nativeConfirmCalls,
      hiddenAfterDecision: document.querySelector('#confirmation-overlay').classList.contains('hidden'),
    };
  })()`));
  const messageFeatures = await window.webContents.executeJavaScript(`(async () => {
    const agent = document.querySelector('.message.agent');
    const user = document.querySelector('.message.user');
    agent.querySelector('[title="复制消息"]').click();
    user.querySelector('[title="引用到输入框"]').click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const quotedText = document.querySelector('#composer-input').value;
    user.querySelector('.user-edit-message').click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const editedText = document.querySelector('#composer-input').value;
    const stopRequestedByEdit = state.runningThreads.get(state.activeThread.id)?.stopRequested === true;
    const editTitleWhileRunning = user.querySelector('.user-edit-message').title;
    const run = state.runningThreads.get(state.activeThread.id);
    if (run) {
      run.stopRequested = false;
      run.interruptingTurnId = null;
    }
    document.querySelector('#composer-input').value = '';
    document.querySelector('#thread-search').value = '克制的提示';
    scheduleThreadSearch();
    await new Promise((resolve) => setTimeout(resolve, 340));
    const originalThread = state.activeThread;
    const originalThreads = state.activeThreads;
    const originalAllThreads = state.allThreads;
    const originalVisibleThreads = state.threads;
    const branchButtonVisible = Boolean(agent.querySelector('[title="分支到新聊天"]'));
    agent.querySelector('[title="分支到新聊天"]').click();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const branchCreated = state.activeThread?.id === 'branch-vue-fixture'
      && state.activeThread?.name === '界面优化讨论 · 分支';
    const branchOriginalPreserved = originalThread?.id === 'vue-conversation-fixture'
      && originalThreads.some((thread) => thread.id === originalThread.id);
    state.activeThread = originalThread;
    state.activeThreads = originalThreads;
    state.allThreads = originalAllThreads;
    state.threads = originalVisibleThreads;
    state.renderedThreadRevision = null;
    renderConversation(originalThread);
    state.runningThreads.set(originalThread.id, { turnId: 'turn-running', stopRequested: false, interruptingTurnId: null, startedAt: Date.now() });
    syncActiveRunState();
    return {
      actionButtons: document.querySelectorAll('.message-action-button').length,
      agentActions: agent.querySelectorAll('.message-action-button').length,
      userActions: user.querySelectorAll('.message-action-button').length,
      branchButtonVisible,
      branchCreated,
      branchOriginalPreserved,
      quotedText,
      editedText,
      stopRequestedByEdit,
      editTitleWhileRunning,
      searchHits: state.threadSearchHits.size,
      searchSnippet: document.querySelector('.thread-item small')?.textContent || '',
      searchBodyOverflow: document.body.scrollWidth > document.body.clientWidth || document.body.scrollHeight > document.body.clientHeight,
    };
  })()`);
  messageFeatures.copiedText = copiedTexts.at(-1) || '';
  const deliveryModes = await window.webContents.executeJavaScript(`(async () => {
    const input = document.querySelector('#composer-input');
    state.providerEngine = 'openai-compatible';
    input.value = '等当前回复完成后再执行这一条';
    syncComposerState();
    await sendMessage('auto');
    input.value = '竞态情况下也不能丢失的消息';
    syncComposerState();
    await sendMessage('steer');
    await new Promise((resolve) => setTimeout(resolve, 40));
    const queuedBeforeSteer = state.messageQueues.get(state.activeThread.id) || [];
    const queuePanel = document.querySelector('#message-queue-panel');
    const queued = {
      queueLengthBeforeSteer: queuedBeforeSteer.length,
      firstQueuedText: queuedBeforeSteer[0]?.displayText || '',
      secondQueuedText: queuedBeforeSteer[1]?.displayText || '',
      secondQueuedId: queuedBeforeSteer[1]?.clientUserMessageId || '',
      queueButtonRemoved: !document.querySelector('#queue-button'),
      queuePanelVisible: !queuePanel.classList.contains('hidden'),
      queuePanelItems: queuePanel.querySelectorAll('.queued-prompt-item').length,
      queueIcons: queuePanel.querySelectorAll('.queued-prompt-icon').length,
      deleteButtons: queuePanel.querySelectorAll('.queued-prompt-delete').length,
      moreButtons: queuePanel.querySelectorAll('.queued-prompt-more > summary').length,
      queuePanelAboveInput: queuePanel.getBoundingClientRect().bottom <= input.getBoundingClientRect().top + 1,
      steerButtonsBeforeClick: queuePanel.querySelectorAll('.queued-steer-button').length,
      compatibleSteerVisible: [...queuePanel.querySelectorAll('.queued-steer-button')].every((button) => !button.classList.contains('hidden')),
      queuedMessagesInChat: queuedBeforeSteer.filter((message) => document.querySelector('[data-message-id="' + CSS.escape(message.clientUserMessageId) + '"]')).length,
      inputAfterQueue: input.value,
    };
    state.providerEngine = 'codex';
    syncActiveRunState();
    const firstSteer = [...document.querySelectorAll('.queued-steer-button')]
      .find((button) => button.dataset.clientUserMessageId === queuedBeforeSteer[0].clientUserMessageId);
    firstSteer.click();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const queueAfterSuccess = state.messageQueues.get(state.activeThread.id) || [];
    const queueLengthAfterSuccess = queueAfterSuccess.length;
    const inactiveSteer = [...document.querySelectorAll('.queued-steer-button')]
      .find((button) => button.dataset.clientUserMessageId === queueAfterSuccess[0]?.clientUserMessageId);
    inactiveSteer.click();
    await new Promise((resolve) => setTimeout(resolve, 120));
    return {
      ...queued,
      queueLengthAfterSuccess,
      remainingAfterInactive: (state.messageQueues.get(state.activeThread.id) || []).length,
      queuePanelHiddenAfterDrain: document.querySelector('#message-queue-panel').classList.contains('hidden'),
      deliveryLabels: [...document.querySelectorAll('.message-delivery-state')].map((node) => node.textContent),
      sendTitle: document.querySelector('#send-button').title,
      actionTopDelta: Math.abs(Math.round(document.querySelector('#send-button').getBoundingClientRect().top - document.querySelector('#stop-button').getBoundingClientRect().top)),
      footerOverflow: document.querySelector('.composer-footer').scrollWidth > document.querySelector('.composer-footer').clientWidth,
    };
  })()`);
  deliveryModes.nativeSteerRequests = steerRequests.length;
  deliveryModes.interruptRequests = interruptRequests.length;
  deliveryModes.nativeExpectedTurnId = steerRequests[0]?.expectedTurnId || null;
  deliveryModes.inactiveExpectedTurnId = steerRequests[1]?.expectedTurnId || null;
  deliveryModes.inactiveStartedText = startTurnRequests.at(-1)?.displayText || '';
  deliveryModes.persistedQueueWrites = persistedQueues.length;
  deliveryModes.persistedQueueLength = persistedQueues.at(-1)?.messages?.length || 0;
  deliveryModes.queueClaimCount = claimedQueues.length;
  deliveryModes.claimedMessageIds = claimedQueues.map((claim) => claim.clientUserMessageId);
  const compatibleStartOffset = startTurnRequests.length;
  const compatibleInterruptOffset = interruptRequests.length;
  const compatibleButton = await window.webContents.executeJavaScript(`(() => {
    const threadId = state.activeThread.id;
    setThreadRunning(threadId, false);
    setThreadRunning(threadId, true, 'turn-compatible-guide');
    state.providerEngine = 'openai-compatible';
    state.messageQueues.set(threadId, [{
      threadId,
      text: '立即采用新的要求',
      displayText: '立即采用新的要求',
      clientUserMessageId: 'compatible-guide',
      providerId: state.provider,
      queuedAt: 1,
    }]);
    renderMessageQueuePanel(threadId);
    const button = document.querySelector('[data-client-user-message-id="compatible-guide"] .queued-steer-button');
    const snapshot = {
      visible: !button.classList.contains('hidden'),
      title: button.title,
    };
    button.click();
    return snapshot;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 40));
  await window.webContents.executeJavaScript(`handleEvent({
    method: 'turn/completed',
    params: { threadId: state.activeThread.id, turn: { id: 'turn-compatible-guide', status: 'interrupted' } }
  })`);
  await new Promise((resolve) => setTimeout(resolve, 160));
  const compatibleGuide = await window.webContents.executeJavaScript(`(() => {
    const result = {
      remaining: (state.messageQueues.get(state.activeThread.id) || []).length,
      runningTurnId: state.runningThreads.get(state.activeThread.id)?.turnId || null,
      deliveryLabels: [...document.querySelectorAll('.message-delivery-state')].map((node) => node.textContent),
    };
    setThreadRunning(state.activeThread.id, false);
    return result;
  })()`);
  compatibleGuide.button = compatibleButton;
  compatibleGuide.started = startTurnRequests.slice(compatibleStartOffset).map((request) => request.displayText);
  compatibleGuide.interrupted = interruptRequests.slice(compatibleInterruptOffset).map((request) => request.turnId);
  const raceStartTurnOffset = startTurnRequests.length;
  await window.webContents.executeJavaScript(`(() => {
    const threadId = state.activeThread.id;
    setThreadRunning(threadId, true, 'turn-race');
    state.providerEngine = 'codex';
    state.messageQueues.set(threadId, [
      { threadId, text: '等待引导完成', displayText: '等待引导完成', clientUserMessageId: 'race-steer', providerId: state.provider, queuedAt: 1 },
      { threadId, text: '只发送一次的下一条', displayText: '只发送一次的下一条', clientUserMessageId: 'race-next', providerId: state.provider, queuedAt: 2 },
    ]);
    renderMessageQueuePanel(threadId);
    document.querySelector('[data-client-user-message-id="race-steer"] .queued-steer-button').click();
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await window.webContents.executeJavaScript(`handleEvent({
    method: 'turn/completed',
    params: { threadId: state.activeThread.id, turn: { id: 'turn-race', status: 'completed' } }
  })`);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const startsWhileSteerPending = startTurnRequests.length - raceStartTurnOffset;
  assert.equal(typeof pendingSteerResolve, "function", "Deferred steer was not invoked.");
  pendingSteerResolve({ turnId: "turn-race" });
  pendingSteerResolve = null;
  await new Promise((resolve) => setTimeout(resolve, 160));
  await window.webContents.executeJavaScript(`handleEvent({
    method: 'turn/completed',
    params: { threadId: state.activeThread.id, turn: { id: 'turn-race', status: 'completed' } }
  })`);
  const steerRace = await window.webContents.executeJavaScript(`(() => ({
    remaining: (state.messageQueues.get(state.activeThread.id) || []).map((message) => message.displayText),
    runningTurnId: state.runningThreads.get(state.activeThread.id)?.turnId || null,
    steeringLocked: state.steeringThreads.has(state.activeThread.id),
    dispatchLocked: state.queueDispatchingThreads.has(state.activeThread.id),
  }))()`);
  steerRace.startsWhilePending = startsWhileSteerPending;
  steerRace.startedAfterResolve = startTurnRequests.slice(raceStartTurnOffset).map((request) => request.displayText);
  const queueActions = await window.webContents.executeJavaScript(`(async () => {
    const threadId = state.activeThread.id;
    setThreadRunning(threadId, false);
    setThreadRunning(threadId, true, 'turn-queue-actions');
    state.messageQueues.set(threadId, [
      { threadId, text: '删除我', displayText: '删除我', clientUserMessageId: 'queue-delete', providerId: state.provider, queuedAt: 1 },
      { threadId, text: '编辑我', displayText: '编辑我', clientUserMessageId: 'queue-edit', providerId: state.provider, queuedAt: 2, imageInputs: [{ path: ${JSON.stringify(conversationScreenshot)}, detail: 'auto' }] },
    ]);
    renderMessageQueuePanel(threadId);
    document.querySelector('[data-client-user-message-id="queue-delete"] .queued-prompt-delete').click();
    await new Promise((resolve) => setTimeout(resolve, 40));
    const afterDelete = (state.messageQueues.get(threadId) || []).map((message) => message.displayText);
    const more = document.querySelector('[data-client-user-message-id="queue-edit"] .queued-prompt-more');
    more.open = true;
    more.querySelector('.queued-prompt-edit').click();
    await new Promise((resolve) => setTimeout(resolve, 40));
    const result = {
      afterDelete,
      remainingAfterEdit: (state.messageQueues.get(threadId) || []).length,
      restoredText: document.querySelector('#composer-input').value,
      restoredAttachments: [...state.pendingAttachments],
      panelHidden: document.querySelector('#message-queue-panel').classList.contains('hidden'),
    };
    setThreadRunning(threadId, false);
    state.pendingAttachments = [];
    renderAttachments();
    document.querySelector('#composer-input').value = '';
    syncComposerState();
    return result;
  })()`);
  const recoveryStartOffset = startTurnRequests.length;
  const recoveryClaimOffset = claimedQueues.length;
  const recoveryBefore = await window.webContents.executeJavaScript(`(async () => {
    const thread = { id: 'vue-conversation-fixture', name: '界面优化讨论', cwd: 'F:\\codepro', turns: [] };
    state.activeThread = thread;
    state.activeThreads = [thread];
    state.allThreads = [thread];
    state.threadResumed = false;
    setThreadRunning(thread.id, false);
    state.messageQueues.set(thread.id, [{
      threadId: thread.id,
      text: '重启后只发送一次',
      displayText: '重启后只发送一次',
      clientUserMessageId: 'restart-queue-message',
      providerId: state.provider,
      queuedAt: 1,
    }]);
    syncRecoveredTurns([{
      threadId: thread.id,
      turnId: 'turn-before-restart',
      status: 'interrupted',
      interruptionReason: 'app-restarted',
    }]);
    renderConversation(thread);
    const result = {
      interruptionVisibleBeforeOpen: Boolean(document.querySelector('.turn-interruption')),
      interruptionText: document.querySelector('.turn-interruption')?.textContent.replace(/\\s+/g, ' ').trim() || '',
      queuedBeforeOpen: (state.messageQueues.get(thread.id) || []).length,
    };
    await openThread(thread);
    return result;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 140));
  const restartRecovery = await window.webContents.executeJavaScript(`(() => ({
    queueLength: (state.messageQueues.get(state.activeThread.id) || []).length,
    interruptionVisibleAfterOpen: Boolean(document.querySelector('.turn-interruption')),
    running: state.runningThreads.has(state.activeThread.id),
    panelHidden: document.querySelector('#message-queue-panel').classList.contains('hidden'),
  }))()`);
  Object.assign(restartRecovery, recoveryBefore, {
    started: startTurnRequests.slice(recoveryStartOffset).map((request) => request.displayText),
    claimed: claimedQueues.slice(recoveryClaimOffset).map((claim) => claim.clientUserMessageId),
  });
  const attachments = await window.webContents.executeJavaScript(`(async () => {
    const testImage = ${JSON.stringify(conversationScreenshot)};
    state.pendingAttachments = [];
    renderAttachments();
    const clipboardTransfer = new DataTransfer();
    clipboardTransfer.items.add(new File(['clipboard-image'], 'clipboard.png', { type: 'image/png' }));
    const pasteCanceled = !document.querySelector('#composer-input').dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: clipboardTransfer,
      bubbles: true,
      cancelable: true,
    }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const pasted = {
      pasteCanceled,
      pastedCount: state.pendingAttachments.length,
      pastedFilename: document.querySelector('.attachment-copy strong')?.textContent || '',
    };
    const result = addDroppedAttachments([testImage, 'F:\\\\codepro\\\\notes.pdf']);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const tray = {
      count: document.querySelectorAll('#attachment-list .attachment-item').length,
      filename: document.querySelector('.attachment-copy strong')?.textContent || '',
      reactiveCount: ChatSwitchVueRuntime.attachmentUi.items.length,
      typeLabels: [...document.querySelectorAll('#attachment-list .attachment-copy small')].map((node) => node.textContent),
      ignoredMessage: document.querySelector('#status-toast').textContent,
    };
    const imageMessage = appendUserMessage({
      id: 'copyable-image-message',
      type: 'userMessage',
      content: [{ type: 'text', text: '可复制附件' }, { type: 'localImage', path: testImage }],
    });
    imageMessage.querySelector('.message-media-copy').click();
    document.querySelector('.attachment-copy-button').click();
    await new Promise((resolve) => setTimeout(resolve, 40));
    tray.conversationCopyButtons = imageMessage.querySelectorAll('.message-media-copy').length;
    tray.trayActionButtons = document.querySelectorAll('.attachment-copy-button').length;
    document.querySelectorAll('.attachment-copy-button')[1]?.click();
    await new Promise((resolve) => setTimeout(resolve, 60));
    tray.documentPreviewVisible = !document.querySelector('#file-preview-overlay').classList.contains('hidden');
    tray.documentPreviewTitle = document.querySelector('#file-preview-title')?.textContent || '';
    document.querySelector('#file-preview-done-button')?.click();
    await new Promise((resolve) => setTimeout(resolve, 40));
    const transfer = new DataTransfer();
    transfer.items.add(new File(['image'], 'drop.png', { type: 'image/png' }));
    window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: transfer }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    tray.overlayVisible = !document.querySelector('#attachment-drop-overlay').classList.contains('hidden');
    window.dispatchEvent(new DragEvent('dragleave', { dataTransfer: transfer }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    tray.overlayCleared = document.querySelector('#attachment-drop-overlay').classList.contains('hidden');
    return { ...result, ...pasted, ...tray };
  })()`);
  attachments.clipboardPasteRequests = clipboardPasteRequests;
  attachments.copiedImages = structuredClone(copiedImages);
  fs.writeFileSync(attachmentScreenshot, (await capturePageWithRetry(window)).toPNG());
  Object.assign(attachments, await window.webContents.executeJavaScript(`(async () => {
    document.querySelector('.attachment-remove').click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    return {
      countAfterRemove: document.querySelectorAll('#attachment-list .attachment-item').length,
      reactiveCountAfterRemove: ChatSwitchVueRuntime.attachmentUi.items.length,
    };
  })()`));
  await window.webContents.executeJavaScript("(async () => { await openLocalHistoryDialog(); await openLocalHistoryConversation(state.localHistoryConversations[0]); })()");
  await new Promise((resolve) => setTimeout(resolve, 100));
  fs.writeFileSync(localHistoryScreenshot, (await capturePageWithRetry(window)).toPNG());
  const localHistory = await window.webContents.executeJavaScript(`(() => ({
    visible: !document.querySelector('#local-history-overlay').classList.contains('hidden'),
    sources: document.querySelectorAll('#local-history-sources button').length,
    conversations: document.querySelectorAll('.local-history-item').length,
    messages: document.querySelectorAll('.local-history-message').length,
    title: document.querySelector('.local-history-preview-heading h3')?.textContent || '',
    readOnlyNotice: document.querySelector('#local-history-title').parentElement.textContent,
    bodyOverflow: document.body.scrollWidth > document.body.clientWidth || document.body.scrollHeight > document.body.clientHeight,
    dialogOverflow: document.querySelector('.local-history-dialog').scrollHeight > document.querySelector('.local-history-dialog').clientHeight
  }))()`);
  Object.assign(localHistory, await window.webContents.executeJavaScript(`(async () => {
    const bulkButton = document.querySelector('#local-history-import-all-button');
    const enabledBefore = !bulkButton.disabled;
    bulkButton.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const confirmationVisible = Boolean(document.querySelector('#confirmation-overlay:not(.hidden)'));
    const started = Date.now();
    while (!document.querySelector('#local-history-summary').textContent.includes('批量完成')) {
      if (Date.now() - started > 5000) throw new Error('Local history bulk import timed out.');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return { bulkEnabledBefore: enabledBefore, bulkConfirmationVisible: confirmationVisible, bulkSummary: document.querySelector('#local-history-summary').textContent };
  })()`));
  Object.assign(localHistory, await window.webContents.executeJavaScript(`(async () => {
    const button = document.querySelector('.local-history-import-button');
    const buttonLabel = button?.textContent || '';
    const status = document.querySelector('.local-history-import-status');
    button.click();
    const started = Date.now();
    while (!document.querySelector('#local-history-overlay').classList.contains('hidden')) {
      if (Date.now() - started > 5000) throw new Error('Local history import timed out.');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return {
      buttonLabel,
      statusRole: status?.getAttribute('role') || '',
      overlayClosedAfterImport: document.querySelector('#local-history-overlay').classList.contains('hidden'),
      openedThreadId: state.activeThread?.id || null,
      openedThreadName: state.activeThread?.name || null,
    };
  })()`));
  localHistory.importRequests = structuredClone(localHistoryImportRequests);
  localHistory.bulkImportRequests = structuredClone(localHistoryBulkImportRequests);
  const filePreview = await window.webContents.executeJavaScript(`(async () => {
    await openFilePreview('F:\\\\codepro\\\\notes.txt');
    await new Promise((resolve) => setTimeout(resolve, 40));
    return {
      visible: !document.querySelector('#file-preview-overlay').classList.contains('hidden'),
      title: document.querySelector('#file-preview-title')?.textContent || '',
      meta: document.querySelector('#file-preview-meta')?.textContent || '',
      content: document.querySelector('#file-preview-text')?.textContent || '',
      systemButton: Boolean(document.querySelector('#file-preview-open-system')),
      bodyOverflow: document.body.scrollWidth > document.body.clientWidth || document.body.scrollHeight > document.body.clientHeight,
    };
  })()`);
  fs.writeFileSync(filePreviewScreenshot, (await capturePageWithRetry(window)).toPNG());
  await window.webContents.executeJavaScript("closeFilePreview()");
  await window.webContents.executeJavaScript("closeLocalHistoryDialog(); openLocalProviderDialog()");
  await new Promise((resolve) => setTimeout(resolve, 100));
  fs.writeFileSync(localProviderScreenshot, (await capturePageWithRetry(window)).toPNG());
  const localProviders = await window.webContents.executeJavaScript(`(async () => {
    const before = {
      visible: !document.querySelector('#local-provider-overlay').classList.contains('hidden'),
      rows: document.querySelectorAll('.local-provider-row').length,
      selectable: document.querySelectorAll('.local-provider-row input:not(:disabled)').length,
      privacy: document.querySelector('.local-provider-privacy').textContent,
      exposedSecret: document.querySelector('#local-provider-overlay').textContent.includes('unit-secret'),
      bodyOverflow: document.body.scrollWidth > document.body.clientWidth || document.body.scrollHeight > document.body.clientHeight,
      dialogOverflow: document.querySelector('.local-provider-dialog').scrollHeight > document.querySelector('.local-provider-dialog').clientHeight,
    };
    document.querySelector('.local-provider-row input:not(:disabled)').click();
    document.querySelector('#local-provider-import-button').click();
    const started = Date.now();
    while (!document.querySelector('#local-provider-status').textContent.includes('已导入')) {
      if (Date.now() - started > 5000) throw new Error('Local provider import timed out.');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return {
      ...before,
      importStatus: document.querySelector('#local-provider-status').textContent,
      providerAdded: state.providers.some((provider) => provider.id === 'local-imported'),
      importedCandidateMarkedDuplicate: state.localProviderCandidates.find((candidate) => candidate.id === 'local-ready')?.duplicate === true,
    };
  })()`);
  await window.webContents.executeJavaScript("closeLocalProviderDialog(); openUsageDialog()");
  await new Promise((resolve) => setTimeout(resolve, 150));
  fs.writeFileSync(usageScreenshot, (await capturePageWithRetry(window)).toPNG());
  const usage = await window.webContents.executeJavaScript(`(() => ({
    visible: !document.querySelector('#usage-overlay').classList.contains('hidden'),
    stats: document.querySelectorAll('.usage-stat').length,
    rows: document.querySelectorAll('.usage-log-row').length,
    trendColumns: document.querySelectorAll('.usage-trend-column').length,
    pricingTop: Math.round(document.querySelector('.pricing-form').getBoundingClientRect().top),
    logBottom: Math.round(document.querySelector('.usage-log-section').getBoundingClientRect().bottom),
    dialogOverflow: document.querySelector('.usage-dialog').scrollHeight > document.querySelector('.usage-dialog').clientHeight,
    bodyOverflow: document.body.scrollWidth > document.body.clientWidth || document.body.scrollHeight > document.body.clientHeight
  }))()`);
  window.setSize(900, 640);
  await new Promise((resolve) => setTimeout(resolve, 200));
  fs.writeFileSync(usageCompactScreenshot, (await capturePageWithRetry(window)).toPNG());
  usage.compactBodyOverflow = await window.webContents.executeJavaScript("document.body.scrollWidth > document.body.clientWidth || document.body.scrollHeight > document.body.clientHeight");
  window.setSize(1200, 800);
  await window.webContents.executeJavaScript("closeUsageDialog(); openBackupDialog()");
  await new Promise((resolve) => setTimeout(resolve, 150));
  fs.writeFileSync(backupScreenshot, (await capturePageWithRetry(window)).toPNG());
  const backup = await window.webContents.executeJavaScript(`(() => ({
    visible: !document.querySelector('#backup-overlay').classList.contains('hidden'),
    rows: document.querySelectorAll('.backup-row').length,
    restoreButtons: document.querySelectorAll('.backup-restore').length,
    bodyOverflow: document.body.scrollWidth > document.body.clientWidth || document.body.scrollHeight > document.body.clientHeight
  }))()`);
  await window.webContents.executeJavaScript("closeBackupDialog(); openSyncDialog()");
  await new Promise((resolve) => setTimeout(resolve, 150));
  fs.writeFileSync(syncScreenshot, (await capturePageWithRetry(window)).toPNG());
  const sync = await window.webContents.executeJavaScript(`(() => ({
    visible: !document.querySelector('#sync-overlay').classList.contains('hidden'),
    rows: document.querySelectorAll('.sync-history-row').length,
    directory: document.querySelector('#sync-directory-input').value,
    webdavVisible: !document.querySelector('#sync-webdav-form').classList.contains('hidden'),
    webdavUrl: document.querySelector('#sync-webdav-form [name="url"]').value,
    pullLabel: document.querySelector('#sync-pull-label').textContent,
    selectedTabs: [...document.querySelectorAll('[data-sync-backend]')].map((button) => button.getAttribute('aria-selected')),
    description: document.querySelector('#sync-title').parentElement.textContent,
    bodyOverflow: document.body.scrollWidth > document.body.clientWidth || document.body.scrollHeight > document.body.clientHeight,
    dialogOverflow: document.querySelector('.sync-dialog').scrollHeight > document.querySelector('.sync-dialog').clientHeight
  }))()`);
  await window.webContents.executeJavaScript("closeSyncDialog(); openAppSettingsDialog()");
  await new Promise((resolve) => setTimeout(resolve, 100));
  fs.writeFileSync(appSettingsScreenshot, (await capturePageWithRetry(window)).toPNG());
  const appSettings = await window.webContents.executeJavaScript(`(() => ({
    visible: !document.querySelector('#app-settings-overlay').classList.contains('hidden'),
    toggles: document.querySelectorAll('#app-settings-form input[type="checkbox"]').length,
    closeToTray: document.querySelector('#app-settings-form [name="closeToTray"]').checked,
    bodyOverflow: document.body.scrollWidth > document.body.clientWidth || document.body.scrollHeight > document.body.clientHeight
  }))()`);
  Object.assign(appSettings, await window.webContents.executeJavaScript(`(async () => {
    document.querySelector('#check-update-button').click();
    const started = Date.now();
    while (document.querySelector('#check-update-button').disabled) {
      if (Date.now() - started > 5000) throw new Error('Update check timed out.');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return {
      updateState: document.querySelector('#update-status').dataset.state,
      updateMessage: document.querySelector('#update-status').textContent,
      updateDownloadVisible: !document.querySelector('#download-update-button').classList.contains('hidden'),
      versionLabel: document.querySelector('#app-version').textContent,
    };
  })()`));
  await window.webContents.executeJavaScript(`(() => {
    closeAppSettingsDialog();
    openDeepLinkImportPreview({
      importType: 'provider',
      config: { label: 'Imported Lab API', baseUrl: 'https://api.example.test/v1', model: 'lab-model', preset: 'custom', protocol: 'chat_completions' },
    });
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 80));
  fs.writeFileSync(importPreviewScreenshot, (await capturePageWithRetry(window)).toPNG());
  const importPreview = await window.webContents.executeJavaScript(`(async () => {
    const before = {
      visible: !document.querySelector('#deep-link-import-overlay').classList.contains('hidden'),
      rows: document.querySelectorAll('#import-preview-details .import-preview-row').length,
      safety: document.querySelector('.import-safety-note').textContent,
      bodyOverflow: document.body.scrollWidth > document.body.clientWidth || document.body.scrollHeight > document.body.clientHeight,
    };
    document.querySelector('#import-preview-confirm-button').click();
    const started = Date.now();
    while (document.querySelector('#import-preview-confirm-button').disabled) {
      if (Date.now() - started > 5000) throw new Error('Deep link import timed out.');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return {
      ...before,
      connectionVisible: !document.querySelector('#connection-overlay').classList.contains('hidden'),
      importedLabel: document.querySelector('#relay-form [name="label"]').value,
      importedModel: document.querySelector('#relay-form [name="model"]').value,
      apiKey: document.querySelector('#relay-form [name="apiKey"]').value,
      apiKeyRequired: document.querySelector('#relay-form [name="apiKey"]').required,
    };
  })()`);
  await window.webContents.executeJavaScript(`(async () => {
    document.querySelector('#connection-overlay').classList.add('hidden');
    openHealthDialog();
    document.querySelector('#health-test-all-button').click();
    const started = Date.now();
    while (document.querySelector('#health-status').textContent !== '检测完成') {
      if (Date.now() - started > 5000) throw new Error('Health monitor timed out.');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  })()`);
  fs.writeFileSync(healthScreenshot, (await capturePageWithRetry(window)).toPNG());
  const health = await window.webContents.executeJavaScript(`(() => ({
    visible: !document.querySelector('#health-overlay').classList.contains('hidden'),
    rows: document.querySelectorAll('.health-row').length,
    healthy: document.querySelectorAll('.health-row.health-healthy').length,
    routeText: document.querySelector('.health-copy span')?.textContent || '',
    summary: document.querySelector('#health-summary').textContent,
    bodyOverflow: document.body.scrollWidth > document.body.clientWidth || document.body.scrollHeight > document.body.clientHeight
  }))()`);
  await window.webContents.executeJavaScript("closeHealthDialog()");
  window.webContents.send("app:navigate", { action: "extensions", tab: "skills" });
  await new Promise((resolve) => setTimeout(resolve, 180));
  fs.writeFileSync(extensionsScreenshot, (await capturePageWithRetry(window)).toPNG());
  await window.webContents.executeJavaScript(`(() => {
    openSkillInstallDialog();
    setSkillInstallKind('github');
    document.querySelector('#skill-install-source').value = 'https://github.com/example/skills';
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 80));
  fs.writeFileSync(skillInstallScreenshot, (await capturePageWithRetry(window)).toPNG());
  const skillInstall = await window.webContents.executeJavaScript(`(() => ({
    visible: !document.querySelector('#skill-install-overlay').classList.contains('hidden'),
    kind: state.skillInstallKind,
    sourceType: document.querySelector('#skill-install-source').type,
    browseHidden: document.querySelector('#skill-install-browse').classList.contains('hidden'),
    bodyOverflow: document.body.scrollWidth > document.body.clientWidth || document.body.scrollHeight > document.body.clientHeight
  }))()`);
  await window.webContents.executeJavaScript("closeSkillInstallDialog()");
  const extensions = await window.webContents.executeJavaScript(`(async () => {
    const skillRows = document.querySelectorAll('#extensions-skill-list .extension-row').length;
    const removableButtons = document.querySelectorAll('#extensions-skill-list .danger-icon').length;
    document.querySelector('[data-extension-tab="prompts"]').click();
    document.querySelector('.extension-index-row')?.click();
    const promptName = document.querySelector('#prompt-form [name="name"]').value;
    document.querySelector('[data-prompt-mode="preview"]').click();
    const promptPreview = {
      visible: !document.querySelector('#prompt-markdown-preview').matches(':not(:empty)') ? false : getComputedStyle(document.querySelector('#prompt-markdown-preview')).display !== 'none',
      text: document.querySelector('#prompt-markdown-preview').textContent,
    };
    document.querySelector('[data-extension-tab="mcp"]').click();
    document.querySelector('#extensions-mcp-list .extension-index-row')?.click();
    const secretValue = document.querySelector('#mcp-form [name="env"]').value;
    closeExtensionsDialog();
    document.querySelectorAll('.overlay').forEach((node) => node.classList.add('hidden'));
    const input = document.querySelector('#composer-input');
    input.value = '/summ';
    input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    const promptOption = document.querySelector('.skill-option[data-command-type="prompt"]');
    promptOption?.click();
    return {
      skillRows,
      removableButtons,
      promptName,
      promptPreview,
      mcpRows: document.querySelectorAll('#extensions-mcp-list .extension-index-row').length,
      secretValue,
      insertedPrompt: input.value,
      bodyOverflow: document.body.scrollWidth > document.body.clientWidth || document.body.scrollHeight > document.body.clientHeight,
    };
  })()`);
  await window.webContents.executeJavaScript("applyTheme('light'); applyTheme('dark'); openExtensionsDialog('mcp')");
  await new Promise((resolve) => setTimeout(resolve, 120));
  fs.writeFileSync(darkExtensionsScreenshot, (await capturePageWithRetry(window)).toPNG());
  const darkTheme = await window.webContents.executeJavaScript(`(() => ({
    theme: document.documentElement.dataset.theme,
    bodyBackground: getComputedStyle(document.body).backgroundColor,
    dialogBackground: getComputedStyle(document.querySelector('.extensions-dialog')).backgroundColor,
    inputBackground: getComputedStyle(document.querySelector('#mcp-form input[name="name"]')).backgroundColor,
    bodyOverflow: document.body.scrollWidth > document.body.clientWidth || document.body.scrollHeight > document.body.clientHeight
  }))()`);

  const backgroundInterruption = await window.webContents.executeJavaScript(`(() => {
    document.querySelectorAll('.overlay').forEach((node) => node.classList.add('hidden'));
    clearReconnectTimer(true);
    const foreground = { id: 'foreground-thread', name: '前台会话', turns: [] };
    const background = { id: 'background-thread', name: '后台会话', turns: [] };
    state.connected = true;
    state.provider = 'deepseek-fixture';
    state.providerType = 'relay';
    state.providerEngine = 'openai-compatible';
    state.activeThread = foreground;
    state.activeThreads = [foreground, background];
    state.allThreads = [foreground, background];
    setThreadRunning(background.id, true, 'background-running-turn');
    completeThreadRun(background.id, {
      id: 'background-running-turn',
      status: 'failed',
      error: { code: 'INCOMPLETE_STREAM', message: '后台回答连接提前关闭。' },
      items: [],
    });
    clearTimeout(state.threadRefreshTimer);
    state.threadRefreshTimer = null;
    state.activeThread = background;
    renderConversation(background);
    return {
      stored: state.interruptedTurns.has(background.id),
      visible: Boolean(document.querySelector('[data-interrupted-turn-id="background-running-turn"]')),
      buttons: document.querySelectorAll('.continue-interrupted-turn').length,
    };
  })()`);

  const reconnectPrompt = '这条原消息只能保留，自动重连不能重新发送';
  await window.webContents.executeJavaScript(`(() => {
    clearReconnectTimer(true);
    state.connectionPromise = null;
    state.connectingProvider = null;
    state.connected = true;
    state.provider = 'deepseek-fixture';
    state.providerType = 'relay';
    state.providerEngine = 'openai-compatible';
    const thread = { id: 'reconnect-thread', name: '重连测试', turns: [] };
    state.activeThread = thread;
    state.activeThreads = [thread];
    state.allThreads = [thread];
    state.threads = [thread];
    document.querySelector('#composer-input').value = ${JSON.stringify(reconnectPrompt)};
    renderConversation(thread);
    setThreadRunning(thread.id, true, 'reconnect-running-turn');
    handleConnectionDisconnect({
      reason: 'server-exit',
      providerId: 'deepseek-fixture',
      detail: 'stream disconnected before completion',
      reconnectable: true,
    });
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 1300));
  const reconnect = await window.webContents.executeJavaScript(`(() => ({
    connected: state.connected,
    reconnecting: state.reconnecting,
    running: state.runningThreads.has('reconnect-thread'),
    interruptionVisible: Boolean(document.querySelector('[data-interrupted-turn-id="reconnect-running-turn"]')),
    interruptionText: document.querySelector('[data-interrupted-turn-id="reconnect-running-turn"]')?.textContent || '',
    prompt: document.querySelector('#composer-input').value,
  }))()`);

  assert.equal(desktop.vueMounted, true);
  assert.equal(authGate.connected, false);
  assert.equal(authGate.provider, "official");
  assert.equal(authGate.providerType, "official");
  assert.equal(authGate.providerOverlayVisible, true);
  assert.equal(authGate.sendDisabled, true);
  assert.match(authGate.error, /尚未登录 ChatGPT/);
  assert.equal(authGate.loginButtonVisible, true);
  assert.match(authGate.loginButtonText, /ChatGPT.*Codex/);
  assert.equal(authGate.claudeOfficialEntryVisible, true);
  assert.match(authGate.claudeOfficialEntryText, /Claude Code/);
  assert.equal(authGate.claudeOfficialFlow.visible, true);
  assert.match(authGate.claudeOfficialFlow.buttonText, /Claude 官方登录/);
  assert.equal(authGate.claudeOfficialFlow.tokenLabel, "API Token");
  assert.match(authGate.accountPanelText, /尚未登录/);
  assert.equal(authGate.localHistoryEnabled, true);
  assert.equal(authGate.localHistoryVisible, true);
  assert.equal(loginFlow.failed.connected, false);
  assert.equal(loginFlow.failed.overlayVisible, true);
  assert.match(loginFlow.failed.error, /登录未完成/);
  assert.equal(loginFlow.succeeded.connected, true);
  assert.equal(loginFlow.succeeded.overlayHidden, true);
  assert.equal(loginFlow.succeeded.accountEmail, "tester@example.test");
  assert.equal(accountFormFlow.visible, true);
  assert.equal(accountFormFlow.accountTabSelected, "true");
  assert.equal(accountFormFlow.labelRequired, false);
  assert.equal(accountFormFlow.labelValue, "");
  assert.match(accountFormFlow.submitText, /打开 ChatGPT 登录/);
  assert.match(accountFormFlow.helperText, /不填写邮箱或密码/);
  assert.deepEqual(accountFormFlow.addRequest, { label: "ChatGPT 官方账号" });
  assert.equal(accountFormFlow.loginProviderId, "account_fixture");
  assert.equal(accountFormFlow.connected, true);
  assert.equal(accountFormFlow.provider, "account_fixture");
  assert.equal(accountFormFlow.overlayHidden, true);
  assert.equal(accountFormFlow.providerOverlayHidden, true);
  assert.equal(accountFormFlow.accountEmail, "tester@example.test");
  assert.equal(relayModelFlow.visible, true);
  assert.match(relayModelFlow.modelLabel, /来自中转商/);
  assert.equal(relayModelFlow.modelDisabled, false);
  assert.equal(relayModelFlow.optionCount, 2);
  assert.equal(relayModelFlow.selected, "deepseek-chat");
  assert.equal(relayModelFlow.inputValue, "deepseek-chat");
  assert.match(relayModelFlow.helper, /\/models/);
  assert.equal(storedRelayKeyFlow.value, "********");
  assert.equal(storedRelayKeyFlow.required, false);
  assert.equal(storedRelayKeyFlow.masked, "true");
  assert.match(storedRelayKeyFlow.helper, /已配置/);
  assert.equal(storedRelayKeyFlow.busyAfter, false);
  assert.equal(storedRelayKeyFlow.error, "");
  assert.equal(storedRelayKeyFlow.probeRequest.providerId, "deepseek-fixture");
  assert.equal(storedRelayKeyFlow.probeRequest.apiKey, "");
  assert.equal(accountUsage.quotaRows, 2);
  assert.equal(accountUsage.progressBars, 2);
  assert.deepEqual(accountUsage.progressValues, ["77.5", "52"]);
  assert.equal(accountUsage.refreshLabel, "刷新 ChatGPT 账号用量");
  assert.equal(accountUsage.refreshDisabled, false);
  assert.equal(accountUsage.refreshRequests, 1);
  assert.match(accountUsage.text, /5 小时额度/);
  assert.match(accountUsage.text, /每周额度/);
  assert.match(accountUsage.text, /已用 22\.5% · 剩余 77\.5%/);
  assert.match(accountUsage.text, /2026/);
  assert.match(accountUsage.text, /累计 Token 125万/);
  assert.match(accountUsage.text, /峰值日用量 25万/);
  assert.match(accountUsage.text, /当前连续使用 7 天/);
  assert.equal(desktop.wordmarkIconLoaded, true);
  assert.equal(desktop.stateExposed, true);
  assert.equal(desktop.pending, false);
  assert.equal(desktop.providerDialogVisible, true);
  assert.equal(desktop.connectionDialogVisible, false);
  assert.equal(desktop.composerOverflow, false);
  assert.equal(desktop.bodyOverflow, false);
  assert.equal(desktop.fatal, null);
  assert.notEqual(desktop.formActionsBackground, "rgb(255, 255, 255)");
  assert.deepEqual(desktop.providerGroups, ["ChatGPT / Codex 账号", "Chat Completions 模型"]);
  assert.deepEqual(desktop.actionGroups, ["连接管理", "数据与同步", "应用"]);
  assert.equal(desktop.selectedProviderRows, 1);
  assert.equal(desktop.providerActionLayout.length, 4);
  assert.equal(desktop.providerActionLayout.every((row) => row.actions === 1 && !row.overlaps), true);
  assert.equal(compact.vueMounted, true);
  assert.equal(compact.wordmarkIconLoaded, true);
  assert.equal(compact.bodyOverflow, false);
  assert.equal(compact.providerActionLayout.every((row) => row.actions === 1 && !row.overlaps), true);
  assert.equal(compact.fatal, null);
  assert.equal(conversation.messages, 2);
  assert.deepEqual(conversation.effortOptions, ["low", "medium", "high"]);
  assert.equal(conversation.effortEnabled, true);
  assert.equal(notificationApprovalSync.visibleBeforeResolution, true);
  assert.equal(notificationApprovalSync.activeBeforeResolution, "notification-approval-fixture");
  assert.equal(notificationApprovalSync.hiddenAfterResolution, true);
  assert.equal(notificationApprovalSync.activeAfterResolution, null);
  assert.equal(notificationApprovalSync.rendererResponses, 0);
  assert.equal(conversation.agentHeader, "DeepSeek");
  assert.notEqual(conversation.userBubbleColor, "rgb(255, 255, 255)");
  assert.ok(conversation.composerWidth >= 600);
  assert.equal(conversation.chatOverflow, false);
  assert.ok(conversation.activityWidth >= 700, `Reasoning activity remained too narrow: ${JSON.stringify(conversation)}`);
  assert.ok(conversation.reasoningOutputWidth >= 650, `Reasoning output remained too narrow: ${JSON.stringify(conversation)}`);
  assert.ok(conversation.reasoningLineHeight >= 19);
  assert.match(conversation.reasoningText, /^先检查信息层级、对比度/);
  assert.doesNotMatch(conversation.reasoningText, /先检查信息层级、\s+对比度/);
  assert.equal(conversation.commandButtonVisible, true);
  assert.equal(conversation.commandInitiallyHidden, true);
  assert.match(conversation.commandExpanded, /Get-ChildItem -Force/);
  assert.match(conversation.commandToggleLabel, /收起命令/);
  assert.equal(conversation.changeButtonVisible, true);
  assert.equal(conversation.changeInitiallyHidden, true);
  assert.match(conversation.changeExpanded, /增加修改内容查看入口/);
  assert.match(conversation.changeToggleLabel, /收起/);
  assert.match(conversation.streamedChange, /流式增量也被保留/);
  assert.equal(conversation.streamedLabel, "修改文件");
  assert.match(conversation.streamedPath, /src[\\/]renderer[\\/]app\.js/);
  assert.equal(conversation.thinkingVisible, true);
  assert.match(conversation.thinkingText, /正在思考/);
  assert.equal(conversation.thinkingIsLast, true);
  assert.ok(conversation.thinkingWidth >= 750, `Thinking indicator remained too short: ${JSON.stringify(conversation)}`);
  assert.ok(conversation.thinkingHeight >= 62, `Thinking indicator remained too low: ${JSON.stringify(conversation)}`);
  assert.equal(conversation.thinkingHiddenAfterCompletion, true);
  assert.equal(conversation.interruptionVisible, true);
  assert.match(conversation.interruptionText, /回答中途断开/);
  assert.match(conversation.interruptionText, /qa-request-1/);
  assert.equal(conversation.interruptionButtons, 1);
  assert.deepEqual(backgroundInterruption, { stored: true, visible: true, buttons: 1 });
  assert.deepEqual(connectRequests.filter((id) => id === "official"), ["official", "official"]);
  assert.deepEqual(connectRequests.filter((id) => id === "deepseek-fixture"), ["deepseek-fixture"]);
  assert.equal(startThreadRequests.length, 0);
  assert.equal(reconnect.connected, true);
  assert.equal(reconnect.reconnecting, false);
  assert.equal(reconnect.running, false);
  assert.equal(reconnect.interruptionVisible, true);
  assert.match(reconnect.interruptionText, /stream disconnected before completion/);
  assert.equal(reconnect.prompt, reconnectPrompt);
  assert.equal(conversation.stopVisible, true);
  assert.ok(conversation.actionTopDelta <= 1, `Send and stop controls are on different rows: ${JSON.stringify(conversation)}`);
  assert.ok(conversation.actionLaneWidth >= 70);
  assert.equal(conversation.composerFooterOverflow, false);
  assert.ok(conversation.compactActionTopDelta <= 1);
  assert.equal(conversation.compactFooterOverflow, false);
  assert.equal(conversation.compactBodyOverflow, false);
  assert.ok(conversation.compactActivityWidth >= 500);
  assert.equal(permissionMode.modalVisible, true);
  assert.match(permissionMode.modalTitle, /完全访问权限/);
  assert.match(permissionMode.modalDescription, /互联网/);
  assert.equal(permissionMode.nativeConfirmCalls, 0);
  assert.equal(permissionMode.cancelMode, "ask");
  assert.equal(permissionMode.cancelInputEnabled, true);
  assert.equal(permissionMode.cancelInputFocused, true);
  assert.equal(permissionMode.confirmMode, "full");
  assert.equal(permissionMode.confirmInputEnabled, true);
  assert.equal(permissionMode.confirmInputFocused, true);
  assert.equal(permissionMode.delayedInputEnabled, true);
  assert.equal(permissionMode.delayedInputFocused, true);
  assert.equal(permissionMode.dialogWithinViewport, true);
  assert.equal(permissionMode.buttonsOverlap, false);
  assert.equal(permissionMode.overlayHidden, true);
  assert.equal(permissionMode.queueButtonRemoved, true);
  assert.equal(confirmation.visible, true);
  assert.match(confirmation.title, /移除这个会话/);
  assert.match(confirmation.description, /一小时内恢复/);
  assert.match(confirmation.detail, /原始 ChatGPT/);
  assert.equal(confirmation.cancelFocused, true);
  assert.equal(confirmation.dialogWithinViewport, true);
  assert.equal(confirmation.buttonsOverlap, false);
  assert.equal(confirmation.cancelResult, false);
  assert.equal(confirmation.confirmResult, true);
  assert.equal(confirmation.escapeResult, false);
  assert.equal(confirmation.neutralTone, true);
  assert.equal(confirmation.nativeConfirmCalls, 0);
  assert.equal(confirmation.hiddenAfterDecision, true);
  assert.equal(messageFeatures.actionButtons, 8);
  assert.equal(messageFeatures.agentActions, 4);
  assert.equal(messageFeatures.userActions, 4);
  assert.equal(messageFeatures.branchButtonVisible, true);
  assert.equal(messageFeatures.branchCreated, true);
  assert.equal(messageFeatures.branchOriginalPreserved, true);
  assert.match(messageFeatures.copiedText, /优化重点/);
  assert.match(messageFeatures.quotedText, /^回复完成后继续处理下一条消息/);
  assert.match(messageFeatures.quotedText, /> 请分析当前界面/);
  assert.match(messageFeatures.editedText, /请分析当前界面/);
  assert.equal(messageFeatures.stopRequestedByEdit, true);
  assert.match(messageFeatures.editTitleWhileRunning, /停止当前回复并编辑/);
  assert.equal(messageFeatures.searchHits, 1);
  assert.match(messageFeatures.searchSnippet, /消息正文命中/);
  assert.equal(messageFeatures.searchBodyOverflow, false);
  assert.equal(deliveryModes.queueLengthBeforeSteer, 2);
  assert.equal(deliveryModes.firstQueuedText, "等当前回复完成后再执行这一条");
  assert.equal(deliveryModes.secondQueuedText, "竞态情况下也不能丢失的消息");
  assert.equal(deliveryModes.steerButtonsBeforeClick, 2);
  assert.equal(deliveryModes.compatibleSteerVisible, true);
  assert.equal(deliveryModes.queuePanelVisible, true);
  assert.equal(deliveryModes.queuePanelItems, 2);
  assert.equal(deliveryModes.queueIcons, 2);
  assert.equal(deliveryModes.deleteButtons, 2);
  assert.equal(deliveryModes.moreButtons, 2);
  assert.equal(deliveryModes.queuePanelAboveInput, true);
  assert.equal(deliveryModes.queuedMessagesInChat, 0);
  assert.equal(deliveryModes.inputAfterQueue, "");
  assert.equal(deliveryModes.queueButtonRemoved, true);
  assert.equal(deliveryModes.queueLengthAfterSuccess, 1);
  assert.equal(deliveryModes.remainingAfterInactive, 0);
  assert.equal(deliveryModes.queuePanelHiddenAfterDrain, true);
  assert.equal(deliveryModes.nativeSteerRequests, 2);
  assert.equal(deliveryModes.interruptRequests, 1);
  assert.ok(deliveryModes.persistedQueueWrites >= 3);
  assert.equal(deliveryModes.persistedQueueLength, 1);
  assert.equal(deliveryModes.queueClaimCount, 1);
  assert.deepEqual(deliveryModes.claimedMessageIds, [deliveryModes.secondQueuedId]);
  assert.equal(deliveryModes.nativeExpectedTurnId, "turn-running");
  assert.equal(deliveryModes.inactiveExpectedTurnId, "turn-running");
  assert.equal(deliveryModes.inactiveStartedText, "竞态情况下也不能丢失的消息");
  assert.match(deliveryModes.sendTitle, /排队发送/);
  assert.ok(deliveryModes.deliveryLabels.some((label) => label.includes("已引导")));
  assert.ok(deliveryModes.actionTopDelta <= 1);
  assert.equal(deliveryModes.footerOverflow, false);
  assert.equal(compatibleGuide.button.visible, true);
  assert.match(compatibleGuide.button.title, /停止当前回复并立即/);
  assert.deepEqual(compatibleGuide.interrupted, ["turn-compatible-guide"]);
  assert.deepEqual(compatibleGuide.started, ["立即采用新的要求"]);
  assert.equal(compatibleGuide.remaining, 0);
  assert.equal(compatibleGuide.runningTurnId, "unexpected-reconnect-turn");
  assert.ok(compatibleGuide.deliveryLabels.some((label) => label.includes("已引导")));
  assert.equal(steerRace.startsWhilePending, 0);
  assert.deepEqual(steerRace.startedAfterResolve, ["只发送一次的下一条"]);
  assert.deepEqual(steerRace.remaining, []);
  assert.equal(steerRace.runningTurnId, "unexpected-reconnect-turn");
  assert.equal(steerRace.steeringLocked, false);
  assert.equal(steerRace.dispatchLocked, false);
  assert.deepEqual(queueActions.afterDelete, ["编辑我"]);
  assert.equal(queueActions.remainingAfterEdit, 0);
  assert.equal(queueActions.restoredText, "编辑我");
  assert.deepEqual(queueActions.restoredAttachments, [conversationScreenshot]);
  assert.equal(queueActions.panelHidden, true);
  assert.equal(restartRecovery.interruptionVisibleBeforeOpen, true);
  assert.match(restartRecovery.interruptionText, /上次在回答完成前关闭/);
  assert.equal(restartRecovery.queuedBeforeOpen, 1);
  assert.equal(restartRecovery.queueLength, 0);
  assert.equal(restartRecovery.interruptionVisibleAfterOpen, false);
  assert.equal(restartRecovery.running, true);
  assert.equal(restartRecovery.panelHidden, true);
  assert.deepEqual(restartRecovery.started, ["重启后只发送一次"]);
  assert.deepEqual(restartRecovery.claimed, ["restart-queue-message"]);
  assert.deepEqual({ added: attachments.added, unsupported: attachments.unsupported }, { added: 1, unsupported: 0 });
  assert.equal(attachments.pasteCanceled, true);
  assert.equal(attachments.pastedCount, 1);
  assert.equal(attachments.pastedFilename, "vue-renderer-conversation.png");
  assert.equal(attachments.clipboardPasteRequests, 1);
  assert.equal(attachments.count, 2);
  assert.equal(attachments.reactiveCount, 2);
  assert.equal(attachments.filename, "vue-renderer-conversation.png");
  assert.deepEqual(attachments.typeLabels, ["图片附件", "文档附件"]);
  assert.equal(attachments.ignoredMessage, "已从剪贴板添加 1 个附件。");
  assert.equal(attachments.overlayVisible, true);
  assert.equal(attachments.overlayCleared, true);
  assert.equal(attachments.conversationCopyButtons, 1);
  assert.equal(attachments.trayActionButtons, 2);
  assert.equal(attachments.documentPreviewVisible, true);
  assert.equal(attachments.documentPreviewTitle, "notes.txt");
  assert.deepEqual(attachments.copiedImages, [
    { path: conversationScreenshot },
    { path: conversationScreenshot },
  ]);
  assert.equal(attachments.countAfterRemove, 1);
  assert.equal(attachments.reactiveCountAfterRemove, 1);
  assert.deepEqual({ visible: localHistory.visible, sources: localHistory.sources, conversations: localHistory.conversations, messages: localHistory.messages }, { visible: true, sources: 2, conversations: 2, messages: 3 });
  assert.equal(localHistory.title, "本地记录功能迭代");
  assert.match(localHistory.readOnlyNotice, /只读浏览原始会话/);
  assert.match(localHistory.readOnlyNotice, /ChatSwitch 私有记录/);
  assert.match(localHistory.buttonLabel, /复制到 ChatSwitch/);
  assert.equal(localHistory.statusRole, "status");
  assert.equal(localHistory.overlayClosedAfterImport, true);
  assert.equal(localHistory.openedThreadId, "local-imported-history-fixture");
  assert.equal(localHistory.openedThreadName, "本地记录功能迭代");
  assert.deepEqual(localHistory.importRequests, [{ conversationId: "codex-local-1" }]);
  assert.equal(localHistory.bodyOverflow, false);
  assert.equal(localHistory.dialogOverflow, false);
  assert.equal(localHistory.bulkEnabledBefore, true);
  assert.equal(localHistory.bulkConfirmationVisible, false);
  assert.match(localHistory.bulkSummary, /批量完成：导入 4/);
  assert.deepEqual(localHistory.bulkImportRequests, [{ sourceIds: ["codex", "claude"], search: "" }]);
  assert.equal(filePreview.visible, true);
  assert.equal(filePreview.title, "notes.txt");
  assert.match(filePreview.meta, /TXT/);
  assert.match(filePreview.content, /文件预览测试/);
  assert.equal(filePreview.systemButton, true);
  assert.equal(filePreview.bodyOverflow, false);
  assert.deepEqual(
    { visible: localProviders.visible, rows: localProviders.rows, selectable: localProviders.selectable },
    { visible: true, rows: 3, selectable: 1 },
  );
  assert.match(localProviders.privacy, /API Key 不会发送到界面/);
  assert.equal(localProviders.exposedSecret, false);
  assert.match(localProviders.importStatus, /已导入 1 项/);
  assert.equal(localProviders.providerAdded, true);
  assert.equal(localProviders.importedCandidateMarkedDuplicate, true);
  assert.equal(localProviders.bodyOverflow, false);
  assert.equal(localProviders.dialogOverflow, false);
  assert.deepEqual({ visible: usage.visible, stats: usage.stats, rows: usage.rows }, { visible: true, stats: 5, rows: 3 });
  assert.equal(usage.trendColumns, 14);
  assert.ok(usage.pricingTop >= usage.logBottom, `Pricing overlaps request log: ${JSON.stringify(usage)}`);
  assert.equal(usage.bodyOverflow, false);
  assert.equal(usage.compactBodyOverflow, false);
  assert.deepEqual({ visible: backup.visible, rows: backup.rows, restoreButtons: backup.restoreButtons }, { visible: true, rows: 2, restoreButtons: 2 });
  assert.equal(backup.bodyOverflow, false);
  assert.deepEqual(
    { visible: sync.visible, rows: sync.rows, directory: sync.directory, webdavVisible: sync.webdavVisible, webdavUrl: sync.webdavUrl, pullLabel: sync.pullLabel },
    { visible: true, rows: 2, directory: "F:\\ChatSwitch Sync", webdavVisible: true, webdavUrl: "https://dav.example.test/chatswitch/", pullLabel: "使用 WebDAV" },
  );
  assert.equal(sync.bodyOverflow, false);
  assert.equal(sync.dialogOverflow, false);
  assert.deepEqual(sync.selectedTabs, ["false", "true"]);
  assert.match(sync.description, /不包含 API Key、MCP 密钥或聊天正文/);
  assert.deepEqual({ visible: appSettings.visible, toggles: appSettings.toggles, closeToTray: appSettings.closeToTray }, { visible: true, toggles: 2, closeToTray: true });
  assert.equal(appSettings.bodyOverflow, false);
  assert.equal(appSettings.updateState, "available");
  assert.match(appSettings.updateMessage, /v0\.2\.0/);
  assert.equal(appSettings.updateDownloadVisible, true);
  assert.equal(appSettings.versionLabel, `v${APP_VERSION}`);
  assert.equal(importPreview.visible, true);
  assert.equal(importPreview.rows, 4);
  assert.match(importPreview.safety, /敏感信息不会从链接导入/);
  assert.equal(importPreview.bodyOverflow, false);
  assert.equal(importPreview.connectionVisible, true);
  assert.equal(importPreview.importedLabel, "Imported Lab API");
  assert.equal(importPreview.importedModel, "");
  assert.equal(importPreview.apiKey, "");
  assert.equal(importPreview.apiKeyRequired, true);
  assert.deepEqual({ visible: skillInstall.visible, kind: skillInstall.kind, sourceType: skillInstall.sourceType, browseHidden: skillInstall.browseHidden }, { visible: true, kind: "github", sourceType: "url", browseHidden: true });
  assert.equal(skillInstall.bodyOverflow, false);
  assert.deepEqual({ visible: health.visible, rows: health.rows, healthy: health.healthy }, { visible: true, rows: 3, healthy: 3 });
  assert.match(health.routeText, /备用 Qwen/);
  assert.match(health.summary, /3 正常/);
  assert.equal(health.bodyOverflow, false);
  assert.deepEqual({ skillRows: extensions.skillRows, promptName: extensions.promptName, mcpRows: extensions.mcpRows }, { skillRows: 2, promptName: "summarize", mcpRows: 1 });
  assert.equal(extensions.removableButtons, 1);
  assert.equal(extensions.promptPreview.visible, true);
  assert.match(extensions.promptPreview.text, /提炼当前内容/);
  assert.equal(extensions.secretValue, "ACCESS_TOKEN=");
  assert.equal(extensions.insertedPrompt, "请提炼当前内容的关键结论。\n");
  assert.equal(extensions.bodyOverflow, false);
  assert.equal(darkTheme.theme, "dark");
  assert.equal(windowThemeRequests.includes("light"), true);
  assert.equal(windowThemeRequests.at(-1), "dark");
  assert.equal(darkTheme.bodyOverflow, false);
  assert.equal(
    interactiveLayoutAudits.every((audit) => audit.overlaps.length === 0),
    true,
    `Interactive controls overlap: ${JSON.stringify(interactiveLayoutAudits.filter((audit) => audit.overlaps.length))}`,
  );
  assert.notEqual(darkTheme.bodyBackground, "rgb(255, 255, 255)");
  assert.notEqual(darkTheme.dialogBackground, "rgb(255, 255, 255)");
  assert.notEqual(darkTheme.inputBackground, "rgb(255, 255, 255)");
  assert.equal(errors.some((message) => /Content Security Policy|Uncaught|Vue warn/i.test(message)), false, errors.join("\n"));

  console.log(JSON.stringify({
    ok: true,
    authGate,
    loginFlow,
    accountUsage,
    relayModelFlow,
    lightDesktop,
    desktop,
    compact,
    conversation,
    notificationApprovalSync,
    confirmation,
    messageFeatures,
    deliveryModes,
    restartRecovery,
    attachments,
    localHistory,
    filePreview,
    localProviders,
    usage,
    backup,
    sync,
    appSettings,
    importPreview,
    skillInstall,
    health,
    extensions,
    darkTheme,
    windowThemeRequests,
    interactiveLayoutAudits,
    errors,
    screenshots: [accountUsageScreenshot, lightDesktopScreenshot, desktopScreenshot, compactScreenshot, conversationScreenshot, confirmationScreenshot, attachmentScreenshot, localHistoryScreenshot, filePreviewScreenshot, localProviderScreenshot, usageScreenshot, usageCompactScreenshot, backupScreenshot, syncScreenshot, appSettingsScreenshot, importPreviewScreenshot, healthScreenshot, extensionsScreenshot, skillInstallScreenshot, darkExtensionsScreenshot],
  }));
  window.destroy();
  app.quit();
}

run().catch((error) => {
  console.error(error.stack || error.message);
  app.exit(1);
});
