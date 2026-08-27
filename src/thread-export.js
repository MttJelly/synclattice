const fs = require("node:fs");

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[character]));
}

function threadExportContent(thread = {}) {
  const title = String(thread.name || thread.preview || "ChatSwitch 会话").trim().slice(0, 80) || "ChatSwitch 会话";
  const safeTitle = title.replace(/[<>:"/\\|?*]+/g, "_");
  const rows = (thread.turns || []).flatMap((turn) => (turn.items || []).map((item) => {
    const role = item.type === "userMessage" ? "用户" : item.type === "reasoning" ? "推理摘要" : "助手";
    const text = item.type === "userMessage"
      ? (item.content || []).map((part) => part.text || "").join("\n")
      : item.text || (item.summary || []).map((part) => part.text || "").join("\n");
    return { role, text: String(text || "").trim() };
  }).filter((item) => item.text));
  const markdown = `# ${title}\n\n${rows.map((row) => `## ${row.role}\n\n${row.text}`).join("\n\n---\n\n")}\n`;
  const html = `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>body{font:16px system-ui;max-width:860px;margin:40px auto;line-height:1.65;color:#1b2529}h1{border-bottom:1px solid #d6dfe0;padding-bottom:12px}h2{margin-top:28px;color:#087f68;white-space:pre-wrap}p{white-space:pre-wrap}</style><h1>${escapeHtml(title)}</h1>${rows.map((row) => `<h2>${escapeHtml(row.role)}</h2><p>${escapeHtml(row.text)}</p>`).join("")}`;
  return {
    title,
    safeTitle,
    rows,
    markdown,
    html,
    json: `${JSON.stringify(thread, null, 2)}\n`,
  };
}

async function writeThreadExportFile(filePath, format, thread, pdfWriter) {
  const normalizedFormat = ["md", "html", "json", "pdf"].includes(format) ? format : "md";
  const exported = threadExportContent(thread);
  if (normalizedFormat === "json") fs.writeFileSync(filePath, exported.json, "utf8");
  else if (normalizedFormat === "html") fs.writeFileSync(filePath, exported.html, "utf8");
  else if (normalizedFormat === "md") fs.writeFileSync(filePath, exported.markdown, "utf8");
  else {
    if (typeof pdfWriter !== "function") throw new Error("PDF 导出需要提供 PDF 写入器。");
    fs.writeFileSync(filePath, await pdfWriter(exported.html));
  }
  return { filePath, format: normalizedFormat, exported };
}

module.exports = { escapeHtml, threadExportContent, writeThreadExportFile };
