const fs = require("node:fs");
const path = require("node:path");
const { DOMParser } = require("@xmldom/xmldom");
const { strFromU8, unzipSync } = require("fflate");

const DEFAULT_MAX_CHARACTERS = 5 * 1024 * 1024;
const MAX_XML_MEMBER_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_XML_BYTES = 40 * 1024 * 1024;

function parseXml(source, label) {
  const document = new DOMParser().parseFromString(String(source || ""), "application/xml");
  if (!document?.documentElement || elementsByLocalName(document, "parsererror").length) {
    throw new Error(`${label} XML 无法解析。`);
  }
  return document;
}

function elementsByLocalName(root, localName) {
  const matches = [];
  const visit = (node) => {
    if (!node) return;
    if (node.nodeType === 1 && (node.localName || node.nodeName?.split(":").at(-1)) === localName) {
      matches.push(node);
    }
    for (let child = node.firstChild; child; child = child.nextSibling) visit(child);
  };
  visit(root);
  return matches;
}

function descendantText(root, localName = "t") {
  return elementsByLocalName(root, localName).map((node) => node.textContent || "").join("");
}

function naturalOfficePathCompare(left, right) {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

function wantedOfficeMember(extension, name) {
  const normalized = String(name || "").replaceAll("\\", "/");
  if (extension === ".docx") return normalized === "word/document.xml";
  if (extension === ".xlsx") {
    return normalized === "xl/workbook.xml"
      || normalized === "xl/_rels/workbook.xml.rels"
      || normalized === "xl/sharedStrings.xml"
      || /^xl\/worksheets\/[^/]+\.xml$/i.test(normalized);
  }
  if (extension === ".pptx") {
    return normalized === "ppt/presentation.xml"
      || normalized === "ppt/_rels/presentation.xml.rels"
      || /^ppt\/slides\/slide\d+\.xml$/i.test(normalized);
  }
  return false;
}

function readOfficeArchive(filePath, extension) {
  let selectedBytes = 0;
  let skippedLargeMember = false;
  const archive = unzipSync(fs.readFileSync(filePath), {
    filter(member) {
      if (!wantedOfficeMember(extension, member.name)) return false;
      const size = Number(member.originalSize || 0);
      if (size > MAX_XML_MEMBER_BYTES || selectedBytes + size > MAX_TOTAL_XML_BYTES) {
        skippedLargeMember = true;
        return false;
      }
      selectedBytes += size;
      return true;
    },
  });
  const members = new Map(Object.entries(archive).map(([name, bytes]) => [name.replaceAll("\\", "/"), strFromU8(bytes)]));
  return { members, skippedLargeMember };
}

function relationshipTargets(xml, baseDirectory) {
  if (!xml) return new Map();
  const relationships = parseXml(xml, "Office 关系");
  const targets = new Map();
  for (const node of elementsByLocalName(relationships, "Relationship")) {
    if (String(node.getAttribute("TargetMode") || "").toLowerCase() === "external") continue;
    const id = String(node.getAttribute("Id") || "").trim();
    const target = String(node.getAttribute("Target") || "").replaceAll("\\", "/").trim();
    if (!id || !target) continue;
    const resolved = target.startsWith("/")
      ? path.posix.normalize(target.slice(1))
      : path.posix.normalize(path.posix.join(baseDirectory, target));
    if (resolved.startsWith("../") || path.posix.isAbsolute(resolved)) continue;
    targets.set(id, resolved);
  }
  return targets;
}

function orderedWorkbookSheets(members) {
  const fallback = [...members.keys()]
    .filter((name) => /^xl\/worksheets\/[^/]+\.xml$/i.test(name))
    .sort(naturalOfficePathCompare)
    .map((member, index) => ({ name: `工作表 ${index + 1}`, member }));
  const workbookXml = members.get("xl/workbook.xml");
  if (!workbookXml) return fallback;
  const relationships = relationshipTargets(members.get("xl/_rels/workbook.xml.rels"), "xl");
  const workbook = parseXml(workbookXml, "Excel 工作簿");
  const ordered = elementsByLocalName(workbook, "sheet").map((sheet, index) => {
    const relationshipId = sheet.getAttribute("r:id")
      || sheet.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
    return {
      name: String(sheet.getAttribute("name") || `工作表 ${index + 1}`).trim(),
      member: relationships.get(relationshipId),
    };
  }).filter((sheet) => sheet.member && members.has(sheet.member));
  return ordered.length ? ordered : fallback;
}

function sharedStrings(members) {
  const xml = members.get("xl/sharedStrings.xml");
  if (!xml) return [];
  const document = parseXml(xml, "Excel 共享字符串");
  return elementsByLocalName(document, "si").map((item) => descendantText(item));
}

function firstChildText(node, localName) {
  return elementsByLocalName(node, localName)[0]?.textContent || "";
}

function excelCellValue(cell, strings) {
  const type = String(cell.getAttribute("t") || "").toLowerCase();
  if (type === "inlinestr") return descendantText(cell);
  const raw = firstChildText(cell, "v");
  if (type === "s") return strings[Number.parseInt(raw, 10)] ?? raw;
  if (type === "b") return raw === "1" ? "TRUE" : raw === "0" ? "FALSE" : raw;
  if (raw) return raw;
  return descendantText(cell);
}

function xlsxText(members) {
  const strings = sharedStrings(members);
  const sections = [];
  for (const sheet of orderedWorkbookSheets(members)) {
    const worksheet = parseXml(members.get(sheet.member), `Excel ${sheet.name}`);
    const rows = elementsByLocalName(worksheet, "row").map((row) => {
      return elementsByLocalName(row, "c").map((cell) => {
        const reference = String(cell.getAttribute("r") || "").trim();
        const value = excelCellValue(cell, strings).replace(/\r?\n/g, " ").trim();
        if (!value) return "";
        return reference ? `${reference}=${value}` : value;
      }).filter(Boolean).join("\t");
    }).filter(Boolean);
    sections.push(`[工作表：${sheet.name}]${rows.length ? `\n${rows.join("\n")}` : "\n（无可提取文本）"}`);
  }
  return sections.join("\n\n");
}

function orderedPresentationSlides(members) {
  const fallback = [...members.keys()]
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort(naturalOfficePathCompare);
  const presentationXml = members.get("ppt/presentation.xml");
  if (!presentationXml) return fallback;
  const relationships = relationshipTargets(members.get("ppt/_rels/presentation.xml.rels"), "ppt");
  const presentation = parseXml(presentationXml, "PowerPoint 演示文稿");
  const ordered = elementsByLocalName(presentation, "sldId").map((slide) => {
    const relationshipId = slide.getAttribute("r:id")
      || slide.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
    return relationships.get(relationshipId);
  }).filter((member) => member && members.has(member));
  return ordered.length ? ordered : fallback;
}

function pptxText(members) {
  return orderedPresentationSlides(members).map((member, index) => {
    const slide = parseXml(members.get(member), `PowerPoint 第 ${index + 1} 张幻灯片`);
    const paragraphs = elementsByLocalName(slide, "p")
      .map((paragraph) => descendantText(paragraph).trim())
      .filter(Boolean);
    return `[第 ${index + 1} 张幻灯片]${paragraphs.length ? `\n${paragraphs.join("\n")}` : "\n（无可提取文本）"}`;
  }).join("\n\n");
}

function docxText(members) {
  const xml = members.get("word/document.xml");
  if (!xml) return "";
  const document = parseXml(xml, "Word 文档");
  return elementsByLocalName(document, "p")
    .map((paragraph) => descendantText(paragraph).trim())
    .filter(Boolean)
    .join("\n");
}

function extractOfficeText(filePath, options = {}) {
  const extension = String(options.extension || path.extname(filePath)).toLowerCase();
  if (![".docx", ".xlsx", ".pptx"].includes(extension)) throw new Error("不支持此 Office 文件格式。");
  const maxCharacters = Number.isFinite(options.maxCharacters) && options.maxCharacters > 0
    ? Math.floor(options.maxCharacters)
    : DEFAULT_MAX_CHARACTERS;
  const { members, skippedLargeMember } = readOfficeArchive(filePath, extension);
  const completeText = extension === ".docx"
    ? docxText(members)
    : extension === ".xlsx" ? xlsxText(members) : pptxText(members);
  const text = completeText.slice(0, maxCharacters);
  return {
    text,
    truncated: skippedLargeMember || completeText.length > text.length,
    sections: extension === ".xlsx"
      ? orderedWorkbookSheets(members).length
      : extension === ".pptx" ? orderedPresentationSlides(members).length : 1,
  };
}

module.exports = {
  extractOfficeText,
  orderedPresentationSlides,
  orderedWorkbookSheets,
};
