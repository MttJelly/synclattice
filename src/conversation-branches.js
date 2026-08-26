function userItemText(item) {
  return (item?.content || [])
    .filter((part) => part?.type === "text")
    .map((part) => String(part.text || ""))
    .filter(Boolean)
    .join("\n");
}

function conversationMessages(thread) {
  const messages = [];
  for (const turn of thread?.turns || []) {
    for (const item of turn?.items || []) {
      if (item?.type === "userMessage") {
        const text = userItemText(item);
        if (text) messages.push({ role: "user", text });
      } else if (item?.type === "agentMessage" && item.text) {
        messages.push({ role: "assistant", text: String(item.text) });
      }
    }
  }
  return messages;
}

function buildContinuationPrompt(thread, userText, maxCharacters = 60000) {
  const latest = [];
  let characters = 0;
  const messages = conversationMessages(thread);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const line = `${message.role === "user" ? "用户" : "助手"}: ${message.text}`;
    if (latest.length && characters + line.length > maxCharacters) break;
    latest.unshift(line);
    characters += line.length;
  }
  const prompt = String(userText || "").trim();
  if (!latest.length) return prompt;
  return [
    "你正在 ChatSwitch 中接续一个由其他模型参与的同一逻辑会话。",
    "下面是此前会话记录。请把它作为上下文继续处理，不要复述记录，也不要声称无法访问此前内容。",
    "<shared_conversation>",
    ...latest,
    "</shared_conversation>",
    "<current_user_message>",
    prompt,
    "</current_user_message>",
  ].join("\n");
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function restoreFirstUserMessage(thread, metadata) {
  const restored = clone(thread);
  const expectedText = metadata?.firstUserText;
  if (typeof expectedText !== "string") return restored;
  for (const turn of restored?.turns || []) {
    const item = (turn.items || []).find((candidate) => candidate?.type === "userMessage");
    if (!item) continue;
    const content = Array.isArray(item.content) ? item.content : [];
    const textIndex = content.findIndex((part) => part?.type === "text");
    if (textIndex >= 0) content[textIndex] = { ...content[textIndex], text: expectedText };
    else if (expectedText) content.unshift({ type: "text", text: expectedText });
    item.content = content;
    break;
  }
  return restored;
}

function tagBranchAnswers(thread, label) {
  if (!label) return thread;
  for (const turn of thread?.turns || []) {
    for (const item of turn?.items || []) {
      if (item?.type === "agentMessage" && !item.sourceLabel) item.sourceLabel = label;
    }
  }
  return thread;
}

function mergeLogicalThread(baseThread, branches = [], timeline = []) {
  const base = clone(baseThread);
  const candidates = [];
  const timelineByTurn = new Map(timeline.map((entry) => [
    `${entry.nativeThreadId}:${entry.turnId}`,
    entry,
  ]));
  const addTurns = (thread, nativeThreadId, providerId, sourceOrder) => {
    (thread?.turns || []).forEach((turn, turnIndex) => {
      const key = `${nativeThreadId}:${turn.id}`;
      const displayText = timelineByTurn.get(key)?.displayText;
      const visibleTurn = typeof displayText === "string"
        ? restoreFirstUserMessage({ turns: [turn] }, { firstUserText: displayText }).turns[0]
        : turn;
      candidates.push({
        turn: visibleTurn,
        nativeThreadId,
        providerId,
        sourceOrder,
        turnIndex,
        key,
      });
    });
  };
  addTurns(base, base.id, base.modelProvider || "origin", 0);
  branches.forEach((entry, index) => {
    const restored = tagBranchAnswers(
      restoreFirstUserMessage(entry.thread, entry.metadata),
      entry.label,
    );
    addTurns(restored, entry.metadata.threadId, entry.providerId, index + 1);
  });

  const orderedKeys = new Map(
    [...timeline]
      .sort((left, right) => Number(left.startedAt) - Number(right.startedAt))
      .map((entry, index) => [`${entry.nativeThreadId}:${entry.turnId}`, index]),
  );
  const baseline = candidates
    .filter((entry) => !orderedKeys.has(entry.key))
    .sort((left, right) => left.sourceOrder - right.sourceOrder || left.turnIndex - right.turnIndex);
  const ordered = candidates
    .filter((entry) => orderedKeys.has(entry.key))
    .sort((left, right) => orderedKeys.get(left.key) - orderedKeys.get(right.key));
  const latestBranch = branches.at(-1)?.thread || null;
  const timestamps = [base.updatedAt, base.recencyAt, ...branches.flatMap((entry) => [
    entry.thread?.updatedAt,
    entry.thread?.recencyAt,
    Number(entry.metadata?.updatedAt) > 1e12 ? Number(entry.metadata.updatedAt) / 1000 : entry.metadata?.updatedAt,
  ])].map(Number).filter(Number.isFinite);
  const updatedAt = timestamps.length ? Math.max(...timestamps) : Math.floor(Date.now() / 1000);
  return {
    ...base,
    id: baseThread.id,
    model: latestBranch?.model || base.model,
    modelProvider: latestBranch?.modelProvider || base.modelProvider,
    updatedAt,
    recencyAt: updatedAt,
    turns: [...baseline, ...ordered].map((entry) => entry.turn),
    _logicalThread: true,
    _crossModelReadOnly: false,
  };
}

function remapBranchMessage(message, nativeThreadId, logicalThreadId, metadata = null) {
  if (!message?.params || !nativeThreadId || !logicalThreadId) return message;
  const params = { ...message.params };
  let changed = false;
  for (const key of ["threadId", "conversationId"]) {
    if (params[key] === nativeThreadId) {
      params[key] = logicalThreadId;
      changed = true;
    }
  }
  if (params.thread?.id === nativeThreadId) {
    params.thread = { ...params.thread, id: logicalThreadId };
    changed = true;
  }
  if (params.item?.type === "userMessage" && typeof metadata?.firstUserText === "string") {
    const item = restoreFirstUserMessage({ turns: [{ items: [params.item] }] }, metadata).turns[0].items[0];
    params.item = item;
    changed = true;
  }
  return changed ? { ...message, params } : message;
}

module.exports = {
  buildContinuationPrompt,
  conversationMessages,
  mergeLogicalThread,
  remapBranchMessage,
  restoreFirstUserMessage,
};
