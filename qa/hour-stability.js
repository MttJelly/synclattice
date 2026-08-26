const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");

const root = path.resolve(__dirname, "..");
const artifactRoot = path.join(__dirname, "multi-window-artifacts");
const profileRoot = path.join(__dirname, ".hour-stability-profile");
const durationMs = Number(process.env.CHATSWITCH_SOAK_MS || 3_600_000);
const cycleMs = Math.max(250, Number(process.env.CHATSWITCH_SOAK_CYCLE_MS || 2_000));

if (!Number.isFinite(durationMs) || durationMs < 10_000) {
  throw new Error("CHATSWITCH_SOAK_MS must be at least 10000.");
}

app.setPath("userData", profileRoot);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function rendererPrivateKb(window) {
  const rendererPid = window.webContents.getOSProcessId();
  const metric = app.getAppMetrics().find((item) => item.pid === rendererPid);
  const value = metric?.memory?.privateBytes ?? metric?.memory?.workingSetSize;
  if (!Number.isFinite(value)) throw new Error(`Renderer memory metric unavailable for PID ${rendererPid}.`);
  return value;
}

async function capture(window, filename) {
  fs.mkdirSync(artifactRoot, { recursive: true });
  const image = await window.webContents.capturePage();
  assert.equal(image.isEmpty(), false, `${filename} screenshot was empty.`);
  fs.writeFileSync(path.join(artifactRoot, filename), image.toPNG());
}

function registerHandlers(counters) {
  const threadSummaries = Array.from({ length: 12 }, (_, index) => ({
    id: `soak-thread-${index}`,
    name: `稳定性会话 ${index + 1}`,
    cwd: root,
    model: "deepseek-chat",
    updatedAt: Math.floor(Date.now() / 1000) - index * 60,
  }));
  const threadResult = (threadId) => ({
    thread: {
      id: threadId,
      name: `稳定性会话 ${threadId}`,
      cwd: root,
      model: "deepseek-chat",
      turns: [{
        id: `${threadId}-turn`,
        items: [{ id: `${threadId}-agent`, type: "agentMessage", text: "会话已载入。" }],
      }],
    },
  });
  ipcMain.handle("app:bootstrap", () => ({
    providers: [{
      id: "soak-provider",
      type: "relay",
      brand: "openai",
      preset: "deepseek",
      protocol: "chat_completions",
      label: "DeepSeek QA",
      model: "deepseek-chat",
      baseUrl: "https://api.deepseek.com/v1",
      hasStoredKey: true,
    }],
    projects: [
      { id: "soak-project-a", label: "稳定性测试", root, createdAt: new Date().toISOString() },
      { id: "soak-project-b", label: "后台任务", root: "", createdAt: new Date().toISOString() },
    ],
    projectThreads: {},
    hiddenProjectRoots: [],
    threadSettings: {},
    threadAliases: {},
    hiddenThreadIds: [],
    deletedThreadIds: [],
    localArchivedThreadIds: [],
    pendingDeletions: [],
    scheduledTasks: [],
    runningTaskIds: [],
    recordHome: path.join(profileRoot, "conversations"),
  }));
  ipcMain.handle("extension:list", () => ({ skills: [], prompts: [], mcpServers: [] }));
  ipcMain.handle("codex:resume", (_event, input) => threadResult(input.threadId));
  ipcMain.handle("codex:read", (_event, threadId) => threadResult(threadId));
  ipcMain.handle("codex:read-window", (_event, input) => threadResult(input.threadId));
  ipcMain.handle("codex:list", (_event, input) => ({ data: input.archived ? [] : threadSummaries }));
  ipcMain.handle("thread:save-message-queue", () => {
    counters.queueSaves += 1;
    return [];
  });
  ipcMain.handle("thread:claim-message-queue", (_event, input) => ({
    busy: false,
    message: structuredClone(input.message),
    messages: structuredClone(input.remainingMessages || []),
  }));
  ipcMain.handle("thread:restore-message-queue", (_event, input) => [structuredClone(input.message)]);
  ipcMain.handle("codex:start-turn", () => {
    counters.turns += 1;
    return { turn: { id: `soak-queued-turn-${counters.turns}` } };
  });
  ipcMain.handle("codex:steer", (_event, input) => {
    counters.steers += 1;
    counters.lastSteerTurnId = input.expectedTurnId;
    return { turnId: input.expectedTurnId };
  });
  ipcMain.handle("codex:interrupt", () => {
    counters.interrupts += 1;
    return true;
  });
  ipcMain.handle("app:notify", () => {
    counters.notifications += 1;
    return true;
  });
}

async function initializeRenderer(window) {
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (window.chatSwitchVue && window.chatSwitchState) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > 10000) {
        clearInterval(timer);
        reject(new Error('Vue renderer initialization timed out.'));
      }
    }, 50);
  })`);
  return window.webContents.executeJavaScript(`(() => {
    document.querySelectorAll('.overlay').forEach((node) => node.classList.add('hidden'));
    state.connected = true;
    state.provider = 'soak-provider';
    state.providerType = 'relay';
    state.providerEngine = 'openai-compatible';
    state.modelProvider = 'deepseek';
    state.modelCatalog = [{
      id: 'deepseek-chat', model: 'deepseek-chat', displayName: 'DeepSeek Chat',
      isDefault: true, supportedReasoningEfforts: []
    }];
    const threads = Array.from({ length: 12 }, (_, threadIndex) => ({
      id: 'soak-thread-' + threadIndex,
      name: '稳定性会话 ' + (threadIndex + 1),
      cwd: ${JSON.stringify(root)},
      model: 'deepseek-chat',
      updatedAt: Math.floor(Date.now() / 1000) - threadIndex * 60,
      turns: Array.from({ length: 50 }, (_, turnIndex) => ({
        id: 'turn-' + threadIndex + '-' + turnIndex,
        items: [
          { id: 'user-' + threadIndex + '-' + turnIndex, type: 'userMessage', content: [{ type: 'text', text: '第 ' + (turnIndex + 1) + ' 轮问题：检查窗口切换和后台运行。' }] },
          { id: 'reasoning-' + threadIndex + '-' + turnIndex, type: 'reasoning', summary: [{ text: '检查状态、布局与消息队列。' }] },
          { id: 'agent-' + threadIndex + '-' + turnIndex, type: 'agentMessage', text: '### 检查结果\\n\\n- 会话：' + (threadIndex + 1) + '\\n- 轮次：' + (turnIndex + 1) + '\\n- 状态：正常' }
        ]
      }))
    }));
    window.__soakThreads = threads;
    state.activeThreads = threads;
    state.archivedThreads = [];
    state.allThreads = threads;
    state.threads = threads;
    state.activeProject = null;
    state.activeThread = threads[0];
    state.threadResumed = true;
    renderProjects();
    renderThreadList();
    renderConversation(threads[0]);
    applyThreadSessionSettings(threads[0]);
    syncComposerState();
    return { threadCount: threads.length, messageCount: document.querySelectorAll('.message').length };
  })()`);
}

async function exerciseCycle(window, cycle) {
  return window.webContents.executeJavaScript(`(async () => {
    const threads = window.__soakThreads;
    const thread = threads[${cycle} % threads.length];
    const next = threads[(${cycle} + 1) % threads.length];
    state.threadView = 'active';
    state.activeThread = thread;
    state.threadResumed = true;
    showCachedConversation(thread);
    renderConversation(thread);
    applyThreadSessionSettings(thread);
    syncActiveRunState();

    let queued = 0;
    let deliveryScenario = false;
    let nativeSteerKeptQueueEmpty = true;
    let fallbackOrderCorrect = true;
    let queueBadgeCorrect = true;
    let actionTopDelta = 0;
    let backgroundPreserved = true;
    if (${cycle} % 30 === 0) {
      setThreadRunning(thread.id, true, 'background-' + ${cycle});
      const input = document.querySelector('#composer-input');
      state.providerEngine = 'codex';
      input.value = '原生引导 ' + ${cycle};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await sendMessage('auto');
      const nativeQueued = state.messageQueues.get(thread.id) || [];
      const nativeMessageId = nativeQueued[0]?.clientUserMessageId;
      const nativeQueuedOnce = nativeQueued.length === 1;
      if (nativeQueuedOnce && nativeMessageId) {
        await steerQueuedMessage(thread.id, nativeMessageId);
      }
      nativeSteerKeptQueueEmpty = nativeQueuedOnce
        && (state.messageQueues.get(thread.id) || []).length === 0;

      state.providerEngine = 'openai-compatible';
      for (const value of ['排队消息 A ' + ${cycle}, '排队消息 B ' + ${cycle}]) {
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await sendMessage('queue');
      }
      input.value = '兼容连接引导 ' + ${cycle};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await sendMessage('auto');
      await new Promise((resolve) => setTimeout(resolve, 10));
      const pending = state.messageQueues.get(thread.id) || [];
      queued = pending.length;
      deliveryScenario = true;
      fallbackOrderCorrect = pending[0]?.displayText === '排队消息 A ' + ${cycle}
        && pending[1]?.displayText === '排队消息 B ' + ${cycle}
        && pending[2]?.displayText === '兼容连接引导 ' + ${cycle};
      queueBadgeCorrect = !document.querySelector('#queue-button')
        && document.querySelectorAll('#message-queue-panel .queued-prompt-item').length === pending.length;
      const sendBounds = document.querySelector('#send-button').getBoundingClientRect();
      const stopBounds = document.querySelector('#stop-button').getBoundingClientRect();
      actionTopDelta = Math.abs(Math.round(sendBounds.top - stopBounds.top));
      state.activeThread = next;
      syncActiveRunState();
      backgroundPreserved = state.runningThreads.has(thread.id);
      for (let pass = 0; pass < 4 && state.runningThreads.has(thread.id); pass += 1) {
        const turnId = state.runningThreads.get(thread.id)?.turnId;
        handleEvent({ method: 'turn/completed', params: { threadId: thread.id, turn: { id: turnId, status: 'completed' } } });
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      state.messageQueues.delete(thread.id);
      setThreadRunning(thread.id, false);
      state.activeThread = thread;
      state.providerEngine = 'openai-compatible';
    }

    if (${cycle} % 45 === 15) {
      setThreadRunning(thread.id, true, 'interrupt-' + ${cycle});
      requestTurnInterrupt();
      await new Promise((resolve) => setTimeout(resolve, 10));
      setThreadRunning(thread.id, false);
    }

    const connectionOverlay = document.querySelector('#connection-overlay');
    if (${cycle} % 5 === 0) connectionOverlay.classList.remove('hidden');
    else connectionOverlay.classList.add('hidden');
    if (${cycle} % 7 === 0) {
      document.querySelector('#thread-search').value = '稳定性会话';
      applyThreadFilter('稳定性会话');
    } else {
      document.querySelector('#thread-search').value = '';
      applyThreadFilter('');
    }
    updateThreadViewControls();
    state.renderedThreadRevision = null;
    renderConversation(thread);
    refreshIcons();
    await new Promise((resolve) => requestAnimationFrame(resolve));

    const composer = document.querySelector('.composer');
    const bodyOverflow = document.body.scrollWidth > document.body.clientWidth || document.body.scrollHeight > document.body.clientHeight;
    const composerOverflow = composer.scrollWidth > composer.clientWidth;
    const chatOverflow = document.querySelector('#chat-view').scrollWidth > document.querySelector('#chat-view').clientWidth;
    return {
      bodyOverflow,
      composerOverflow,
      chatOverflow,
      messages: document.querySelectorAll('.message').length,
      activities: document.querySelectorAll('.activity-row').length,
      cacheSize: state.conversationCache.size,
      runningThreads: state.runningThreads.size,
      queued,
      deliveryScenario,
      nativeSteerKeptQueueEmpty,
      fallbackOrderCorrect,
      queueBadgeCorrect,
      actionTopDelta,
      composerFooterOverflow: document.querySelector('.composer-footer').scrollWidth > document.querySelector('.composer-footer').clientWidth,
      backgroundPreserved,
      fatal: document.querySelector('.renderer-fatal')?.textContent || null
    };
  })()`);
}

async function run() {
  const counters = { turns: 0, steers: 0, interrupts: 0, notifications: 0, queueSaves: 0, lastSteerTurnId: null };
  registerHandlers(counters);
  await app.whenReady();
  const errors = [];
  let rendererGone = null;
  let unresponsive = false;
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
      backgroundThrottling: false,
    },
  });
  window.webContents.on("console-message", (_event, level, message) => {
    if (level >= 2) errors.push(message);
  });
  window.webContents.on("render-process-gone", (_event, details) => { rendererGone = details; });
  window.on("unresponsive", () => { unresponsive = true; });
  await window.loadFile(path.join(root, "src", "renderer", "index.html"));
  const initialized = await initializeRenderer(window);
  assert.equal(initialized.threadCount, 12);
  assert.equal(initialized.messageCount, 80);
  await capture(window, "hour-stability-start.png");

  const startedAt = Date.now();
  let cycle = 0;
  let lastHeartbeat = 0;
  let maxPrivateKb = 0;
  let minPrivateKb = Number.POSITIVE_INFINITY;
  let lastSnapshot = null;
  while (Date.now() - startedAt < durationMs) {
    const sizes = [[1200, 800], [900, 640], [1440, 900]];
    if (cycle % 4 === 0) window.setSize(...sizes[(cycle / 4) % sizes.length | 0]);
    lastSnapshot = await exerciseCycle(window, cycle);
    assert.equal(lastSnapshot.bodyOverflow, false, `Body overflow at cycle ${cycle}.`);
    assert.equal(lastSnapshot.composerOverflow, false, `Composer overflow at cycle ${cycle}.`);
    assert.equal(lastSnapshot.chatOverflow, false, `Chat overflow at cycle ${cycle}.`);
    assert.equal(lastSnapshot.composerFooterOverflow, false, `Composer footer overflow at cycle ${cycle}.`);
    assert.ok(lastSnapshot.actionTopDelta <= 1, `Composer actions wrapped at cycle ${cycle}.`);
    assert.equal(lastSnapshot.fatal, null, `Renderer fatal state at cycle ${cycle}.`);
    assert.ok(lastSnapshot.messages <= 80, `DOM message count grew to ${lastSnapshot.messages}.`);
    assert.ok(lastSnapshot.cacheSize <= 20, `Conversation cache grew to ${lastSnapshot.cacheSize}.`);
    assert.equal(lastSnapshot.backgroundPreserved, true, `Background run was lost at cycle ${cycle}.`);
    assert.equal(lastSnapshot.nativeSteerKeptQueueEmpty, true, `Native steer entered the queue at cycle ${cycle}.`);
    assert.equal(lastSnapshot.fallbackOrderCorrect, true, `Fallback steer queue order changed at cycle ${cycle}.`);
    assert.equal(lastSnapshot.queueBadgeCorrect, true, `Queue badge was stale at cycle ${cycle}.`);
    if (lastSnapshot.deliveryScenario) {
      assert.equal(lastSnapshot.queued, 3, `Expected three fallback messages at cycle ${cycle}.`);
    }
    assert.equal(rendererGone, null, `Renderer exited: ${JSON.stringify(rendererGone)}`);
    assert.equal(unresponsive, false, "Window became unresponsive.");
    assert.equal(errors.some((message) => /Uncaught|Vue warn|Content Security Policy/i.test(message)), false, errors.join("\n"));

    const elapsed = Date.now() - startedAt;
    if (elapsed - lastHeartbeat >= 60_000 || cycle === 0) {
      const privateKb = rendererPrivateKb(window);
      maxPrivateKb = Math.max(maxPrivateKb, privateKb);
      minPrivateKb = Math.min(minPrivateKb, privateKb);
      lastHeartbeat = elapsed;
      console.log(JSON.stringify({
        heartbeat: true,
        elapsedMs: elapsed,
        cycle,
        privateMb: Number((privateKb / 1024).toFixed(1)),
        cacheSize: lastSnapshot.cacheSize,
        messages: lastSnapshot.messages,
        turns: counters.turns,
        steers: counters.steers,
        interrupts: counters.interrupts,
        queueSaves: counters.queueSaves,
      }));
    }
    cycle += 1;
    await delay(Math.min(cycleMs, Math.max(0, durationMs - (Date.now() - startedAt))));
  }

  const documentResult = await window.webContents.executeJavaScript(`(() => {
    document.querySelector('#connection-overlay').classList.add('hidden');
    state.runningThreads.clear();
    state.messageQueues.clear();
    state.activeThread = window.__soakThreads[0];
    renderConversation(state.activeThread);
    syncActiveRunState();
    return { running: state.runningThreads.size, queued: state.messageQueues.size };
  })()`);
  assert.deepEqual(documentResult, { running: 0, queued: 0 });
  assert.ok(maxPrivateKb - minPrivateKb < 300 * 1024, `Renderer private memory grew by ${((maxPrivateKb - minPrivateKb) / 1024).toFixed(1)} MB.`);
  window.setSize(1200, 800);
  await delay(100);
  await capture(window, "hour-stability-end.png");
  console.log(JSON.stringify({
    ok: true,
    durationMs: Date.now() - startedAt,
    cycles: cycle,
    memoryGrowthMb: Number(((maxPrivateKb - minPrivateKb) / 1024).toFixed(1)),
    peakPrivateMb: Number((maxPrivateKb / 1024).toFixed(1)),
    turns: counters.turns,
    steers: counters.steers,
    interrupts: counters.interrupts,
    queueSaves: counters.queueSaves,
    notifications: counters.notifications,
    errors,
    lastSnapshot,
  }));
  window.destroy();
}

run()
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(() => app.quit());
