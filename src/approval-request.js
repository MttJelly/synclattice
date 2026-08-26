const DIRECT_APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "applyPatchApproval",
  "execCommandApproval",
]);

const NOTIFICATION_APPROVAL_ACTIONS = Object.freeze([
  { type: "button", text: "拒绝", decision: "decline" },
  { type: "button", text: "允许一次", decision: "accept" },
  { type: "button", text: "本会话允许", decision: "acceptForSession" },
]);

class ApprovalRequestRegistry {
  constructor() {
    this.requestsByServer = new WeakMap();
  }

  requests(server, create = false) {
    let requests = this.requestsByServer.get(server);
    if (!requests && create) {
      requests = new Map();
      this.requestsByServer.set(server, requests);
    }
    return requests || null;
  }

  replace(server, requestId, value) {
    const requests = this.requests(server, true);
    const key = String(requestId);
    const previous = requests.get(key) || null;
    requests.set(key, value);
    return previous;
  }

  take(server, requestId) {
    const requests = this.requests(server);
    const key = String(requestId);
    const value = requests?.get(key) || null;
    if (value) requests.delete(key);
    return value;
  }

  clear(server) {
    const requests = this.requests(server);
    if (!requests) return [];
    const values = [...requests.values()];
    requests.clear();
    return values;
  }
}

function requestedPermissionLabels(params = {}) {
  const labels = [];
  if (params.permissions?.network) labels.push("网络访问");
  if (params.permissions?.fileSystem) labels.push("文件访问");
  return labels;
}

function approvalNotificationSpec(request = {}) {
  const method = String(request.method || "");
  if (method === "item/tool/requestUserInput") {
    return {
      title: "ChatSwitch 需要你的选择",
      body: "模型正在等待你填写信息。点击通知返回对应会话。",
      actions: [],
    };
  }
  if (method === "mcpServer/elicitation/request") {
    return {
      title: "ChatSwitch 需要你的输入",
      body: "MCP 服务正在等待你的确认或输入。点击通知返回对应会话。",
      actions: [],
    };
  }

  let operation = "执行受限操作";
  if (["item/commandExecution/requestApproval", "execCommandApproval"].includes(method)) operation = "运行一条命令";
  if (["item/fileChange/requestApproval", "applyPatchApproval"].includes(method)) operation = "修改文件";
  if (method === "item/permissions/requestApproval") {
    const labels = requestedPermissionLabels(request.params);
    operation = labels.length ? `使用${labels.join("和")}` : "提升访问权限";
  }
  return {
    title: "ChatSwitch 请求授权",
    body: `模型请求${operation}。可直接处理，或点击通知查看完整详情。`,
    actions: DIRECT_APPROVAL_METHODS.has(method)
      ? NOTIFICATION_APPROVAL_ACTIONS.map(({ type, text }) => ({ type, text }))
      : [],
  };
}

function approvalDecisionForNotificationAction(actionIndex) {
  return NOTIFICATION_APPROVAL_ACTIONS[Number(actionIndex)]?.decision || null;
}

function approvalDecisionResult(request = {}, decision) {
  const params = request.params || {};
  if (request.method === "item/permissions/requestApproval") {
    const granted = {};
    if (String(decision).startsWith("accept") && params.permissions?.network) {
      granted.network = params.permissions.network;
    }
    if (String(decision).startsWith("accept") && params.permissions?.fileSystem) {
      granted.fileSystem = params.permissions.fileSystem;
    }
    return { permissions: granted, scope: decision === "acceptForSession" ? "session" : "turn" };
  }
  if (["applyPatchApproval", "execCommandApproval"].includes(request.method)) {
    const legacyDecision = decision === "accept" ? "approved"
      : decision === "acceptForSession" ? "approved_for_session"
        : decision === "cancel" ? "abort" : "denied";
    return { decision: legacyDecision };
  }
  return { decision };
}

module.exports = {
  ApprovalRequestRegistry,
  DIRECT_APPROVAL_METHODS,
  approvalDecisionForNotificationAction,
  approvalDecisionResult,
  approvalNotificationSpec,
};
