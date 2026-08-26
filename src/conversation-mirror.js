const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const CHAT_AREAS = ["sessions", "archived_sessions"];
const MANIFEST_NAME = ".chatswitch-mirror.json";
const BACKUP_DIRECTORY = ".chatswitch-sync-backups";

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function jsonlFiles(root, current = root) {
  let entries;
  try {
    entries = await fsp.readdir(current, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const file = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...await jsonlFiles(root, file));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) files.push(file);
  }
  return files;
}

async function readManifest(targetHome) {
  try {
    return JSON.parse(await fsp.readFile(path.join(targetHome, MANIFEST_NAME), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return { version: 1, files: {} };
    throw error;
  }
}

async function writeManifest(targetHome, manifest) {
  const file = path.join(targetHome, MANIFEST_NAME);
  const temporary = `${file}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await fsp.rename(temporary, file);
}

function normalizedSources(sourceDirectories, targetHome) {
  const unique = [];
  for (const value of Array.isArray(sourceDirectories) ? sourceDirectories : [sourceDirectories]) {
    const sourceHome = path.resolve(String(value || "").trim());
    if (!value || unique.some((item) => item.toLocaleLowerCase() === sourceHome.toLocaleLowerCase())) continue;
    if (sourceHome === targetHome || isInside(sourceHome, targetHome) || isInside(targetHome, sourceHome)) {
      throw new Error("聊天记录源目录和 ChatSwitch 副本目录必须彼此独立。");
    }
    if (!fs.existsSync(sourceHome) || !fs.statSync(sourceHome).isDirectory()) continue;
    if (!CHAT_AREAS.some((area) => fs.existsSync(path.join(sourceHome, area)))) continue;
    unique.push(sourceHome);
  }
  if (!unique.length) throw new Error("聊天记录只读源目录不存在。");
  return unique;
}

function changedSince(entry, stats, prefix) {
  if (!entry) return true;
  return entry[`${prefix}Size`] !== stats.size
    || Math.abs(entry[`${prefix}MtimeMs`] - stats.mtimeMs) > 2;
}

async function copyRecord(source, target, sourceStats) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.chatswitch-sync.tmp`;
  await fsp.copyFile(source, temporary);
  await fsp.rename(temporary, target);
  await fsp.utimes(target, sourceStats.atime, sourceStats.mtime);
  return fsp.stat(target);
}

async function syncConversationMirrors(sourceDirectories, targetDirectory) {
  const targetHome = path.resolve(String(targetDirectory || ""));
  if (!targetDirectory) throw new Error("聊天记录副本目录不存在。");
  const sourceHomes = normalizedSources(sourceDirectories, targetHome);
  await fsp.mkdir(targetHome, { recursive: true });
  const previous = await readManifest(targetHome);
  const manifest = {
    version: 2,
    direction: "source-to-chatswitch",
    sourceHome: sourceHomes[0],
    sourceHomes,
    targetHome,
    syncedAt: Date.now(),
    files: { ...(previous.files || {}) },
  };
  const result = { copied: 0, updated: 0, backedUp: 0, skipped: 0, conflicts: 0, bytes: 0, sourceHomes };

  for (const sourceHome of sourceHomes) {
    for (const area of CHAT_AREAS) {
      const sourceRoot = path.join(sourceHome, area);
      for (const source of await jsonlFiles(sourceRoot)) {
        const relative = path.relative(sourceRoot, source);
        const key = `${area}/${relative.replaceAll("\\", "/")}`;
        const target = path.join(targetHome, area, relative);
        const sourceStats = await fsp.stat(source);
        let targetStats = null;
        try {
          targetStats = await fsp.stat(target);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        const entry = manifest.files[key] || null;
        const owner = path.resolve(String(entry?.sourceHome || previous.sourceHome || ""));
        if (targetStats && (!entry || owner.toLocaleLowerCase() !== sourceHome.toLocaleLowerCase())) {
          result.skipped += 1;
          result.conflicts += 1;
          continue;
        }
        const sourceChanged = changedSince(entry, sourceStats, "source");
        if (targetStats && !sourceChanged) {
          result.skipped += 1;
          continue;
        }
        if (targetStats && entry && changedSince(entry, targetStats, "target")) {
          const backup = path.join(targetHome, BACKUP_DIRECTORY, area, `${relative}.${Date.now()}.bak`);
          await fsp.mkdir(path.dirname(backup), { recursive: true });
          await fsp.copyFile(target, backup);
          result.backedUp += 1;
        }
        const nextTargetStats = await copyRecord(source, target, sourceStats);
        if (targetStats) result.updated += 1;
        else result.copied += 1;
        result.bytes += sourceStats.size;
        manifest.files[key] = {
          sourceHome,
          sourceSize: sourceStats.size,
          sourceMtimeMs: sourceStats.mtimeMs,
          targetSize: nextTargetStats.size,
          targetMtimeMs: nextTargetStats.mtimeMs,
        };
      }
    }
  }
  await writeManifest(targetHome, manifest);
  return result;
}

async function syncConversationMirror(sourceDirectory, targetDirectory) {
  return syncConversationMirrors([sourceDirectory], targetDirectory);
}

module.exports = { CHAT_AREAS, syncConversationMirror, syncConversationMirrors };
