const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  CodexServer,
  BASE_PROVIDERS,
  approvalSettings,
  normalizeDiagnostic,
} = require("../src/codex-server");
const {
  bundledCodexCandidates,
  isBundledCodexExecutable,
} = require("../src/cli-discovery");
const {
  INTERRUPTED_TOOL_OUTPUT,
  interruptedToolCalls,
  repairInterruptedToolCallsForThread,
} = require("../src/conversation-integrity");
const providerStoreTestRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chatswitch-store-unit-"));
process.env.CHATSWITCH_STORE_ROOT = providerStoreTestRoot;
const {
  ProviderStore,
  DEFAULT_CONVERSATION_HOME,
  nextScheduledAt,
  providerApiKey,
  providerPresetCatalog,
  reasoningProfile,
  seedOfficialCredentials,
} = require("../src/provider-store");
const { ClaudeServer, claudePermissionArgs } = require("../src/claude-server");
const {
  OpenAICompatibleServer,
  chatCompletionsEndpoint,
  importedLocalThread,
  parseCodexThreadFile,
  parseSseBlock,
} = require("../src/openai-compatible-server");
const { explicitBoolean, fetchRelayBalance } = require("../src/relay-balance");
const { fetchClaudeModels, fetchClaudeModelsSafely } = require("../src/claude-models");
const { fetchOpenAIModels, modelsEndpoint, modelsEndpointCandidates } = require("../src/openai-models");
const { executeScheduledTask, finalizeScheduledTask } = require("../src/scheduled-task-runner");
const { syncConversationMirror, syncConversationMirrors } = require("../src/conversation-mirror");
const { installSkillSource, listManagedSkills, syncManagedSkills, syncSkillRoots } = require("../src/skill-mirror");
const { parseChatSwitchLink, chatSwitchLinkFromArgs } = require("../src/deep-link");
const { createLocalHistoryReader } = require("../src/local-conversation-history");
const { createLocalProviderDiscovery, parseCodexConfig } = require("../src/local-provider-discovery");
const { APP_VERSION, USER_AGENT, compareVersions, updateFromRelease } = require("../src/app-version");
const {
  isAuthenticatedOfficialSnapshot,
  requireAuthenticatedOfficialSnapshot,
} = require("../src/openai-auth");
const { normalizeRateLimits, normalizeAccountUsage } = require("../src/openai-account-usage");
const {
  buildContinuationPrompt,
  mergeLogicalThread,
  remapBranchMessage,
} = require("../src/conversation-branches");
const { createStreamEventBatcher } = require("../src/stream-event-batcher");
const {
  ensureWindowsNotificationIdentity,
  notificationShortcutArguments,
  windowsTaskbarDetails,
} = require("../src/windows-notification-identity");
const {
  ApprovalRequestRegistry,
  approvalDecisionForNotificationAction,
  approvalDecisionResult,
  approvalNotificationSpec,
} = require("../src/approval-request");

function testApprovalNotifications() {
  const registry = new ApprovalRequestRegistry();
  const server = {};
  const first = { id: "first" };
  const replacement = { id: "replacement" };
  assert.equal(registry.replace(server, 7, first), null);
  assert.equal(registry.replace(server, "7", replacement), first);
  assert.equal(registry.take(server, 7), replacement);
  assert.equal(registry.take(server, 7), null);
  registry.replace(server, 8, first);
  assert.deepEqual(registry.clear(server), [first]);
  assert.deepEqual(registry.clear(server), []);

  const command = {
    method: "item/commandExecution/requestApproval",
    params: { command: "tool.exe --api-key must-not-appear" },
  };
  const commandSpec = approvalNotificationSpec(command);
  assert.equal(commandSpec.title, "ChatSwitch 请求授权");
  assert.equal(commandSpec.actions.length, 3);
  assert.equal(commandSpec.body.includes("must-not-appear"), false);
  assert.deepEqual(commandSpec.actions.map((action) => action.text), ["拒绝", "允许一次", "本会话允许"]);
  assert.equal(approvalDecisionForNotificationAction(0), "decline");
  assert.equal(approvalDecisionForNotificationAction(1), "accept");
  assert.equal(approvalDecisionForNotificationAction(2), "acceptForSession");
  assert.equal(approvalDecisionForNotificationAction(3), null);
  assert.deepEqual(approvalDecisionResult(command, "accept"), { decision: "accept" });
  assert.deepEqual(approvalDecisionResult({ method: "execCommandApproval" }, "acceptForSession"), {
    decision: "approved_for_session",
  });

  const permissions = {
    method: "item/permissions/requestApproval",
    params: { permissions: { network: { hosts: ["example.test"] }, fileSystem: { roots: ["F:\\work"] } } },
  };
  assert.match(approvalNotificationSpec(permissions).body, /网络访问和文件访问/);
  assert.deepEqual(approvalDecisionResult(permissions, "acceptForSession"), {
    permissions: permissions.params.permissions,
    scope: "session",
  });
  assert.deepEqual(approvalDecisionResult(permissions, "decline"), { permissions: {}, scope: "turn" });

  const userInputSpec = approvalNotificationSpec({ method: "item/tool/requestUserInput" });
  assert.equal(userInputSpec.actions.length, 0);
  assert.match(userInputSpec.body, /点击通知/);
  const mcpSpec = approvalNotificationSpec({ method: "mcpServer/elicitation/request" });
  assert.equal(mcpSpec.actions.length, 0);
}

function testOfficialAuthenticationGate() {
  const provider = { type: "official" };
  const account = { account: { type: "chatgpt", email: "person@example.test" }, requiresOpenaiAuth: true };
  assert.equal(isAuthenticatedOfficialSnapshot(account), true);
  assert.equal(isAuthenticatedOfficialSnapshot({
    account: { type: "chatgpt", email: "person@example.test" },
    requiresOpenaiAuth: false,
  }), true);
  assert.equal(isAuthenticatedOfficialSnapshot({ account: null, requiresOpenaiAuth: true }), false);
  assert.equal(isAuthenticatedOfficialSnapshot({ account: null, requiresOpenaiAuth: false }), false);
  assert.equal(requireAuthenticatedOfficialSnapshot(provider, account), account);
  assert.throws(
    () => requireAuthenticatedOfficialSnapshot(provider, { account: null, requiresOpenaiAuth: true }),
    /尚未登录 ChatGPT/,
  );
  assert.throws(
    () => requireAuthenticatedOfficialSnapshot(provider, { account: null }, { afterLogin: true }),
    /登录未完成/,
  );
  assert.deepEqual(
    requireAuthenticatedOfficialSnapshot({ type: "relay" }, { account: null }),
    { account: null },
  );
}

function testOfficialAccountUsageNormalization() {
  const response = normalizeRateLimits({
    rateLimits: {
      limitId: "codex-default",
      primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1786753800 },
      secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1787013000 },
      credits: { hasCredits: true, unlimited: false, balance: "12.5" },
    },
    rateLimitsByLimitId: {
      "codex-dynamic-id": {
        limitId: "codex-dynamic-id",
        limitName: "Codex",
        primary: { usedPercent: 12.5, windowDurationMins: 300, resetsAt: 1786753800 },
        secondary: { usedPercent: 55, windowDurationMins: 10080, resetsAt: 1787013000 },
        credits: { hasCredits: true, unlimited: false, balance: "8.0" },
      },
    },
    rateLimitResetCredits: { availableCount: "2" },
  });
  assert.equal(response.groups.length, 2);
  assert.equal(response.groups[0].id, "codex-dynamic-id");
  assert.deepEqual(response.groups[0].windows.map((window) => window.windowDurationMins), [300, 10080]);
  assert.deepEqual(response.groups[0].windows.map((window) => window.usedPercent), [12.5, 55]);
  assert.equal(response.resetCredits, 2);
  assert.deepEqual(normalizeAccountUsage({ summary: {
    lifetimeTokens: "1250000",
    peakDailyTokens: 250000,
    longestRunningTurnSec: 360,
    currentStreakDays: 7,
    longestStreakDays: 12,
  } }), {
    lifetimeTokens: 1250000,
    peakDailyTokens: 250000,
    longestRunningTurnSec: 360,
    currentStreakDays: 7,
    longestStreakDays: 12,
  });
}

function testWindowsNotificationIdentity() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chatswitch-notification-"));
  const programs = path.join(root, "Microsoft", "Windows", "Start Menu", "Programs");
  const legacyPath = path.join(programs, "Electron.lnk");
  const target = path.join(root, "electron.exe");
  const writes = [];
  try {
    fs.mkdirSync(programs, { recursive: true });
    fs.writeFileSync(legacyPath, "legacy", "utf8");
    const shellApi = {
      writeShortcutLink(shortcutPath, operation, details) {
        writes.push({ shortcutPath, operation, details });
        fs.writeFileSync(shortcutPath, "chatswitch", "utf8");
        return true;
      },
      readShortcutLink() {
        return { target, appUserModelId: "com.chatswitch.desktop" };
      },
    };
    const result = ensureWindowsNotificationIdentity({
      platform: "win32",
      appData: root,
      appUserModelId: "com.chatswitch.desktop",
      toastActivatorClsid: "{E6B8F4D5-4A0D-4B9F-8E3B-3C0F5C3E6D21}",
      target,
      args: "--test",
      cwd: root,
      icon: path.join(root, "icon.ico"),
      shellApi,
    });
    assert.equal(result.status, "registered");
    assert.equal(result.removedLegacy, true);
    assert.equal(fs.existsSync(legacyPath), false);
    assert.equal(writes.length, 1);
    assert.equal(path.basename(writes[0].shortcutPath), "ChatSwitch.lnk");
    assert.equal(writes[0].operation, "create");
    assert.equal(writes[0].details.description, "ChatSwitch");
    assert.equal(writes[0].details.appUserModelId, "com.chatswitch.desktop");
    assert.equal(writes[0].details.toastActivatorClsid, "{E6B8F4D5-4A0D-4B9F-8E3B-3C0F5C3E6D21}");
    fs.writeFileSync(legacyPath, "unrelated", "utf8");
    shellApi.readShortcutLink = () => ({
      target: path.join(root, "another-electron-app.exe"),
      appUserModelId: "com.chatswitch.desktop",
    });
    const preserved = ensureWindowsNotificationIdentity({
      platform: "win32",
      appData: root,
      appUserModelId: "com.chatswitch.desktop",
      toastActivatorClsid: "{E6B8F4D5-4A0D-4B9F-8E3B-3C0F5C3E6D21}",
      target,
      shellApi,
    });
    assert.equal(preserved.operation, "replace");
    assert.equal(preserved.removedLegacy, false);
    assert.equal(fs.existsSync(legacyPath), true);
    assert.equal(notificationShortcutArguments({
      isPackaged: false,
      userData: "C:\\ChatSwitch Data",
      applicationRoot: "F:\\codepro",
    }), '--user-data-dir="C:\\ChatSwitch Data" "F:\\codepro"');
    assert.equal(notificationShortcutArguments({ isPackaged: true }), "");
    assert.deepEqual(windowsTaskbarDetails({
      isPackaged: false,
      userData: "C:\\ChatSwitch Data",
      applicationRoot: "F:\\codepro",
      appUserModelId: "com.chatswitch.desktop",
      target: "F:\\codepro\\electron.exe",
      icon: "F:\\codepro\\build\\icon.ico",
    }), {
      appId: "com.chatswitch.desktop",
      appIconPath: "F:\\codepro\\build\\icon.ico",
      appIconIndex: 0,
      relaunchCommand: '"F:\\codepro\\electron.exe" --user-data-dir="C:\\ChatSwitch Data" "F:\\codepro"',
      relaunchDisplayName: "ChatSwitch",
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testOfficialCliArguments() {
  assert.equal(BASE_PROVIDERS.official.args.includes("--ignore-user-config"), false);
  assert.deepEqual(BASE_PROVIDERS.official.args, [
    "-c", "model_provider=\"openai\"",
    "-c", "cli_auth_credentials_store=\"file\"",
    "-c", "features.apps=false",
    "-c", "features.remote_plugin=false",
    "app-server",
  ]);
}

function testBundledCodexRuntimeDiscovery() {
  if (process.platform !== "win32") return;
  assert.equal(isBundledCodexExecutable("C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0.0.0_x64__test\\app\\resources\\codex.exe"), true);
  assert.equal(isBundledCodexExecutable("C:\\Users\\PC\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe"), false);
  assert.ok(bundledCodexCandidates().every((candidate) => isBundledCodexExecutable(candidate)));
}

function testDiagnosticNormalization() {
  const diagnostic = "\u001b[2m2026-07-26T09:42:17Z\u001b[0m \u001b[31mERROR\u001b[0m\r\nfailed to refresh models\u0007";
  assert.equal(normalizeDiagnostic(diagnostic), "2026-07-26T09:42:17Z ERROR\nfailed to refresh models");
}

function testRawCodexDiagnosticsStayInternal() {
  const server = new CodexServer(BASE_PROVIDERS.hexuan, {});
  const visible = [];
  const internal = [];
  server.on("diagnostic", (message) => visible.push(message));
  server.on("server-log", (message) => internal.push(message));
  server.recordDiagnostic("2026-08-04T13:02:29Z ERROR custom tool output is missing");
  server.handleLine("plain app-server stderr-like output");
  assert.deepEqual(visible, []);
  assert.equal(internal.length, 2);
  assert.match(server.diagnostics.at(-1), /plain app-server/);
}

function testApplicationVersioning() {
  assert.equal(APP_VERSION, require("../package.json").version);
  assert.equal(USER_AGENT, `ChatSwitch/${APP_VERSION}`);
  assert.equal(compareVersions("0.1.2", "0.1.1"), 1);
  assert.equal(compareVersions("v0.1.2", "0.1.2"), 0);
  assert.equal(compareVersions("0.1.1", "0.1.2"), -1);
  const release = { tag_name: "v0.2.0", html_url: "https://github.com/MttJelly/chatswitch/releases/tag/v0.2.0" };
  assert.deepEqual(updateFromRelease("0.1.2", release), {
    status: "available",
    currentVersion: "0.1.2",
    latestVersion: "0.2.0",
    releaseUrl: release.html_url,
    publishedAt: null,
    message: "发现新版本 v0.2.0，当前为 v0.1.2。",
  });
}

function testOfficialCredentialSeeding() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chatswitch-unit-"));
  const source = path.join(root, "source");
  const target = path.join(root, "target");
  try {
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, "auth.json"), "source-auth", "utf8");
    assert.equal(seedOfficialCredentials(source, target), true);
    assert.equal(fs.readFileSync(path.join(target, "auth.json"), "utf8"), "source-auth");
    fs.writeFileSync(path.join(source, "auth.json"), "new-source-auth", "utf8");
    assert.equal(seedOfficialCredentials(source, target), false);
    assert.equal(fs.readFileSync(path.join(target, "auth.json"), "utf8"), "source-auth");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testIsolatedStoreDefaults() {
  const store = new ProviderStore();
  assert.equal(DEFAULT_CONVERSATION_HOME, path.join(providerStoreTestRoot, "conversations"));
  assert.equal(store.conversationHome(), DEFAULT_CONVERSATION_HOME);
  assert.equal(fs.existsSync(DEFAULT_CONVERSATION_HOME), true);
  assert.deepEqual(store.list(), []);
  const claude = new ClaudeServer({
    claudeConfigDir: path.join(DEFAULT_CONVERSATION_HOME, "claude"),
    model: "fable",
  });
  assert.equal(claude.globalProjectsRoot, null);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "chatswitch-outside-store-"));
  try {
    assert.throws(() => store.setConversationHome(outside), /隔离模式/);
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
}

function testClaudeOfficialAuthSettings() {
  const store = new ProviderStore();
  const provider = store.saveClaudeSettings({
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-sonnet",
    vendorLabel: "Anthropic 官方",
    authMode: "oauth",
  });
  assert.equal(provider.id, "claude");
  assert.equal(provider.authMode, "oauth");
  assert.equal(store.resolve("claude").authMode, "oauth");
}



async function testConversationMirror() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chatswitch-mirror-unit-"));
  const source = path.join(root, "source");
  const target = path.join(root, "target");
  const activeSource = path.join(source, "sessions", "2026", "07", "thread-a.jsonl");
  const archivedSource = path.join(source, "archived_sessions", "thread-b.jsonl");
  try {
    fs.mkdirSync(path.dirname(activeSource), { recursive: true });
    fs.mkdirSync(path.dirname(archivedSource), { recursive: true });
    fs.writeFileSync(activeSource, '{"id":"a","value":1}\n', "utf8");
    fs.writeFileSync(archivedSource, '{"id":"b"}\n', "utf8");
    fs.writeFileSync(path.join(source, "auth.json"), "must-not-copy", "utf8");
    const first = await syncConversationMirror(source, target);
    assert.deepEqual({ copied: first.copied, updated: first.updated }, { copied: 2, updated: 0 });
    assert.equal(fs.readFileSync(path.join(target, "sessions", "2026", "07", "thread-a.jsonl"), "utf8"), '{"id":"a","value":1}\n');
    assert.equal(fs.existsSync(path.join(target, "auth.json")), false);
    const second = await syncConversationMirror(source, target);
    assert.equal(second.skipped, 2);

    const activeTarget = path.join(target, "sessions", "2026", "07", "thread-a.jsonl");
    fs.writeFileSync(activeTarget, '{"id":"a","local":true}\n', "utf8");
    fs.writeFileSync(activeSource, '{"id":"a","value":2}\n', "utf8");
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(activeSource, future, future);
    const updated = await syncConversationMirror(source, target);
    assert.equal(updated.updated, 1);
    assert.equal(updated.backedUp, 1);
    assert.equal(fs.readFileSync(activeTarget, "utf8"), '{"id":"a","value":2}\n');
    assert.equal(fs.existsSync(path.join(target, ".chatswitch-sync-backups")), true);

    fs.unlinkSync(archivedSource);
    await syncConversationMirror(source, target);
    assert.equal(fs.existsSync(path.join(target, "archived_sessions", "thread-b.jsonl")), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testConversationMirrorMultipleSources() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chatswitch-mirror-multi-unit-"));
  const primary = path.join(root, "primary");
  const original = path.join(root, "original");
  const target = path.join(root, "target");
  const sharedRelative = path.join("sessions", "2026", "08", "shared.jsonl");
  const originalOnlyRelative = path.join("sessions", "2026", "08", "original-only.jsonl");
  try {
    fs.mkdirSync(path.dirname(path.join(primary, sharedRelative)), { recursive: true });
    fs.mkdirSync(path.dirname(path.join(original, sharedRelative)), { recursive: true });
    fs.writeFileSync(path.join(primary, sharedRelative), '{"source":"primary"}\n', "utf8");
    fs.writeFileSync(path.join(original, sharedRelative), '{"source":"original"}\n', "utf8");
    fs.writeFileSync(path.join(original, originalOnlyRelative), '{"source":"original-only"}\n', "utf8");
    const first = await syncConversationMirrors([primary, original], target);
    assert.equal(first.copied, 2);
    assert.equal(first.conflicts, 1);
    assert.equal(fs.readFileSync(path.join(target, sharedRelative), "utf8"), '{"source":"primary"}\n');
    assert.equal(fs.readFileSync(path.join(target, originalOnlyRelative), "utf8"), '{"source":"original-only"}\n');

    fs.writeFileSync(path.join(original, originalOnlyRelative), '{"source":"original-updated"}\n', "utf8");
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(original, originalOnlyRelative), future, future);
    const second = await syncConversationMirrors([primary, original], target);
    assert.equal(second.updated, 1);
    assert.equal(fs.readFileSync(path.join(target, originalOnlyRelative), "utf8"), '{"source":"original-updated"}\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testPrivateConfigurationSync() {
  const store = new ProviderStore();
  const syncRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chatswitch-sync-unit-"));
  try {
    assert.throws(() => store.configureSync({ directory: path.join(providerStoreTestRoot, "sync") }), /不能位于/);
    const configured = store.configureSync({ directory: syncRoot, autoSync: true });
    assert.equal(configured.directory, syncRoot);
    assert.equal(configured.autoSync, true);

    const pushed = store.syncConfiguration("auto");
    assert.equal(pushed.conflict, false);
    assert.equal(pushed.result.direction, "push");
    const syncFile = path.join(syncRoot, "chatswitch-sync.json");
    const remote = JSON.parse(fs.readFileSync(syncFile, "utf8"));
    assert.equal(remote.containsCredentials, false);
    assert.equal(JSON.stringify(remote).includes("encryptedCredentials"), false);

    remote.projects.push({ label: "Remote Sync Project", root: null });
    fs.writeFileSync(syncFile, `${JSON.stringify(remote, null, 2)}\n`, "utf8");
    const pulled = store.syncConfiguration("auto");
    assert.equal(pulled.result.direction, "pull");
    assert.equal(store.listProjects().some((project) => project.label === "Remote Sync Project"), true);

    store.addProject({ label: "Local Sync Conflict" });
    const changedRemote = JSON.parse(fs.readFileSync(syncFile, "utf8"));
    changedRemote.projects.push({ label: "Remote Sync Conflict", root: null });
    fs.writeFileSync(syncFile, `${JSON.stringify(changedRemote, null, 2)}\n`, "utf8");
    const conflict = store.syncConfiguration("auto");
    assert.equal(conflict.conflict, true);
    assert.equal(conflict.result.status, "conflict");
    const resolved = store.syncConfiguration("push");
    assert.equal(resolved.result.direction, "push");
  } finally {
    fs.rmSync(syncRoot, { recursive: true, force: true });
  }
}

async function testWebdavConfigurationSync() {
  const store = new ProviderStore();
  const metadataFile = path.join(providerStoreTestRoot, "providers.json");
  const metadata = JSON.parse(fs.readFileSync(metadataFile, "utf8"));
  metadata.syncSettings = {
    backend: "webdav",
    webdavUrl: "https://dav.example.test/chatswitch/",
    autoSync: false,
    lastSyncedHash: null,
    lastSyncedAt: null,
    lastRemoteExists: false,
  };
  fs.writeFileSync(metadataFile, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  store.webdavCredentials = () => ({ username: "qa-user", password: "qa-pass" });
  let remoteText = null;
  const requests = [];
  const fakeFetch = async (url, options) => {
    requests.push({ url, method: options.method, authorization: options.headers.Authorization });
    if (options.method === "GET") {
      return remoteText === null
        ? new Response(null, { status: 404 })
        : new Response(remoteText, { status: 200, headers: { "Content-Type": "application/json" } });
    }
    remoteText = options.body;
    return new Response(null, { status: 204 });
  };
  const pushed = await store.syncConfigured("auto", fakeFetch);
  assert.equal(pushed.result.direction, "push");
  assert.equal(requests[0].url, "https://dav.example.test/chatswitch/chatswitch-sync.json");
  assert.match(requests[0].authorization, /^Basic /);
  assert.equal(requests.some((entry) => entry.authorization.includes("qa-pass")), false);

  const remote = JSON.parse(remoteText);
  remote.projects.push({ label: "WebDAV Remote Project", root: null });
  remoteText = `${JSON.stringify(remote, null, 2)}\n`;
  const pulled = await store.syncConfigured("auto", fakeFetch);
  assert.equal(pulled.result.direction, "pull");
  assert.equal(store.listProjects().some((project) => project.label === "WebDAV Remote Project"), true);

  store.addProject({ label: "WebDAV Local Conflict" });
  const changedRemote = JSON.parse(remoteText);
  changedRemote.projects.push({ label: "WebDAV Remote Conflict", root: null });
  remoteText = `${JSON.stringify(changedRemote, null, 2)}\n`;
  const conflict = await store.syncConfigured("auto", fakeFetch);
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.result.status, "conflict");
}

async function testSkillMirror() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chatswitch-skill-unit-"));
  const firstSource = path.join(root, "first");
  const secondSource = path.join(root, "second");
  const target = path.join(root, "private", "skills");
  try {
    fs.mkdirSync(path.join(firstSource, "alpha", ".git"), { recursive: true });
    fs.mkdirSync(path.join(firstSource, ".system", "internal"), { recursive: true });
    fs.mkdirSync(path.join(firstSource, "not-a-skill"), { recursive: true });
    fs.mkdirSync(path.join(secondSource, "alpha"), { recursive: true });
    fs.mkdirSync(path.join(secondSource, "beta"), { recursive: true });
    fs.writeFileSync(path.join(firstSource, "alpha", "SKILL.md"), "first alpha", "utf8");
    fs.writeFileSync(path.join(firstSource, "alpha", ".git", "config"), "excluded", "utf8");
    fs.writeFileSync(path.join(firstSource, ".system", "internal", "SKILL.md"), "internal", "utf8");
    fs.writeFileSync(path.join(secondSource, "alpha", "SKILL.md"), "second alpha", "utf8");
    fs.writeFileSync(path.join(secondSource, "beta", "SKILL.md"), "beta", "utf8");

    const result = await syncSkillRoots([firstSource, secondSource], target);
    assert.deepEqual(result.names, ["alpha", "beta"]);
    assert.equal(result.copied, 2);
    assert.equal(fs.readFileSync(path.join(target, "alpha", "SKILL.md"), "utf8"), "second alpha");
    assert.equal(fs.readFileSync(path.join(target, "beta", "SKILL.md"), "utf8"), "beta");
    assert.equal(fs.existsSync(path.join(target, ".system")), false);
    assert.equal(fs.existsSync(path.join(target, "not-a-skill")), false);
    assert.equal(fs.existsSync(path.join(target, "alpha", ".git")), false);

    fs.writeFileSync(path.join(target, "alpha", "SKILL.md"), "private edit", "utf8");
    assert.equal(fs.readFileSync(path.join(secondSource, "alpha", "SKILL.md"), "utf8"), "second alpha");
    const repaired = await syncSkillRoots([firstSource, secondSource], target);
    assert.equal(repaired.copied, 1);
    assert.equal(repaired.skipped, 1);
    assert.equal(fs.readFileSync(path.join(target, "alpha", "SKILL.md"), "utf8"), "second alpha");
    const unchanged = await syncSkillRoots([firstSource, secondSource], target);
    assert.equal(unchanged.copied, 0);
    assert.equal(unchanged.skipped, 2);
    const importSource = path.join(root, "repository", "packages", "gamma");
    const installedSource = path.join(root, "installed-sources");
    fs.mkdirSync(importSource, { recursive: true });
    fs.writeFileSync(path.join(importSource, "SKILL.md"), "---\ndescription: Gamma import\n---\n", "utf8");
    fs.writeFileSync(path.join(importSource, "helper.js"), "module.exports = true;\n", "utf8");
    const installed = await installSkillSource(path.join(root, "repository"), installedSource, "QA repository");
    assert.deepEqual(installed.map((item) => item.name), ["gamma"]);
    assert.equal(installed[0].files, 2);
    assert.equal(fs.readFileSync(path.join(installedSource, "gamma", "SKILL.md"), "utf8").includes("Gamma import"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testManagedSkillActivation() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chatswitch-managed-skill-unit-"));
  const source = path.join(root, "source");
  const library = path.join(root, "private-library");
  const active = path.join(root, "active");
  try {
    fs.mkdirSync(path.join(source, "alpha"), { recursive: true });
    fs.mkdirSync(path.join(source, "beta"), { recursive: true });
    fs.writeFileSync(path.join(source, "alpha", "SKILL.md"), "---\ndescription: Alpha workflow\n---\n# Alpha\n", "utf8");
    fs.writeFileSync(path.join(source, "beta", "SKILL.md"), "# Beta workflow\n", "utf8");
    const first = await syncManagedSkills([source], library, active, ["beta"]);
    assert.equal(first.activated, 1);
    assert.equal(fs.existsSync(path.join(active, "alpha", "SKILL.md")), true);
    assert.equal(fs.existsSync(path.join(active, "beta")), false);
    const catalog = await listManagedSkills(library, ["beta"]);
    assert.deepEqual(catalog.map((skill) => [skill.name, skill.enabled]), [["alpha", true], ["beta", false]]);
    assert.equal(catalog[0].description, "Alpha workflow");
    await syncManagedSkills([source], library, active, ["alpha"]);
    assert.equal(fs.existsSync(path.join(active, "alpha")), false);
    assert.equal(fs.existsSync(path.join(active, "beta", "SKILL.md")), true);
    assert.equal(fs.readFileSync(path.join(source, "alpha", "SKILL.md"), "utf8").includes("Alpha workflow"), true);
    const unavailable = await syncManagedSkills([path.join(root, "temporarily-unavailable")], library, active, ["alpha"]);
    assert.deepEqual(unavailable.names, ["alpha", "beta"]);
    assert.equal(fs.existsSync(path.join(active, "beta", "SKILL.md")), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testPrivateExtensionsStore() {
  const store = new ProviderStore();
  const decorated = store.setThreadDecoration("thread-fixture", { pinned: true, favorite: true, tags: ["论文", "重要"] });
  assert.equal(decorated["thread-fixture"].pinned, true);
  assert.deepEqual(decorated["thread-fixture"].tags, ["论文", "重要"]);
  const cleared = store.setThreadDecoration("thread-fixture", { pinned: false, favorite: false, tags: [] });
  assert.equal(cleared["thread-fixture"], undefined);
  const skill = store.setSkillEnabled("nature-writing", false);
  assert.deepEqual(skill, { name: "nature-writing", enabled: false });
  assert.deepEqual(store.disabledSkills(), ["nature-writing"]);
  store.setSkillEnabled("NATURE-WRITING", true);
  assert.deepEqual(store.disabledSkills(), []);

  const prompt = store.savePromptTemplate({ name: "review-code", description: "Review code", content: "Review this code." });
  assert.equal(store.promptTemplates().some((item) => item.id === prompt.id), true);
  assert.throws(() => store.savePromptTemplate({ name: "REVIEW-CODE", content: "Duplicate" }), /不能重名/);
  const updated = store.savePromptTemplate({ ...prompt, name: "review-changes", content: "Review these changes." });
  assert.equal(updated.name, "review-changes");
  store.removePromptTemplate(prompt.id);
  assert.equal(store.promptTemplates().some((item) => item.id === prompt.id), false);

  const mcp = store.saveMcpServer({ name: "Local tools", transport: "stdio", command: "node", args: ["server.js"], env: {}, enabled: true });
  assert.equal(mcp.command, "node");
  assert.equal(mcp.hasSecrets, false);
  assert.throws(() => store.saveMcpServer({ name: "LOCAL TOOLS", transport: "stdio", command: "node", env: {} }), /不能重名/);
  assert.throws(() => store.saveMcpServer({ name: "Remote", transport: "http", url: "file:///tmp/mcp", env: {} }), /有效且不含凭据/);
  const configuredProvider = store.resolve("official");
  assert.equal(configuredProvider.args.includes(`mcp_servers.${mcp.id}.command=${JSON.stringify("node")}`), true);
  assert.equal(configuredProvider.args.includes(`mcp_servers.${mcp.id}.args=${JSON.stringify(["server.js"])}`), true);
  store.removeMcpServer(mcp.id);
  assert.equal(store.mcpServers().length, 0);
}

function testBuiltinApiEditing() {
  const store = new ProviderStore();
  store.reorderProviders(["hexuan"]);
  const updated = store.updateBuiltinApi({
    id: "hexuan",
    label: "Hexuan API",
    baseUrl: "https://relay.example.test/v1",
    model: "fixture-model",
    discoveredModels: ["fixture-model", "fixture-reasoning"],
  });
  assert.equal(updated.id, "hexuan");
  assert.equal(updated.baseUrl, "https://relay.example.test/v1");
  assert.deepEqual(updated.discoveredModels, ["fixture-model", "fixture-reasoning"]);
  const resolved = store.resolve("hexuan");
  assert.equal(resolved.baseUrl, "https://relay.example.test/v1");
  assert.equal(resolved.model, "fixture-model");
  assert.ok(resolved.args.includes('model="fixture-model"'));
  assert.ok(resolved.args.includes('model_providers.hexuan.base_url="https://relay.example.test/v1"'));
}

function testProviderApiKeyFallback() {
  const provider = {
    envKey: "HEXUAN_API_KEY",
    env: { HEXUAN_API_KEY: "encrypted-saved-key" },
  };
  assert.equal(providerApiKey(provider, {}), "encrypted-saved-key");
  assert.equal(providerApiKey({ envKey: "HEXUAN_API_KEY" }, { HEXUAN_API_KEY: "environment-key" }), "environment-key");
  assert.equal(providerApiKey({ apiKey: "relay-key" }, {}), "relay-key");
}

function testDeepLinks() {
  assert.deepEqual(parseChatSwitchLink("chatswitch://extensions?tab=mcp"), { action: "extensions", tab: "mcp" });
  assert.deepEqual(parseChatSwitchLink("chatswitch://scheduled"), { action: "scheduled" });
  assert.deepEqual(parseChatSwitchLink("chatswitch://new?provider=relay_123&projectId=project_456"), {
    action: "new", provider: "relay_123", thread: null, projectId: "project_456", workspace: null,
  });
  assert.deepEqual(parseChatSwitchLink("chatswitch://open?thread=thread_123&workspace=F%3A%5Ccodepro"), {
    action: "open", provider: null, thread: "thread_123", projectId: null, workspace: "F:\\codepro",
  });
  assert.equal(parseChatSwitchLink("https://example.com/open"), null);
  assert.equal(parseChatSwitchLink("chatswitch://unknown"), null);
  assert.equal(parseChatSwitchLink(`chatswitch://open?thread=${"x".repeat(300)}`)?.thread, null);
  assert.equal(chatSwitchLinkFromArgs(["electron.exe", ".", "chatswitch://scheduled"]), "chatswitch://scheduled");
  assert.deepEqual(parseChatSwitchLink("chatswitch://import?type=provider&label=Lab%20API&baseUrl=https%3A%2F%2Fapi.example.test%2Fv1&model=lab-model&preset=custom"), {
    action: "import",
    importType: "provider",
    config: {
      label: "Lab API", baseUrl: "https://api.example.test/v1", model: "lab-model",
      preset: "custom", protocol: "chat_completions",
    },
  });
  const promptData = Buffer.from(JSON.stringify({
    type: "prompt", name: "review", description: "Review changes", content: "Review this:\n{{content}}",
  })).toString("base64url");
  assert.equal(parseChatSwitchLink(`chatswitch://import?data=${promptData}`).config.content.includes("\n"), true);
  const mcpData = Buffer.from(JSON.stringify({
    type: "mcp", name: "Local MCP", transport: "stdio", command: "node", args: ["server.js"], envKeys: ["ACCESS_TOKEN"],
  })).toString("base64url");
  assert.deepEqual(parseChatSwitchLink(`chatswitch://import?data=${mcpData}`).config.envKeys, ["ACCESS_TOKEN"]);
  assert.equal(parseChatSwitchLink("chatswitch://import?type=skill&source=https%3A%2F%2Fgithub.com%2Fexample%2Fskills").config.source, "https://github.com/example/skills");
  assert.equal(parseChatSwitchLink("chatswitch://import?type=provider&label=Unsafe&baseUrl=https%3A%2F%2Fexample.test%2Fv1&model=x&apiKey=secret"), null);
  assert.equal(parseChatSwitchLink("chatswitch://import?type=skill&source=https%3A%2F%2Fexample.com%2Fskills"), null);
}

function testProviderPresetCatalog() {
  const presets = providerPresetCatalog();
  assert.ok(presets.length >= 50);
  assert.equal(new Set(presets.map((preset) => preset.id)).size, presets.length);
  assert.equal(presets.every((preset) => preset.label && preset.group && preset.protocol && preset.note), true);
  assert.equal(presets.find((preset) => preset.id === "deepseek").baseUrl, "https://api.deepseek.com/v1");
}

async function testThreadPagination() {
  const server = Object.create(CodexServer.prototype);
  const cursors = [];
  server.request = async (method, params) => {
    assert.equal(method, "thread/list");
    cursors.push(params.cursor);
    if (params.cursor === null) return { data: [{ id: "a" }], nextCursor: "page-2", backwardsCursor: "back" };
    if (params.cursor === "page-2") return { data: [{ id: "b" }], nextCursor: "page-3", backwardsCursor: null };
    return { data: [{ id: "c" }], nextCursor: null, backwardsCursor: null };
  };
  const result = await server.listThreads("needle", true);
  assert.deepEqual(cursors, [null, "page-2", "page-3"]);
  assert.deepEqual(result.data.map((thread) => thread.id), ["a", "b", "c"]);
  assert.equal(result.nextCursor, null);
  assert.equal(result.backwardsCursor, "back");
}

async function testRepeatedPaginationCursor() {
  const server = Object.create(CodexServer.prototype);
  server.request = async () => ({ data: [], nextCursor: "repeat", backwardsCursor: null });
  await assert.rejects(() => server.listThreads(), /repeated pagination cursor/);
}

async function testClientUserMessageId() {
  const server = Object.create(CodexServer.prototype);
  const captured = [];
  server.request = async (method, params) => {
    captured.push({ method, params });
    return { turn: { id: "turn" } };
  };
  await server.startTurn("thread", "hello", "F:\\codepro", "client-message");
  assert.equal(captured[0].method, "turn/start");
  assert.equal(captured[0].params.clientUserMessageId, "client-message");
  assert.deepEqual(captured[0].params.input, [{ type: "text", text: "hello" }]);
  await server.startTurn("thread", "draft this", "F:\\codepro", null, {
    skillInputs: [{ name: "nature-writing", path: "F:\\skills\\nature-writing\\SKILL.md" }],
    imageInputs: [{ path: "F:\\images\\figure.png", detail: "high" }],
  });
  assert.deepEqual(captured[1].params.input, [
    { type: "skill", name: "nature-writing", path: "F:\\skills\\nature-writing\\SKILL.md" },
    { type: "localImage", path: "F:\\images\\figure.png", detail: "high" },
    { type: "text", text: "draft this" },
  ]);
  await server.steerTurn("thread", "turn-active", "focus on the failing test", {
    imageInputs: [{ path: "F:\\images\\error.png", detail: "auto" }],
  });
  assert.equal(captured[2].method, "turn/steer");
  assert.equal(captured[2].params.threadId, "thread");
  assert.equal(captured[2].params.expectedTurnId, "turn-active");
  assert.deepEqual(captured[2].params.input, [
    { type: "localImage", path: "F:\\images\\error.png", detail: "auto" },
    { type: "text", text: "focus on the failing test" },
  ]);
}

async function testModelAndEffortOverrides() {
  const server = Object.create(CodexServer.prototype);
  const captured = [];
  server.request = async (method, params) => {
    captured.push({ method, params });
    return method === "thread/start" ? { thread: { id: "thread" } } : { turn: { id: "turn" } };
  };
  await server.startThread("F:\\codepro", "gpt-5.6-terra");
  await server.startTurn("thread", "hello", "F:\\codepro", null, {
    model: "gpt-5.6-terra",
    effort: "xhigh",
  });
  assert.equal(captured[0].params.model, "gpt-5.6-terra");
  assert.equal(captured[1].params.model, "gpt-5.6-terra");
  assert.equal(captured[1].params.effort, "xhigh");
}

async function testReasoningProfiles() {
  assert.deepEqual(reasoningProfile("gpt-5.6-sol"), {
    defaultEffort: "low",
    efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
  });
  assert.equal(reasoningProfile("gpt-5.6-luna").efforts.includes("ultra"), false);
  assert.deepEqual(reasoningProfile("gpt-5.4").efforts, ["low", "medium", "high", "xhigh"]);
  assert.equal(reasoningProfile("unknown-relay-model"), null);
}

async function testApprovalModes() {
  assert.deepEqual(approvalSettings("ask"), {
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
  });
  assert.deepEqual(approvalSettings("auto"), {
    approvalPolicy: "on-request",
    approvalsReviewer: "auto_review",
    sandbox: "workspace-write",
  });
  assert.deepEqual(approvalSettings("full"), {
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: "danger-full-access",
  });
  assert.deepEqual(claudePermissionArgs("ask"), ["--permission-mode", "manual"]);
  assert.deepEqual(claudePermissionArgs("auto"), ["--permission-mode", "auto"]);
  assert.deepEqual(claudePermissionArgs("full"), [
    "--permission-mode",
    "bypassPermissions",
    "--dangerously-skip-permissions",
  ]);

  const server = Object.create(CodexServer.prototype);
  const captured = [];
  server.request = async (method, params) => {
    captured.push({ method, params });
    return method === "turn/start" ? { turn: { id: "turn" } } : { thread: { id: "thread" } };
  };
  await server.startThread("F:\\codepro", "gpt-test", { approvalMode: "auto" });
  await server.resumeThread("thread", "F:\\codepro", "openai", "gpt-test", { approvalMode: "full" });
  await server.startTurn("thread", "hello", "F:\\codepro", null, { approvalMode: "ask" });
  assert.equal(captured[0].params.approvalsReviewer, "auto_review");
  assert.equal(captured[0].params.sandbox, "workspace-write");
  assert.equal(captured[1].params.approvalPolicy, "never");
  assert.equal(captured[1].params.sandbox, "danger-full-access");
  assert.equal(captured[2].params.approvalsReviewer, "user");
  assert.equal(captured[2].params.approvalPolicy, "on-request");
}

async function testOpenAIModelDiscovery() {
  assert.equal(modelsEndpoint("https://relay.example/v1/"), "https://relay.example/v1/models");
  assert.deepEqual(modelsEndpointCandidates("https://relay.example/v1"), ["https://relay.example/v1/models"]);
  assert.deepEqual(modelsEndpointCandidates("https://relay.example"), [
    "https://relay.example/models",
    "https://relay.example/v1/models",
  ]);
  const calls = [];
  const models = await fetchOpenAIModels("https://relay.example/v1", "secret", async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        data: [{ id: "gpt-real-a" }, { id: "gpt-real-b" }, { id: "gpt-real-a" }],
      }),
    };
  });
  assert.deepEqual(models, ["gpt-real-a", "gpt-real-b"]);
  assert.equal(calls[0].url, "https://relay.example/v1/models");
  assert.equal(calls[0].options.headers.Authorization, "Bearer secret");
  const fallbackCalls = [];
  const fallbackModels = await fetchOpenAIModels("https://root-relay.example", "secret", async (url) => {
    fallbackCalls.push(url);
    return url.endsWith("/v1/models")
      ? { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: "root-model" }] }) }
      : { ok: false, status: 404, statusText: "Not Found", text: async () => "" };
  });
  assert.deepEqual(fallbackCalls, ["https://root-relay.example/models", "https://root-relay.example/v1/models"]);
  assert.deepEqual(fallbackModels, ["root-model"]);
  await assert.rejects(
    () => fetchOpenAIModels("https://relay.example/v1", "secret", async () => ({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      text: async () => JSON.stringify({ error: { message: "denied" } }),
    })),
    /403.*denied/,
  );

  const prepared = new ProviderStore().withModelCatalog(
    BASE_PROVIDERS.niubi,
    ["gpt-real-a", "gpt-real-b"],
  );
  assert.equal(prepared.model, "gpt-real-a");
  assert.deepEqual(prepared.discoveredModels, ["gpt-real-a", "gpt-real-b"]);
  assert.equal(prepared.args.includes('model="gpt-real-a"'), true);
  const catalogSetting = prepared.args.find((item) => item.startsWith("model_catalog_json="));
  const catalogFile = JSON.parse(catalogSetting.slice("model_catalog_json=".length));
  const catalog = JSON.parse(fs.readFileSync(catalogFile, "utf8"));
  assert.deepEqual(catalog.models.map((model) => model.slug), ["gpt-real-a", "gpt-real-b"]);
}

async function testModelPagination() {
  const server = Object.create(CodexServer.prototype);
  server.request = async (_method, params) => params.cursor
    ? { data: [{ id: "b" }], nextCursor: null }
    : { data: [{ id: "a" }], nextCursor: "next" };
  const result = await server.listModels();
  assert.deepEqual(result.data.map((item) => item.id), ["a", "b"]);
}

async function testRenameThread() {
  const server = Object.create(CodexServer.prototype);
  let captured;
  server.request = async (method, params, timeout) => {
    captured = { method, params, timeout };
    return {};
  };
  await server.renameThread("thread-id", "  New name  ");
  assert.deepEqual(captured, {
    method: "thread/name/set",
    params: { threadId: "thread-id", name: "New name" },
    timeout: 30000,
  });
  await assert.rejects(() => server.renameThread("thread-id", "  "), /不能为空/);

  await server.deleteThread("thread-id");
  assert.deepEqual(captured, {
    method: "thread/delete",
    params: { threadId: "thread-id" },
    timeout: 30000,
  });
}

function testDeferredThreadDeletion() {
  const store = new ProviderStore();
  const entry = store.scheduleThreadDeletion("scheduled-thread", "codex", "official", 1000, 3600000);
  assert.equal(entry.expiresAt, 3601000);
  assert.equal(store.metadata().hiddenThreads.includes("scheduled-thread"), true);
  assert.equal(store.dueThreadDeletions(3600999).length, 0);
  assert.equal(store.dueThreadDeletions(3601000).length, 1);
  store.restoreThread("scheduled-thread");
  assert.equal(store.pendingDeletions().length, 0);
  assert.equal(store.metadata().hiddenThreads.includes("scheduled-thread"), false);
}

function testLegacyDeletionMigration() {
  const metadataFile = path.join(providerStoreTestRoot, "providers.json");
  fs.writeFileSync(metadataFile, JSON.stringify({
    hiddenThreads: ["legacy-pending-thread"],
    pendingDeletions: [{
      threadId: "legacy-pending-thread",
      scheduledAt: 1000,
      expiresAt: 2000,
    }],
  }), "utf8");
  const store = new ProviderStore();
  assert.equal(store.pendingDeletions().length, 1);
  assert.equal(store.metadata().hiddenThreads.includes("legacy-pending-thread"), true);
  assert.equal(store.deletedThreads().includes("legacy-pending-thread"), false);
  assert.equal(store.dueThreadDeletions(2000).length, 1);
  store.completeThreadDeletion("legacy-pending-thread");
  assert.equal(store.metadata().hiddenThreads.includes("legacy-pending-thread"), false);
  assert.equal(store.deletedThreads().includes("legacy-pending-thread"), true);
}

function testLegacyTurnLifecycleMigration() {
  const metadataFile = path.join(providerStoreTestRoot, "providers.json");
  fs.writeFileSync(metadataFile, JSON.stringify({
    threadTimeline: {
      "legacy-running-thread": [{
        turnId: "legacy-running-turn",
        nativeThreadId: "legacy-running-thread",
        providerId: "fixture-provider",
        status: "inProgress",
        startedAt: 1000,
        updatedAt: 1000,
      }],
    },
  }), "utf8");
  const migrated = new ProviderStore();
  assert.equal(migrated.threadTimeline("legacy-running-thread")[0].status, "stale");
  assert.equal(migrated.recoverableInterruptedTurns().length, 0);
  assert.equal(migrated.metadata().turnLifecycleMigrationVersion, 1);

  migrated.recordLogicalTurn("restart-running-thread", {
    turnId: "restart-running-turn",
    nativeThreadId: "restart-running-thread",
    providerId: "fixture-provider",
    status: "inProgress",
  });
  const restarted = new ProviderStore();
  assert.equal(restarted.threadTimeline("restart-running-thread")[0].status, "interrupted");
  assert.equal(restarted.recoverableInterruptedTurns().some((turn) => (
    turn.threadId === "restart-running-thread"
  )), true);
}

function testLocalThreadManagement() {
  const store = new ProviderStore();
  const aliases = store.renameThreadLocal("local-thread", "  Local   title  ");
  assert.equal(aliases["local-thread"], "Local title");
  assert.equal(store.archiveThreadLocal("local-thread").includes("local-thread"), true);
  assert.equal(store.unarchiveThreadLocal("local-thread").includes("local-thread"), false);
  store.hideThread("local-thread");
  const deleted = store.deleteThreadNow("local-thread");
  assert.equal(deleted.includes("local-thread"), true);
  assert.equal(store.metadata().hiddenThreads.includes("local-thread"), false);
  assert.equal(store.threadAliases()["local-thread"], undefined);
  assert.throws(() => store.hideThread("local-thread"), /永久移出/);
}

function testThreadBranchMapping() {
  const store = new ProviderStore();
  const branch = store.saveThreadBranch("logical-thread", "deepseek-provider", "deepseek-branch", {
    engine: "openai-compatible",
    sourceEngine: "codex",
    firstUserText: "continue here",
    seeded: true,
    createdAt: 1000,
  });
  assert.equal(branch.threadId, "deepseek-branch");
  assert.equal(branch.sourceEngine, "codex");
  assert.equal(branch.seeded, true);
  assert.equal(store.threadBranch("logical-thread", "deepseek-provider").threadId, "deepseek-branch");
  assert.equal(store.logicalThreadIdForBranch("deepseek-provider", "deepseek-branch"), "logical-thread");
  assert.equal(store.logicalThreadIdForAnyBranch("deepseek-branch"), "logical-thread");
  assert.deepEqual(store.branchThreadIds(), ["deepseek-branch"]);
  const timeline = store.recordLogicalTurn("logical-thread", {
    turnId: "turn-1",
    nativeThreadId: "deepseek-branch",
    providerId: "deepseek-provider",
    engine: "openai-compatible",
    startedAt: 1234,
  });
  assert.equal(timeline.length, 1);
  assert.equal(store.threadTimeline("logical-thread")[0].turnId, "turn-1");
  store.deleteThreadNow("logical-thread");
  assert.equal(store.threadBranches()["logical-thread"], undefined);
  assert.deepEqual(store.threadTimeline("logical-thread"), []);
}

function testProviderUsageAndPricing() {
  const store = new ProviderStore();
  store.saveModelPricing({
    providerId: "usage-provider",
    model: "usage-model",
    inputPerMillion: 2,
    cachedInputPerMillion: 1,
    outputPerMillion: 4,
  });
  const entry = store.recordProviderRequest({
    providerId: "usage-provider",
    engine: "openai-compatible",
    model: "usage-model",
    logicalThreadId: "usage-thread",
    turnId: "usage-turn",
    startedAt: 1000,
    finishedAt: 1600,
    durationMs: 600,
    status: "completed",
    inputTokens: 1000,
    cachedInputTokens: 200,
    outputTokens: 500,
  });
  assert.equal(entry.totalTokens, 1500);
  assert.equal(entry.costUsd, 0.0038);
  store.recordProviderRequest({ ...entry, durationMs: 9999 });
  const usage = store.providerUsage("usage-provider");
  assert.equal(usage.requestCount, 1);
  assert.equal(usage.totalTokens, 1500);
  assert.equal(usage.averageDurationMs, 600);
  assert.equal(usage.costUsd, 0.0038);
  assert.equal(usage.daily.length, 14);
  assert.equal(store.clearProviderRequestLogs("usage-provider").removed, 1);
  assert.equal(store.providerUsage("usage-provider").requestCount, 0);
}

function testConfigurationImportExportAndBackup() {
  const store = new ProviderStore();
  assert.equal(store.appSettings().closeToTray, true);
  assert.equal(store.saveAppSettings({ closeToTray: false }).closeToTray, false);
  store.saveAppSettings({ closeToTray: true });
  const bundle = {
    schema: "chatswitch-config",
    version: 1,
    relays: [{
      label: "Imported Provider",
      baseUrl: "https://imported.example/v1",
      model: "imported-model",
      protocol: "chat_completions",
      preset: "custom",
      discoveredModels: ["imported-model", "imported-model-2"],
    }, {
      label: "Imported Fallback",
      baseUrl: "https://fallback.example/v1",
      model: "fallback-model",
      protocol: "chat_completions",
      preset: "custom",
      discoveredModels: ["fallback-model"],
    }],
    projects: [{ label: "Imported Project", root: "F:\\imported" }],
    pricing: [{
      providerLabel: "Imported Provider",
      providerBaseUrl: "https://imported.example/v1",
      model: "imported-model",
      inputPerMillion: 1,
      cachedInputPerMillion: 0.5,
      outputPerMillion: 3,
    }],
    routes: [{
      providerLabel: "Imported Provider",
      providerBaseUrl: "https://imported.example/v1",
      enabled: true,
      fallbackProviders: [{ label: "Imported Fallback", baseUrl: "https://fallback.example/v1" }],
      failureThreshold: 3,
      cooldownMs: 45000,
    }],
    mcpServers: [{ name: "Broken MCP", transport: "stdio", command: "", args: ["--invalid"] }],
  };
  const imported = store.importConfiguration(bundle);
  assert.equal(imported.providersAdded, 2);
  assert.equal(imported.requiresCredentials, true);
  assert.equal(imported.projectsAdded, 1);
  assert.equal(imported.routesImported, 1);
  assert.equal(imported.mcpServersImported, 0);
  assert.equal(imported.mcpServersSkipped, 1);
  const exported = store.exportConfiguration();
  assert.equal(exported.containsCredentials, false);
  assert.equal(JSON.stringify(exported).includes("apiKey"), false);
  assert.equal(exported.relays.some((relay) => relay.label === "Imported Provider"), true);
  assert.equal(exported.routes.length, 1);
  assert.equal(exported.routes[0].fallbackProviders[0].label, "Imported Fallback");
  assert.equal(store.importConfiguration(bundle).providersUpdated, 2);
  const importedProvider = store.list().find((provider) => provider.label === "Imported Provider");
  const importedFallback = store.list().find((provider) => provider.label === "Imported Fallback");
  const reordered = store.reorderProviders([importedFallback.id, importedProvider.id]);
  assert.deepEqual(reordered.slice(0, 2).map((provider) => provider.id), [importedFallback.id, importedProvider.id]);
  store.renameThreadLocal("backup-fixture-thread", "Before backup");
  const backup = store.createRotatingBackup(10, 0);
  assert.equal(backup.created, true);
  store.renameThreadLocal("backup-fixture-thread", "After backup");
  assert.equal(store.threadAliases()["backup-fixture-thread"], "After backup");
  assert.equal(store.restoreConfigurationBackup(backup.name).restored, true);
  assert.equal(store.threadAliases()["backup-fixture-thread"], "Before backup");
  assert.ok(store.listConfigurationBackups().length >= 1);
}

function testCrossModelConversationMerge() {
  const user = (id, text) => ({ id, type: "userMessage", content: [{ type: "text", text }] });
  const agent = (id, text) => ({ id, type: "agentMessage", text });
  const base = {
    id: "logical-thread",
    modelProvider: "official",
    updatedAt: 20,
    turns: [
      { id: "base-old", items: [user("u1", "old question"), agent("a1", "old answer")] },
      { id: "base-late", items: [user("u3", "back to Codex"), agent("a3", "Codex again")] },
    ],
  };
  const branch = {
    id: "deepseek-branch",
    modelProvider: "deepseek-provider",
    updatedAt: 15,
    turns: [{
      id: "branch-first",
      items: [user("u2", "large hidden seed\nactual question"), agent("a2", "DeepSeek answer")],
    }],
  };
  const merged = mergeLogicalThread(base, [{
    providerId: "deepseek-provider",
    thread: branch,
    label: "DeepSeek",
    metadata: {
      threadId: branch.id,
      firstUserText: "actual question",
      createdAt: 10,
      updatedAt: 15000,
    },
  }], [
    { nativeThreadId: branch.id, turnId: "branch-first", startedAt: 100 },
    { nativeThreadId: base.id, turnId: "base-late", startedAt: 200 },
  ]);
  assert.equal(merged.id, base.id);
  assert.deepEqual(merged.turns.map((turn) => turn.id), ["base-old", "branch-first", "base-late"]);
  assert.equal(merged.turns[1].items[0].content[0].text, "actual question");
  assert.equal(merged.turns[1].items[1].sourceLabel, "DeepSeek");
  assert.match(buildContinuationPrompt(merged, "next question"), /<shared_conversation>[\s\S]*next question/);
  const mapped = remapBranchMessage({
    method: "item/completed",
    params: { threadId: branch.id, item: user("u2", "hidden seed") },
  }, branch.id, base.id, { firstUserText: "actual question" });
  assert.equal(mapped.params.threadId, base.id);
  assert.equal(mapped.params.item.content[0].text, "actual question");
}

function testScheduledTasks() {
  const store = new ProviderStore();
  assert.throws(() => store.saveScheduledTask({
    title: "Missing connection",
    prompt: "No provider",
    scheduledAt: 5000,
    providerId: "missing-provider",
  }), /连接不存在/);
  const once = store.saveScheduledTask({
    title: "One time task",
    prompt: "Run once",
    scheduledAt: 5000,
    repeat: "once",
    workspace: "F:\\codepro",
  });
  assert.equal(store.dueScheduledTasks(4999).some((task) => task.id === once.id), false);
  assert.equal(store.dueScheduledTasks(5000).some((task) => task.id === once.id), true);
  const completed = store.completeScheduledTask(once.id, "created-thread", 6000);
  assert.equal(completed.enabled, false);
  assert.equal(completed.lastThreadId, "created-thread");

  const daily = store.saveScheduledTask({
    title: "Daily task",
    prompt: "Run daily",
    scheduledAt: 1000,
    repeat: "daily",
  });
  const advanced = store.completeScheduledTask(daily.id, "daily-thread", 1000);
  assert.equal(advanced.scheduledAt, 1000 + 86400000);
  const failed = store.failScheduledTask(daily.id, new Error("temporary"), 2000);
  assert.equal(failed.retryAt, 302000);
  assert.match(failed.lastError, /temporary/);
  assert.equal(store.setScheduledTaskEnabled(daily.id, false).enabled, false);
  assert.equal(store.removeScheduledTask(daily.id).id, daily.id);
  assert.throws(() => store.removeScheduledTask(daily.id), /不存在/);
}

function testScheduledTaskCalendarAndRetries() {
  const friday = new Date(2026, 6, 31, 9, 30, 0, 0);
  const monday = new Date(nextScheduledAt(friday.getTime(), "weekdays", friday.getTime()));
  assert.equal(monday.getDay(), 1);
  assert.equal(monday.getHours(), 9);
  assert.equal(monday.getMinutes(), 30);

  const january31 = new Date(2026, 0, 31, 8, 15, 0, 0);
  const february = new Date(nextScheduledAt(january31.getTime(), "monthly", january31.getTime(), 31));
  assert.equal(february.getMonth(), 1);
  assert.equal(february.getDate(), 28);
  const march = new Date(nextScheduledAt(february.getTime(), "monthly", february.getTime(), 31));
  assert.equal(march.getMonth(), 2);
  assert.equal(march.getDate(), 31);

  const store = new ProviderStore();
  const scheduledAt = new Date(2026, 0, 31, 8, 15, 0, 0).getTime();
  const monthly = store.saveScheduledTask({
    title: "Month end",
    prompt: "Run at month end",
    scheduledAt,
    repeat: "monthly",
  });
  assert.equal(monthly.scheduleAnchorDay, 31);
  const manualRun = store.beginScheduledTaskRun(monthly.id, true, scheduledAt - 1000);
  const manualResult = store.completeScheduledTask(monthly.id, "manual-thread", scheduledAt - 500, {
    runId: manualRun.id,
    manual: true,
  });
  assert.equal(manualResult.scheduledAt, scheduledAt);
  assert.equal(manualResult.runHistory[0].status, "completed");
  assert.equal(manualResult.runHistory[0].manual, true);

  let failure = monthly;
  const failureTimes = [1000, 2000, 3000, 4000];
  const retryDelays = [300000, 900000, 3600000];
  for (let index = 0; index < failureTimes.length; index += 1) {
    failure = store.failScheduledTask(monthly.id, `failure-${index + 1}`, failureTimes[index]);
    if (index < retryDelays.length) {
      assert.equal(failure.retryAt, failureTimes[index] + retryDelays[index]);
      assert.equal(failure.enabled, true);
    }
  }
  assert.equal(failure.retryAt, null);
  assert.equal(failure.consecutiveFailures, 4);
  assert.ok(failure.scheduledAt > failureTimes.at(-1));
}

async function testScheduledTaskExecution() {
  const store = new ProviderStore();
  const project = store.addProject({ label: "Scheduled runner project", root: "" });
  const task = store.saveScheduledTask({
    title: "Runner task",
    prompt: "Execute this prompt",
    scheduledAt: 9000,
    repeat: "once",
    projectId: project.id,
    workspace: "F:\\codepro",
  });
  const calls = [];
  const server = {
    provider: { id: "fixture", model: "fixture-model" },
    startThread: async (...args) => {
      calls.push({ method: "startThread", args });
      return { thread: { id: "scheduled-created-thread" } };
    },
    startTurn: async (...args) => {
      calls.push({ method: "startTurn", args });
      return { turn: { id: "scheduled-turn" } };
    },
  };
  let createdThreadId = null;
  const result = await executeScheduledTask(
    task,
    server,
    store,
    "client-task-id",
    (threadId) => { createdThreadId = threadId; },
  );
  assert.deepEqual(result, { threadId: "scheduled-created-thread", workspace: "F:\\codepro" });
  assert.equal(createdThreadId, "scheduled-created-thread");
  assert.deepEqual(calls[0], {
    method: "startThread",
    args: ["F:\\codepro", "fixture-model", { approvalMode: "auto" }],
  });
  assert.equal(calls[1].args[0], "scheduled-created-thread");
  assert.equal(calls[1].args[1], "Execute this prompt");
  assert.equal(calls[1].args[3], "client-task-id");
  assert.deepEqual(calls[1].args[4], {
    model: "fixture-model",
    effort: "high",
    approvalMode: "auto",
  });
  assert.equal(store.projectThreads()["scheduled-created-thread"], project.id);
  assert.equal(store.threadAliases()["scheduled-created-thread"], "Runner task");
  const running = store.scheduledTasks().find((item) => item.id === task.id);
  assert.equal(running.enabled, true);
  assert.equal(running.lastThreadId, null);
  const completed = finalizeScheduledTask(
    task.id,
    result.threadId,
    { status: "completed" },
    store,
  );
  assert.equal(completed.enabled, false);
  assert.equal(completed.lastThreadId, "scheduled-created-thread");

  const failingTask = store.saveScheduledTask({
    title: "Failing runner task",
    prompt: "Fail this prompt",
    scheduledAt: 11000,
    repeat: "once",
  });
  const failed = finalizeScheduledTask(
    failingTask.id,
    "failed-thread",
    { status: "failed", error: { message: "model failed" } },
    store,
  );
  assert.equal(failed.enabled, true);
  assert.match(failed.lastError, /model failed/);
  assert.equal(failed.lastThreadId, null);

  const interruptedTask = store.saveScheduledTask({
    title: "Interrupted runner task",
    prompt: "Interrupt this prompt",
    scheduledAt: 12000,
    repeat: "once",
  });
  const interrupted = finalizeScheduledTask(
    interruptedTask.id,
    "interrupted-thread",
    { status: "interrupted" },
    store,
  );
  assert.equal(interrupted.enabled, true);
  assert.match(interrupted.lastError, /interrupted/);
  assert.equal(interrupted.lastThreadId, null);
}

async function testClaudeThreadDeletion() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chatswitch-claude-delete-unit-"));
  const project = path.join(root, "projects", "qa");
  const file = path.join(project, "delete-me.jsonl");
  try {
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(file, '{"type":"user","message":{"content":"temporary"}}\n', "utf8");
    const server = new ClaudeServer({ claudeConfigDir: root, model: "fable" });
    await server.deleteThread("delete-me");
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testOpenAICompatibleStreaming() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chatswitch-compatible-unit-"));
  const image = path.join(root, "fixture.png");
  const document = path.join(root, "fixture.txt");
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options, body: JSON.parse(options.body) });
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"先分析"}}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"再回答"}}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"你好"}}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":7,"total_tokens":19}}\n\n'));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  try {
    fs.writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    fs.writeFileSync(document, "文件上下文 fixture", "utf8");
    const server = new OpenAICompatibleServer({
      id: "deepseek-unit",
      label: "DeepSeek unit",
      baseUrl: "https://api.deepseek.com/v1/",
      model: "deepseek-chat",
      discoveredModels: ["deepseek-chat"],
      apiKey: "encrypted-store-value",
      codexHome: root,
    }, fetchImpl);
    await server.start();
    const created = await server.startThread("F:\\codepro", "deepseek-chat");
    const completed = new Promise((resolve) => {
      server.on("notification", (message) => {
        if (message.method === "turn/completed") resolve(message);
      });
    });
    await server.startTurn(created.thread.id, "测试消息", "F:\\codepro", "client-message", {
      effort: "high",
      webSearch: true,
      fileInputs: [{ path: document, fileName: "fixture.txt" }],
    });
    const completion = await completed;
    assert.equal(completion.params.turn.status, "completed");
    assert.equal(completion.params.turn.usage.total_tokens, 19);
    assert.equal(requests[0].url, "https://api.deepseek.com/v1/chat/completions");
    assert.equal(requests[0].options.headers.Authorization, "Bearer encrypted-store-value");
    assert.equal(requests[0].body.reasoning_effort, "high");
    assert.deepEqual(requests[0].body.web_search_options, { search_context_size: "medium" });
    assert.deepEqual(requests[0].body.messages, [{ role: "user", content: "测试消息" }]);
    const read = await server.readThread(created.thread.id);
    assert.deepEqual(read.thread.turns[0].items[0].content.at(-1), { type: "localFile", path: document, fileName: "fixture.txt" });
    assert.equal(read.thread.turns[0].items.find((item) => item.type === "agentMessage").text, "你好");
    const reasoning = read.thread.turns[0].items.find((item) => item.type === "reasoning");
    assert.equal(reasoning.summary.length, 1);
    assert.equal(reasoning.summary[0].text, "先分析再回答");
    const secondCompleted = new Promise((resolve) => {
      const listener = (message) => {
        if (message.method !== "turn/completed") return;
        server.off("notification", listener);
        resolve(message);
      };
      server.on("notification", listener);
    });
    await server.startTurn(created.thread.id, "第二条", "F:\\codepro", null, {
      imageInputs: [{ path: image, detail: "auto" }],
    });
    await secondCompleted;
    assert.equal(Object.hasOwn(requests[1].body, "web_search_options"), false);
    assert.equal(requests[1].body.messages.length, 3);
    assert.deepEqual(requests[1].body.messages.slice(0, 2), [
      { role: "user", content: "测试消息" },
      { role: "assistant", content: "你好" },
    ]);
    assert.equal(requests[1].body.messages[2].content[0].text, "第二条");
    assert.match(requests[1].body.messages[2].content[1].image_url.url, /^data:image\/png;base64,/);
    const fileOnlyThread = await server.startThread("F:\\codepro", "deepseek-chat");
    const fileOnlyCompleted = new Promise((resolve) => {
      const listener = (message) => {
        if (message.method !== "turn/completed" || message.params.threadId !== fileOnlyThread.thread.id) return;
        server.off("notification", listener);
        resolve(message);
      };
      server.on("notification", listener);
    });
    await server.startTurn(fileOnlyThread.thread.id, "", "F:\\codepro", null, {
      fileInputs: [{ path: document, fileName: "fixture.txt" }],
    });
    await fileOnlyCompleted;
    assert.deepEqual((await server.readThread(fileOnlyThread.thread.id)).thread.turns[0].items[0].content, [
      { type: "localFile", path: document, fileName: "fixture.txt" },
    ]);
    assert.ok((await server.listThreads()).data.some((thread) => thread.id === created.thread.id));
    assert.equal((await server.listModels()).data[0].id, "deepseek-chat");
    assert.equal(parseSseBlock('data: {"value":1}').value, 1);
    assert.equal(chatCompletionsEndpoint("https://example.com/v1/chat/completions"), "https://example.com/v1/chat/completions");
    server.stop();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testOpenAICompatibleFailover() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chatswitch-compatible-failover-"));
  const jsonResponse = (content, status = 200) => new Response(JSON.stringify(
    status === 200
      ? { choices: [{ message: { content } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }
      : { error: { message: content } },
  ), { status, headers: { "content-type": "application/json" } });
  const runTurn = async (server, threadId, prompt) => {
    const completed = new Promise((resolve) => {
      const listener = (message) => {
        if (message.method !== "turn/completed") return;
        server.off("notification", listener);
        resolve(message.params.turn);
      };
      server.on("notification", listener);
    });
    await server.startTurn(threadId, prompt, "F:\\codepro");
    return completed;
  };
  try {
    const calls = [];
    let primaryAttempts = 0;
    const server = new OpenAICompatibleServer({
      id: "primary-unit",
      label: "Primary unit",
      baseUrl: "https://primary.example/v1",
      model: "primary-model",
      apiKey: "primary-key",
      codexHome: root,
      fallbackProviders: [{
        id: "fallback-unit",
        label: "Fallback unit",
        baseUrl: "https://fallback.example/v1",
        model: "fallback-model",
        apiKey: "fallback-key",
      }],
      failover: { failureThreshold: 2, cooldownMs: 5000 },
    }, async (url) => {
      calls.push(url);
      if (url.startsWith("https://primary.example")) {
        primaryAttempts += 1;
        return primaryAttempts <= 2
          ? jsonResponse("temporary outage", 500)
          : jsonResponse("primary restored");
      }
      return jsonResponse("fallback answer");
    });
    await server.start();
    const threadId = (await server.startThread("F:\\codepro", "primary-model")).thread.id;
    assert.equal((await runTurn(server, threadId, "first")).providerId, "fallback-unit");
    assert.equal(server.providerHealth.get("primary-unit").status, "degraded");
    assert.equal((await runTurn(server, threadId, "second")).providerId, "fallback-unit");
    assert.ok(server.providerHealth.get("primary-unit").openUntil > Date.now());
    assert.equal((await runTurn(server, threadId, "third")).providerId, "fallback-unit");
    assert.deepEqual(calls.map((url) => new URL(url).hostname), [
      "primary.example", "fallback.example",
      "primary.example", "fallback.example",
      "fallback.example",
    ]);
    server.providerHealth.get("primary-unit").openUntil = Date.now() - 1;
    const recovered = await runTurn(server, threadId, "fourth");
    assert.equal(recovered.providerId, "primary-unit");
    assert.equal(recovered.model, "primary-model");
    assert.equal(server.providerHealth.get("primary-unit").failures, 0);
    assert.equal(server.providerHealth.get("primary-unit").status, "healthy");
    server.stop();

    let fallbackCalls = 0;
    const authServer = new OpenAICompatibleServer({
      id: "auth-primary",
      label: "Auth primary",
      baseUrl: "https://auth.example/v1",
      model: "auth-model",
      apiKey: "bad-key",
      codexHome: root,
      fallbackProviders: [{
        id: "auth-fallback",
        label: "Auth fallback",
        baseUrl: "https://auth-fallback.example/v1",
        model: "fallback-model",
        apiKey: "fallback-key",
      }],
      failover: { failureThreshold: 1, cooldownMs: 5000 },
    }, async (url) => {
      if (url.startsWith("https://auth-fallback.example")) fallbackCalls += 1;
      return url.startsWith("https://auth.example")
        ? jsonResponse("invalid API key", 401)
        : jsonResponse("must not be used");
    });
    await authServer.start();
    const authThread = (await authServer.startThread("F:\\codepro", "auth-model")).thread.id;
    const authCompletion = await runTurn(authServer, authThread, "auth failure");
    assert.equal(authCompletion.status, "failed");
    assert.equal(fallbackCalls, 0);
    assert.equal(authServer.providerHealth.get("auth-primary").failures, 0);
    assert.equal(authServer.providerHealth.get("auth-primary").status, "configuration-error");
    authServer.stop();

    let partialFallbackCalls = 0;
    const partialServer = new OpenAICompatibleServer({
      id: "partial-primary",
      label: "Partial primary",
      baseUrl: "https://partial.example/v1",
      model: "partial-model",
      apiKey: "partial-key",
      codexHome: root,
      fallbackProviders: [{
        id: "partial-fallback",
        label: "Partial fallback",
        baseUrl: "https://partial-fallback.example/v1",
        model: "fallback-model",
        apiKey: "fallback-key",
      }],
      failover: { failureThreshold: 1, cooldownMs: 5000 },
    }, async (url) => {
      if (url.startsWith("https://partial-fallback.example")) {
        partialFallbackCalls += 1;
        return jsonResponse("duplicate answer");
      }
      const encoder = new TextEncoder();
      let sent = false;
      return new Response(new ReadableStream({
        pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
          } else {
            controller.error(new TypeError("stream disconnected"));
          }
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    await partialServer.start();
    const partialThread = (await partialServer.startThread("F:\\codepro", "partial-model")).thread.id;
    const partialCompletion = await runTurn(partialServer, partialThread, "partial failure");
    assert.equal(partialCompletion.status, "failed");
    assert.equal(partialCompletion.error.code, "INCOMPLETE_STREAM");
    assert.match(partialCompletion.error.message, /流式连接/);
    assert.equal(partialFallbackCalls, 0);
    const partialRead = await partialServer.readThread(partialThread);
    assert.equal(partialRead.thread.turns[0].items.find((item) => item.type === "agentMessage").text, "partial");
    partialServer.stop();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testOpenAICompatibleCompletionValidation() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chatswitch-compatible-completion-"));
  const encoder = new TextEncoder();
  const responses = [
    [
      'data: {"choices":[{"delta":{"content":"complete"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    ],
    [
      'data: {"choices":[{"delta":{"content":"partial-eof"}}]}\n\n',
    ],
    [
      'data: {"choices":[{"delta":{"content":"partial-length"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
      'data: [DONE]\n\n',
    ],
  ];
  let requestIndex = 0;
  const server = new OpenAICompatibleServer({
    id: "completion-unit",
    label: "Completion unit",
    baseUrl: "https://completion.example/v1",
    model: "completion-model",
    apiKey: "completion-key",
    codexHome: root,
  }, async () => {
    const chunks = responses[requestIndex++] || [];
    return new Response(new ReadableStream({
      start(controller) {
        chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
        controller.close();
      },
    }), {
      status: 200,
      headers: { "content-type": "text/event-stream", "x-request-id": `request-${requestIndex}` },
    });
  });
  const runTurn = async (threadId, prompt) => {
    const completed = new Promise((resolve) => {
      const listener = (message) => {
        if (message.method !== "turn/completed") return;
        server.off("notification", listener);
        resolve(message.params.turn);
      };
      server.on("notification", listener);
    });
    await server.startTurn(threadId, prompt, "F:\\codepro");
    return completed;
  };
  try {
    await server.start();
    const threadId = (await server.startThread("F:\\codepro", "completion-model")).thread.id;
    const normal = await runTurn(threadId, "normal eof");
    assert.equal(normal.status, "completed");
    assert.equal(normal.finishReason, "stop");
    const incomplete = await runTurn(threadId, "missing marker");
    assert.equal(incomplete.status, "failed");
    assert.equal(incomplete.error.code, "INCOMPLETE_STREAM");
    assert.equal(incomplete.error.requestId, "request-2");
    const limited = await runTurn(threadId, "length limit");
    assert.equal(limited.status, "failed");
    assert.equal(limited.error.code, "OUTPUT_TRUNCATED");
    assert.equal(limited.finishReason, "length");
    const thread = (await server.readThread(threadId)).thread;
    assert.equal(thread.turns[1].items.find((item) => item.type === "agentMessage").text, "partial-eof");
    assert.equal(thread.turns[2].items.find((item) => item.type === "agentMessage").text, "partial-length");
  } finally {
    server.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testOpenAICompatibleInterrupt() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chatswitch-compatible-interrupt-"));
  try {
    const fetchImpl = (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
    const server = new OpenAICompatibleServer({
      id: "qwen-unit",
      label: "Qwen unit",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "qwen-plus",
      apiKey: "local-key",
      codexHome: root,
    }, fetchImpl);
    await server.start();
    const created = await server.startThread("F:\\codepro", "qwen-plus");
    const completed = new Promise((resolve) => {
      server.on("notification", (message) => {
        if (message.method === "turn/completed") resolve(message.params.turn);
      });
    });
    const started = await server.startTurn(created.thread.id, "停止测试", "F:\\codepro");
    await server.request("turn/interrupt", { threadId: created.thread.id, turnId: started.turn.id });
    assert.equal((await completed).status, "interrupted");
    server.stop();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testOpenAICompatibleSharedCodexHistory() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chatswitch-compatible-history-"));
  const threadId = "019f0000-1111-7222-8333-444455556666";
  const source = path.join(root, "sessions", "2026", "08", "01", `rollout-${threadId}.jsonl`);
  const requests = [];
  try {
    fs.mkdirSync(path.dirname(source), { recursive: true });
    const original = [
      JSON.stringify({
        timestamp: "2026-08-01T10:00:00.000Z",
        type: "session_meta",
        payload: {
          id: threadId,
          timestamp: "2026-08-01T10:00:00.000Z",
          cwd: "F:\\codepro",
          model_provider: "openai",
        },
      }),
      JSON.stringify({
        timestamp: "2026-08-01T10:00:01.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "原来的问题" },
      }),
      JSON.stringify({
        timestamp: "2026-08-01T10:00:02.000Z",
        type: "event_msg",
        payload: { type: "agent_message", message: "中间进度", phase: "commentary" },
      }),
      JSON.stringify({
        timestamp: "2026-08-01T10:00:03.000Z",
        type: "event_msg",
        payload: { type: "agent_message", message: "原来的回答", phase: "final_answer" },
      }),
      "",
    ].join("\n");
    fs.writeFileSync(source, original, "utf8");
    const parsed = parseCodexThreadFile(source);
    assert.equal(parsed.id, threadId);
    assert.equal(parsed.turns.length, 1);
    assert.equal(parsed.turns[0].items.length, 3);
    assert.equal(parsed.turns[0].items[1].sourceLabel, "Codex 历史");
    assert.equal(parsed._syncedFromCodex, true);

    const server = new OpenAICompatibleServer({
      id: "deepseek-history",
      label: "DeepSeek history",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-v4-flash",
      apiKey: "local-key",
      codexHome: root,
    }, async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: "DeepSeek 接续回答" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    await server.start();
    const listed = await server.listThreads();
    assert.equal(listed.data[0].id, threadId);
    assert.equal(listed.data[0]._syncedFromCodex, true);
    const resumed = await server.resumeThread(threadId);
    assert.equal(resumed.thread.turns[0].items[0].content[0].text, "原来的问题");
    assert.equal(fs.existsSync(server.threadFile(threadId)), false);

    const completed = new Promise((resolve) => {
      server.on("notification", (message) => {
        if (message.method === "turn/completed") resolve(message);
      });
    });
    await server.startTurn(threadId, "用 DeepSeek 继续", "F:\\codepro");
    await completed;
    assert.equal(fs.existsSync(server.threadFile(threadId)), true);
    assert.equal(fs.readFileSync(source, "utf8"), original);
    assert.deepEqual(requests[0].messages.map((message) => message.role), [
      "user", "assistant", "assistant", "user",
    ]);
    assert.equal(requests[0].messages.at(-1).content, "用 DeepSeek 继续");
    server.stop();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testImportedLocalConversation() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chatswitch-local-import-"));
  const conversation = {
    id: "codex-app:F:\\source\\session.jsonl",
    sourceId: "codex",
    sourceLabel: "Codex App",
    sessionId: "source-session",
    title: "共享记录迭代",
    cwd: "F:\\codepro",
    model: "gpt-fixture",
    createdAt: 1760000000000,
    updatedAt: 1760000060000,
    messages: [
      { role: "user", text: "继续检查聊天记录共享" },
      { role: "reasoning", text: "先验证只读源和私有副本" },
      { role: "assistant", text: "共享链路验证完成" },
    ],
  };
  try {
    const converted = importedLocalThread(conversation, 1760000120000);
    assert.match(converted.id, /^local-[a-f0-9]{40}$/);
    assert.equal(importedLocalThread(conversation, 1760000180000).id, converted.id);
    assert.equal(converted.name, "共享记录迭代");
    assert.equal(converted.cwd, "F:\\codepro");
    assert.equal(converted.turns.length, 1);
    assert.deepEqual(converted.turns[0].items.map((item) => item.type), [
      "userMessage",
      "reasoning",
      "agentMessage",
    ]);
    assert.equal(converted.turns[0].items[0].content[0].text, "继续检查聊天记录共享");
    assert.equal(converted.turns[0].items[1].summary[0].text, "先验证只读源和私有副本");
    assert.equal(converted.turns[0].items[2].text, "共享链路验证完成");
    assert.equal(converted._importedLocalHistory.sourceConversationId, conversation.id);
    assert.equal(converted._importedLocalHistory.sourceLabel, "Codex App");

    const server = new OpenAICompatibleServer({
      id: "local-import-fixture",
      label: "Local import fixture",
      baseUrl: "https://example.test/v1",
      model: "fixture-model",
      apiKey: "local-key",
      codexHome: root,
    });
    await server.start();
    const first = server.importLocalConversation(conversation);
    assert.equal(first.imported, true);
    assert.equal(first.duplicate, false);
    assert.equal(fs.existsSync(server.threadFile(converted.id)), true);
    const localOnly = await server.listLocalThreads();
    assert.equal(localOnly.data.length, 1);
    assert.equal(localOnly.data[0].id, converted.id);
    assert.equal(localOnly.data[0]._importedLocalHistory.sourceLabel, "Codex App");
    assert.deepEqual((await server.readThread(converted.id)).thread.turns[0].items.map((item) => item.type), [
      "userMessage", "reasoning", "agentMessage",
    ]);

    const continued = server.loadThread(converted.id);
    continued.turns.push({
      id: `${converted.id}-continued-turn`,
      status: "completed",
      items: [{
        id: `${converted.id}-continued-item`,
        type: "agentMessage",
        text: "ChatSwitch 中后续产生的内容",
        phase: "final_answer",
      }],
    });
    server.saveThread(continued);
    const duplicate = server.importLocalConversation({
      ...conversation,
      messages: [...conversation.messages, { role: "assistant", text: "源文件后来新增的内容" }],
    });
    assert.equal(duplicate.imported, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.thread.turns.length, 2);
    assert.equal(duplicate.thread.turns[1].items[0].text, "ChatSwitch 中后续产生的内容");
    assert.equal(JSON.stringify(duplicate.thread).includes("源文件后来新增的内容"), false);
    const secondConversation = {
      ...conversation,
      id: "claude:F:\\source\\other-session.jsonl",
      sourceId: "claude",
      sourceLabel: "Claude Code",
      sessionId: "other-session",
      title: "另一份记录",
    };
    const second = server.importLocalConversation(secondConversation);
    assert.equal(second.imported, true);
    assert.equal(second.duplicate, false);
    assert.notEqual(second.thread.id, converted.id);
    assert.equal((await server.listLocalThreads()).data.length, 2);
    assert.throws(() => importedLocalThread({ id: "empty", messages: [] }), /没有可复制的消息/);
    server.stop();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testNewApiBalance() {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, authorization: options.headers.Authorization || null });
    if (url.endsWith("/api/status")) {
      return new Response(JSON.stringify({ data: { quota_per_unit: 500000, quota_display_type: "USD" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({
      data: {
        name: "Research key",
        total_granted: 5000000,
        total_used: 1250000,
        total_available: 3750000,
        unlimited_quota: "false",
        expires_at: 0,
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const result = await fetchRelayBalance({ baseUrl: "https://relay.example/v1", label: "Relay" }, "secret", fetchImpl);
  assert.equal(result.supported, true);
  assert.equal(result.balance, 7.5);
  assert.equal(result.used, 2.5);
  assert.equal(result.granted, 10);
  assert.equal(result.unlimited, false);
  assert.equal(explicitBoolean("false"), false);
  assert.equal(explicitBoolean("0"), false);
  assert.equal(explicitBoolean("true"), true);
  assert.equal(explicitBoolean(1), true);

  const unlimitedKeyResult = await fetchRelayBalance(
    { baseUrl: "https://relay.example/v1", label: "Relay" },
    "secret",
    async (url) => new Response(JSON.stringify(url.endsWith("/api/status")
      ? { data: { quota_per_unit: 500000, quota_display_type: "USD" } }
      : {
          data: {
            total_granted: 185521544,
            total_used: 189118160,
            total_available: -3596616,
            unlimited_quota: true,
          },
        }), { status: 200, headers: { "content-type": "application/json" } }),
  );
  assert.equal(unlimitedKeyResult.tokenUnlimited, true);
  assert.equal(unlimitedKeyResult.unlimited, true);
  assert.equal(unlimitedKeyResult.balance, null);
  assert.equal(calls[0].authorization, "Bearer secret");
  assert.equal(calls.some((call) => call.url === "https://relay.example/api/usage/token/"), true);
}

async function testUnsupportedBalance() {
  const fetchImpl = async (url) => new Response("not found", { status: url.endsWith("/api/usage/token/") ? 404 : 200 });
  const result = await fetchRelayBalance({ baseUrl: "https://relay.example/v1", label: "Relay" }, "secret", fetchImpl);
  assert.equal(result.supported, false);
  assert.match(result.message, /未提供兼容/);

  const forbidden = await fetchRelayBalance(
    { baseUrl: "https://relay.example/v1", label: "Relay" },
    "secret",
    async () => new Response("forbidden", { status: 403 }),
  );
  assert.equal(forbidden.supported, false);
  assert.match(forbidden.message, /稍后重试或检查 API Key/);
}

async function testClaudeModelList() {
  const fetchImpl = async (url, options) => {
    assert.equal(url, "https://ai.hexuan.cc/v1/models");
    assert.equal(options.headers.Authorization, "Bearer secret");
    assert.equal(options.headers["x-api-key"], "secret");
    return new Response(JSON.stringify({
      data: [
        { id: "claude-fable-5", display_name: "Claude Fable 5" },
        { id: "claude-haiku-4-5", display_name: "Claude Haiku" },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const result = await fetchClaudeModels("https://ai.hexuan.cc/v1/", "secret", fetchImpl);
  assert.equal(result.models.length, 2);
  assert.equal(result.routes.find((route) => route.id === "fable").actualModel, "claude-fable-5");
  assert.equal(result.routes.find((route) => route.id === "sonnet").actualModel, "deepseek-v4-pro");
}

async function testClaudeModelError() {
  const fetchImpl = async () => new Response(JSON.stringify({
    error: { message: "Request not allowed" },
  }), { status: 403, headers: { "content-type": "application/json" } });
  await assert.rejects(async () => {
    try {
      await fetchClaudeModels("https://api.anthropic.com/v1", "secret", fetchImpl);
    } catch (error) {
      assert.equal(error.status, 403);
      throw error;
    }
  }, /Request not allowed/);
}

async function testClaudeModelFallback() {
  const fetchImpl = async () => new Response(JSON.stringify({
    error: { message: "API Key group was deleted" },
  }), { status: 403, headers: { "content-type": "application/json" } });
  const result = await fetchClaudeModelsSafely("https://ai.hexuan.cc/v1", "secret", fetchImpl);
  assert.equal(result.fallback, true);
  assert.equal(result.status, 403);
  assert.match(result.warning, /group was deleted/);
  assert.equal(result.models.length, 0);
  assert.equal(result.routes.some((route) => route.id === "fable"), true);
}

function testRootlessProjectMembership() {
  const store = new ProviderStore();
  const project = store.addProject({ label: "Named only", root: "" });
  assert.equal(project.label, "Named only");
  assert.equal(project.root, null);
  assert.equal(store.listProjects().some((item) => item.id === project.id && item.root === null), true);
  const membership = store.assignThreadToProject("thread-a", project.id);
  assert.equal(membership["thread-a"], project.id);
  assert.deepEqual(store.projectThreads(), membership);
  const settings = store.saveThreadSettings("thread-a", "official", { model: "gpt-5.6-sol", effort: "high" });
  assert.equal(settings["official:thread-a"].model, "gpt-5.6-sol");
  assert.equal(store.threadSettings()["official:thread-a"].effort, "high");
  assert.equal(store.threadSettings()["official:thread-a"].approvalMode, "ask");
  assert.throws(() => store.addProject({ label: "", root: "" }), /名称不能为空/);
  assert.throws(() => store.addProject({ label: "  NAMED   ONLY  ", root: "" }), /已存在/);
  assert.throws(() => store.addProject({ label: "x".repeat(101), root: "" }), /100/);
  const second = store.addProject({ label: "Second Project", root: "" });
  const renamed = store.renameProject(project.id, "  Renamed   Project  ");
  assert.equal(renamed.label, "Renamed Project");
  assert.equal(store.listProjects().find((item) => item.id === project.id).label, "Renamed Project");
  assert.throws(() => store.renameProject(second.id, "renamed project"), /已存在/);
  assert.throws(() => store.renameProject("missing-project", "Missing"), /不存在/);
}

function testProjectDeletion() {
  const store = new ProviderStore();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chatswitch-project-delete-"));
  try {
    const conversation = path.join(root, "conversation.jsonl");
    fs.writeFileSync(conversation, '{"type":"fixture"}\n', "utf8");
    const project = store.addProject({ label: "Delete me", root });
    store.assignThreadToProject("delete-thread", project.id);
    store.assignThreadToProject("keep-thread", store.addProject({ label: "Keep me", root: "" }).id);
    const result = store.deleteProject(project.id);
    assert.equal(result.project.id, project.id);
    assert.equal(result.removedAssignments, 1);
    assert.equal(store.listProjects().some((item) => item.id === project.id), false);
    assert.equal(store.projectThreads()["delete-thread"], undefined);
    assert.equal(fs.existsSync(root), true);
    assert.equal(fs.readFileSync(conversation, "utf8"), '{"type":"fixture"}\n');
    assert.equal(store.hiddenProjectRoots().some((item) => item.toLowerCase() === root.toLowerCase()), true);
    assert.throws(() => store.deleteProject(project.id), /不存在/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testClaudeMergedHistoryAndImport() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chatswitch-claude-unit-"));
  const configDir = path.join(root, "chatswitch-claude");
  const globalRoot = path.join(root, "global-projects");
  const localRoot = path.join(configDir, "projects");
  const localProject = path.join(localRoot, "local-project");
  const globalProject = path.join(globalRoot, "global-project");
  try {
    fs.mkdirSync(localProject, { recursive: true });
    fs.mkdirSync(globalProject, { recursive: true });
    fs.writeFileSync(path.join(localProject, "same.jsonl"), '{"source":"local"}\n', "utf8");
    fs.writeFileSync(path.join(globalProject, "same.jsonl"), '{"source":"global"}\n', "utf8");
    const globalOnly = path.join(globalProject, "global-only.jsonl");
    fs.writeFileSync(globalOnly, '{"source":"original"}\n', "utf8");
    const server = new ClaudeServer({
      claudeConfigDir: configDir,
      model: "fable",
      envKey: "ANTHROPIC_AUTH_TOKEN",
      env: { ANTHROPIC_AUTH_TOKEN: "test" },
    });
    server.globalProjectsRoot = globalRoot;
    const files = server.threadFiles();
    assert.equal(files.length, 2);
    assert.equal(server.findThreadFile("same"), path.join(localProject, "same.jsonl"));
    const imported = server.importThreadForResume("global-only");
    assert.equal(imported, path.join(localRoot, "global-project", "global-only.jsonl"));
    assert.equal(fs.readFileSync(imported, "utf8"), '{"source":"original"}\n');
    assert.equal(fs.readFileSync(globalOnly, "utf8"), '{"source":"original"}\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testClaudeStreamingThreadParse() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chatswitch-claude-parse-unit-"));
  const file = path.join(root, "thread.jsonl");
  try {
    fs.writeFileSync(file, [
      JSON.stringify({
        type: "user",
        uuid: "user-1",
        cwd: "F:\\codepro",
        timestamp: "2026-07-26T10:00:00.000Z",
        message: { content: "hello" },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "assistant-1",
        timestamp: "2026-07-26T10:00:01.000Z",
        message: { model: "claude-fable-5", content: [{ type: "text", text: "world" }] },
      }),
      "",
    ].join("\n"), "utf8");
    const server = new ClaudeServer({ claudeConfigDir: root, model: "fable" });
    const thread = await server.parseThread(file);
    assert.equal(thread.turns.length, 1);
    assert.equal(thread.turns[0].items.length, 2);
    assert.equal(thread.model, "claude-fable-5");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testLocalConversationHistoryReader() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "chatswitch-local-history-"));
  try {
    const codexSessions = path.join(home, ".codex", "sessions", "2026", "08", "02");
    const codexArchived = path.join(home, ".codex", "archived_sessions");
    const claudeProjects = path.join(home, ".claude", "projects", "fixture-project");
    const codexAppHome = path.join(home, "Codex App Data");
    const codexAppSessions = path.join(codexAppHome, "sessions", "2026", "08", "03");
    fs.mkdirSync(codexSessions, { recursive: true });
    fs.mkdirSync(codexArchived, { recursive: true });
    fs.mkdirSync(claudeProjects, { recursive: true });
    fs.mkdirSync(codexAppSessions, { recursive: true });
    const codexFile = path.join(codexSessions, "codex-fixture.jsonl");
    const archivedFile = path.join(codexArchived, "codex-archived.jsonl");
    const claudeFile = path.join(claudeProjects, "claude-fixture.jsonl");
    const codexAppFile = path.join(codexAppSessions, "codex-app-fixture.jsonl");
    const codexContents = [
      JSON.stringify({ timestamp: "2026-08-02T01:00:00.000Z", type: "session_meta", payload: { id: "codex-session", cwd: "F:\\codepro", model_provider: "openai" } }),
      JSON.stringify({ timestamp: "2026-08-02T01:00:01.000Z", type: "turn_context", payload: { model: "gpt-fixture" } }),
      JSON.stringify({ timestamp: "2026-08-02T01:00:02.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<permissions instructions>hidden context</permissions instructions>" }] } }),
      JSON.stringify({ timestamp: "2026-08-02T01:00:03.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "修复本地记录浏览器" }] } }),
      JSON.stringify({ timestamp: "2026-08-02T01:00:04.000Z", type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "检查只读边界" }] } }),
      JSON.stringify({ timestamp: "2026-08-02T01:00:05.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "已经完成" }] } }),
      "",
    ].join("\n");
    fs.writeFileSync(codexFile, codexContents, "utf8");
    fs.writeFileSync(archivedFile, [
      JSON.stringify({ timestamp: "2026-07-01T01:00:00.000Z", type: "session_meta", payload: { id: "archived-session", cwd: "F:\\archive" } }),
      JSON.stringify({ timestamp: "2026-07-01T01:00:01.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "归档会话" }] } }),
      "",
    ].join("\n"), "utf8");
    fs.writeFileSync(claudeFile, [
      JSON.stringify({ type: "ai-title", aiTitle: "Claude 本地会话", sessionId: "claude-session", timestamp: "2026-08-02T02:00:00.000Z" }),
      JSON.stringify({ type: "user", sessionId: "claude-session", cwd: "F:\\claude-project", timestamp: "2026-08-02T02:00:01.000Z", message: { role: "user", content: "读取 Claude 记录" } }),
      JSON.stringify({ type: "assistant", sessionId: "claude-session", timestamp: "2026-08-02T02:00:02.000Z", message: { role: "assistant", model: "claude-fixture", content: [{ type: "text", text: "只读预览完成" }, { type: "tool_use", name: "ignored" }] } }),
      "",
    ].join("\n"), "utf8");
    const codexAppContents = [
      JSON.stringify({ timestamp: "2026-08-03T01:00:00.000Z", type: "session_meta", payload: { id: "codex-app-session", cwd: "F:\\codex-app", model_provider: "openai" } }),
      JSON.stringify({ timestamp: "2026-08-03T01:00:01.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "只读取 Codex App 会话" }] } }),
      JSON.stringify({ timestamp: "2026-08-03T01:00:02.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "无需安装 CLI" }] } }),
      "",
    ].join("\n");
    fs.writeFileSync(codexAppFile, codexAppContents, "utf8");

    const reader = createLocalHistoryReader({ homeDirectory: home, codexHomes: [codexAppHome] });
    const sources = await reader.sources();
    assert.deepEqual(sources.map((source) => [source.id, source.available]), [["codex", true], ["codex-app-1", true], ["claude", true]]);
    const codex = await reader.list({ sourceId: "codex" });
    assert.equal(codex.total, 2);
    assert.equal(codex.conversations.some((conversation) => conversation.archived), true);
    const active = codex.conversations.find((conversation) => !conversation.archived);
    assert.equal(active.title, "修复本地记录浏览器");
    assert.equal(active.model, "gpt-fixture");
    const codexPreview = await reader.read({ conversationId: active.id });
    assert.deepEqual(codexPreview.messages.map((message) => message.role), ["user", "reasoning", "assistant"]);
    assert.equal(codexPreview.messages.some((message) => message.text.includes("hidden context")), false);
    assert.equal(fs.readFileSync(codexFile, "utf8"), codexContents);
    const allCodex = await reader.list({ sourceId: "codex", all: true, limit: 20000 });
    assert.equal(allCodex.conversations.length, allCodex.total);
    assert.equal(allCodex.total, 2);

    const codexApp = await reader.list({ sourceId: "codex-app-1" });
    assert.equal(codexApp.total, 1);
    assert.equal(codexApp.conversations[0].title, "只读取 Codex App 会话");
    const codexAppPreview = await reader.read({ conversationId: codexApp.conversations[0].id });
    assert.deepEqual(codexAppPreview.messages.map((message) => message.text), ["只读取 Codex App 会话", "无需安装 CLI"]);
    assert.equal(fs.readFileSync(codexAppFile, "utf8"), codexAppContents);

    const claude = await reader.list({ sourceId: "claude", search: "Claude 本地" });
    assert.equal(claude.total, 1);
    const claudePreview = await reader.read({ conversationId: claude.conversations[0].id });
    assert.equal(claudePreview.title, "Claude 本地会话");
    assert.equal(claudePreview.model, "claude-fixture");
    assert.deepEqual(claudePreview.messages.map((message) => message.text), ["读取 Claude 记录", "只读预览完成"]);

    const forged = Buffer.from(JSON.stringify({ sourceId: "codex", relativePath: "..\\outside.jsonl" }), "utf8").toString("base64url");
    await assert.rejects(() => reader.read({ conversationId: forged }), /不允许读取/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function testLocalProviderDiscovery() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "chatswitch-local-providers-"));
  const codexHome = path.join(home, ".codex");
  const claudeHome = path.join(home, ".claude");
  const relayKey = "unit-relay-secret";
  const claudeKey = "unit-claude-secret";
  const codexConfig = [
    'model_provider = "fixture"',
    'model = "fixture-model"',
    '',
    '[model_providers.fixture]',
    'name = "Fixture Relay"',
    'base_url = "https://relay.example.test/v1" # keep this comment out of the URL',
    'env_key = "FIXTURE_API_KEY"',
    'wire_api = "responses"',
    '',
  ].join("\n");
  const claudeSettings = {
    env: {
      ANTHROPIC_BASE_URL: "https://claude.example.test/v1",
      ANTHROPIC_AUTH_TOKEN: claudeKey,
      ANTHROPIC_MODEL: "claude-fixture",
    },
  };
  const providers = [];
  const imported = [];
  const fakeStore = {
    list: () => providers.map((provider) => ({ ...provider })),
    addRelay: (input) => {
      imported.push({ kind: "relay", ...input });
      const provider = { id: `relay-${providers.length}`, type: "relay", hasStoredKey: true, ...input };
      delete provider.apiKey;
      providers.push(provider);
      return provider;
    },
    saveProviderKey: (id, apiKey) => imported.push({ kind: "key", id, apiKey }),
    saveClaudeSettings: (input) => {
      const provider = { id: "claude", type: "claude", protocol: "claude_messages", ...input };
      providers.push(provider);
      return provider;
    },
  };
  try {
    fs.mkdirSync(codexHome, { recursive: true });
    fs.mkdirSync(claudeHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, "config.toml"), codexConfig, "utf8");
    fs.writeFileSync(path.join(claudeHome, "settings.json"), JSON.stringify(claudeSettings), "utf8");
    const parsed = parseCodexConfig(codexConfig);
    assert.equal(parsed.providers.fixture.base_url, "https://relay.example.test/v1");
    assert.equal(parsed.topLevel.model, "fixture-model");

    const discovery = createLocalProviderDiscovery({
      homeDirectory: home,
      environment: { FIXTURE_API_KEY: relayKey },
      providerStore: fakeStore,
    });
    const result = discovery.discover();
    assert.equal(result.candidates.length, 2);
    assert.equal(result.candidates.every((candidate) => !Object.hasOwn(candidate, "apiKey")), true);
    assert.equal(JSON.stringify(result).includes(relayKey), false);
    assert.equal(JSON.stringify(result).includes(claudeKey), false);
    const relay = result.candidates.find((candidate) => candidate.kind === "relay");
    const claude = result.candidates.find((candidate) => candidate.kind === "claude");
    assert.equal(relay.importable, true);
    assert.equal(claude.importable, true);
    assert.equal(discovery.importCandidate(relay.id).status, "imported");
    assert.equal(imported.find((entry) => entry.kind === "relay").apiKey, relayKey);
    assert.equal(discovery.importCandidate(relay.id).status, "duplicate");
    assert.equal(discovery.importCandidate(claude.id).status, "imported");
    assert.equal(imported.some((entry) => entry.kind === "key" && entry.apiKey === claudeKey), true);
    assert.equal(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8"), codexConfig);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(claudeHome, "settings.json"), "utf8")), claudeSettings);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function testPersistedMessageQueues() {
  const store = new ProviderStore();
  const threadId = `queue-unit-${Date.now()}`;
  const saved = store.saveMessageQueue(threadId, [{
    text: "恢复后发送这条消息",
    displayText: "恢复后发送这条消息",
    imageInputs: [{ path: "F:\\codepro\\fixture.png", detail: "original" }],
    skillInputs: [{ name: "fixture", path: "F:\\skills\\fixture\\SKILL.md" }],
    cwd: "F:\\codepro",
    clientUserMessageId: "client-fixture",
    providerId: "deepseek-fixture",
    model: "deepseek-chat",
    effort: "high",
    approvalMode: "auto",
    apiKey: "must-not-persist",
  }]);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].imageInputs[0].detail, "auto");
  assert.equal(Object.hasOwn(saved[0], "apiKey"), false);
  const restored = new ProviderStore().messageQueues();
  assert.equal(restored[threadId][0].text, "恢复后发送这条消息");
  assert.equal(JSON.stringify(restored).includes("must-not-persist"), false);
  const claimed = store.claimMessageQueue(threadId, "client-fixture");
  assert.equal(claimed.message.clientUserMessageId, "client-fixture");
  assert.deepEqual(claimed.messages, []);
  assert.equal(Object.hasOwn(store.messageQueues(), threadId), false);
  const restoredClaim = store.restoreClaimedMessage(threadId, claimed.message);
  assert.equal(restoredClaim.length, 1);
  assert.equal(store.restoreClaimedMessage(threadId, claimed.message).length, 1);
  assert.deepEqual(store.saveMessageQueue(threadId, []), []);
  assert.equal(Object.hasOwn(store.messageQueues(), threadId), false);

  const interruptedThreadId = `interrupted-unit-${Date.now()}`;
  store.recordLogicalTurn(interruptedThreadId, {
    turnId: "turn-before-restart",
    nativeThreadId: interruptedThreadId,
    providerId: "deepseek-fixture",
    engine: "openai-compatible",
    status: "inProgress",
  });
  const restartedStore = new ProviderStore();
  assert.equal(restartedStore.threadTimeline(interruptedThreadId)[0].status, "interrupted");
  assert.equal(restartedStore.recoverableInterruptedTurns().some((turn) => turn.threadId === interruptedThreadId), true);
  restartedStore.recordLogicalTurn(interruptedThreadId, {
    turnId: "turn-before-restart",
    nativeThreadId: interruptedThreadId,
    providerId: "deepseek-fixture",
    status: "completed",
  });
  assert.equal(restartedStore.recoverableInterruptedTurns().some((turn) => turn.threadId === interruptedThreadId), false);
  restartedStore.deleteThreadNow(interruptedThreadId);
}

async function testInterruptedToolCallRepair() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "chatswitch-integrity-"));
  const threadId = "thread-integrity-fixture";
  const directory = path.join(home, "sessions", "2026", "08", "04");
  const file = path.join(directory, `rollout-2026-08-04T00-00-00-${threadId}.jsonl`);
  const records = [
    { timestamp: "2026-08-04T00:00:00.000Z", type: "response_item", payload: { type: "custom_tool_call", call_id: "call_interrupted", name: "exec", internal_chat_message_metadata_passthrough: { turn_id: "turn-old" } } },
    { timestamp: "2026-08-04T00:00:01.000Z", type: "turn_context", payload: { turn_id: "turn-new" } },
    { timestamp: "2026-08-04T00:00:02.000Z", type: "response_item", payload: { type: "custom_tool_call", call_id: "call_active", name: "exec" } },
  ];
  const original = `${records.slice(0, 1).map(JSON.stringify).join("\n")}\nmalformed-json\n${records.slice(1).map(JSON.stringify).join("\n")}`;
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(file, original, "utf8");
    assert.deepEqual(interruptedToolCalls(original).map((item) => item.callId), ["call_interrupted"]);
    const repaired = repairInterruptedToolCallsForThread(home, threadId, () => new Date("2026-08-04T00:01:00.000Z"));
    assert.deepEqual(repaired.map((item) => item.callId), ["call_interrupted"]);
    const after = fs.readFileSync(file, "utf8");
    assert.equal(after.startsWith(original), true);
    const output = after.split(/\r?\n/).filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    }).find((item) => item.payload?.type === "custom_tool_call_output");
    assert.equal(output.payload.call_id, "call_interrupted");
    assert.equal(output.payload.output[0].text, INTERRUPTED_TOOL_OUTPUT);
    assert.equal(output.payload.internal_chat_message_metadata_passthrough.turn_id, "turn-old");
    assert.deepEqual(interruptedToolCalls(after), []);
    assert.deepEqual(repairInterruptedToolCallsForThread(home, threadId), []);

    const server = Object.create(CodexServer.prototype);
    server.provider = { codexHome: home };
    let requests = 0;
    server.request = async () => { requests += 1; return { thread: { id: threadId } }; };
    await server.resumeThread(threadId);
    await server.resumeThread(threadId);
    assert.equal(requests, 2);
    assert.equal(server.integrityCheckedThreads.has(threadId), true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function testStreamEventBatcher() {
  const delivered = [];
  const batcher = createStreamEventBatcher((message) => delivered.push(message), { intervalMs: 1000 });
  batcher.push({ method: "item/agentMessage/delta", params: { threadId: "thread-a", turnId: "turn-a", itemId: "agent-a", delta: "你好" } });
  batcher.push({ method: "item/reasoning/summaryTextDelta", params: { threadId: "thread-a", turnId: "turn-a", itemId: "reasoning-a", delta: "检查" } });
  batcher.push({ method: "item/agentMessage/delta", params: { threadId: "thread-a", turnId: "turn-a", itemId: "agent-a", delta: "，世界" } });
  assert.equal(batcher.pendingCount(), 2);
  batcher.push({ method: "item/completed", params: { threadId: "thread-a", item: { id: "agent-a" } } });
  assert.deepEqual(delivered.map((message) => [message.method, message.params.delta || null]), [
    ["item/agentMessage/delta", "你好，世界"],
    ["item/reasoning/summaryTextDelta", "检查"],
    ["item/completed", null],
  ]);
  assert.equal(batcher.pendingCount(), 0);
  batcher.stop(false);
}

Promise.resolve()
  .then(testOfficialAuthenticationGate)
  .then(testOfficialAccountUsageNormalization)
  .then(testOfficialCliArguments)
  .then(testBundledCodexRuntimeDiscovery)
  .then(testDiagnosticNormalization)
  .then(testRawCodexDiagnosticsStayInternal)
  .then(testApplicationVersioning)
  .then(testApprovalNotifications)
  .then(testWindowsNotificationIdentity)
  .then(testOfficialCredentialSeeding)
  .then(testIsolatedStoreDefaults)
  .then(testConversationMirror)
  .then(testConversationMirrorMultipleSources)
  .then(testPrivateConfigurationSync)
  .then(testWebdavConfigurationSync)
  .then(testSkillMirror)
  .then(testManagedSkillActivation)
  .then(testPrivateExtensionsStore)
  .then(testBuiltinApiEditing)
  .then(testProviderApiKeyFallback)
  .then(testDeepLinks)
  .then(testProviderPresetCatalog)
  .then(testThreadPagination)
  .then(testRepeatedPaginationCursor)
  .then(testClientUserMessageId)
  .then(testModelAndEffortOverrides)
  .then(testReasoningProfiles)
  .then(testApprovalModes)
  .then(testOpenAIModelDiscovery)
  .then(testModelPagination)
  .then(testRenameThread)
  .then(testLegacyDeletionMigration)
  .then(testLegacyTurnLifecycleMigration)
  .then(testDeferredThreadDeletion)
  .then(testLocalThreadManagement)
  .then(testThreadBranchMapping)
  .then(testProviderUsageAndPricing)
  .then(testConfigurationImportExportAndBackup)
  .then(testCrossModelConversationMerge)
  .then(testScheduledTasks)
  .then(testScheduledTaskCalendarAndRetries)
  .then(testScheduledTaskExecution)
  .then(testNewApiBalance)
  .then(testUnsupportedBalance)
  .then(testClaudeModelList)
  .then(testClaudeModelError)
  .then(testClaudeModelFallback)
  .then(testRootlessProjectMembership)
  .then(testProjectDeletion)
  .then(testClaudeMergedHistoryAndImport)
  .then(testClaudeStreamingThreadParse)
  .then(testLocalConversationHistoryReader)
  .then(testLocalProviderDiscovery)
  .then(testPersistedMessageQueues)
  .then(testInterruptedToolCallRepair)
  .then(testStreamEventBatcher)
  .then(testClaudeThreadDeletion)
  .then(testOpenAICompatibleStreaming)
  .then(testOpenAICompatibleFailover)
  .then(testOpenAICompatibleCompletionValidation)
  .then(testOpenAICompatibleInterrupt)
  .then(testOpenAICompatibleSharedCodexHistory)
  .then(testImportedLocalConversation)
  .then(testClaudeOfficialAuthSettings)
  .then(() => console.log(JSON.stringify({ ok: true, tests: 63 })))
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(providerStoreTestRoot, { recursive: true, force: true });
  });
