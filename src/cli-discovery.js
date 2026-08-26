const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function existingFile(value) {
  if (!value) return null;
  const resolved = path.resolve(String(value).trim().replace(/^"|"$/g, ""));
  try {
    return fs.statSync(resolved).isFile() ? resolved : null;
  } catch {
    return null;
  }
}

function pathMatches(command) {
  const finder = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(finder, [command], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 3000,
  });
  if (result.error || result.status !== 0) return [];
  return String(result.stdout || "").split(/\r?\n/).map(existingFile).filter(Boolean);
}

function wingetMatches(packagePrefix, executable) {
  if (process.platform !== "win32" || !process.env.LOCALAPPDATA) return [];
  const root = path.join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Packages");
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.toLowerCase().startsWith(packagePrefix.toLowerCase()))
      .map((entry) => existingFile(path.join(root, entry.name, executable)))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function bundledCodexCandidates() {
  if (process.platform !== "win32") return [];
  const managedRoot = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "OpenAI", "Codex", "bin")
    : null;
  let managed = [];
  try {
    managed = fs.readdirSync(managedRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => right.name.localeCompare(left.name, undefined, { numeric: true }))
      .map((entry) => existingFile(path.join(managedRoot, entry.name, "codex.exe")))
      .filter(Boolean);
  } catch {}
  const root = path.join(process.env.ProgramFiles || "C:\\Program Files", "WindowsApps");
  try {
    return [...managed, ...fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^OpenAI\.Codex_/i.test(entry.name))
      .sort((left, right) => right.name.localeCompare(left.name, undefined, { numeric: true }))
      .map((entry) => existingFile(path.join(root, entry.name, "app", "resources", "codex.exe")))
      .filter(Boolean)];
  } catch {
    return managed;
  }
}

function packagedCodexCandidates() {
  const resources = typeof process.resourcesPath === "string" ? process.resourcesPath : "";
  return resources ? [existingFile(path.join(resources, "codex-runtime", "codex.exe"))].filter(Boolean) : [];
}

function developmentCodexCandidates() {
  const projectRuntime = path.resolve(__dirname, "..", "build", "codex-runtime", "codex.exe");
  return [existingFile(projectRuntime)].filter(Boolean);
}

function isBundledCodexExecutable(value) {
  if (process.platform !== "win32" || !value) return false;
  const normalized = path.normalize(String(value)).toLowerCase();
  const windowsAppRuntime = normalized.includes(`${path.sep}windowsapps${path.sep}openai.codex_`)
    && normalized.endsWith(`${path.sep}app${path.sep}resources${path.sep}codex.exe`);
  const packagedRuntime = normalized.includes(`${path.sep}codex-runtime${path.sep}`)
    && normalized.endsWith(`${path.sep}codex.exe`);
  const managedRuntimeRoot = process.env.LOCALAPPDATA
    ? path.normalize(path.join(process.env.LOCALAPPDATA, "OpenAI", "Codex", "bin")).toLowerCase()
    : null;
  const managedRuntime = managedRuntimeRoot
    && normalized.startsWith(`${managedRuntimeRoot}${path.sep}`)
    && normalized.endsWith(`${path.sep}codex.exe`);
  return windowsAppRuntime || packagedRuntime || managedRuntime;
}

function findExecutable({ override, candidates = [], commands = [], winget = null }) {
  const matches = [
    existingFile(override),
    ...candidates.map(existingFile),
    ...commands.flatMap(pathMatches),
    ...(winget ? wingetMatches(winget.packagePrefix, winget.executable) : []),
  ].filter(Boolean);
  return [...new Set(matches.map((match) => path.normalize(match)))][0] || null;
}

function userExecutableCandidates(name) {
  const home = os.homedir();
  const extension = process.platform === "win32" ? ".exe" : "";
  return [
    path.join(home, ".local", "bin", `${name}${extension}`),
    process.env.APPDATA ? path.join(process.env.APPDATA, "npm", `${name}.cmd`) : null,
  ].filter(Boolean);
}

module.exports = {
  bundledCodexCandidates,
  developmentCodexCandidates,
  findExecutable,
  isBundledCodexExecutable,
  packagedCodexCandidates,
  userExecutableCandidates,
};
