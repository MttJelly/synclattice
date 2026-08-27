const fs = require("node:fs");
const path = require("node:path");
const { extractOfficeText } = require("./office-text");
const { extractPdfText } = require("./pdf-text");

const TEXT_EXTENSIONS = new Set([".txt", ".md", ".csv", ".json"]);
const OFFICE_EXTENSIONS = new Set([".docx", ".xlsx", ".pptx"]);
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_CHARACTERS = 120000;

function extractAttachmentText(filePath, options = {}) {
  const resolved = path.resolve(String(filePath || ""));
  const extension = String(options.extension || path.extname(resolved)).toLowerCase();
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0
    ? Math.floor(options.maxBytes)
    : DEFAULT_MAX_BYTES;
  const maxCharacters = Number.isFinite(options.maxCharacters) && options.maxCharacters > 0
    ? Math.floor(options.maxCharacters)
    : DEFAULT_MAX_CHARACTERS;
  const stats = fs.statSync(resolved);
  if (!stats.isFile()) throw new Error("附件路径不是文件。");
  if (TEXT_EXTENSIONS.has(extension)) {
    if (stats.size > maxBytes) throw new Error("文本文件超过 5 MB，无法提取文本。");
    const content = fs.readFileSync(resolved, "utf8").replace(/^\uFEFF/, "");
    if (content.includes("\u0000")) throw new Error("该文件不是可读文本，请使用系统程序打开。");
    return { text: content.slice(0, maxCharacters), truncated: content.length > maxCharacters, sections: 1 };
  }
  if (extension === ".pdf") return extractPdfText(resolved, { maxCharacters });
  if (OFFICE_EXTENSIONS.has(extension)) return extractOfficeText(resolved, { extension, maxCharacters });
  throw new Error("当前格式暂不支持文本提取。");
}

module.exports = { extractAttachmentText, TEXT_EXTENSIONS, OFFICE_EXTENSIONS };
