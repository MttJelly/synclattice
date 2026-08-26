const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { safeStorage } = require("electron");
const { CODEX_HOME, BASE_PROVIDERS } = require("./codex-server");

// Keep the legacy directory so existing providers, projects, and hidden-thread state remain available.
const STORE_ROOT = process.env.CHATSWITCH_STORE_ROOT || path.join(CODEX_HOME, "chatswitch");
const METADATA_FILE = path.join(STORE_ROOT, "providers.json");
const SECRETS_FILE = path.join(STORE_ROOT, "credentials.json");
const CONFIG_SCHEMA = "chatswitch-config";
const LEGACY_CONFIG_SCHEMAS = new Set([CONFIG_SCHEMA, "share-master-config"]);
const BACKUP_SCHEMA = "chatswitch-backup";
const LEGACY_BACKUP_SCHEMAS = new Set([BACKUP_SCHEMA, "share-master-backup"]);
const SYNC_FILE_NAME = "chatswitch-sync.json";
const LEGACY_SYNC_FILE_NAME = "share-master-sync.json";
const ISOLATED_STORE = Boolean(process.env.CHATSWITCH_STORE_ROOT);
const DEFAULT_CONVERSATION_HOME = ISOLATED_STORE
  ? path.join(STORE_ROOT, "conversations")
  : CODEX_HOME;

function seedOfficialCredentials(sourceHome = path.join(os.homedir(), ".codex"), targetHome = CODEX_HOME) {
  const source = path.join(sourceHome, "auth.json");
  const target = path.join(targetHome, "auth.json");
  if (fs.existsSync(target) || !fs.existsSync(source)) return false;
  fs.mkdirSync(targetHome, { recursive: true });
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  return true;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw new Error(`无法读取 ChatSwitch 配置 ${file}：${error.message}`);
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, file);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function configurationHash(bundle) {
  const comparable = structuredClone(bundle || {});
  delete comparable.exportedAt;
  return crypto.createHash("sha256").update(stableJson(comparable)).digest("hex");
}

function cleanId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

function cleanProjectLabel(value) {
  const label = String(value || "").trim().replace(/\s+/g, " ");
  if (!label) throw new Error("Project 名称不能为空。");
  if (label.length > 100) throw new Error("Project 名称不能超过 100 个字符。");
  return label;
}

function projectLabelKey(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLocaleLowerCase("zh-CN");
}

function cleanQueuedMessage(input) {
  if (!input || typeof input !== "object") return null;
  const text = String(input.text || "").slice(0, 20000);
  const displayText = String(input.displayText || text).slice(0, 20000);
  const imageInputs = (Array.isArray(input.imageInputs) ? input.imageInputs : [])
    .slice(0, 20)
    .map((image) => ({ path: String(image?.path || "").slice(0, 2000), detail: "auto" }))
    .filter((image) => image.path);
  if (!text.trim() && !imageInputs.length) return null;
  return {
    text,
    displayText,
    imageInputs,
    skillInputs: (Array.isArray(input.skillInputs) ? input.skillInputs : [])
      .slice(0, 20)
      .map((skill) => ({
        name: String(skill?.name || "").slice(0, 100),
        path: String(skill?.path || "").slice(0, 2000),
      }))
      .filter((skill) => skill.name && skill.path),
    cwd: String(input.cwd || "").slice(0, 2000),
    clientUserMessageId: String(input.clientUserMessageId || "").slice(0, 100),
    providerId: String(input.providerId || "").slice(0, 160) || null,
    model: String(input.model || "").slice(0, 160) || null,
    effort: String(input.effort || "").slice(0, 32) || null,
    approvalMode: ["ask", "auto", "full"].includes(input.approvalMode) ? input.approvalMode : "ask",
    queuedAt: Number(input.queuedAt) || Date.now(),
  };
}

function cleanMessageQueues(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).slice(0, 100).flatMap(([threadId, messages]) => {
    const id = String(threadId || "").trim().slice(0, 200);
    if (!id || !Array.isArray(messages)) return [];
    const cleaned = messages.slice(0, 50).map(cleanQueuedMessage).filter(Boolean);
    return cleaned.length ? [[id, cleaned]] : [];
  }));
}

function claudeVendorLabel(baseUrl) {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    if (hostname === "ai.hexuan.cc") return "Hexuan";
    if (hostname === "api.anthropic.com") return "Anthropic 官方";
    return hostname;
  } catch {
    return "Claude 中转";
  }
}

function providerBrand(provider) {
  return provider.type === "claude" || provider.engine === "claude" ? "claude" : "openai";
}

function providerApiKey(provider = {}, environment = {}) {
  const keyName = provider.envKey;
  if (keyName) return provider.env?.[keyName] || environment[keyName] || provider.apiKey || null;
  return provider.apiKey || Object.values(provider.env || {})[0] || null;
}

const PROVIDER_PRESETS = {
  openai: {
    label: "OpenAI API",
    group: "官方模型",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5.4",
    protocol: "chat_completions",
    note: "OpenAI 官方 Chat Completions 接口。",
  },
  deepseek: {
    label: "DeepSeek",
    group: "国内模型",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    protocol: "chat_completions",
    note: "直接调用 DeepSeek；支持流式回复、中断和共享本地会话。",
  },
  qwen: {
    label: "Qwen / DashScope",
    group: "国内模型",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
    protocol: "chat_completions",
    note: "通过 DashScope 的 OpenAI 兼容接口调用 Qwen。",
  },
  openrouter: {
    label: "OpenRouter",
    group: "模型聚合",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openai/gpt-5.4",
    protocol: "chat_completions",
    note: "通过 OpenRouter 统一访问多个模型厂商。",
  },
  groq: {
    label: "Groq",
    group: "海外模型",
    baseUrl: "https://api.groq.com/openai/v1",
    model: "llama-3.3-70b-versatile",
    protocol: "chat_completions",
    note: "Groq 的 OpenAI 兼容推理接口。",
  },
  mistral: {
    label: "Mistral AI",
    group: "海外模型",
    baseUrl: "https://api.mistral.ai/v1",
    model: "mistral-large-latest",
    protocol: "chat_completions",
    note: "Mistral AI 官方兼容接口。",
  },
  xai: {
    label: "xAI",
    group: "海外模型",
    baseUrl: "https://api.x.ai/v1",
    model: "grok-4",
    protocol: "chat_completions",
    note: "xAI Grok 官方兼容接口。",
  },
  kimi: {
    label: "Kimi / Moonshot",
    group: "国内模型",
    baseUrl: "https://api.moonshot.cn/v1",
    model: "kimi-k2.5",
    protocol: "chat_completions",
    note: "Moonshot Kimi 的 OpenAI 兼容接口。",
  },
  zhipu: {
    label: "智谱 GLM",
    group: "国内模型",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-4.5",
    protocol: "chat_completions",
    note: "智谱 BigModel 的 OpenAI 兼容接口。",
  },
  siliconflow: {
    label: "SiliconFlow",
    group: "模型聚合",
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "deepseek-ai/DeepSeek-V3",
    protocol: "chat_completions",
    note: "SiliconFlow 多模型兼容接口。",
  },
  together: {
    label: "Together AI",
    group: "模型聚合",
    baseUrl: "https://api.together.xyz/v1",
    model: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    protocol: "chat_completions",
    note: "Together AI 多模型兼容接口。",
  },
  fireworks: {
    label: "Fireworks AI",
    group: "模型聚合",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    model: "accounts/fireworks/models/llama-v3p3-70b-instruct",
    protocol: "chat_completions",
    note: "Fireworks AI 推理接口。",
  },
  gemini: {
    label: "Google Gemini",
    group: "官方模型",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-2.5-pro",
    protocol: "chat_completions",
    note: "Google Gemini 的 OpenAI 兼容接口。",
  },
  minimax: {
    label: "MiniMax",
    group: "国内模型",
    baseUrl: "https://api.minimax.io/v1",
    model: "MiniMax-M2.1",
    protocol: "chat_completions",
    note: "MiniMax 的 OpenAI 兼容接口。",
  },
  volcengine: {
    label: "火山方舟 Ark",
    group: "国内模型",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    model: "doubao-seed-1-6-250615",
    protocol: "chat_completions",
    note: "火山引擎方舟 OpenAI 兼容接口；默认模型可替换为推理接入点 ID。",
  },
  hunyuan: {
    label: "腾讯混元",
    group: "国内模型",
    baseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
    model: "hunyuan-turbos-latest",
    protocol: "chat_completions",
    note: "腾讯混元 OpenAI 兼容接口。",
  },
  baichuan: {
    label: "百川智能",
    group: "国内模型",
    baseUrl: "https://api.baichuan-ai.com/v1",
    model: "Baichuan4",
    protocol: "chat_completions",
    note: "百川智能 OpenAI 兼容接口。",
  },
  stepfun: {
    label: "阶跃星辰 StepFun",
    group: "国内模型",
    baseUrl: "https://api.stepfun.com/v1",
    model: "step-2-16k",
    protocol: "chat_completions",
    note: "阶跃星辰 OpenAI 兼容接口。",
  },
  lingyi: {
    label: "零一万物 Yi",
    group: "国内模型",
    baseUrl: "https://api.lingyiwanwu.com/v1",
    model: "yi-large",
    protocol: "chat_completions",
    note: "零一万物 Yi OpenAI 兼容接口。",
  },
  modelscope: {
    label: "ModelScope 魔搭",
    group: "模型聚合",
    baseUrl: "https://api-inference.modelscope.cn/v1",
    model: "Qwen/Qwen3-235B-A22B",
    protocol: "chat_completions",
    note: "ModelScope Inference OpenAI 兼容接口。",
  },
  nvidia: {
    label: "NVIDIA NIM",
    group: "模型聚合",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    model: "meta/llama-3.3-70b-instruct",
    protocol: "chat_completions",
    note: "NVIDIA NIM 多模型推理接口。",
  },
  cerebras: {
    label: "Cerebras",
    group: "海外模型",
    baseUrl: "https://api.cerebras.ai/v1",
    model: "llama-3.3-70b",
    protocol: "chat_completions",
    note: "Cerebras 高速 OpenAI 兼容推理接口。",
  },
  sambanova: {
    label: "SambaNova",
    group: "海外模型",
    baseUrl: "https://api.sambanova.ai/v1",
    model: "Meta-Llama-3.3-70B-Instruct",
    protocol: "chat_completions",
    note: "SambaNova Cloud OpenAI 兼容接口。",
  },
  perplexity: {
    label: "Perplexity",
    group: "海外模型",
    baseUrl: "https://api.perplexity.ai",
    model: "sonar-pro",
    protocol: "chat_completions",
    note: "Perplexity Sonar 搜索增强接口。",
  },
  huggingface: {
    label: "Hugging Face Router",
    group: "模型聚合",
    baseUrl: "https://router.huggingface.co/v1",
    model: "openai/gpt-oss-120b",
    protocol: "chat_completions",
    note: "Hugging Face Inference Providers 的 OpenAI 兼容入口。",
  },
  novita: {
    label: "Novita AI",
    group: "模型聚合",
    baseUrl: "https://api.novita.ai/v3/openai",
    model: "deepseek/deepseek-v3-0324",
    protocol: "chat_completions",
    note: "Novita AI 多模型 OpenAI 兼容接口。",
  },
  kimi_coding: {
    label: "Kimi For Coding",
    group: "Coding 网关",
    baseUrl: "https://api.kimi.com/coding/v1",
    model: "kimi-for-coding",
    protocol: "chat_completions",
    note: "Kimi Coding 套餐接口；请使用对应套餐密钥。",
  },
  volcengine_coding: {
    label: "火山方舟 Coding Plan",
    group: "Coding 网关",
    baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
    model: "ark-code-latest",
    protocol: "responses",
    note: "火山方舟 Coding Plan 专用 Responses 端点，与按量端点分开计费。",
  },
  byteplus_coding: {
    label: "BytePlus ModelArk Coding",
    group: "Coding 网关",
    baseUrl: "https://ark.ap-southeast.bytepluses.com/api/coding/v3",
    model: "ark-code-latest",
    protocol: "chat_completions",
    note: "BytePlus ModelArk Coding 兼容入口；使用前请核验区域和套餐。",
  },
  packycode: {
    label: "PackyCode",
    group: "Coding 网关",
    baseUrl: "https://www.packyapi.ai/v1",
    model: "gpt-5.6-sol",
    protocol: "responses",
    note: "第三方 Codex 兼容网关；使用前请自行核验服务与计费。",
  },
  zetaapi: {
    label: "ZetaAPI",
    group: "Coding 网关",
    baseUrl: "https://api.zetaapi.ai/v1",
    model: "gpt-5.6-sol",
    protocol: "responses",
    note: "第三方 Codex 兼容网关；使用前请自行核验服务与计费。",
  },
  apinebula: {
    label: "APINebula",
    group: "Coding 网关",
    baseUrl: "https://apinebula.ai/v1",
    model: "gpt-5.6-sol",
    protocol: "responses",
    note: "第三方 Responses 兼容网关；使用前请自行核验服务与计费。",
  },
  pateway: {
    label: "PatewayAI",
    group: "Coding 网关",
    baseUrl: "https://api.pateway.ai/v1",
    model: "gpt-5.6-sol",
    protocol: "responses",
    note: "第三方 Codex 兼容网关；使用前请自行核验服务与计费。",
  },
  fenno: {
    label: "FennoAI",
    group: "Coding 网关",
    baseUrl: "https://api.fenno.ai",
    model: "gpt-5.6-sol",
    protocol: "responses",
    note: "第三方 Codex 兼容网关；使用前请自行核验服务与计费。",
  },
  runapi: {
    label: "RunAPI",
    group: "Coding 网关",
    baseUrl: "https://runapi.co/v1",
    model: "gpt-5.6-sol",
    protocol: "responses",
    note: "第三方多模型网关；使用前请自行核验服务与计费。",
  },
  shengsuanyun: {
    label: "胜算云",
    group: "Coding 网关",
    baseUrl: "https://router.shengsuanyun.com/api/v1",
    model: "openai/gpt-5.6-sol",
    protocol: "responses",
    note: "第三方多模型网关；使用前请自行核验服务与计费。",
  },
  aigocode: {
    label: "AIGoCode",
    group: "Coding 网关",
    baseUrl: "https://api.aigocode.app",
    model: "gpt-5.6-sol",
    protocol: "responses",
    note: "第三方 Codex 兼容网关；使用前请自行核验服务与计费。",
  },
  aicoding: {
    label: "AICoding",
    group: "Coding 网关",
    baseUrl: "https://api.aicoding.inc",
    model: "gpt-5.6-sol",
    protocol: "responses",
    note: "第三方 Codex 兼容网关；使用前请自行核验服务与计费。",
  },
  subrouter: {
    label: "SubRouter",
    group: "Coding 网关",
    baseUrl: "https://subrouter.ai/v1",
    model: "gpt-5.6-sol",
    protocol: "responses",
    note: "第三方模型路由服务；使用前请自行核验服务与计费。",
  },
  apikeyfun: {
    label: "APIKEY.FUN",
    group: "Coding 网关",
    baseUrl: "https://api.apikey.fun/v1",
    model: "gpt-5.6-sol",
    protocol: "responses",
    note: "第三方 Responses 兼容网关；使用前请自行核验服务与计费。",
  },
  code0: {
    label: "Code0",
    group: "Coding 网关",
    baseUrl: "https://code0.ai/v1",
    model: "gpt-5.6-sol",
    protocol: "responses",
    note: "第三方 Codex 兼容网关；使用前请自行核验服务与计费。",
  },
  teamorouter: {
    label: "TeamoRouter",
    group: "Coding 网关",
    baseUrl: "https://api.teamorouter.com/v1",
    model: "gpt-5.6-sol",
    protocol: "responses",
    note: "第三方模型路由服务；使用前请自行核验服务与计费。",
  },
  claudecn: {
    label: "ClaudeCN",
    group: "Coding 网关",
    baseUrl: "https://claudecn.top/v1",
    model: "gpt-5.6-sol",
    protocol: "responses",
    note: "第三方 Codex 兼容网关；使用前请自行核验服务与计费。",
  },
  crazyrouter: {
    label: "CrazyRouter",
    group: "Coding 网关",
    baseUrl: "https://cn.crazyrouter.com/v1",
    model: "gpt-5.6-sol",
    protocol: "responses",
    note: "第三方模型路由服务；使用前请自行核验服务与计费。",
  },
  dmxapi: {
    label: "DMXAPI",
    group: "Coding 网关",
    baseUrl: "https://www.dmxapi.cn/v1",
    model: "gpt-5.6-sol",
    protocol: "responses",
    note: "第三方多模型网关；使用前请自行核验服务与计费。",
  },
  aihubmix: {
    label: "AiHubMix",
    group: "Coding 网关",
    baseUrl: "https://aihubmix.com/v1",
    model: "gpt-5.6-sol",
    protocol: "responses",
    note: "第三方多模型网关；使用前请自行核验服务与计费。",
  },
  therouter: {
    label: "TheRouter",
    group: "Coding 网关",
    baseUrl: "https://api.therouter.ai/v1",
    model: "openai/gpt-5.3-codex",
    protocol: "responses",
    note: "第三方模型路由服务；使用前请自行核验服务与计费。",
  },
  ollama: {
    label: "Ollama 本地",
    group: "本地模型",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "qwen3:8b",
    protocol: "chat_completions",
    note: "连接本机 Ollama；API Key 可填写任意非空占位值。",
  },
  lmstudio: {
    label: "LM Studio 本地",
    group: "本地模型",
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "local-model",
    protocol: "chat_completions",
    note: "连接本机 LM Studio；模型名称以本地服务实际列表为准。",
  },
  custom: {
    label: "自定义模型供应商",
    group: "高级连接",
    baseUrl: "",
    model: "",
    protocol: "chat_completions",
    note: "适用于提供 /chat/completions 的 OpenAI 兼容服务。",
  },
  responses: {
    label: "Codex Responses 中转",
    group: "高级连接",
    baseUrl: "",
    model: "",
    protocol: "responses",
    note: "适用于完整支持 Responses API 的中转；由 Codex 代理执行本地工具和 Skills。",
  },
};

function providerPresetCatalog() {
  return Object.entries(PROVIDER_PRESETS).map(([id, preset]) => ({ id, ...preset }));
}

const SCHEDULE_REPEATS = new Set(["once", "hourly", "daily", "weekdays", "weekly", "monthly"]);

function nextScheduledAt(scheduledAt, repeat, now = Date.now(), anchorDay = null) {
  const mode = SCHEDULE_REPEATS.has(repeat) ? repeat : "once";
  if (mode === "once") return null;
  const next = new Date(Number(scheduledAt));
  if (!Number.isFinite(next.getTime())) return null;
  const advance = () => {
    if (mode === "hourly") next.setHours(next.getHours() + 1);
    else if (mode === "daily") next.setDate(next.getDate() + 1);
    else if (mode === "weekdays") {
      do next.setDate(next.getDate() + 1);
      while ([0, 6].includes(next.getDay()));
    } else if (mode === "weekly") next.setDate(next.getDate() + 7);
    else if (mode === "monthly") {
      const day = Math.max(1, Math.min(31, Number(anchorDay) || next.getDate()));
      next.setDate(1);
      next.setMonth(next.getMonth() + 1);
      const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
      next.setDate(Math.min(day, lastDay));
    }
  };
  do advance();
  while (next.getTime() <= now);
  return next.getTime();
}

function providerConnectionLabel(provider) {
  if (providerBrand(provider) === "claude") return provider.vendorLabel || claudeVendorLabel(provider.baseUrl);
  if (provider.id === "official") return "OpenAI 官方";
  if (provider.id === "niubi") return "Niubi";
  if (provider.id === "hexuan") return "Hexuan";
  return provider.label;
}

const OFFICIAL_REASONING_PROFILES = {
  "gpt-5.6-sol": { defaultEffort: "low", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
  "gpt-5.6-terra": { defaultEffort: "medium", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
  "gpt-5.6-luna": { defaultEffort: "medium", efforts: ["low", "medium", "high", "xhigh", "max"] },
  "gpt-5.5": { defaultEffort: "medium", efforts: ["low", "medium", "high", "xhigh"] },
  "gpt-5.4": { defaultEffort: "medium", efforts: ["low", "medium", "high", "xhigh"] },
  "gpt-5.4-mini": { defaultEffort: "medium", efforts: ["low", "medium", "high", "xhigh"] },
};

function reasoningProfile(model) {
  const profile = OFFICIAL_REASONING_PROFILES[String(model || "").trim()] || null;
  return profile ? { defaultEffort: profile.defaultEffort, efforts: [...profile.efforts] } : null;
}

function providerModelCatalog(id, model, availableModels = [model]) {
  const source = readJson(path.join(__dirname, "model-catalog.json"), { models: [] });
  if (!source.models?.length) throw new Error("ChatSwitch 模型目录不可用。");
  const catalog = structuredClone(source);
  const models = [...new Set([model, ...availableModels].map((item) => String(item || "").trim()).filter(Boolean))];
  catalog.models = models.map((slug, index) => {
    const profile = reasoningProfile(slug);
    const supported = profile
      ? catalog.models[0].supported_reasoning_levels.filter((item) => profile.efforts.includes(item.effort))
      : catalog.models[0].supported_reasoning_levels;
    return {
      ...catalog.models[0],
      slug,
      display_name: slug,
      description: `Model reported by ${id}.`,
      default_reasoning_level: profile?.defaultEffort || catalog.models[0].default_reasoning_level,
      supported_reasoning_levels: supported,
      priority: index + 1,
    };
  });
  const file = path.join(STORE_ROOT, "model-catalogs", `${id}.json`);
  writeJson(file, catalog);
  return file;
}

function ensureJunction(link, target) {
  fs.mkdirSync(target, { recursive: true });
  if (fs.existsSync(link)) {
    const existing = fs.lstatSync(link);
    if (!existing.isSymbolicLink()) return;
    if (fs.realpathSync(link).toLowerCase() === fs.realpathSync(target).toLowerCase()) return;
    fs.unlinkSync(link);
  }
  fs.symlinkSync(target, link, "junction");
}

class ProviderStore {
  constructor() {
    fs.mkdirSync(STORE_ROOT, { recursive: true });
    fs.mkdirSync(DEFAULT_CONVERSATION_HOME, { recursive: true });
    // Development builds retain the legacy migration path; packaged installs
    // must never copy credentials from an external Codex profile on first run.
    if (!ISOLATED_STORE && process.env.CHATSWITCH_PACKAGED !== "1") seedOfficialCredentials();
    const metadata = this.metadata();
    let changed = false;
    if (ISOLATED_STORE && metadata.conversationHome.toLowerCase() === CODEX_HOME.toLowerCase()) {
      metadata.conversationHome = DEFAULT_CONVERSATION_HOME;
      changed = true;
    }
    if ((metadata.deletionMigrationVersion || 0) < 2) {
      const queued = new Set(metadata.pendingDeletions.map((entry) => entry.threadId));
      const now = Date.now();
      for (const threadId of metadata.hiddenThreads) {
        if (metadata.deletedThreads.includes(threadId) || queued.has(threadId)) continue;
        metadata.pendingDeletions.push({
          threadId,
          engine: "codex",
          providerId: null,
          scheduledAt: now - 60 * 60 * 1000,
          expiresAt: now,
        });
      }
      metadata.deletionMigrationVersion = 2;
      changed = true;
    }
    const recoveredAt = Date.now();
    const legacyLifecycle = metadata.turnLifecycleMigrationVersion < 1;
    for (const timeline of Object.values(metadata.threadTimeline)) {
      if (!Array.isArray(timeline)) continue;
      for (const entry of timeline) {
        if (entry?.status !== "inProgress") continue;
        entry.status = legacyLifecycle ? "stale" : "interrupted";
        entry.updatedAt = recoveredAt;
        if (legacyLifecycle) {
          delete entry.recoveredAt;
          delete entry.interruptionReason;
        } else {
          entry.recoveredAt = recoveredAt;
          entry.interruptionReason = "app-restarted";
        }
        changed = true;
      }
    }
    if (legacyLifecycle) {
      metadata.turnLifecycleMigrationVersion = 1;
      changed = true;
    }
    if (changed) {
      writeJson(METADATA_FILE, metadata);
    }
  }

  metadata() {
    const value = readJson(METADATA_FILE, {});
    return {
      relays: Array.isArray(value.relays) ? value.relays : [],
      accounts: Array.isArray(value.accounts) ? value.accounts : [],
      projects: Array.isArray(value.projects) ? value.projects : [],
      projectThreads: value.projectThreads && typeof value.projectThreads === "object"
        ? value.projectThreads
        : {},
      hiddenProjectRoots: Array.isArray(value.hiddenProjectRoots) ? value.hiddenProjectRoots : [],
      threadSettings: value.threadSettings && typeof value.threadSettings === "object"
        ? value.threadSettings
        : {},
      threadAliases: value.threadAliases && typeof value.threadAliases === "object"
        ? value.threadAliases
        : {},
      threadDecorations: value.threadDecorations && typeof value.threadDecorations === "object"
        ? value.threadDecorations
        : {},
      threadBranches: value.threadBranches && typeof value.threadBranches === "object"
        ? value.threadBranches
        : {},
      threadTimeline: value.threadTimeline && typeof value.threadTimeline === "object"
        ? value.threadTimeline
        : {},
      requestLogs: Array.isArray(value.requestLogs) ? value.requestLogs : [],
      modelPricing: value.modelPricing && typeof value.modelPricing === "object"
        ? value.modelPricing
        : {},
      providerRoutes: value.providerRoutes && typeof value.providerRoutes === "object"
        ? value.providerRoutes
        : {},
      providerOrder: Array.isArray(value.providerOrder) ? value.providerOrder : [],
      hiddenThreads: Array.isArray(value.hiddenThreads) ? value.hiddenThreads : [],
      deletedThreads: Array.isArray(value.deletedThreads) ? value.deletedThreads : [],
      localArchivedThreads: Array.isArray(value.localArchivedThreads) ? value.localArchivedThreads : [],
      pendingDeletions: Array.isArray(value.pendingDeletions) ? value.pendingDeletions : [],
      deletionMigrationVersion: Number(value.deletionMigrationVersion) || 0,
      turnLifecycleMigrationVersion: Number(value.turnLifecycleMigrationVersion) || 0,
      scheduledTasks: Array.isArray(value.scheduledTasks) ? value.scheduledTasks : [],
      messageQueues: cleanMessageQueues(value.messageQueues),
      disabledSkills: Array.isArray(value.disabledSkills) ? value.disabledSkills : [],
      promptTemplates: Array.isArray(value.promptTemplates) ? value.promptTemplates : [],
      mcpServers: Array.isArray(value.mcpServers) ? value.mcpServers : [],
      syncSettings: value.syncSettings && typeof value.syncSettings === "object"
        ? value.syncSettings
        : { backend: "directory", directory: null, webdavUrl: null, autoSync: false, lastSyncedHash: null, lastSyncedAt: null },
      syncHistory: Array.isArray(value.syncHistory) ? value.syncHistory.slice(0, 50) : [],
      appSettings: value.appSettings && typeof value.appSettings === "object"
        ? value.appSettings
        : { closeToTray: true },
      conversationHome: typeof value.conversationHome === "string" && value.conversationHome
        ? value.conversationHome
        : DEFAULT_CONVERSATION_HOME,
      conversationMirrorSource: typeof value.conversationMirrorSource === "string" && value.conversationMirrorSource
        ? value.conversationMirrorSource
        : null,
      providerSettings: value.providerSettings && typeof value.providerSettings === "object"
        ? value.providerSettings
        : {},
    };
  }

  list() {
    const metadata = this.metadata();
    const secrets = readJson(SECRETS_FILE, {});
    const configuredBuiltin = (id) => (id === "official"
      ? Boolean(secrets[`builtin:${id}`]) || metadata.providerOrder.includes(id)
        || (fs.existsSync(METADATA_FILE) && fs.existsSync(path.join(CODEX_HOME, "auth.json")))
        || process.env.CHATSWITCH_QA === "1"
      : Boolean(secrets[`builtin:${id}`]) || process.env.CHATSWITCH_QA === "1")
      || metadata.providerOrder.includes(id)
      || (id === "claude" && Boolean(metadata.providerSettings.claude));
    const builtins = Object.values(BASE_PROVIDERS)
      // A fresh install has no configured connections. The login action remains
      // available in the dialog, while provider rows appear only after setup.
      .filter((item) => configuredBuiltin(item.id))
      .map((item) => {
      if (item.id !== "claude" && !["niubi", "hexuan"].includes(item.id)) return item;
      const provider = { ...item, ...(metadata.providerSettings[item.id] || {}) };
      if (item.id === "claude") {
      provider.vendorLabel ||= claudeVendorLabel(provider.baseUrl);
      }
      return provider;
      });
    const providers = [
      ...builtins,
      ...metadata.relays.map((item) => ({
        ...item,
        type: "relay",
        modelProvider: item.id,
        envKey: "CHATSWITCH_RELAY_API_KEY",
      })),
      ...metadata.accounts.map((item) => ({ ...item, type: "account", modelProvider: "openai" })),
    ];
    const order = new Map(metadata.providerOrder.map((id, index) => [id, index]));
    providers.sort((left, right) => {
      const leftIndex = order.has(left.id) ? order.get(left.id) : Number.MAX_SAFE_INTEGER;
      const rightIndex = order.has(right.id) ? order.get(right.id) : Number.MAX_SAFE_INTEGER;
      return leftIndex - rightIndex;
    });
    return providers.map((provider) => ({
      id: provider.id,
      label: provider.label,
      connectionLabel: providerConnectionLabel(provider),
      brand: providerBrand(provider),
      vendorLabel: provider.vendorLabel,
      type: provider.type,
      engine: provider.engine,
      modelProvider: provider.modelProvider,
      baseUrl: provider.baseUrl,
      model: provider.model,
      protocol: provider.protocol || (provider.engine === "openai-compatible" ? "chat_completions" : "responses"),
      preset: provider.preset || null,
      discoveredModels: Array.isArray(provider.discoveredModels) ? [...provider.discoveredModels] : [],
      envKey: provider.envKey,
      balanceType: provider.balanceType,
      deletable: ["relay", "account"].includes(provider.type),
      keyConfigurable: ["niubi", "hexuan", "claude"].includes(provider.id) || provider.type === "relay",
      modelConfigurable: provider.id === "claude",
      authMode: provider.id === "claude" ? (provider.authMode || "token") : null,
      hasStoredKey: provider.type === "relay"
        ? Boolean(this.decryptRelayKey(provider.id))
        : Boolean(this.decryptStoredProviderKey(provider.id)),
    }));
  }

  reorderProviders(providerIds = []) {
    const metadata = this.metadata();
    const valid = new Set([
      ...Object.keys(BASE_PROVIDERS),
      ...metadata.relays.map((item) => item.id),
      ...metadata.accounts.map((item) => item.id),
    ]);
    const ordered = [];
    for (const value of Array.isArray(providerIds) ? providerIds : []) {
      const id = String(value || "").trim();
      if (valid.has(id) && !ordered.includes(id)) ordered.push(id);
    }
    for (const id of valid) if (!ordered.includes(id)) ordered.push(id);
    metadata.providerOrder = ordered;
    writeJson(METADATA_FILE, metadata);
    return this.list();
  }

  publicProvider(id) {
    const provider = this.list().find((item) => item.id === id);
    if (!provider) throw new Error(`Unknown provider: ${id}`);
    return provider;
  }

  markOfficialConfigured() {
    const metadata = this.metadata();
    if (!metadata.providerOrder.includes("official")) {
      metadata.providerOrder.unshift("official");
      writeJson(METADATA_FILE, metadata);
    }
    return this.publicProvider("official");
  }

  listProjects() {
    return this.metadata().projects.map(({ id, label, root, createdAt }) => ({
      id,
      label,
      root: typeof root === "string" && root ? root : null,
      createdAt,
    }));
  }

  projectThreads() {
    return { ...this.metadata().projectThreads };
  }

  hiddenProjectRoots() {
    return [...this.metadata().hiddenProjectRoots];
  }

  hiddenThreads() {
    return [...this.metadata().hiddenThreads];
  }

  threadSettings() {
    return { ...this.metadata().threadSettings };
  }

  threadAliases() {
    return { ...this.metadata().threadAliases };
  }

  threadDecorations() {
    return structuredClone(this.metadata().threadDecorations);
  }

  setThreadDecoration(threadId, input = {}) {
    const id = String(threadId || "").trim();
    if (!id) throw new Error("无效的会话 ID。");
    const metadata = this.metadata();
    const previous = metadata.threadDecorations[id] || {};
    const tags = Array.isArray(input.tags)
      ? [...new Set(input.tags.map((tag) => String(tag || "").trim().slice(0, 40)).filter(Boolean))].slice(0, 20)
      : previous.tags || [];
    const next = {
      pinned: input.pinned === undefined ? Boolean(previous.pinned) : Boolean(input.pinned),
      favorite: input.favorite === undefined ? Boolean(previous.favorite) : Boolean(input.favorite),
      tags,
      updatedAt: Date.now(),
    };
    if (!next.pinned && !next.favorite && !next.tags.length) delete metadata.threadDecorations[id];
    else metadata.threadDecorations[id] = next;
    writeJson(METADATA_FILE, metadata);
    return structuredClone(metadata.threadDecorations);
  }

  threadBranches() {
    return structuredClone(this.metadata().threadBranches);
  }

  threadTimeline(logicalThreadId) {
    const logicalId = String(logicalThreadId || "").trim();
    const timeline = this.metadata().threadTimeline[logicalId];
    return Array.isArray(timeline) ? timeline.map((entry) => ({ ...entry })) : [];
  }

  messageQueues() {
    return structuredClone(this.metadata().messageQueues);
  }

  claimMessageQueue(threadId, expectedClientUserMessageId = null) {
    const id = String(threadId || "").trim().slice(0, 200);
    if (!id) throw new Error("无效的会话 ID。");
    const expectedId = String(expectedClientUserMessageId || "").trim().slice(0, 100);
    const metadata = this.metadata();
    const queue = metadata.messageQueues[id] || [];
    const message = queue[0] || null;
    if (!message || (expectedId && message.clientUserMessageId !== expectedId)) {
      return { message: null, messages: queue.map((item) => ({ ...item })) };
    }
    queue.shift();
    if (queue.length) metadata.messageQueues[id] = queue;
    else delete metadata.messageQueues[id];
    writeJson(METADATA_FILE, metadata);
    return { message: { ...message }, messages: queue.map((item) => ({ ...item })) };
  }

  restoreClaimedMessage(threadId, message) {
    const id = String(threadId || "").trim().slice(0, 200);
    if (!id) throw new Error("无效的会话 ID。");
    const restored = cleanQueuedMessage(message);
    if (!restored) throw new Error("无法恢复无效的队列消息。");
    const metadata = this.metadata();
    const queue = metadata.messageQueues[id] || [];
    if (!queue.some((item) => item.clientUserMessageId === restored.clientUserMessageId)) queue.unshift(restored);
    metadata.messageQueues[id] = queue.slice(0, 50);
    writeJson(METADATA_FILE, metadata);
    return metadata.messageQueues[id].map((item) => ({ ...item }));
  }

  saveMessageQueue(threadId, messages) {
    const id = String(threadId || "").trim().slice(0, 200);
    if (!id) throw new Error("无效的会话 ID。");
    const metadata = this.metadata();
    const cleaned = (Array.isArray(messages) ? messages : []).slice(0, 50).map(cleanQueuedMessage).filter(Boolean);
    if (cleaned.length) metadata.messageQueues[id] = cleaned;
    else delete metadata.messageQueues[id];
    writeJson(METADATA_FILE, metadata);
    return cleaned.map((item) => ({ ...item }));
  }

  threadBranch(logicalThreadId, providerId) {
    const logicalId = String(logicalThreadId || "").trim();
    const targetProvider = String(providerId || "").trim();
    const branch = this.metadata().threadBranches[logicalId]?.[targetProvider];
    return branch ? { ...branch } : null;
  }

  logicalThreadIdForBranch(providerId, branchThreadId) {
    const targetProvider = String(providerId || "").trim();
    const branchId = String(branchThreadId || "").trim();
    for (const [logicalId, providers] of Object.entries(this.metadata().threadBranches)) {
      if (providers?.[targetProvider]?.threadId === branchId) return logicalId;
    }
    return null;
  }

  logicalThreadIdForAnyBranch(branchThreadId) {
    const branchId = String(branchThreadId || "").trim();
    if (!branchId) return null;
    for (const [logicalId, providers] of Object.entries(this.metadata().threadBranches)) {
      if (Object.values(providers || {}).some((branch) => branch?.threadId === branchId)) return logicalId;
    }
    return null;
  }

  branchThreadIds() {
    const ids = [];
    for (const providers of Object.values(this.metadata().threadBranches)) {
      for (const branch of Object.values(providers || {})) {
        if (branch?.threadId) ids.push(branch.threadId);
      }
    }
    return [...new Set(ids)];
  }

  saveThreadBranch(logicalThreadId, providerId, branchThreadId, input = {}) {
    const logicalId = String(logicalThreadId || "").trim();
    const targetProvider = String(providerId || "").trim();
    const branchId = String(branchThreadId || "").trim();
    if (!logicalId || !targetProvider || !branchId) throw new Error("跨模型会话分支参数无效。");
    const metadata = this.metadata();
    metadata.threadBranches[logicalId] ||= {};
    metadata.threadBranches[logicalId][targetProvider] = {
      threadId: branchId,
      engine: String(input.engine || "").trim() || null,
      sourceEngine: String(input.sourceEngine || "").trim() || null,
      firstUserText: typeof input.firstUserText === "string" ? input.firstUserText.slice(0, 100000) : null,
      firstClientUserMessageId: String(input.firstClientUserMessageId || "").trim() || null,
      seeded: Boolean(input.seeded),
      createdAt: Number(input.createdAt) || Date.now(),
      updatedAt: Date.now(),
    };
    writeJson(METADATA_FILE, metadata);
    return { ...metadata.threadBranches[logicalId][targetProvider] };
  }

  touchThreadBranch(logicalThreadId, providerId, now = Date.now()) {
    const logicalId = String(logicalThreadId || "").trim();
    const targetProvider = String(providerId || "").trim();
    const metadata = this.metadata();
    const branch = metadata.threadBranches[logicalId]?.[targetProvider];
    if (!branch) return null;
    branch.updatedAt = Number(now) || Date.now();
    writeJson(METADATA_FILE, metadata);
    return { ...branch };
  }

  recordLogicalTurn(logicalThreadId, input = {}) {
    const logicalId = String(logicalThreadId || "").trim();
    const turnId = String(input.turnId || "").trim();
    const nativeThreadId = String(input.nativeThreadId || "").trim();
    const providerId = String(input.providerId || "").trim();
    if (!logicalId || !turnId || !nativeThreadId || !providerId) {
      throw new Error("逻辑会话轮次参数无效。");
    }
    const metadata = this.metadata();
    metadata.threadTimeline[logicalId] ||= [];
    const existing = metadata.threadTimeline[logicalId].find((entry) => (
      entry.turnId === turnId && entry.nativeThreadId === nativeThreadId
    ));
    if (existing) {
      existing.updatedAt = Number(input.updatedAt) || Date.now();
      if (input.status) {
        existing.status = String(input.status);
        if (existing.status !== "interrupted") {
          delete existing.recoveredAt;
          delete existing.interruptionReason;
        }
      }
      if (input.interruptionReason) existing.interruptionReason = String(input.interruptionReason).slice(0, 100);
      if (input.recoveredAt) existing.recoveredAt = Number(input.recoveredAt);
      if (typeof input.displayText === "string") existing.displayText = input.displayText.slice(0, 100000);
      if (input.clientUserMessageId) existing.clientUserMessageId = String(input.clientUserMessageId);
    } else {
      metadata.threadTimeline[logicalId].push({
        turnId,
        nativeThreadId,
        providerId,
        engine: String(input.engine || "").trim() || null,
        startedAt: Number(input.startedAt) || Date.now(),
        updatedAt: Number(input.updatedAt) || Date.now(),
        status: String(input.status || "inProgress"),
        displayText: typeof input.displayText === "string" ? input.displayText.slice(0, 100000) : null,
        clientUserMessageId: String(input.clientUserMessageId || "").trim() || null,
      });
    }
    metadata.threadTimeline[logicalId].sort((left, right) => left.startedAt - right.startedAt);
    writeJson(METADATA_FILE, metadata);
    return metadata.threadTimeline[logicalId].map((entry) => ({ ...entry }));
  }

  recoverableInterruptedTurns() {
    const result = [];
    for (const [threadId, timeline] of Object.entries(this.metadata().threadTimeline)) {
      if (!Array.isArray(timeline) || !timeline.length) continue;
      const latest = [...timeline].sort((left, right) => Number(left.startedAt) - Number(right.startedAt)).at(-1);
      if (latest?.status !== "interrupted" || !latest.interruptionReason) continue;
      result.push({ threadId, ...latest });
    }
    return result;
  }

  recordProviderRequest(input = {}) {
    const providerId = String(input.providerId || "").trim();
    const turnId = String(input.turnId || "").trim();
    if (!providerId || !turnId) throw new Error("请求日志参数无效。");
    const number = (value) => Math.max(0, Number(value) || 0);
    const model = String(input.model || "").trim() || "unknown";
    const metadata = this.metadata();
    const existing = metadata.requestLogs.find((entry) => entry.providerId === providerId && entry.turnId === turnId);
    if (existing) return { ...existing };
    const pricing = metadata.modelPricing[`${providerId}:${model}`] || {};
    const inputTokens = number(input.inputTokens);
    const outputTokens = number(input.outputTokens);
    const cachedInputTokens = Math.min(inputTokens, number(input.cachedInputTokens));
    const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens);
    const costUsd = (
      uncachedInputTokens * number(pricing.inputPerMillion)
      + cachedInputTokens * number(pricing.cachedInputPerMillion ?? pricing.inputPerMillion)
      + outputTokens * number(pricing.outputPerMillion)
    ) / 1_000_000;
    const entry = {
      id: cleanId("request"),
      providerId,
      engine: String(input.engine || "").trim() || null,
      model,
      logicalThreadId: String(input.logicalThreadId || "").trim() || null,
      turnId,
      startedAt: number(input.startedAt) || Date.now(),
      finishedAt: number(input.finishedAt) || Date.now(),
      durationMs: number(input.durationMs),
      status: ["completed", "failed", "interrupted"].includes(input.status) ? input.status : "completed",
      errorCode: String(input.errorCode || "").trim().slice(0, 120) || null,
      errorMessage: String(input.errorMessage || "").trim().slice(0, 1000) || null,
      requestId: String(input.requestId || "").trim().slice(0, 240) || null,
      finishReason: String(input.finishReason || "").trim().slice(0, 120) || null,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      totalTokens: number(input.totalTokens) || inputTokens + outputTokens,
      costUsd,
    };
    metadata.requestLogs = [entry, ...metadata.requestLogs].slice(0, 2000);
    writeJson(METADATA_FILE, metadata);
    return { ...entry };
  }

  providerUsage(providerId = null, since = 0) {
    const targetProvider = String(providerId || "").trim() || null;
    const minimumTime = Math.max(0, Number(since) || 0);
    const logs = this.metadata().requestLogs.filter((entry) => (
      (!targetProvider || entry.providerId === targetProvider)
      && Number(entry.finishedAt) >= minimumTime
    ));
    const daily = [];
    const dayKey = (timestamp) => {
      const date = new Date(timestamp);
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    };
    const dailyMap = new Map();
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    for (let offset = 13; offset >= 0; offset -= 1) {
      const date = new Date(today);
      date.setDate(today.getDate() - offset);
      const day = dayKey(date.getTime());
      const entry = { day, requestCount: 0, totalTokens: 0, costUsd: 0 };
      daily.push(entry);
      dailyMap.set(day, entry);
    }
    for (const log of logs) {
      const entry = dailyMap.get(dayKey(Number(log.finishedAt)));
      if (!entry) continue;
      entry.requestCount += 1;
      entry.totalTokens += Number(log.totalTokens) || 0;
      entry.costUsd += Number(log.costUsd) || 0;
    }
    return {
      providerId: targetProvider,
      requestCount: logs.length,
      completedCount: logs.filter((entry) => entry.status === "completed").length,
      failedCount: logs.filter((entry) => entry.status === "failed").length,
      interruptedCount: logs.filter((entry) => entry.status === "interrupted").length,
      inputTokens: logs.reduce((sum, entry) => sum + (Number(entry.inputTokens) || 0), 0),
      outputTokens: logs.reduce((sum, entry) => sum + (Number(entry.outputTokens) || 0), 0),
      totalTokens: logs.reduce((sum, entry) => sum + (Number(entry.totalTokens) || 0), 0),
      costUsd: logs.reduce((sum, entry) => sum + (Number(entry.costUsd) || 0), 0),
      averageDurationMs: logs.length
        ? Math.round(logs.reduce((sum, entry) => sum + (Number(entry.durationMs) || 0), 0) / logs.length)
        : 0,
      daily,
      logs: logs.slice(0, 500).map((entry) => ({ ...entry })),
    };
  }

  clearProviderRequestLogs(providerId = null) {
    const targetProvider = String(providerId || "").trim() || null;
    const metadata = this.metadata();
    const removed = targetProvider
      ? metadata.requestLogs.filter((entry) => entry.providerId === targetProvider).length
      : metadata.requestLogs.length;
    metadata.requestLogs = targetProvider
      ? metadata.requestLogs.filter((entry) => entry.providerId !== targetProvider)
      : [];
    writeJson(METADATA_FILE, metadata);
    return { removed, providerId: targetProvider };
  }

  saveModelPricing(input = {}) {
    const providerId = String(input.providerId || "").trim();
    const model = String(input.model || "").trim();
    if (!providerId || !model) throw new Error("供应商和模型不能为空。");
    const price = (value) => {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1_000_000) throw new Error("模型价格必须是有效的非负数。");
      return parsed;
    };
    const metadata = this.metadata();
    metadata.modelPricing[`${providerId}:${model}`] = {
      inputPerMillion: price(input.inputPerMillion),
      outputPerMillion: price(input.outputPerMillion),
      cachedInputPerMillion: price(input.cachedInputPerMillion ?? input.inputPerMillion),
      updatedAt: Date.now(),
    };
    writeJson(METADATA_FILE, metadata);
    return { ...metadata.modelPricing[`${providerId}:${model}`] };
  }

  modelPricing() {
    return structuredClone(this.metadata().modelPricing);
  }

  providerRoutes() {
    return structuredClone(this.metadata().providerRoutes);
  }

  providerRoute(providerId) {
    const id = String(providerId || "").trim();
    const route = this.metadata().providerRoutes[id];
    return route ? { ...route, fallbackProviderIds: [...(route.fallbackProviderIds || [])] } : null;
  }

  saveProviderRoute(input = {}) {
    const providerId = String(input.providerId || "").trim();
    const metadata = this.metadata();
    const primary = metadata.relays.find((relay) => relay.id === providerId);
    if (!primary) throw new Error("模型供应商不存在。");
    if ((primary.protocol || "responses") !== "chat_completions") {
      if (input.enabled) throw new Error("自动故障转移仅支持 Chat Completions 连接。");
      delete metadata.providerRoutes[providerId];
      writeJson(METADATA_FILE, metadata);
      return { enabled: false, fallbackProviderIds: [], failureThreshold: 2, cooldownMs: 60000 };
    }
    const compatibleIds = new Set(metadata.relays
      .filter((relay) => relay.id !== providerId && (relay.protocol || "responses") === "chat_completions")
      .map((relay) => relay.id));
    const fallbackProviderIds = [...new Set((Array.isArray(input.fallbackProviderIds)
      ? input.fallbackProviderIds
      : [input.fallbackProviderId]
    ).map((id) => String(id || "").trim()).filter((id) => compatibleIds.has(id)))].slice(0, 5);
    const failureThreshold = Math.max(1, Math.min(10, Number(input.failureThreshold) || 2));
    const cooldownMs = Math.max(5000, Math.min(60 * 60 * 1000, Number(input.cooldownMs) || 60000));
    metadata.providerRoutes[providerId] = {
      enabled: Boolean(input.enabled) && fallbackProviderIds.length > 0,
      fallbackProviderIds,
      failureThreshold,
      cooldownMs,
      updatedAt: Date.now(),
    };
    writeJson(METADATA_FILE, metadata);
    return { ...metadata.providerRoutes[providerId], fallbackProviderIds: [...fallbackProviderIds] };
  }

  exportConfiguration() {
    const metadata = this.metadata();
    const relayById = new Map(metadata.relays.map((relay) => [relay.id, relay]));
    const pricing = [];
    const routes = [];
    for (const [key, value] of Object.entries(metadata.modelPricing)) {
      const separator = key.indexOf(":");
      const providerId = separator >= 0 ? key.slice(0, separator) : "";
      const model = separator >= 0 ? key.slice(separator + 1) : "";
      const relay = relayById.get(providerId);
      if (!relay || !model) continue;
      pricing.push({ providerLabel: relay.label, providerBaseUrl: relay.baseUrl, model, ...value });
    }
    for (const [providerId, route] of Object.entries(metadata.providerRoutes)) {
      const primary = relayById.get(providerId);
      if (!primary || !route || typeof route !== "object") continue;
      const fallbackProviders = (route.fallbackProviderIds || [])
        .map((fallbackId) => relayById.get(fallbackId))
        .filter(Boolean)
        .map((fallback) => ({ label: fallback.label, baseUrl: fallback.baseUrl }));
      if (!fallbackProviders.length) continue;
      routes.push({
        providerLabel: primary.label,
        providerBaseUrl: primary.baseUrl,
        enabled: Boolean(route.enabled),
        fallbackProviders,
        failureThreshold: route.failureThreshold,
        cooldownMs: route.cooldownMs,
      });
    }
    return {
      schema: CONFIG_SCHEMA,
      version: 1,
      exportedAt: new Date().toISOString(),
      containsCredentials: false,
      relays: metadata.relays.map((relay) => ({
        label: relay.label,
        baseUrl: relay.baseUrl,
        model: relay.model,
        protocol: relay.protocol || "responses",
        preset: relay.preset || "custom",
        discoveredModels: [...(relay.discoveredModels || [])],
      })),
      providerSettings: structuredClone(metadata.providerSettings),
      projects: metadata.projects.map(({ label, root }) => ({ label, root: root || null })),
      pricing,
      routes,
      disabledSkills: [...metadata.disabledSkills],
      prompts: metadata.promptTemplates.map(({ name, description, content }) => ({ name, description, content })),
      mcpServers: metadata.mcpServers.map(({ name, transport, command, args, url, envKeys, enabled }) => ({
        name, transport, command, args: [...(args || [])], url,
        envKeys: [...(envKeys || [])], enabled: enabled !== false,
      })),
    };
  }

  importConfiguration(bundle) {
    if (!bundle || !LEGACY_CONFIG_SCHEMAS.has(bundle.schema) || Number(bundle.version) !== 1) {
      throw new Error("不是有效的 ChatSwitch 配置文件。");
    }
    const metadata = this.metadata();
    let providersAdded = 0;
    let providersUpdated = 0;
    let projectsAdded = 0;
    let routesImported = 0;
    let promptsImported = 0;
    let mcpServersImported = 0;
    let mcpServersSkipped = 0;
    for (const input of Array.isArray(bundle.relays) ? bundle.relays : []) {
      const label = String(input?.label || "").trim();
      const model = String(input?.model || "").trim();
      let parsed;
      try {
        parsed = new URL(String(input?.baseUrl || "").trim());
      } catch {
        parsed = null;
      }
      if (!label || !model || !parsed || !["http:", "https:"].includes(parsed.protocol)
        || parsed.username || parsed.password || parsed.search || parsed.hash) continue;
      const baseUrl = parsed.toString().replace(/\/+$/, "");
      const existing = metadata.relays.find((relay) => (
        relay.baseUrl.toLowerCase() === baseUrl.toLowerCase()
        && projectLabelKey(relay.label) === projectLabelKey(label)
      ));
      const values = {
        label,
        baseUrl,
        model,
        protocol: ["responses", "chat_completions"].includes(input.protocol) ? input.protocol : "chat_completions",
        preset: Object.hasOwn(PROVIDER_PRESETS, input.preset) ? input.preset : "custom",
        discoveredModels: [...new Set((input.discoveredModels || []).map((item) => String(item || "").trim()).filter(Boolean))],
        updatedAt: Date.now(),
      };
      if (existing) {
        Object.assign(existing, values);
        providersUpdated += 1;
      } else {
        metadata.relays.push({ id: cleanId("relay"), ...values, createdAt: Date.now() });
        providersAdded += 1;
      }
    }
    const importedProviderSettings = bundle.providerSettings && typeof bundle.providerSettings === "object"
      ? bundle.providerSettings
      : {};
    if (importedProviderSettings.claude && typeof importedProviderSettings.claude === "object") {
      const claude = importedProviderSettings.claude;
      metadata.providerSettings.claude = {
        vendorLabel: String(claude.vendorLabel || "").trim() || undefined,
        baseUrl: String(claude.baseUrl || "").trim() || undefined,
        model: String(claude.model || "").trim() || undefined,
        authMode: String(claude.authMode || "").trim() === "oauth" ? "oauth" : "token",
      };
    }
    for (const input of Array.isArray(bundle.projects) ? bundle.projects : []) {
      let label;
      try {
        label = cleanProjectLabel(input?.label);
      } catch {
        continue;
      }
      if (metadata.projects.some((project) => projectLabelKey(project.label) === projectLabelKey(label))) continue;
      metadata.projects.push({
        id: cleanId("project"),
        label,
        root: String(input?.root || "").trim() || null,
        createdAt: new Date().toISOString(),
      });
      projectsAdded += 1;
    }
    for (const input of Array.isArray(bundle.pricing) ? bundle.pricing : []) {
      const relay = metadata.relays.find((candidate) => (
        projectLabelKey(candidate.label) === projectLabelKey(input?.providerLabel)
        && candidate.baseUrl.toLowerCase() === String(input?.providerBaseUrl || "").trim().toLowerCase()
      ));
      const model = String(input?.model || "").trim();
      if (!relay || !model) continue;
      const validPrice = (value) => Number.isFinite(Number(value)) && Number(value) >= 0;
      if (!validPrice(input.inputPerMillion) || !validPrice(input.outputPerMillion)) continue;
      metadata.modelPricing[`${relay.id}:${model}`] = {
        inputPerMillion: Number(input.inputPerMillion),
        outputPerMillion: Number(input.outputPerMillion),
        cachedInputPerMillion: validPrice(input.cachedInputPerMillion)
          ? Number(input.cachedInputPerMillion)
          : Number(input.inputPerMillion),
        updatedAt: Date.now(),
      };
    }
    const relayForReference = (label, baseUrl) => metadata.relays.find((candidate) => (
      projectLabelKey(candidate.label) === projectLabelKey(label)
      && candidate.baseUrl.toLowerCase() === String(baseUrl || "").trim().toLowerCase()
    ));
    for (const input of Array.isArray(bundle.routes) ? bundle.routes : []) {
      const primary = relayForReference(input?.providerLabel, input?.providerBaseUrl);
      if (!primary || (primary.protocol || "responses") !== "chat_completions") continue;
      const fallbackProviderIds = [...new Set((Array.isArray(input?.fallbackProviders)
        ? input.fallbackProviders
        : []
      ).map((reference) => relayForReference(reference?.label, reference?.baseUrl))
        .filter((relay) => relay && relay.id !== primary.id && (relay.protocol || "responses") === "chat_completions")
        .map((relay) => relay.id))].slice(0, 5);
      if (!fallbackProviderIds.length) continue;
      metadata.providerRoutes[primary.id] = {
        enabled: Boolean(input.enabled),
        fallbackProviderIds,
        failureThreshold: Math.max(1, Math.min(10, Number(input.failureThreshold) || 2)),
        cooldownMs: Math.max(5000, Math.min(60 * 60 * 1000, Number(input.cooldownMs) || 60000)),
        updatedAt: Date.now(),
      };
      routesImported += 1;
    }
    metadata.disabledSkills = [...new Set((Array.isArray(bundle.disabledSkills) ? bundle.disabledSkills : [])
      .map((name) => String(name || "").trim()).filter((name) => /^[\w-]{1,120}$/i.test(name)))];
    for (const input of Array.isArray(bundle.prompts) ? bundle.prompts : []) {
      const name = String(input?.name || "").trim().replace(/^\/+/, "").replace(/\s+/g, "-");
      const content = String(input?.content || "").trim();
      if (!/^[\w\u4e00-\u9fff-]{1,80}$/i.test(name) || !content || content.length > 20000) continue;
      const existing = metadata.promptTemplates.find((item) => projectLabelKey(item.name) === projectLabelKey(name));
      const values = { name, description: String(input?.description || "").trim().slice(0, 240), content, updatedAt: Date.now() };
      if (existing) Object.assign(existing, values);
      else metadata.promptTemplates.push({ id: cleanId("prompt"), createdAt: Date.now(), ...values });
      promptsImported += 1;
    }
    for (const input of Array.isArray(bundle.mcpServers) ? bundle.mcpServers : []) {
      const name = String(input?.name || "").trim();
      const transport = ["stdio", "http", "sse"].includes(input?.transport) ? input.transport : "stdio";
      const command = typeof input?.command === "string" ? input.command.trim() : "";
      const url = String(input?.url || "").trim();
      const rawArgs = Array.isArray(input?.args) ? input.args : [];
      const argsValid = rawArgs.every((item) => typeof item === "string" && !item.includes("\u0000"));
      const args = argsValid ? rawArgs.map((item) => item.trim()).filter(Boolean).slice(0, 50) : [];
      let validUrl = false;
      if (transport !== "stdio") {
        try {
          const parsed = new URL(url);
          validUrl = ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password;
        } catch {}
      }
      if (!name || name.length > 100 || (transport === "stdio"
        ? (!command || command.includes("\u0000") || !argsValid)
        : !validUrl)) {
        mcpServersSkipped += 1;
        continue;
      }
      const existing = metadata.mcpServers.find((item) => projectLabelKey(item.name) === projectLabelKey(name));
      const values = {
        name, transport, command: transport === "stdio" ? command : null,
        args: transport === "stdio" ? args : [],
        url: transport === "stdio" ? null : url,
        envKeys: [...new Set((input.envKeys || []).map((key) => String(key || "").trim()).filter((key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)))],
        enabled: input.enabled !== false,
        updatedAt: Date.now(),
      };
      if (existing) Object.assign(existing, values);
      else metadata.mcpServers.push({ id: cleanId("mcp"), createdAt: Date.now(), ...values });
      mcpServersImported += 1;
    }
    writeJson(METADATA_FILE, metadata);
    return {
      providersAdded,
      providersUpdated,
      projectsAdded,
      routesImported,
      promptsImported,
      mcpServersImported,
      mcpServersSkipped,
      credentialsImported: false,
      requiresCredentials: providersAdded + providersUpdated > 0,
    };
  }

  createRotatingBackup(maxBackups = 10, minimumIntervalMs = 6 * 60 * 60 * 1000) {
    const backupRoot = path.join(STORE_ROOT, "backups");
    fs.mkdirSync(backupRoot, { recursive: true });
    const existing = fs.readdirSync(backupRoot)
      .filter((name) => /^(?:chatswitch|share-master)-backup-.*\.json$/i.test(name))
      .map((name) => ({ name, file: path.join(backupRoot, name), stat: fs.statSync(path.join(backupRoot, name)) }))
      .sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs);
    if (existing[0] && Date.now() - existing[0].stat.mtimeMs < Math.max(0, minimumIntervalMs)) {
      return { created: false, name: existing[0].name, createdAt: existing[0].stat.mtimeMs };
    }
    const createdAt = Date.now();
    const name = `chatswitch-backup-${new Date(createdAt).toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}.json`;
    writeJson(path.join(backupRoot, name), {
      schema: BACKUP_SCHEMA,
      version: 1,
      createdAt,
      machineBoundCredentials: true,
      metadata: this.metadata(),
      encryptedCredentials: readJson(SECRETS_FILE, {}),
    });
    const after = [name, ...existing.map((entry) => entry.name)];
    for (const stale of after.slice(Math.max(1, Number(maxBackups) || 10))) {
      const target = path.resolve(backupRoot, stale);
      if (path.dirname(target) === path.resolve(backupRoot) && fs.existsSync(target)) fs.unlinkSync(target);
    }
    return { created: true, name, createdAt };
  }

  listConfigurationBackups() {
    const backupRoot = path.join(STORE_ROOT, "backups");
    if (!fs.existsSync(backupRoot)) return [];
    return fs.readdirSync(backupRoot)
      .filter((name) => /^(?:chatswitch|share-master)-backup-.*\.json$/i.test(name))
      .map((name) => {
        const stat = fs.statSync(path.join(backupRoot, name));
        return { name, createdAt: stat.mtimeMs, size: stat.size };
      })
      .sort((left, right) => right.createdAt - left.createdAt);
  }

  restoreConfigurationBackup(name) {
    const backupRoot = path.resolve(STORE_ROOT, "backups");
    const file = path.resolve(backupRoot, path.basename(String(name || "")));
    if (path.dirname(file) !== backupRoot || !fs.existsSync(file)) throw new Error("备份不存在。");
    const backup = readJson(file, null);
    if (!backup || !LEGACY_BACKUP_SCHEMAS.has(backup.schema) || Number(backup.version) !== 1
      || !backup.metadata || typeof backup.encryptedCredentials !== "object") {
      throw new Error("备份文件无效或已损坏。");
    }
    this.createRotatingBackup(10, 0);
    writeJson(METADATA_FILE, backup.metadata);
    writeJson(SECRETS_FILE, backup.encryptedCredentials);
    return { restored: true, name: path.basename(file), restoredAt: Date.now() };
  }

  syncStatus() {
    const metadata = this.metadata();
    const settings = metadata.syncSettings || {};
    const backend = settings.backend === "webdav" ? "webdav" : "directory";
    const directory = typeof settings.directory === "string" ? settings.directory : null;
    const syncFiles = directory
      ? [SYNC_FILE_NAME, LEGACY_SYNC_FILE_NAME].map((name) => path.join(directory, name))
      : [];
    const secrets = readJson(SECRETS_FILE, {});
    return {
      backend,
      directory,
      webdavUrl: typeof settings.webdavUrl === "string" ? settings.webdavUrl : null,
      hasWebdavCredentials: Boolean(secrets["sync:webdav:username"] && secrets["sync:webdav:password"]),
      autoSync: Boolean(settings.autoSync),
      lastSyncedAt: Number(settings.lastSyncedAt) || null,
      remoteExists: backend === "directory"
        ? syncFiles.some((file) => fs.existsSync(file))
        : Boolean(settings.lastRemoteExists),
      history: metadata.syncHistory.slice(0, 20).map((entry) => ({ ...entry })),
    };
  }

  appSettings() {
    const settings = this.metadata().appSettings || {};
    return { closeToTray: settings.closeToTray !== false };
  }

  saveAppSettings(input = {}) {
    const metadata = this.metadata();
    metadata.appSettings = { closeToTray: input.closeToTray !== false };
    writeJson(METADATA_FILE, metadata);
    return this.appSettings();
  }

  configureSync(input = {}) {
    const metadata = this.metadata();
    const requested = String(input.directory || "").trim();
    let directory = null;
    if (requested) {
      directory = path.resolve(requested);
      const storeRoot = path.resolve(STORE_ROOT);
      const relative = path.relative(storeRoot, directory);
      if (!relative || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
        throw new Error("同步目录不能位于 ChatSwitch 私有数据目录内。");
      }
      fs.mkdirSync(directory, { recursive: true });
      if (!fs.statSync(directory).isDirectory()) throw new Error("同步位置不是目录。");
    }
    metadata.syncSettings = {
      ...metadata.syncSettings,
      backend: "directory",
      directory,
      autoSync: Boolean(input.autoSync) && Boolean(directory),
      lastSyncedHash: directory === metadata.syncSettings?.directory
        ? metadata.syncSettings?.lastSyncedHash || null
        : null,
      lastSyncedAt: directory === metadata.syncSettings?.directory
        ? Number(metadata.syncSettings?.lastSyncedAt) || null
        : null,
    };
    writeJson(METADATA_FILE, metadata);
    return this.syncStatus();
  }

  configureWebdavSync(input = {}) {
    const rawUrl = String(input.url || "").trim();
    let parsed;
    try {
      parsed = new URL(rawUrl.endsWith("/") ? rawUrl : `${rawUrl}/`);
    } catch {
      parsed = null;
    }
    if (!parsed || !["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password
      || parsed.search || parsed.hash || parsed.toString().length > 2048) {
      throw new Error("请输入有效的 WebDAV 目录 URL。");
    }
    const metadata = this.metadata();
    const secrets = readJson(SECRETS_FILE, {});
    const username = String(input.username || "").trim();
    const password = String(input.password || "");
    const hasExisting = Boolean(secrets["sync:webdav:username"] && secrets["sync:webdav:password"]);
    if ((!username || !password) && !hasExisting) throw new Error("WebDAV 用户名和密码不能为空。");
    if (username.length > 300 || password.length > 2000) throw new Error("WebDAV 凭据长度无效。");
    if ((username || password) && (!username || !password)) throw new Error("请同时输入 WebDAV 用户名和密码。");
    if (username && password) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows 安全存储当前不可用，未保存 WebDAV 凭据。");
      secrets["sync:webdav:username"] = safeStorage.encryptString(username).toString("base64");
      secrets["sync:webdav:password"] = safeStorage.encryptString(password).toString("base64");
      writeJson(SECRETS_FILE, secrets);
    }
    const webdavUrl = parsed.toString();
    const sameTarget = metadata.syncSettings?.backend === "webdav" && metadata.syncSettings?.webdavUrl === webdavUrl;
    metadata.syncSettings = {
      ...metadata.syncSettings,
      backend: "webdav",
      webdavUrl,
      autoSync: Boolean(input.autoSync),
      lastSyncedHash: sameTarget ? metadata.syncSettings?.lastSyncedHash || null : null,
      lastSyncedAt: sameTarget ? Number(metadata.syncSettings?.lastSyncedAt) || null : null,
      lastRemoteExists: sameTarget ? Boolean(metadata.syncSettings?.lastRemoteExists) : false,
    };
    writeJson(METADATA_FILE, metadata);
    return this.syncStatus();
  }

  webdavCredentials() {
    const secrets = readJson(SECRETS_FILE, {});
    try {
      const username = safeStorage.decryptString(Buffer.from(secrets["sync:webdav:username"] || "", "base64"));
      const password = safeStorage.decryptString(Buffer.from(secrets["sync:webdav:password"] || "", "base64"));
      return username && password ? { username, password } : null;
    } catch {
      return null;
    }
  }

  async syncConfigured(mode = "auto", fetchImpl = globalThis.fetch) {
    return this.syncStatus().backend === "webdav"
      ? this.syncWebdavConfiguration(mode, fetchImpl)
      : this.syncConfiguration(mode);
  }

  async syncWebdavConfiguration(mode = "auto", fetchImpl = globalThis.fetch) {
    if (!["auto", "push", "pull"].includes(mode)) throw new Error("不支持的同步方式。");
    if (typeof fetchImpl !== "function") throw new Error("WebDAV 网络接口不可用。");
    const metadata = this.metadata();
    const settings = metadata.syncSettings || {};
    if (settings.backend !== "webdav" || !settings.webdavUrl) throw new Error("请先配置 WebDAV 同步。");
    const credentials = this.webdavCredentials();
    if (!credentials) throw new Error("WebDAV 凭据不可用，请重新输入。");
    const target = new URL(SYNC_FILE_NAME, settings.webdavUrl).toString();
    const legacyTarget = new URL(LEGACY_SYNC_FILE_NAME, settings.webdavUrl).toString();
    const authorization = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`, "utf8").toString("base64")}`;
    const request = async (requestTarget, method, body = undefined) => {
      const response = await fetchImpl(requestTarget, {
        method,
        headers: { Authorization: authorization, ...(body ? { "Content-Type": "application/json; charset=utf-8" } : {}) },
        body,
        signal: AbortSignal.timeout(15000),
      });
      if (response.status === 401 || response.status === 403) throw new Error("WebDAV 身份验证失败。");
      if (!response.ok && !(method === "GET" && response.status === 404)) {
        throw new Error(`WebDAV 请求失败（HTTP ${response.status}）。`);
      }
      return response;
    };

    const localBundle = this.exportConfiguration();
    const localHash = configurationHash(localBundle);
    let response = await request(target, "GET");
    if (response.status === 404) response = await request(legacyTarget, "GET");
    let remoteBundle = null;
    let remoteHash = null;
    if (response.status !== 404) {
      try {
        remoteBundle = JSON.parse(await response.text());
      } catch {
        throw new Error("WebDAV 中的同步文件不是有效 JSON。");
      }
      if (!LEGACY_CONFIG_SCHEMAS.has(remoteBundle?.schema) || Number(remoteBundle.version) !== 1) {
        throw new Error("WebDAV 中的同步文件无效或已损坏。");
      }
      remoteHash = configurationHash(remoteBundle);
    }
    const previousHash = settings.lastSyncedHash || null;
    const localChanged = Boolean(previousHash && localHash !== previousHash);
    const remoteChanged = Boolean(previousHash && remoteHash && remoteHash !== previousHash);
    if (mode === "auto" && remoteHash && localHash !== remoteHash) {
      if (!previousHash || (localChanged && remoteChanged)) {
        return this.#recordSyncResult(metadata, {
          status: "conflict", direction: "none", localHash, remoteHash,
          message: "本机和 WebDAV 包含不同配置，请选择保留本机或使用 WebDAV。",
        });
      }
      mode = remoteChanged ? "pull" : "push";
    }
    if (mode === "auto") mode = remoteHash ? "unchanged" : "push";
    let direction = "none";
    let imported = null;
    let syncedHash = localHash;
    if (mode === "pull") {
      if (!remoteBundle) throw new Error("WebDAV 中还没有同步文件。");
      this.createRotatingBackup(10, 0);
      imported = this.importConfiguration(remoteBundle);
      const merged = { ...this.exportConfiguration(), exportedAt: new Date().toISOString() };
      await request(target, "PUT", `${JSON.stringify(merged, null, 2)}\n`);
      syncedHash = configurationHash(merged);
      direction = "pull";
    } else if (mode === "push") {
      const payload = { ...localBundle, exportedAt: new Date().toISOString() };
      await request(target, "PUT", `${JSON.stringify(payload, null, 2)}\n`);
      syncedHash = configurationHash(payload);
      direction = "push";
    }
    return this.#recordSyncResult(this.metadata(), {
      status: "success", direction, localHash: syncedHash, remoteHash: syncedHash,
      message: direction === "pull" ? "已从 WebDAV 合并配置。" : direction === "push" ? "已将本机配置写入 WebDAV。" : "WebDAV 配置已经是最新状态。",
      imported,
    });
  }

  syncConfiguration(mode = "auto") {
    if (!["auto", "push", "pull"].includes(mode)) throw new Error("不支持的同步方式。");
    const metadata = this.metadata();
    const settings = metadata.syncSettings || {};
    if (!settings.directory) throw new Error("请先选择同步目录。");
    const directory = path.resolve(settings.directory);
    const currentFile = path.join(directory, SYNC_FILE_NAME);
    const legacyFile = path.join(directory, LEGACY_SYNC_FILE_NAME);
    const file = fs.existsSync(currentFile) || !fs.existsSync(legacyFile) ? currentFile : legacyFile;
    fs.mkdirSync(directory, { recursive: true });

    const localBundle = this.exportConfiguration();
    const localHash = configurationHash(localBundle);
    let remoteBundle = null;
    let remoteHash = null;
    if (fs.existsSync(file)) {
      remoteBundle = readJson(file, null);
      if (!remoteBundle || !LEGACY_CONFIG_SCHEMAS.has(remoteBundle.schema) || Number(remoteBundle.version) !== 1) {
        throw new Error("同步目录中的配置文件无效或已损坏。");
      }
      remoteHash = configurationHash(remoteBundle);
    }

    const previousHash = settings.lastSyncedHash || null;
    const localChanged = Boolean(previousHash && localHash !== previousHash);
    const remoteChanged = Boolean(previousHash && remoteHash && remoteHash !== previousHash);
    if (mode === "auto" && remoteHash && localHash !== remoteHash) {
      if (!previousHash || (localChanged && remoteChanged)) {
        return this.#recordSyncResult(metadata, {
          status: "conflict", direction: "none", localHash, remoteHash,
          message: "本机和同步目录包含不同配置，请选择保留本机或使用同步目录。",
        });
      }
      mode = remoteChanged ? "pull" : "push";
    }
    if (mode === "auto") mode = remoteHash ? "unchanged" : "push";

    let direction = "none";
    let imported = null;
    let syncedHash = localHash;
    if (mode === "pull") {
      if (!remoteBundle) throw new Error("同步目录中还没有配置文件。");
      this.createRotatingBackup(10, 0);
      imported = this.importConfiguration(remoteBundle);
      const mergedBundle = { ...this.exportConfiguration(), exportedAt: new Date().toISOString() };
      writeJson(currentFile, mergedBundle);
      syncedHash = configurationHash(mergedBundle);
      direction = "pull";
    } else if (mode === "push") {
      const payload = { ...localBundle, exportedAt: new Date().toISOString() };
      writeJson(currentFile, payload);
      syncedHash = configurationHash(payload);
      direction = "push";
    }

    const refreshed = this.metadata();
    return this.#recordSyncResult(refreshed, {
      status: "success", direction, localHash: syncedHash, remoteHash: syncedHash,
      message: direction === "pull" ? "已从同步目录合并配置。" : direction === "push" ? "已将本机配置写入同步目录。" : "配置已经是最新状态。",
      imported,
    });
  }

  #recordSyncResult(metadata, result) {
    const now = Date.now();
    metadata.syncSettings ||= {};
    metadata.syncSettings.lastRemoteExists = Boolean(result.remoteHash);
    if (result.status === "success") {
      metadata.syncSettings.lastSyncedHash = result.localHash;
      metadata.syncSettings.lastSyncedAt = now;
    }
    const historyEntry = {
      id: cleanId("sync"),
      at: now,
      status: result.status,
      direction: result.direction,
      message: result.message,
    };
    metadata.syncHistory = [historyEntry, ...(metadata.syncHistory || [])].slice(0, 50);
    writeJson(METADATA_FILE, metadata);
    return {
      ...this.syncStatus(),
      result: { ...historyEntry, imported: result.imported || null },
      conflict: result.status === "conflict",
    };
  }

  deletedThreads() {
    return [...this.metadata().deletedThreads];
  }

  localArchivedThreads() {
    return [...this.metadata().localArchivedThreads];
  }

  pendingDeletions() {
    return this.metadata().pendingDeletions.map((entry) => ({ ...entry }));
  }

  scheduledTasks() {
    return this.metadata().scheduledTasks.map((task) => ({
      ...task,
      timeZone: task.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai",
      notifyOnCompletion: task.notifyOnCompletion !== false,
      retryOnFailure: task.retryOnFailure !== false,
      approvalMode: ["ask", "auto", "full"].includes(task.approvalMode) ? task.approvalMode : "auto",
      runHistory: Array.isArray(task.runHistory) ? task.runHistory.map((run) => ({ ...run })) : [],
      consecutiveFailures: Number(task.consecutiveFailures) || 0,
      scheduleAnchorDay: Number(task.scheduleAnchorDay) || new Date(task.scheduledAt).getDate(),
    }));
  }

  disabledSkills() {
    return [...this.metadata().disabledSkills];
  }

  setSkillEnabled(name, enabled) {
    const skillName = String(name || "").trim();
    if (!/^[\w-]{1,120}$/i.test(skillName)) throw new Error("Skill 名称无效。");
    const metadata = this.metadata();
    const key = skillName.toLocaleLowerCase("en-US");
    metadata.disabledSkills = metadata.disabledSkills.filter(
      (item) => String(item).toLocaleLowerCase("en-US") !== key,
    );
    if (!enabled) metadata.disabledSkills.push(skillName);
    writeJson(METADATA_FILE, metadata);
    return { name: skillName, enabled: Boolean(enabled) };
  }

  promptTemplates() {
    return this.metadata().promptTemplates
      .map((template) => ({ ...template }))
      .sort((left, right) => String(left.name).localeCompare(String(right.name), "zh-CN"));
  }

  savePromptTemplate(input) {
    const id = String(input?.id || "").trim();
    const name = String(input?.name || "").trim().replace(/^\/+/, "").replace(/\s+/g, "-");
    const description = String(input?.description || "").trim();
    const content = String(input?.content || "").trim();
    if (!/^[\w\u4e00-\u9fff-]{1,80}$/i.test(name)) throw new Error("模板命令只能包含文字、字母、数字、下划线和短横线。");
    if (!content) throw new Error("模板内容不能为空。");
    if (content.length > 20000) throw new Error("模板内容不能超过 20000 个字符。");
    const metadata = this.metadata();
    const duplicate = metadata.promptTemplates.find((item) => (
      String(item.name).toLocaleLowerCase("zh-CN") === name.toLocaleLowerCase("zh-CN") && item.id !== id
    ));
    if (duplicate) throw new Error("模板命令不能重名。");
    const existing = id ? metadata.promptTemplates.find((item) => item.id === id) : null;
    if (id && !existing) throw new Error("Prompt 模板不存在。");
    const now = Date.now();
    const template = existing || { id: cleanId("prompt"), createdAt: now };
    Object.assign(template, { name, description: description.slice(0, 240), content, updatedAt: now });
    if (!existing) metadata.promptTemplates.push(template);
    writeJson(METADATA_FILE, metadata);
    return { ...template };
  }

  removePromptTemplate(id) {
    const templateId = String(id || "").trim();
    const metadata = this.metadata();
    const index = metadata.promptTemplates.findIndex((item) => item.id === templateId);
    if (index < 0) throw new Error("Prompt 模板不存在。");
    const [removed] = metadata.promptTemplates.splice(index, 1);
    writeJson(METADATA_FILE, metadata);
    return { ...removed };
  }

  mcpServers() {
    const secrets = readJson(SECRETS_FILE, {});
    return this.metadata().mcpServers.map((server) => ({
      ...server,
      envKeys: Array.isArray(server.envKeys) ? [...server.envKeys] : [],
      hasSecrets: Boolean(secrets[`mcp:${server.id}`]),
    }));
  }

  saveMcpServer(input) {
    const id = String(input?.id || "").trim();
    const name = String(input?.name || "").trim();
    const transport = ["stdio", "http", "sse"].includes(input?.transport) ? input.transport : "stdio";
    const command = String(input?.command || "").trim();
    const url = String(input?.url || "").trim();
    const args = (Array.isArray(input?.args) ? input.args : [])
      .map((item) => String(item || "").trim()).filter(Boolean).slice(0, 50);
    const env = input?.env && typeof input.env === "object" ? input.env : {};
    if (!name || name.length > 100) throw new Error("MCP 名称不能为空且不能超过 100 个字符。");
    if (transport === "stdio" && !command) throw new Error("stdio MCP 必须填写启动命令。");
    if (transport === "stdio" && (command.includes("\u0000") || args.some((item) => item.includes("\u0000")))) {
      throw new Error("MCP 启动命令和参数不能包含无效字符。");
    }
    if (transport !== "stdio") {
      let parsed;
      try { parsed = new URL(url); } catch {}
      if (!parsed || !["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
        throw new Error("请输入有效且不含凭据的 MCP URL。");
      }
    }
    if (Object.values(env).some(Boolean) && !safeStorage?.isEncryptionAvailable?.()) {
      throw new Error("Windows 安全存储当前不可用，未保存 MCP 环境变量。");
    }
    const metadata = this.metadata();
    const duplicate = metadata.mcpServers.find((item) => (
      String(item.name).toLocaleLowerCase("zh-CN") === name.toLocaleLowerCase("zh-CN") && item.id !== id
    ));
    if (duplicate) throw new Error("MCP 名称不能重名。");
    const existing = id ? metadata.mcpServers.find((item) => item.id === id) : null;
    if (id && !existing) throw new Error("MCP 配置不存在。");
    const now = Date.now();
    const envKeys = [...new Set(Object.keys(env).map((key) => String(key).trim()).filter((key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)))];
    const server = existing || { id: cleanId("mcp"), createdAt: now };
    Object.assign(server, {
      name, transport, command: transport === "stdio" ? command : null,
      args: transport === "stdio" ? args : [], url: transport === "stdio" ? null : url,
      envKeys, enabled: input?.enabled !== false, updatedAt: now,
    });
    if (!existing) metadata.mcpServers.push(server);
    const secrets = readJson(SECRETS_FILE, {});
    const previousSecrets = existing ? this.mcpEnvironment(server.id) : {};
    const secretValues = Object.fromEntries(envKeys
      .map((key) => [key, String(env[key] || "") || String(previousSecrets[key] || "")])
      .filter(([, value]) => value));
    if (Object.keys(secretValues).length) {
      secrets[`mcp:${server.id}`] = safeStorage.encryptString(JSON.stringify(secretValues)).toString("base64");
      writeJson(SECRETS_FILE, secrets);
    } else if (input?.clearSecrets || envKeys.length === 0) {
      delete secrets[`mcp:${server.id}`];
      writeJson(SECRETS_FILE, secrets);
    }
    writeJson(METADATA_FILE, metadata);
    return this.mcpServers().find((item) => item.id === server.id);
  }

  removeMcpServer(id) {
    const serverId = String(id || "").trim();
    const metadata = this.metadata();
    const index = metadata.mcpServers.findIndex((item) => item.id === serverId);
    if (index < 0) throw new Error("MCP 配置不存在。");
    const [removed] = metadata.mcpServers.splice(index, 1);
    const secrets = readJson(SECRETS_FILE, {});
    delete secrets[`mcp:${serverId}`];
    writeJson(SECRETS_FILE, secrets);
    writeJson(METADATA_FILE, metadata);
    return { ...removed };
  }

  mcpEnvironment(id) {
    const encoded = readJson(SECRETS_FILE, {})[`mcp:${String(id || "").trim()}`];
    if (!encoded) return {};
    try {
      const value = JSON.parse(safeStorage.decryptString(Buffer.from(encoded, "base64")));
      return value && typeof value === "object" ? value : {};
    } catch {
      return {};
    }
  }

  saveThreadSettings(threadId, providerId, input = {}) {
    const thread = String(threadId || "").trim();
    const provider = String(providerId || "").trim();
    const model = String(input.model || "").trim();
    const effort = String(input.effort || "").trim();
    const approvalMode = String(input.approvalMode || "ask").trim();
    if (!thread || !provider) throw new Error("无效的会话设置。");
    if (model.length > 160 || effort.length > 32) throw new Error("会话模型设置过长。");
    if (!["ask", "auto", "full"].includes(approvalMode)) throw new Error("无效的批准模式。");
    const metadata = this.metadata();
    const key = `${provider}:${thread}`;
    metadata.threadSettings[key] = {
      model: model || null,
      effort: effort || null,
      approvalMode,
      updatedAt: Date.now(),
    };
    writeJson(METADATA_FILE, metadata);
    return { ...metadata.threadSettings };
  }

  conversationHome() {
    return this.metadata().conversationHome;
  }

  conversationMirrorSource() {
    return this.metadata().conversationMirrorSource;
  }

  conversationMirrorSettings() {
    const metadata = this.metadata();
    const intervalMs = Number(metadata.conversationMirrorIntervalMs);
    return {
      source: metadata.conversationMirrorSource || null,
      intervalMs: Number.isFinite(intervalMs) ? Math.max(15000, Math.min(300000, intervalMs)) : 60000,
      enabled: Boolean(metadata.conversationMirrorSource) && metadata.conversationMirrorEnabled !== false,
      target: this.conversationHome(),
    };
  }

  setConversationMirrorSettings(input = {}) {
    const sourceValue = String(input.source || "").trim();
    const enabled = Boolean(input.enabled) && Boolean(sourceValue);
    const intervalSeconds = Number(input.intervalSeconds);
    const intervalMs = Number.isFinite(intervalSeconds)
      ? Math.max(15, Math.min(300, intervalSeconds)) * 1000
      : 60000;
    const metadata = this.metadata();
    if (sourceValue) {
      this.setConversationMirrorSource(sourceValue);
    } else {
      metadata.conversationMirrorSource = null;
    }
    const next = this.metadata();
    next.conversationMirrorIntervalMs = intervalMs;
    next.conversationMirrorEnabled = enabled;
    writeJson(METADATA_FILE, next);
    return this.conversationMirrorSettings();
  }

  setConversationMirrorSource(directory) {
    const source = path.resolve(String(directory || "").trim());
    if (!directory || !fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
      throw new Error("请选择有效的聊天记录只读源目录。");
    }
    if (!["sessions", "archived_sessions"].some((name) => fs.existsSync(path.join(source, name)))) {
      throw new Error("源目录中没有可同步的聊天记录目录。");
    }
    const target = path.resolve(this.conversationHome());
    const relativeTarget = path.relative(source, target);
    const relativeSource = path.relative(target, source);
    if (source === target
      || (relativeTarget && !relativeTarget.startsWith("..") && !path.isAbsolute(relativeTarget))
      || (relativeSource && !relativeSource.startsWith("..") && !path.isAbsolute(relativeSource))) {
      throw new Error("聊天记录源目录和 ChatSwitch 副本目录必须彼此独立。");
    }
    const metadata = this.metadata();
    metadata.conversationMirrorSource = source;
    writeJson(METADATA_FILE, metadata);
    return source;
  }

  setConversationHome(directory) {
    const requested = String(directory || "").trim();
    const target = requested ? path.resolve(requested) : "";
    if (!target || !fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
      throw new Error("请选择一个有效的聊天记录目录。");
    }
    if (ISOLATED_STORE) {
      const relative = path.relative(STORE_ROOT, target);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error("隔离模式只能使用测试数据目录内的聊天记录。");
      }
    }
    const metadata = this.metadata();
    metadata.conversationHome = target;
    writeJson(METADATA_FILE, metadata);
    const sourceAuth = path.join(CODEX_HOME, "auth.json");
    const targetAuth = path.join(target, "auth.json");
    if (!ISOLATED_STORE
      && target.toLowerCase() !== CODEX_HOME.toLowerCase()
      && fs.existsSync(sourceAuth)
      && !fs.existsSync(targetAuth)) {
      fs.copyFileSync(sourceAuth, targetAuth, fs.constants.COPYFILE_EXCL);
    }
    return target;
  }

  addProject(input) {
    const requestedRoot = String(input?.root || "").trim();
    const root = requestedRoot ? path.resolve(requestedRoot) : null;
    if (root && (!fs.existsSync(root) || !fs.statSync(root).isDirectory())) {
      throw new Error("Project 目录无效；也可以清空目录，仅创建命名 Project。");
    }
    const label = cleanProjectLabel(input?.label || (root ? path.basename(root) || root : ""));
    const metadata = this.metadata();
    if (root) {
      const rootKey = root.toLowerCase();
      metadata.hiddenProjectRoots = metadata.hiddenProjectRoots
        .filter((item) => String(item || "").toLowerCase() !== rootKey);
    }
    const existing = root
      ? metadata.projects.find((item) => typeof item.root === "string" && item.root.toLowerCase() === root.toLowerCase())
      : null;
    if (existing) {
      writeJson(METADATA_FILE, metadata);
      return existing;
    }
    const labelKey = projectLabelKey(label);
    if (metadata.projects.some((item) => projectLabelKey(item.label) === labelKey)) {
      throw new Error(`Project 名称“${label}”已存在。`);
    }
    const project = {
      id: cleanId("project"),
      label,
      root,
      createdAt: Date.now(),
    };
    metadata.projects.push(project);
    writeJson(METADATA_FILE, metadata);
    return project;
  }

  renameProject(projectId, requestedLabel) {
    const id = String(projectId || "").trim();
    const label = cleanProjectLabel(requestedLabel);
    const metadata = this.metadata();
    const project = metadata.projects.find((item) => item.id === id);
    if (!project) throw new Error("Project 不存在。");
    const labelKey = projectLabelKey(label);
    if (metadata.projects.some((item) => item.id !== id && projectLabelKey(item.label) === labelKey)) {
      throw new Error(`Project 名称“${label}”已存在。`);
    }
    project.label = label;
    writeJson(METADATA_FILE, metadata);
    return { ...project };
  }

  deleteProject(input) {
    const request = input && typeof input === "object" ? input : { projectId: input };
    const id = String(request.projectId || "").trim();
    const requestedRoots = Array.isArray(request.roots) ? request.roots : [];
    const metadata = this.metadata();
    const index = id ? metadata.projects.findIndex((item) => item.id === id) : -1;
    if (id && index < 0) throw new Error("Project 不存在。");
    const project = index >= 0 ? metadata.projects.splice(index, 1)[0] : null;
    const roots = [project?.root, ...requestedRoots]
      .map((item) => String(item || "").trim())
      .filter(Boolean);
    if (!project && !roots.length) throw new Error("无效的 Project。");
    const hiddenRootKeys = new Set(metadata.hiddenProjectRoots.map((item) => String(item || "").toLowerCase()));
    for (const root of roots) {
      const resolved = path.resolve(root);
      const key = resolved.toLowerCase();
      if (hiddenRootKeys.has(key)) continue;
      metadata.hiddenProjectRoots.push(resolved);
      hiddenRootKeys.add(key);
    }
    let removedAssignments = 0;
    if (id) {
      for (const [threadId, assignedProjectId] of Object.entries(metadata.projectThreads)) {
        if (assignedProjectId !== id) continue;
        delete metadata.projectThreads[threadId];
        removedAssignments += 1;
      }
      for (const task of metadata.scheduledTasks) {
        if (task.projectId !== id) continue;
        task.projectId = null;
        task.workspace ||= project?.root || null;
        task.updatedAt = Date.now();
      }
    }
    writeJson(METADATA_FILE, metadata);
    return {
      project: project ? { ...project } : null,
      removedAssignments,
      hiddenProjectRoots: [...metadata.hiddenProjectRoots],
    };
  }

  assignThreadToProject(threadId, projectId) {
    const thread = String(threadId || "").trim();
    const project = String(projectId || "").trim();
    if (!thread) throw new Error("无效的会话 ID。");
    const metadata = this.metadata();
    if (project && !metadata.projects.some((item) => item.id === project)) {
      throw new Error("Project 不存在。");
    }
    if (project) metadata.projectThreads[thread] = project;
    else delete metadata.projectThreads[thread];
    writeJson(METADATA_FILE, metadata);
    return { ...metadata.projectThreads };
  }

  renameThreadLocal(threadId, requestedName) {
    const id = String(threadId || "").trim();
    const name = String(requestedName || "").trim().replace(/\s+/g, " ");
    if (!id) throw new Error("无效的会话 ID。");
    if (!name) throw new Error("会话名称不能为空。");
    if (name.length > 160) throw new Error("会话名称不能超过 160 个字符。");
    const metadata = this.metadata();
    metadata.threadAliases[id] = name;
    writeJson(METADATA_FILE, metadata);
    return { ...metadata.threadAliases };
  }

  archiveThreadLocal(threadId) {
    const id = String(threadId || "").trim();
    if (!id) throw new Error("无效的会话 ID。");
    const metadata = this.metadata();
    if (metadata.deletedThreads.includes(id)) throw new Error("会话已被永久移出 ChatSwitch。");
    if (!metadata.localArchivedThreads.includes(id)) metadata.localArchivedThreads.push(id);
    metadata.hiddenThreads = metadata.hiddenThreads.filter((item) => item !== id);
    metadata.pendingDeletions = metadata.pendingDeletions.filter((item) => item.threadId !== id);
    writeJson(METADATA_FILE, metadata);
    return [...metadata.localArchivedThreads];
  }

  unarchiveThreadLocal(threadId) {
    const id = String(threadId || "").trim();
    if (!id) throw new Error("无效的会话 ID。");
    const metadata = this.metadata();
    metadata.localArchivedThreads = metadata.localArchivedThreads.filter((item) => item !== id);
    writeJson(METADATA_FILE, metadata);
    return [...metadata.localArchivedThreads];
  }

  hideThread(threadId) {
    const id = String(threadId || "").trim();
    if (!id) throw new Error("无效的会话 ID。");
    const metadata = this.metadata();
    if (metadata.deletedThreads.includes(id)) throw new Error("会话已被永久移出 ChatSwitch。");
    if (!metadata.hiddenThreads.includes(id)) metadata.hiddenThreads.push(id);
    metadata.localArchivedThreads = metadata.localArchivedThreads.filter((item) => item !== id);
    writeJson(METADATA_FILE, metadata);
    return [...metadata.hiddenThreads];
  }

  restoreThread(threadId) {
    const id = String(threadId || "").trim();
    if (!id) throw new Error("无效的会话 ID。");
    const metadata = this.metadata();
    metadata.hiddenThreads = metadata.hiddenThreads.filter((item) => item !== id);
    metadata.pendingDeletions = metadata.pendingDeletions.filter((item) => item.threadId !== id);
    writeJson(METADATA_FILE, metadata);
    return [...metadata.hiddenThreads];
  }

  scheduleThreadDeletion(threadId, engine, providerId, now = Date.now(), graceMs = 60 * 60 * 1000) {
    const id = String(threadId || "").trim();
    const targetEngine = engine === "claude" ? "claude" : "codex";
    if (!id) throw new Error("无效的会话 ID。");
    const metadata = this.metadata();
    const entry = {
      threadId: id,
      engine: targetEngine,
      providerId: String(providerId || "").trim() || null,
      scheduledAt: now,
      expiresAt: now + Math.max(1000, graceMs),
    };
    metadata.pendingDeletions = metadata.pendingDeletions.filter((item) => item.threadId !== id);
    metadata.pendingDeletions.push(entry);
    if (!metadata.hiddenThreads.includes(id)) metadata.hiddenThreads.push(id);
    writeJson(METADATA_FILE, metadata);
    return { ...entry };
  }

  dueThreadDeletions(now = Date.now()) {
    return this.pendingDeletions().filter((entry) => entry.expiresAt <= now);
  }

  completeThreadDeletion(threadId) {
    const id = String(threadId || "").trim();
    if (!id) throw new Error("无效的会话 ID。");
    const metadata = this.metadata();
    metadata.pendingDeletions = metadata.pendingDeletions.filter((item) => item.threadId !== id);
    metadata.hiddenThreads = metadata.hiddenThreads.filter((item) => item !== id);
    metadata.localArchivedThreads = metadata.localArchivedThreads.filter((item) => item !== id);
    if (!metadata.deletedThreads.includes(id)) metadata.deletedThreads.push(id);
    delete metadata.projectThreads[id];
    delete metadata.threadAliases[id];
    delete metadata.threadDecorations[id];
    delete metadata.threadBranches[id];
    delete metadata.threadTimeline[id];
    delete metadata.messageQueues[id];
    for (const key of Object.keys(metadata.threadSettings)) {
      if (key.endsWith(`:${id}`)) delete metadata.threadSettings[key];
    }
    writeJson(METADATA_FILE, metadata);
    return [...metadata.deletedThreads];
  }

  deleteThreadNow(threadId) {
    return this.completeThreadDeletion(threadId);
  }

  saveScheduledTask(input) {
    const id = String(input?.id || "").trim();
    const prompt = String(input?.prompt || "").trim();
    const title = String(input?.title || prompt.split(/\r?\n/)[0] || "").trim().replace(/\s+/g, " ");
    const scheduledAt = Number(input?.scheduledAt);
    const repeat = SCHEDULE_REPEATS.has(input?.repeat) ? input.repeat : "once";
    if (!prompt) throw new Error("任务内容不能为空。");
    if (prompt.length > 20000) throw new Error("任务内容不能超过 20000 个字符。");
    if (!title) throw new Error("任务名称不能为空。");
    if (title.length > 120) throw new Error("任务名称不能超过 120 个字符。");
    if (!Number.isFinite(scheduledAt) || scheduledAt <= 0) throw new Error("请选择有效的执行时间。");
    const metadata = this.metadata();
    const projectId = String(input?.projectId || "").trim() || null;
    const providerId = String(input?.providerId || "").trim() || null;
    if (projectId && !metadata.projects.some((project) => project.id === projectId)) {
      throw new Error("Project 不存在。");
    }
    if (providerId
      && !BASE_PROVIDERS[providerId]
      && !metadata.relays.some((provider) => provider.id === providerId)
      && !metadata.accounts.some((provider) => provider.id === providerId)) {
      throw new Error("连接不存在。");
    }
    const existing = id ? metadata.scheduledTasks.find((task) => task.id === id) : null;
    if (id && !existing) throw new Error("已安排任务不存在。");
    const now = Date.now();
    const task = existing || {
      id: cleanId("task"),
      createdAt: now,
      lastRunAt: null,
      lastThreadId: null,
      lastError: null,
      retryAt: null,
      lastStartedAt: null,
      consecutiveFailures: 0,
      runHistory: [],
    };
    Object.assign(task, {
      title,
      prompt,
      scheduledAt,
      repeat,
      enabled: input?.enabled !== false,
      providerId,
      projectId,
      workspace: String(input?.workspace || "").trim() || null,
      model: String(input?.model || "").trim() || null,
      effort: ["low", "medium", "high", "xhigh", "max", "ultra"].includes(input?.effort)
        ? input.effort
        : "high",
      approvalMode: ["ask", "auto", "full"].includes(input?.approvalMode)
        ? input.approvalMode
        : "auto",
      timeZone: String(input?.timeZone || "").trim()
        || Intl.DateTimeFormat().resolvedOptions().timeZone
        || "Asia/Shanghai",
      scheduleAnchorDay: new Date(scheduledAt).getDate(),
      notifyOnCompletion: input?.notifyOnCompletion !== false,
      retryOnFailure: input?.retryOnFailure !== false,
      updatedAt: now,
    });
    task.retryAt = null;
    task.lastError = null;
    if (!existing) metadata.scheduledTasks.push(task);
    writeJson(METADATA_FILE, metadata);
    return { ...task };
  }

  removeScheduledTask(taskId) {
    const id = String(taskId || "").trim();
    const metadata = this.metadata();
    const index = metadata.scheduledTasks.findIndex((task) => task.id === id);
    if (index < 0) throw new Error("已安排任务不存在。");
    const [task] = metadata.scheduledTasks.splice(index, 1);
    writeJson(METADATA_FILE, metadata);
    return { ...task };
  }

  setScheduledTaskEnabled(taskId, enabled) {
    const id = String(taskId || "").trim();
    const metadata = this.metadata();
    const task = metadata.scheduledTasks.find((item) => item.id === id);
    if (!task) throw new Error("已安排任务不存在。");
    if (enabled
      && task.providerId
      && !BASE_PROVIDERS[task.providerId]
      && !metadata.relays.some((provider) => provider.id === task.providerId)
      && !metadata.accounts.some((provider) => provider.id === task.providerId)) {
      throw new Error("原连接已删除，请先编辑任务并选择新的连接。");
    }
    task.enabled = Boolean(enabled);
    task.updatedAt = Date.now();
    task.retryAt = null;
    writeJson(METADATA_FILE, metadata);
    return { ...task };
  }

  dueScheduledTasks(now = Date.now()) {
    return this.scheduledTasks().filter((task) => (
      task.enabled
      && (task.retryAt || task.scheduledAt) <= now
    ));
  }

  beginScheduledTaskRun(taskId, manual = false, now = Date.now()) {
    const id = String(taskId || "").trim();
    const metadata = this.metadata();
    const task = metadata.scheduledTasks.find((item) => item.id === id);
    if (!task) throw new Error("已安排任务不存在。");
    const run = {
      id: cleanId("run"),
      startedAt: now,
      finishedAt: null,
      status: "running",
      manual: Boolean(manual),
      threadId: null,
      error: null,
    };
    task.lastStartedAt = now;
    task.runHistory = [run, ...(Array.isArray(task.runHistory) ? task.runHistory : [])].slice(0, 20);
    task.updatedAt = now;
    writeJson(METADATA_FILE, metadata);
    return { ...run };
  }

  completeScheduledTask(taskId, threadId, now = Date.now(), options = {}) {
    const id = String(taskId || "").trim();
    const metadata = this.metadata();
    const task = metadata.scheduledTasks.find((item) => item.id === id);
    if (!task) return null;
    task.lastRunAt = now;
    task.lastThreadId = String(threadId || "").trim() || null;
    task.lastError = null;
    task.retryAt = null;
    task.consecutiveFailures = 0;
    const run = (task.runHistory || []).find((item) => item.id === options.runId)
      || (task.runHistory || []).find((item) => item.status === "running");
    if (run) Object.assign(run, { status: "completed", finishedAt: now, threadId: task.lastThreadId, error: null });
    if (!options.manual) {
      const next = nextScheduledAt(task.scheduledAt, task.repeat, now, task.scheduleAnchorDay);
      if (next === null) task.enabled = false;
      else task.scheduledAt = next;
    }
    task.updatedAt = now;
    writeJson(METADATA_FILE, metadata);
    return { ...task };
  }

  failScheduledTask(taskId, error, now = Date.now(), options = {}) {
    const id = String(taskId || "").trim();
    const metadata = this.metadata();
    const task = metadata.scheduledTasks.find((item) => item.id === id);
    if (!task) return null;
    task.lastError = String(error?.message || error || "任务执行失败").slice(0, 500);
    const run = (task.runHistory || []).find((item) => item.id === options.runId)
      || (task.runHistory || []).find((item) => item.status === "running");
    if (run) Object.assign(run, { status: "failed", finishedAt: now, error: task.lastError });
    if (!options.manual) {
      task.consecutiveFailures = (Number(task.consecutiveFailures) || 0) + 1;
      const retryDelays = [5, 15, 60];
      if (task.retryOnFailure !== false && task.consecutiveFailures <= retryDelays.length) {
        task.retryAt = now + retryDelays[task.consecutiveFailures - 1] * 60 * 1000;
      } else {
        task.retryAt = null;
        const next = nextScheduledAt(task.scheduledAt, task.repeat, now, task.scheduleAnchorDay);
        if (next === null) task.enabled = false;
        else task.scheduledAt = next;
      }
    }
    task.updatedAt = now;
    writeJson(METADATA_FILE, metadata);
    return { ...task };
  }

  addRelay(input) {
    const request = input && typeof input === "object" ? input : {};
    const label = String(request.label || "").trim();
    const rawBaseUrl = String(request.baseUrl || "").trim();
    const model = String(request.model || "").trim();
    const apiKey = String(request.apiKey || "").trim();
    const discoveredModels = [...new Set((Array.isArray(request.discoveredModels) ? request.discoveredModels : [])
      .map((item) => String(item || "").trim()).filter(Boolean))];
    const preset = Object.hasOwn(PROVIDER_PRESETS, request.preset) ? request.preset : "custom";
    const protocol = ["responses", "chat_completions"].includes(request.protocol)
      ? request.protocol
      : PROVIDER_PRESETS[preset].protocol;
    let parsedBaseUrl;
    try {
      parsedBaseUrl = new URL(rawBaseUrl);
    } catch {
      parsedBaseUrl = null;
    }
    if (!label || !parsedBaseUrl || !["http:", "https:"].includes(parsedBaseUrl.protocol) || !model || !apiKey) {
      throw new Error("中转站名称、有效 Base URL、模型和 API Key 均为必填项。");
    }
    if (parsedBaseUrl.username || parsedBaseUrl.password) throw new Error("Base URL 中不能包含用户名或密码。");
    if (parsedBaseUrl.search || parsedBaseUrl.hash) throw new Error("Base URL 不能包含 query 参数或 hash。");
    const baseUrl = parsedBaseUrl.toString().replace(/\/+$/, "");
    if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows 安全存储当前不可用，未保存 API Key。");
    const id = cleanId("relay");
    const secrets = readJson(SECRETS_FILE, {});
    secrets[id] = safeStorage.encryptString(apiKey).toString("base64");
    writeJson(SECRETS_FILE, secrets);
    const metadata = this.metadata();
    metadata.relays.push({ id, label, baseUrl, model, protocol, preset, discoveredModels, createdAt: Date.now() });
    writeJson(METADATA_FILE, metadata);
    return this.publicProvider(id);
  }

  updateRelay(input) {
    const request = input && typeof input === "object" ? input : {};
    const id = String(request.id || "").trim();
    const label = String(request.label || "").trim();
    const rawBaseUrl = String(request.baseUrl || "").trim();
    const model = String(request.model || "").trim();
    const apiKey = String(request.apiKey || "").trim();
    const preset = Object.hasOwn(PROVIDER_PRESETS, request.preset) ? request.preset : "custom";
    const protocol = ["responses", "chat_completions"].includes(request.protocol)
      ? request.protocol
      : PROVIDER_PRESETS[preset].protocol;
    let parsedBaseUrl;
    try {
      parsedBaseUrl = new URL(rawBaseUrl);
    } catch {
      parsedBaseUrl = null;
    }
    if (!id || !label || !parsedBaseUrl || !["http:", "https:"].includes(parsedBaseUrl.protocol) || !model) {
      throw new Error("供应商名称、有效 Base URL 和默认模型均为必填项。");
    }
    if (parsedBaseUrl.username || parsedBaseUrl.password || parsedBaseUrl.search || parsedBaseUrl.hash) {
      throw new Error("Base URL 不能包含凭据、query 参数或 hash。");
    }
    const metadata = this.metadata();
    const relay = metadata.relays.find((item) => item.id === id);
    if (!relay) throw new Error("模型供应商不存在。");
    if (apiKey) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows 安全存储当前不可用，未保存 API Key。");
      const secrets = readJson(SECRETS_FILE, {});
      secrets[id] = safeStorage.encryptString(apiKey).toString("base64");
      writeJson(SECRETS_FILE, secrets);
    }
    Object.assign(relay, {
      label,
      baseUrl: parsedBaseUrl.toString().replace(/\/+$/, ""),
      model,
      protocol,
      preset,
      discoveredModels: [...new Set((Array.isArray(request.discoveredModels) ? request.discoveredModels : relay.discoveredModels || [])
        .map((item) => String(item || "").trim()).filter(Boolean))],
      updatedAt: Date.now(),
    });
    writeJson(METADATA_FILE, metadata);
    return this.publicProvider(id);
  }

  updateBuiltinApi(input) {
    const request = input && typeof input === "object" ? input : {};
    const id = String(request.id || "").trim();
    if (!["niubi", "hexuan"].includes(id)) throw new Error("该连接不是可编辑的内置 API。");
    const label = String(request.label || "").trim();
    const rawBaseUrl = String(request.baseUrl || "").trim();
    const model = String(request.model || "").trim();
    let parsedBaseUrl;
    try { parsedBaseUrl = new URL(rawBaseUrl); } catch { parsedBaseUrl = null; }
    if (!label || !parsedBaseUrl || !["http:", "https:"].includes(parsedBaseUrl.protocol) || !model) {
      throw new Error("供应商名称、有效 Base URL 和默认模型均为必填项。");
    }
    if (parsedBaseUrl.username || parsedBaseUrl.password || parsedBaseUrl.search || parsedBaseUrl.hash) {
      throw new Error("Base URL 不能包含凭据、query 参数或 hash。");
    }
    const discoveredModels = [...new Set((Array.isArray(request.discoveredModels) ? request.discoveredModels : [])
      .map((item) => String(item || "").trim()).filter(Boolean))];
    const metadata = this.metadata();
    metadata.providerSettings[id] = {
      ...(metadata.providerSettings[id] || {}),
      baseUrl: parsedBaseUrl.toString().replace(/\/+$/, ""),
      model,
      discoveredModels,
      updatedAt: Date.now(),
    };
    writeJson(METADATA_FILE, metadata);
    const apiKey = String(request.apiKey || "").trim();
    if (apiKey) this.saveProviderKey(id, apiKey);
    return this.publicProvider(id);
  }

  saveProviderKey(id, apiKey) {
    const providerId = String(id || "").trim();
    const value = String(apiKey || "").trim();
    const relay = this.metadata().relays.find((item) => item.id === providerId);
    if (!["niubi", "hexuan", "claude"].includes(providerId) && !relay) {
      throw new Error("该连接不支持单独配置 API Key。");
    }
    if (!value) throw new Error("API Key 不能为空。");
    if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows 安全存储当前不可用，未保存 API Key。");
    const secrets = readJson(SECRETS_FILE, {});
    secrets[relay ? providerId : `builtin:${providerId}`] = safeStorage.encryptString(value).toString("base64");
    writeJson(SECRETS_FILE, secrets);
    return this.publicProvider(providerId);
  }

  addAccount(input) {
    const label = String(input?.label || "").trim() || "ChatGPT 官方账号";
    const id = cleanId("account");
    const home = path.join(STORE_ROOT, "accounts", id);
    fs.mkdirSync(home, { recursive: true });
    ensureJunction(path.join(home, "sessions"), path.join(this.conversationHome(), "sessions"));
    ensureJunction(path.join(home, "archived_sessions"), path.join(this.conversationHome(), "archived_sessions"));
    ensureJunction(path.join(home, "skills"), path.join(this.conversationHome(), "skills"));
    const metadata = this.metadata();
    metadata.accounts.push({ id, label, home, createdAt: Date.now() });
    writeJson(METADATA_FILE, metadata);
    return this.publicProvider(id);
  }

  removeConnection(id) {
    const providerId = String(id || "").trim();
    const metadata = this.metadata();
    const relay = metadata.relays.find((item) => item.id === providerId);
    const account = metadata.accounts.find((item) => item.id === providerId);
    if (!relay && !account) throw new Error("内置连接不能删除。");

    if (account) {
      const authFile = path.join(account.home, "auth.json");
      if (fs.existsSync(authFile)) fs.unlinkSync(authFile);
      metadata.accounts = metadata.accounts.filter((item) => item.id !== providerId);
    } else {
      metadata.relays = metadata.relays.filter((item) => item.id !== providerId);
      const secrets = readJson(SECRETS_FILE, {});
      delete secrets[providerId];
      writeJson(SECRETS_FILE, secrets);
      const catalog = path.join(STORE_ROOT, "model-catalogs", `${providerId}.json`);
      if (fs.existsSync(catalog)) fs.unlinkSync(catalog);
    }

    for (const key of Object.keys(metadata.threadSettings)) {
      if (key.startsWith(`${providerId}:`)) delete metadata.threadSettings[key];
    }
    for (const task of metadata.scheduledTasks) {
      if (task.providerId !== providerId) continue;
      task.enabled = false;
      task.lastError = "原连接已删除，请编辑任务并选择新的连接。";
      task.retryAt = null;
      task.updatedAt = Date.now();
    }
    for (const providers of Object.values(metadata.threadBranches)) {
      if (providers && typeof providers === "object") delete providers[providerId];
    }
    for (const [logicalId, timeline] of Object.entries(metadata.threadTimeline)) {
      metadata.threadTimeline[logicalId] = Array.isArray(timeline)
        ? timeline.filter((entry) => entry.providerId !== providerId)
        : [];
    }
    delete metadata.providerRoutes[providerId];
    metadata.providerOrder = metadata.providerOrder.filter((item) => item !== providerId);
    for (const route of Object.values(metadata.providerRoutes)) {
      if (!route || typeof route !== "object") continue;
      route.fallbackProviderIds = (route.fallbackProviderIds || []).filter((id) => id !== providerId);
      if (!route.fallbackProviderIds.length) route.enabled = false;
    }
    writeJson(METADATA_FILE, metadata);
    return {
      id: providerId,
      type: relay ? "relay" : "account",
      label: relay?.label || account.label,
    };
  }

  resolve(id) {
    const conversationHome = this.conversationHome();
    if (id === "claude") {
      const settings = this.metadata().providerSettings.claude || {};
      const provider = {
        ...BASE_PROVIDERS.claude,
        ...settings,
        codexHome: conversationHome,
        claudeConfigDir: path.join(conversationHome, "claude"),
      };
      provider.vendorLabel ||= claudeVendorLabel(provider.baseUrl);
      const storedKey = this.decryptStoredProviderKey(id);
      if (storedKey) provider.env = { [provider.envKey]: storedKey };
      return provider;
    }
    if (BASE_PROVIDERS[id]) {
      const settings = ["niubi", "hexuan"].includes(id)
        ? (this.metadata().providerSettings[id] || {})
        : {};
      const provider = { ...BASE_PROVIDERS[id], ...settings, codexHome: conversationHome };
      if (["niubi", "hexuan"].includes(id) && Array.isArray(provider.args)) {
        provider.args = provider.args.map((value, index, args) => {
          if (value.startsWith("model=") && args[index - 1] === "-c") return `model=${JSON.stringify(provider.model)}`;
          if (value.startsWith(`model_providers.${id}.base_url=`) && args[index - 1] === "-c") {
            return `model_providers.${id}.base_url=${JSON.stringify(provider.baseUrl)}`;
          }
          return value;
        });
      }
      const storedKey = this.decryptStoredProviderKey(id);
      if (storedKey && provider.envKey) provider.env = { [provider.envKey]: storedKey };
      return this.withMcpConfiguration(provider);
    }
    const metadata = this.metadata();
    const relay = metadata.relays.find((item) => item.id === id);
    if (relay) {
      const apiKey = this.decryptRelayKey(relay.id);
      if ((relay.protocol || "responses") === "chat_completions") {
        return {
          ...relay,
          type: "relay",
          engine: "openai-compatible",
          modelProvider: relay.id,
          envKey: "CHATSWITCH_RELAY_API_KEY",
          apiKey,
          env: apiKey ? { CHATSWITCH_RELAY_API_KEY: apiKey } : {},
          codexHome: conversationHome,
        };
      }
      const catalog = providerModelCatalog(relay.id, relay.model);
      return this.withMcpConfiguration({
        ...relay,
        type: "relay",
        modelProvider: relay.id,
        envKey: "CHATSWITCH_RELAY_API_KEY",
        balanceType: "auto",
        args: [
          "-c", `model_provider=${JSON.stringify(relay.id)}`,
          "-c", `model=${JSON.stringify(relay.model)}`,
          "-c", `model_catalog_json=${JSON.stringify(catalog)}`,
          "-c", "features.apps=false",
          "-c", "features.remote_plugin=false",
          "-c", `model_providers.${relay.id}.name=${JSON.stringify(relay.label)}`,
          "-c", `model_providers.${relay.id}.base_url=${JSON.stringify(relay.baseUrl)}`,
          "-c", `model_providers.${relay.id}.env_key=${JSON.stringify("CHATSWITCH_RELAY_API_KEY")}`,
          "-c", `model_providers.${relay.id}.wire_api=${JSON.stringify("responses")}`,
          "app-server",
        ],
        env: apiKey ? { CHATSWITCH_RELAY_API_KEY: apiKey } : {},
        codexHome: conversationHome,
      });
    }
    const account = metadata.accounts.find((item) => item.id === id);
    if (account) {
      ensureJunction(path.join(account.home, "sessions"), path.join(conversationHome, "sessions"));
      ensureJunction(path.join(account.home, "archived_sessions"), path.join(conversationHome, "archived_sessions"));
      ensureJunction(path.join(account.home, "skills"), path.join(conversationHome, "skills"));
      return this.withMcpConfiguration({
        ...account,
        type: "account",
        modelProvider: "openai",
        codexHome: account.home,
        sqliteHome: conversationHome,
        args: [
          "-c", "model_provider=\"openai\"",
          "-c", "cli_auth_credentials_store=\"file\"",
          "-c", "features.apps=false",
          "-c", "features.remote_plugin=false",
          "app-server",
        ],
      });
    }
    throw new Error(`Unknown provider: ${id}`);
  }

  withMcpConfiguration(provider) {
    if (!provider || !Array.isArray(provider.args) || provider.engine === "openai-compatible") return provider;
    const enabled = this.mcpServers().filter((server) => server.enabled !== false);
    if (!enabled.length) return provider;
    const args = [...provider.args];
    const appServerIndex = args.lastIndexOf("app-server");
    const insertAt = appServerIndex >= 0 ? appServerIndex : args.length;
    const settings = [];
    const env = { ...(provider.env || {}) };
    for (const server of enabled) {
      const key = `mcp_servers.${server.id}`;
      if (server.transport === "stdio") {
        settings.push("-c", `${key}.command=${JSON.stringify(server.command)}`);
        settings.push("-c", `${key}.args=${JSON.stringify(server.args || [])}`);
      } else {
        settings.push("-c", `${key}.url=${JSON.stringify(server.url)}`);
        if (server.envKeys?.[0]) {
          settings.push("-c", `${key}.bearer_token_env_var=${JSON.stringify(server.envKeys[0])}`);
        }
      }
      Object.assign(env, this.mcpEnvironment(server.id));
    }
    args.splice(insertAt, 0, ...settings);
    return { ...provider, args, env };
  }

  withModelCatalog(provider, models) {
    if (!provider?.id) return provider;
    const discoveredModels = [...new Set(
      models.map((model) => String(model || "").trim()).filter(Boolean),
    )];
    if (!discoveredModels.length) return provider;
    const effectiveModel = discoveredModels.includes(provider.model)
      ? provider.model
      : discoveredModels[0];
    if (provider.engine === "openai-compatible") {
      return {
        ...provider,
        discoveredModels: [...new Set([provider.model, ...discoveredModels].filter(Boolean))],
      };
    }
    if (!Array.isArray(provider.args)) return provider;
    const catalog = providerModelCatalog(provider.id, effectiveModel, discoveredModels);
    const args = [...provider.args];
    const catalogIndex = args.findIndex((item) => (
      typeof item === "string" && item.startsWith("model_catalog_json=")
    ));
    const setting = `model_catalog_json=${JSON.stringify(catalog)}`;
    if (catalogIndex >= 0) args[catalogIndex] = setting;
    else {
      const appServerIndex = args.lastIndexOf("app-server");
      args.splice(appServerIndex >= 0 ? appServerIndex : args.length, 0, "-c", setting);
    }
    const modelIndex = args.findIndex((item) => typeof item === "string" && item.startsWith("model="));
    if (modelIndex >= 0) args[modelIndex] = `model=${JSON.stringify(effectiveModel)}`;
    else {
      const appServerIndex = args.lastIndexOf("app-server");
      args.splice(appServerIndex >= 0 ? appServerIndex : args.length, 0, "-c", `model=${JSON.stringify(effectiveModel)}`);
    }
    return { ...provider, model: effectiveModel, args, discoveredModels };
  }

  saveClaudeSettings(input) {
    const rawBaseUrl = String(input?.baseUrl || "").trim();
    const model = String(input?.model || "").trim();
    const requestedVendorLabel = String(input?.vendorLabel || "").trim();
    let baseUrl;
    try {
      const parsed = new URL(rawBaseUrl);
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error();
      baseUrl = parsed.toString().replace(/\/+$/, "");
    } catch {
      throw new Error("请输入有效的 Claude Base URL。");
    }
    if (!model) throw new Error("请选择 Claude 模型。");
    const metadata = this.metadata();
    const existing = metadata.providerSettings.claude || {};
    const officialHost = new URL(baseUrl).hostname.toLowerCase() === "api.anthropic.com";
    const requestedAuthMode = String(input?.authMode || existing.authMode || "token").trim();
    const authMode = requestedAuthMode === "oauth" && officialHost ? "oauth" : "token";
    metadata.providerSettings.claude = {
      baseUrl,
      model,
      vendorLabel: requestedVendorLabel || claudeVendorLabel(baseUrl),
      authMode,
      updatedAt: Date.now(),
    };
    writeJson(METADATA_FILE, metadata);
    return this.publicProvider("claude");
  }

  decryptRelayKey(id) {
    const encoded = readJson(SECRETS_FILE, {})[id];
    if (!encoded) return null;
    try {
      return safeStorage.decryptString(Buffer.from(encoded, "base64"));
    } catch {
      return null;
    }
  }

  hasRelayKey(id) {
    return Boolean(readJson(SECRETS_FILE, {})[id]);
  }

  hasStoredProviderKey(id) {
    return Boolean(readJson(SECRETS_FILE, {})[`builtin:${id}`]);
  }

  decryptStoredProviderKey(id) {
    const encoded = readJson(SECRETS_FILE, {})[`builtin:${id}`];
    if (!encoded) return null;
    try {
      return safeStorage.decryptString(Buffer.from(encoded, "base64"));
    } catch {
      // Chromium profiles have distinct encryption contexts; prompt for the key in this profile.
      return null;
    }
  }
}

module.exports = {
  ProviderStore,
  STORE_ROOT,
  DEFAULT_CONVERSATION_HOME,
  ISOLATED_STORE,
  reasoningProfile,
  seedOfficialCredentials,
  PROVIDER_PRESETS,
  providerPresetCatalog,
  nextScheduledAt,
  providerApiKey,
};
