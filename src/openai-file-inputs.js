const fs = require("node:fs");
const path = require("node:path");

const MAX_OPENAI_FILE_BYTES = 50 * 1024 * 1024;

const OPENAI_FILE_MIME_TYPES = {
  ".csv": "text/csv",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".json": "application/json",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt": "text/plain",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function isNativeOpenAIFileProvider(provider = {}) {
  if ((provider.protocol || "chat_completions") !== "responses") return false;
  try {
    const url = new URL(String(provider.baseUrl || "").trim());
    return url.protocol === "https:" && url.hostname.toLowerCase() === "api.openai.com";
  } catch {
    return false;
  }
}

function openAIFileEndpoint(baseUrl) {
  const parsed = new URL(String(baseUrl || "").trim());
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "api.openai.com") {
    throw new Error("原生文件上传只允许使用 OpenAI 官方 HTTPS API。");
  }
  let pathname = parsed.pathname.replace(/\/+$/, "");
  pathname = pathname.replace(/\/(?:responses|chat\/completions|files)$/i, "");
  parsed.pathname = `${pathname}/files`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function validateOpenAIFileInput(fileInput = {}) {
  const resolved = path.resolve(String(fileInput.path || ""));
  let stats;
  try {
    stats = fs.statSync(resolved);
  } catch {
    throw new Error(`找不到附件：${path.basename(resolved) || "未知文件"}`);
  }
  if (!stats.isFile()) throw new Error(`附件路径不是文件：${resolved}`);
  if (stats.size > MAX_OPENAI_FILE_BYTES) {
    throw new Error(`附件超过 OpenAI 单文件 50 MB 限制：${path.basename(resolved)}`);
  }
  const extension = path.extname(resolved).toLowerCase();
  const mimeType = OPENAI_FILE_MIME_TYPES[extension];
  if (!mimeType) throw new Error(`OpenAI 文件输入不支持此格式：${extension || path.basename(resolved)}`);
  return {
    path: resolved,
    fileName: path.basename(String(fileInput.fileName || "").trim() || resolved),
    mimeType,
    size: stats.size,
  };
}

module.exports = {
  MAX_OPENAI_FILE_BYTES,
  OPENAI_FILE_MIME_TYPES,
  isNativeOpenAIFileProvider,
  openAIFileEndpoint,
  validateOpenAIFileInput,
};
