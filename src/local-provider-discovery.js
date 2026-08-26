const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const ALLOWED_PROTOCOLS = new Set(["responses", "chat_completions"]);

function safeReadText(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function safeReadJson(file) {
  const text = safeReadText(file);
  if (text === null) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function stripTomlComment(value) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && character === "\\") {
      escaped = true;
      continue;
    }
    if ((character === '"' || character === "'") && (!quote || quote === character)) {
      quote = quote ? null : character;
      continue;
    }
    if (character === "#" && !quote) return value.slice(0, index).trim();
  }
  return value.trim();
}

function parseTomlScalar(value) {
  const source = stripTomlComment(String(value || "").trim());
  if (!source) return "";
  if (source.startsWith('"') && source.endsWith('"')) {
    try {
      return JSON.parse(source);
    } catch {
      return source.slice(1, -1);
    }
  }
  if (source.startsWith("'") && source.endsWith("'")) return source.slice(1, -1);
  if (source === "true") return true;
  if (source === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(source)) return Number(source);
  return source;
}

function cleanTomlSegment(value) {
  const source = String(value || "").trim();
  if ((source.startsWith('"') && source.endsWith('"')) || (source.startsWith("'") && source.endsWith("'"))) {
    return String(parseTomlScalar(source));
  }
  return source;
}

function parseCodexConfig(text) {
  const topLevel = {};
  const providers = {};
  let section = null;
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const sectionMatch = line.match(/^\[\s*model_providers\.(.+?)\s*\]$/);
    if (sectionMatch) {
      section = cleanTomlSegment(sectionMatch[1]);
      providers[section] ||= {};
      continue;
    }
    if (line.startsWith("[")) {
      section = null;
      continue;
    }
    const assignment = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!assignment) continue;
    const target = section ? providers[section] : topLevel;
    target[assignment[1]] = parseTomlScalar(assignment[2]);
  }
  return { topLevel, providers };
}

function normalizeBaseUrl(value) {
  try {
    const parsed = new URL(String(value || "").trim());
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    if (parsed.search || parsed.hash) return null;
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function presetFor(baseUrl, label = "") {
  const value = `${baseUrl} ${label}`.toLowerCase();
  if (value.includes("deepseek")) return "deepseek";
  if (value.includes("dashscope") || value.includes("qwen") || value.includes("aliyuncs")) return "qwen";
  if (value.includes("openrouter")) return "openrouter";
  if (value.includes("groq")) return "groq";
  if (value.includes("api.openai.com")) return "openai";
  return "custom";
}

function protocolFor(value, fallback = "responses") {
  const normalized = String(value || "").trim().toLowerCase().replaceAll("-", "_");
  if (["chat", "chat_completions", "chatcompletions"].includes(normalized)) return "chat_completions";
  if (normalized === "responses") return "responses";
  return ALLOWED_PROTOCOLS.has(fallback) ? fallback : "responses";
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function candidateSignature(candidate) {
  return [candidate.kind, candidate.baseUrl.toLowerCase(), candidate.model.toLowerCase(), candidate.protocol].join("|");
}

function providerMatch(candidate, providerStore) {
  if (!providerStore || typeof providerStore.list !== "function") return null;
  const providers = providerStore.list();
  if (candidate.kind === "claude") {
    const claude = providers.find((provider) => provider.id === "claude");
    return claude
      && String(claude.baseUrl || "").replace(/\/+$/, "").toLowerCase() === candidate.baseUrl.toLowerCase()
      && String(claude.model || "").toLowerCase() === candidate.model.toLowerCase()
      ? claude
      : null;
  }
  return providers.find((provider) => provider.type === "relay"
    && String(provider.baseUrl || "").replace(/\/+$/, "").toLowerCase() === candidate.baseUrl.toLowerCase()
    && String(provider.model || "").toLowerCase() === candidate.model.toLowerCase()
    && protocolFor(provider.protocol, "responses") === candidate.protocol) || null;
}

function providerDuplicate(candidate, providerStore) {
  const match = providerMatch(candidate, providerStore);
  return match?.hasStoredKey ? match : null;
}

function publicCandidate(candidate, providerStore) {
  const duplicate = providerDuplicate(candidate, providerStore);
  return {
    id: candidate.id,
    kind: candidate.kind,
    source: [...candidate.sources].join("、"),
    label: candidate.label,
    baseUrl: candidate.baseUrl,
    model: candidate.model,
    protocol: candidate.protocol,
    preset: candidate.preset,
    hasCredential: Boolean(candidate.apiKey),
    importable: Boolean(candidate.apiKey && candidate.baseUrl && candidate.model),
    duplicate: Boolean(duplicate),
    duplicateProviderId: duplicate?.id || null,
    discoveredModels: [...candidate.discoveredModels],
  };
}

function addCandidate(target, input) {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const model = firstString(input.model);
  if (!baseUrl || !model) return;
  const kind = input.kind === "claude" ? "claude" : "relay";
  const protocol = kind === "claude" ? "claude_messages" : protocolFor(input.protocol, "responses");
  const candidate = {
    id: crypto.randomUUID(),
    kind,
    sources: new Set([firstString(input.source, "本机配置")]),
    label: firstString(input.label, kind === "claude" ? "Claude 本机配置" : "本机模型"),
    baseUrl,
    model,
    protocol,
    preset: kind === "claude" ? "claude" : presetFor(baseUrl, input.label),
    apiKey: firstString(input.apiKey),
    discoveredModels: [...new Set((Array.isArray(input.discoveredModels) ? input.discoveredModels : [])
      .map((item) => firstString(item)).filter(Boolean))],
  };
  const signature = candidateSignature(candidate);
  const existing = target.get(signature);
  if (!existing) {
    target.set(signature, candidate);
    return;
  }
  candidate.sources.forEach((source) => existing.sources.add(source));
  if (!existing.apiKey && candidate.apiKey) existing.apiKey = candidate.apiKey;
  existing.discoveredModels = [...new Set([...existing.discoveredModels, ...candidate.discoveredModels])];
}

function addCodexConfigCandidates(target, text, source, environment, apiKey = "", discoveredModels = []) {
  const parsed = parseCodexConfig(text);
  for (const [providerId, provider] of Object.entries(parsed.providers)) {
    const baseUrl = firstString(provider.base_url, provider.baseUrl);
    const model = firstString(provider.model, parsed.topLevel.model);
    const envKey = firstString(provider.env_key, provider.envKey);
    addCandidate(target, {
      kind: "relay",
      source,
      label: firstString(provider.name, providerId, "Codex 模型"),
      baseUrl,
      model,
      protocol: protocolFor(provider.wire_api, "responses"),
      apiKey: firstString(apiKey, environment[envKey]),
      discoveredModels,
    });
  }
}

function addClaudeEnvironmentCandidate(target, env, source) {
  if (!env || typeof env !== "object") return;
  const baseUrl = firstString(env.ANTHROPIC_BASE_URL, "https://api.anthropic.com/v1");
  const model = firstString(
    env.ANTHROPIC_MODEL,
    env.ANTHROPIC_DEFAULT_SONNET_MODEL,
    env.ANTHROPIC_DEFAULT_OPUS_MODEL,
    "claude-sonnet-4-5",
  );
  const apiKey = firstString(env.ANTHROPIC_AUTH_TOKEN, env.ANTHROPIC_API_KEY);
  if (!apiKey && !env.ANTHROPIC_BASE_URL && !env.ANTHROPIC_MODEL) return;
  addCandidate(target, {
    kind: "claude",
    source,
    label: presetFor(baseUrl) === "deepseek" ? "DeepSeek Claude 兼容" : "Claude 本机配置",
    baseUrl,
    model,
    apiKey,
  });
}

function collectClaudeEnvironmentObjects(value, output = [], depth = 0, seen = new Set()) {
  if (!value || typeof value !== "object" || depth > 5 || seen.has(value)) return output;
  seen.add(value);
  if (Object.keys(value).some((key) => key.startsWith("ANTHROPIC_"))) output.push(value);
  for (const child of Object.values(value)) collectClaudeEnvironmentObjects(child, output, depth + 1, seen);
  return output;
}

function addKnownEnvironmentCandidates(target, environment) {
  const definitions = [
    {
      key: "OPENAI_API_KEY", source: "系统环境变量 · OpenAI", label: "OpenAI API",
      baseUrl: firstString(environment.OPENAI_BASE_URL, environment.OPENAI_API_BASE, "https://api.openai.com/v1"),
      model: firstString(environment.OPENAI_MODEL, "gpt-5.4"), protocol: "chat_completions",
    },
    {
      key: "DEEPSEEK_API_KEY", source: "系统环境变量 · DeepSeek", label: "DeepSeek",
      baseUrl: firstString(environment.DEEPSEEK_BASE_URL, "https://api.deepseek.com/v1"),
      model: firstString(environment.DEEPSEEK_MODEL, "deepseek-chat"), protocol: "chat_completions",
    },
    {
      key: "DASHSCOPE_API_KEY", source: "系统环境变量 · Qwen", label: "Qwen / DashScope",
      baseUrl: firstString(environment.DASHSCOPE_BASE_URL, "https://dashscope.aliyuncs.com/compatible-mode/v1"),
      model: firstString(environment.QWEN_MODEL, "qwen-plus"), protocol: "chat_completions",
    },
    {
      key: "OPENROUTER_API_KEY", source: "系统环境变量 · OpenRouter", label: "OpenRouter",
      baseUrl: firstString(environment.OPENROUTER_BASE_URL, "https://openrouter.ai/api/v1"),
      model: firstString(environment.OPENROUTER_MODEL, "openai/gpt-5.4"), protocol: "chat_completions",
    },
    {
      key: "GROQ_API_KEY", source: "系统环境变量 · Groq", label: "Groq",
      baseUrl: firstString(environment.GROQ_BASE_URL, "https://api.groq.com/openai/v1"),
      model: firstString(environment.GROQ_MODEL, "llama-3.3-70b-versatile"), protocol: "chat_completions",
    },
  ];
  for (const definition of definitions) {
    if (!firstString(environment[definition.key])) continue;
    addCandidate(target, { ...definition, apiKey: environment[definition.key] });
  }
  addClaudeEnvironmentCandidate(target, environment, "系统环境变量 · Claude");
}

function createLocalProviderDiscovery(options = {}) {
  const homeDirectory = options.homeDirectory || os.homedir();
  const environment = options.environment || process.env;
  const codexHomes = [...new Set([
    path.join(homeDirectory, ".codex"),
    ...(Array.isArray(options.codexHomes) ? options.codexHomes : []),
  ].filter(Boolean).map((item) => path.resolve(item)))];
  const claudeFiles = options.claudeFiles || [
    path.join(homeDirectory, ".claude", "settings.json"),
    path.join(homeDirectory, ".claude", "settings.local.json"),
    path.join(homeDirectory, ".claude.json"),
  ];
  let candidates = new Map();

  function discover() {
    const collected = new Map();
    const warnings = [];
    const sources = [];
    for (const codexHome of codexHomes) {
      const file = path.join(codexHome, "config.toml");
      const text = safeReadText(file);
      if (text === null) continue;
      const label = path.resolve(codexHome) === path.resolve(path.join(homeDirectory, ".codex"))
        ? "Codex · 用户配置"
        : `Codex · ${path.basename(codexHome)}`;
      addCodexConfigCandidates(collected, text, label, environment);
      sources.push(label);
    }
    for (const file of claudeFiles) {
      const value = safeReadJson(file);
      if (!value) continue;
      const label = `Claude Code · ${path.basename(file)}`;
      collectClaudeEnvironmentObjects(value).forEach((env) => addClaudeEnvironmentCandidate(collected, env, label));
      sources.push(label);
    }
    addKnownEnvironmentCandidates(collected, environment);
    if ([...collected.values()].some((candidate) => [...candidate.sources].some((source) => source.startsWith("系统环境变量")))) {
      sources.push("系统环境变量");
    }
    candidates = new Map([...collected.values()].map((candidate) => [candidate.id, candidate]));
    return {
      candidates: [...candidates.values()].map((candidate) => publicCandidate(candidate, options.providerStore)),
      sources: [...new Set(sources)],
      warnings,
      scannedAt: Date.now(),
    };
  }

  function importCandidate(id, providerStore = options.providerStore) {
    if (!providerStore) throw new Error("ChatSwitch ProviderStore 尚未初始化。");
    const candidate = candidates.get(String(id || ""));
    if (!candidate) throw new Error("该本机配置候选已过期，请重新扫描。");
    const match = providerMatch(candidate, providerStore);
    const duplicate = match?.hasStoredKey ? match : null;
    if (duplicate) return { status: "duplicate", provider: duplicate, candidate: publicCandidate(candidate, providerStore) };
    if (!candidate.apiKey) throw new Error(`“${candidate.label}”没有可导入的 API Key。`);
    let provider;
    if (match) {
      provider = providerStore.saveProviderKey(match.id, candidate.apiKey);
    } else if (candidate.kind === "claude") {
      providerStore.saveProviderKey("claude", candidate.apiKey);
      provider = providerStore.saveClaudeSettings({
        baseUrl: candidate.baseUrl,
        model: candidate.model,
        vendorLabel: candidate.label,
      });
    } else {
      provider = providerStore.addRelay({
        label: candidate.label,
        baseUrl: candidate.baseUrl,
        model: candidate.model,
        protocol: candidate.protocol,
        preset: candidate.preset,
        apiKey: candidate.apiKey,
        discoveredModels: candidate.discoveredModels,
      });
    }
    candidate.apiKey = "";
    return { status: "imported", provider, candidate: publicCandidate(candidate, providerStore) };
  }

  function importCandidates(ids, providerStore = options.providerStore) {
    const requested = [...new Set((Array.isArray(ids) ? ids : []).map((id) => String(id || "")).filter(Boolean))];
    const claudeCount = requested.filter((id) => candidates.get(id)?.kind === "claude").length;
    if (claudeCount > 1) throw new Error("Claude Code 当前只能导入一个配置，请只选择一个 Claude 候选项。");
    return requested.map((id) => {
      try {
        return { id, ...importCandidate(id, providerStore) };
      } catch (error) {
        return { id, status: "error", error: error.message };
      }
    });
  }

  return { discover, importCandidate, importCandidates };
}

module.exports = {
  createLocalProviderDiscovery,
  parseCodexConfig,
  normalizeBaseUrl,
};
