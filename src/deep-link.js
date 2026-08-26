const VALID_HOSTS = new Set(["open", "new", "extensions", "scheduled", "import"]);
const IMPORT_TYPES = new Set(["provider", "mcp", "prompt", "skill"]);
const SENSITIVE_FIELD = /(?:api[-_]?key|token|password|secret|credential|authorization)/i;

function cleanValue(value, maxLength = 200) {
  const text = String(value || "").trim();
  if (!text || text.length > maxLength || /[\u0000-\u001f\u007f]/.test(text)) return null;
  return text;
}

function cleanText(value, maxLength) {
  const text = String(value || "").trim();
  if (!text || text.length > maxLength || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return null;
  return text;
}

function cleanHttpUrl(value, { githubOnly = false, plain = false } = {}) {
  const text = cleanValue(value, 1200);
  if (!text) return null;
  let parsed;
  try { parsed = new URL(text); } catch { return null; }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return null;
  if (plain && (parsed.search || parsed.hash)) return null;
  if (githubOnly && (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com"
    || parsed.search || parsed.hash
    || !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?\/?$/.test(parsed.pathname))) return null;
  return parsed.toString().replace(/\/$/, "");
}

function payloadObject(url) {
  const encoded = url.searchParams.get("data");
  if (!encoded) return Object.fromEntries(url.searchParams.entries());
  if (encoded.length > 12000) return null;
  try {
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    const value = JSON.parse(decoded);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function containsSensitiveFields(value) {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, nested]) => (
    SENSITIVE_FIELD.test(key) || (nested && typeof nested === "object" && containsSensitiveFields(nested))
  ));
}

function parseImportLink(url) {
  const input = payloadObject(url);
  if (!input || containsSensitiveFields(input)) return null;
  const importType = cleanValue(input.type, 20);
  if (!IMPORT_TYPES.has(importType)) return null;
  if (importType === "provider") {
    const label = cleanValue(input.label || input.name, 100);
    const baseUrl = cleanHttpUrl(input.baseUrl || input.url, { plain: true });
    const model = cleanValue(input.model, 160);
    if (!label || !baseUrl || !model) return null;
    return {
      action: "import", importType,
      config: {
        label, baseUrl, model,
        preset: cleanValue(input.preset, 40) || "custom",
        protocol: input.protocol === "responses" ? "responses" : "chat_completions",
      },
    };
  }
  if (importType === "prompt") {
    const name = cleanValue(input.name, 80);
    const content = cleanText(input.content, 8000);
    if (!name || !content) return null;
    return {
      action: "import", importType,
      config: { name, description: cleanValue(input.description, 240) || "", content },
    };
  }
  if (importType === "skill") {
    const source = cleanHttpUrl(input.source || input.url, { githubOnly: true });
    return source ? { action: "import", importType, config: { source } } : null;
  }
  const name = cleanValue(input.name, 100);
  const transport = ["stdio", "http", "sse"].includes(input.transport) ? input.transport : "stdio";
  let args = input.args;
  if (typeof args === "string") {
    try { args = JSON.parse(args); } catch { args = args.split(/\r?\n/); }
  }
  args = (Array.isArray(args) ? args : []).map((item) => cleanValue(item, 500)).filter(Boolean).slice(0, 50);
  let envKeys = input.envKeys;
  if (typeof envKeys === "string") envKeys = envKeys.split(/[\s,]+/);
  envKeys = [...new Set((Array.isArray(envKeys) ? envKeys : [])
    .map((item) => cleanValue(item, 100)).filter((item) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(item)))].slice(0, 50);
  const command = transport === "stdio" ? cleanValue(input.command, 300) : null;
  const remoteUrl = transport === "stdio" ? null : cleanHttpUrl(input.url);
  if (!name || (transport === "stdio" ? !command : !remoteUrl)) return null;
  return {
    action: "import", importType,
    config: { name, transport, command, args, url: remoteUrl, envKeys, enabled: ![false, "false", "0"].includes(input.enabled) },
  };
}

function parseChatSwitchLink(input) {
  const raw = String(input || "").trim();
  if (!raw || raw.length > 16384) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "chatswitch:" || !VALID_HOSTS.has(url.hostname) || url.username || url.password) return null;
  const action = url.hostname;
  if (action === "import") return parseImportLink(url);
  if (action === "extensions") {
    const tab = cleanValue(url.searchParams.get("tab"), 20);
    return { action, tab: ["skills", "prompts", "mcp"].includes(tab) ? tab : "skills" };
  }
  if (action === "scheduled") return { action };
  return {
    action,
    provider: cleanValue(url.searchParams.get("provider")),
    thread: action === "open" ? cleanValue(url.searchParams.get("thread")) : null,
    projectId: cleanValue(url.searchParams.get("projectId")),
    workspace: cleanValue(url.searchParams.get("workspace"), 1024),
  };
}

function chatSwitchLinkFromArgs(args = []) {
  return (args || []).map((value) => String(value || ""))
    .find((value) => value.startsWith("chatswitch://")) || null;
}

module.exports = { parseChatSwitchLink, chatSwitchLinkFromArgs };
