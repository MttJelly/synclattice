const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function directorySnapshot(root) {
  const snapshot = [];
  const visit = async (directory, relativeRoot = "") => {
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en-US"));
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.join(relativeRoot, entry.name);
      const stat = entry.isSymbolicLink() ? await fsp.stat(absolute) : null;
      if (entry.isDirectory() || stat?.isDirectory()) {
        await visit(absolute, relative);
      } else if (entry.isFile() || stat?.isFile()) {
        const fileStat = stat || await fsp.stat(absolute);
        snapshot.push(`${relative}\0${fileStat.size}\0${Math.round(fileStat.mtimeMs)}`);
      }
    }
  };
  await visit(root);
  return snapshot;
}

async function directoriesMatch(source, target) {
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) return false;
  const [sourceSnapshot, targetSnapshot] = await Promise.all([
    directorySnapshot(source),
    directorySnapshot(target),
  ]);
  return sourceSnapshot.length === targetSnapshot.length
    && sourceSnapshot.every((entry, index) => entry === targetSnapshot[index]);
}

async function syncSkillRoots(sourceDirectories, targetDirectory) {
  const targetRoot = path.resolve(String(targetDirectory || ""));
  if (!targetDirectory) throw new Error("ChatSwitch skill target is required.");
  await fsp.mkdir(targetRoot, { recursive: true });
  const result = { copied: 0, skipped: 0, skippedSources: 0, names: [], sources: {} };
  const selectedSkills = new Map();

  for (const sourceDirectory of sourceDirectories || []) {
    const sourceRoot = path.resolve(String(sourceDirectory || ""));
    if (!sourceDirectory || sourceRoot === targetRoot
      || isInside(sourceRoot, targetRoot) || isInside(targetRoot, sourceRoot)
      || !fs.existsSync(sourceRoot) || !fs.statSync(sourceRoot).isDirectory()) {
      result.skippedSources += 1;
      continue;
    }
    const entries = await fsp.readdir(sourceRoot, { withFileTypes: true });
    for (const entry of entries) {
      if ((!entry.isDirectory() && !entry.isSymbolicLink()) || entry.name === ".system") continue;
      const source = path.join(sourceRoot, entry.name);
      if (!fs.existsSync(path.join(source, "SKILL.md")) || !fs.statSync(source).isDirectory()) continue;
      selectedSkills.set(entry.name, source);
    }
  }

  for (const [name, source] of selectedSkills) {
    const target = path.join(targetRoot, name);
    if (await directoriesMatch(source, target)) {
      result.skipped += 1;
    } else {
      await fsp.rm(target, { recursive: true, force: true });
      await fsp.cp(source, target, {
        recursive: true,
        force: true,
        dereference: true,
        preserveTimestamps: true,
        filter: (candidate) => path.basename(candidate) !== ".git",
      });
      result.copied += 1;
    }
    result.names.push(name);
    result.sources[name] = source;
  }
  result.names.sort((a, b) => a.localeCompare(b, "zh-CN"));
  return result;
}

function skillDescription(file) {
  try {
    const text = fs.readFileSync(file, "utf8");
    const frontmatter = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
    if (frontmatter) {
      const description = frontmatter[1].match(/^description:\s*(.+)$/mi)?.[1]?.trim();
      if (description) return description.replace(/^['"]|['"]$/g, "");
    }
    return text
      .replace(/^---[\s\S]*?---\s*/m, "")
      .split(/\r?\n/)
      .map((line) => line.replace(/^#+\s*/, "").trim())
      .find(Boolean) || "ChatSwitch Skill";
  } catch {
    return "ChatSwitch Skill";
  }
}

async function discoverSkillDirectories(sourceDirectory, maxDepth = 4) {
  const root = path.resolve(String(sourceDirectory || ""));
  if (!sourceDirectory || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error("Skill 来源目录不存在。");
  }
  const found = [];
  let visited = 0;
  const visit = async (directory, depth) => {
    visited += 1;
    if (visited > 2000) throw new Error("Skill 包目录数量过多。");
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    if (entries.some((entry) => entry.isSymbolicLink())) throw new Error("Skill 包不能包含符号链接。");
    if (entries.some((entry) => entry.isFile() && entry.name === "SKILL.md")) {
      found.push(directory);
      return;
    }
    if (depth >= maxDepth) return;
    for (const entry of entries) {
      if (!entry.isDirectory() || [".git", "node_modules", "dist", "build"].includes(entry.name)) continue;
      await visit(path.join(directory, entry.name), depth + 1);
    }
  };
  await visit(root, 0);
  return found;
}

async function validateSkillTree(directory) {
  let files = 0;
  let bytes = 0;
  const visit = async (current) => {
    for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const target = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Skill 包不能包含符号链接。");
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) {
        files += 1;
        bytes += (await fsp.stat(target)).size;
        if (files > 2000 || bytes > 25 * 1024 * 1024) throw new Error("Skill 包超过 2000 个文件或 25 MB 限制。");
      }
    }
  };
  await visit(directory);
  const skillFile = path.join(directory, "SKILL.md");
  if (!fs.existsSync(skillFile) || (await fsp.stat(skillFile)).size > 1024 * 1024) {
    throw new Error("Skill 缺少有效的 SKILL.md。");
  }
  return { files, bytes };
}

async function installSkillSource(sourceDirectory, installedSourceRoot, sourceLabel = "本地导入") {
  const targetRoot = path.resolve(String(installedSourceRoot || ""));
  if (!installedSourceRoot) throw new Error("ChatSwitch Skill 安装目录无效。");
  await fsp.mkdir(targetRoot, { recursive: true });
  const directories = await discoverSkillDirectories(sourceDirectory);
  if (!directories.length) throw new Error("没有找到 SKILL.md（最多扫描 4 层目录）。");
  const installed = [];
  for (const directory of directories) {
    const name = path.basename(directory);
    if (!/^[\w.-]{1,100}$/i.test(name) || name === ".system") throw new Error(`Skill 目录名称无效：${name}`);
    const detail = await validateSkillTree(directory);
    const target = path.join(targetRoot, name);
    const temporary = path.join(targetRoot, `.${name}.${process.pid}.${Date.now()}.tmp`);
    await fsp.rm(temporary, { recursive: true, force: true });
    await fsp.cp(directory, temporary, {
      recursive: true,
      force: true,
      dereference: false,
      filter: (candidate) => path.basename(candidate) !== ".git",
    });
    await fsp.rm(target, { recursive: true, force: true });
    await fsp.rename(temporary, target);
    installed.push({ name, source: sourceLabel, ...detail });
  }
  return installed.sort((left, right) => left.name.localeCompare(right.name, "en-US"));
}

async function syncManagedSkills(sourceDirectories, libraryDirectory, activeDirectory, disabledNames = []) {
  const libraryRoot = path.resolve(String(libraryDirectory || ""));
  const activeRoot = path.resolve(String(activeDirectory || ""));
  if (!libraryDirectory || !activeDirectory || libraryRoot === activeRoot) {
    throw new Error("ChatSwitch skill library and active directory must be different.");
  }
  let previousSources = {};
  try {
    previousSources = JSON.parse(await fsp.readFile(path.join(libraryRoot, ".chatswitch-sources.json"), "utf8")).sources || {};
  } catch {}
  const mirrored = await syncSkillRoots(sourceDirectories, libraryRoot);
  if (!mirrored.names.length && mirrored.skippedSources === (sourceDirectories || []).length) {
    mirrored.names = Object.keys(previousSources).filter((name) => fs.existsSync(path.join(libraryRoot, name, "SKILL.md")));
    mirrored.sources = previousSources;
  } else {
    for (const stale of Object.keys(previousSources).filter((name) => !mirrored.names.includes(name))) {
      const target = path.join(libraryRoot, stale);
      if (fs.existsSync(target)) await fsp.rm(target, { recursive: true, force: true });
    }
  }
  await fsp.writeFile(
    path.join(libraryRoot, ".chatswitch-sources.json"),
    `${JSON.stringify({ version: 1, sources: mirrored.sources }, null, 2)}\n`,
    "utf8",
  );
  await fsp.mkdir(activeRoot, { recursive: true });
  const manifestFile = path.join(activeRoot, ".chatswitch-managed.json");
  let previous = [];
  try {
    previous = JSON.parse(await fsp.readFile(manifestFile, "utf8")).names || [];
  } catch {}
  const disabled = new Set((disabledNames || []).map((name) => String(name).toLocaleLowerCase("en-US")));
  const managed = [...new Set([...previous, ...mirrored.names])];
  let activated = 0;
  let deactivated = 0;
  for (const name of managed) {
    const target = path.join(activeRoot, name);
    if (fs.existsSync(target)) {
      const stat = await fsp.lstat(target);
      if (stat.isSymbolicLink()) await fsp.unlink(target);
      else await fsp.rm(target, { recursive: true, force: true });
      deactivated += 1;
    }
  }
  for (const name of mirrored.names) {
    if (disabled.has(name.toLocaleLowerCase("en-US"))) continue;
    const source = path.join(libraryRoot, name);
    const target = path.join(activeRoot, name);
    try {
      await fsp.symlink(source, target, process.platform === "win32" ? "junction" : "dir");
    } catch {
      await fsp.cp(source, target, { recursive: true, force: true, dereference: true, preserveTimestamps: true });
    }
    activated += 1;
  }
  await fsp.writeFile(manifestFile, `${JSON.stringify({ version: 1, names: mirrored.names }, null, 2)}\n`, "utf8");
  return { ...mirrored, activated, deactivated };
}

async function listManagedSkills(libraryDirectory, disabledNames = []) {
  const libraryRoot = path.resolve(String(libraryDirectory || ""));
  if (!libraryDirectory || !fs.existsSync(libraryRoot)) return [];
  const disabled = new Set((disabledNames || []).map((name) => String(name).toLocaleLowerCase("en-US")));
  const entries = await fsp.readdir(libraryRoot, { withFileTypes: true });
  let sources = {};
  try {
    sources = JSON.parse(await fsp.readFile(path.join(libraryRoot, ".chatswitch-sources.json"), "utf8")).sources || {};
  } catch {}
  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(libraryRoot, entry.name, "SKILL.md");
    if (!fs.existsSync(skillFile)) continue;
    skills.push({
      name: entry.name,
      description: skillDescription(skillFile),
      path: skillFile,
      enabled: !disabled.has(entry.name.toLocaleLowerCase("en-US")),
      source: sources[entry.name] || "ChatSwitch 私有目录",
    });
  }
  return skills.sort((left, right) => left.name.localeCompare(right.name, "en-US"));
}

module.exports = { discoverSkillDirectories, installSkillSource, listManagedSkills, syncManagedSkills, syncSkillRoots };
