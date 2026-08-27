const fs = require("node:fs");
const path = require("node:path");

let pdfJsPromise = null;

function pdfJs() {
  pdfJsPromise ||= import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfJsPromise;
}

function textFromPageContent(content = {}) {
  let text = "";
  for (const item of content.items || []) {
    const value = String(item?.str || "");
    if (!value) continue;
    text += value;
    text += item.hasEOL ? "\n" : " ";
  }
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

async function extractPdfText(filePath, options = {}) {
  const resolved = path.resolve(String(filePath || ""));
  const maxCharacters = Math.max(1, Number(options.maxCharacters) || 120000);
  const data = new Uint8Array(fs.readFileSync(resolved));
  const { getDocument } = await pdfJs();
  const loadingTask = getDocument({
    data,
    disableWorker: true,
    isEvalSupported: false,
    useSystemFonts: true,
  });
  let document = null;
  try {
    document = await loadingTask.promise;
    const pages = [];
    let length = 0;
    let truncated = false;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const pageText = textFromPageContent(await page.getTextContent());
      page.cleanup();
      if (!pageText) continue;
      const section = document.numPages > 1 ? `[第 ${pageNumber} 页]\n${pageText}` : pageText;
      const remaining = maxCharacters - length;
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      pages.push(section.slice(0, remaining));
      length += Math.min(section.length, remaining);
      if (section.length > remaining) {
        truncated = true;
        break;
      }
    }
    const text = pages.join("\n\n").trim();
    if (!text) throw new Error(`${path.basename(resolved)} 没有可提取的文字层；扫描件需要先进行 OCR。`);
    return { text, pages: document.numPages, truncated };
  } finally {
    if (document) await document.destroy();
    else await loadingTask.destroy().catch(() => {});
  }
}

module.exports = { extractPdfText, textFromPageContent };
