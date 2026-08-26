const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const destination = path.join(projectRoot, "build", "codex-runtime");

function existingDirectory(value) {
  if (!value) return null;
  try {
    const resolved = path.resolve(String(value));
    return fs.statSync(resolved).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

function existingFile(value) {
  if (!value) return null;
  try {
    const resolved = path.resolve(String(value));
    return fs.statSync(resolved).isFile() ? resolved : null;
  } catch {
    return null;
  }
}

function windowsAppResourceRoots() {
  if (process.platform !== "win32") return [];
  const root = path.join(process.env.ProgramFiles || "C:\\Program Files", "WindowsApps");
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^OpenAI\.Codex_/i.test(entry.name))
      .sort((left, right) => right.name.localeCompare(left.name, undefined, { numeric: true }))
      .map((entry) => path.join(root, entry.name, "app", "resources"))
      .filter((candidate) => existingFile(path.join(candidate, "codex.exe")));
  } catch {
    return [];
  }
}

function runtimeRoots() {
  const explicit = String(process.env.CHATSWITCH_CODEX_RUNTIME || "").trim();
  const explicitDirectory = existingDirectory(explicit);
  const explicitFile = existingFile(explicit);
  const roots = [
    explicitDirectory,
    explicitFile ? path.dirname(explicitFile) : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs", "OpenAI", "Codex", "bin") : null,
    ...windowsAppResourceRoots(),
  ];
  return [...new Set(roots.map(existingDirectory).filter(Boolean))];
}

const sourceRoot = runtimeRoots()[0];
const sourceCodex = sourceRoot && existingFile(path.join(sourceRoot, "codex.exe"));
if (!sourceCodex) {
  throw new Error("没有找到可打包的 Codex app-server。请安装 ChatGPT/Codex 应用，或设置 CHATSWITCH_CODEX_RUNTIME。");
}

const runtimeFiles = fs.readdirSync(sourceRoot)
  .filter((name) => /^codex(?:[-_].+)?\.exe$/i.test(name))
  .map((name) => path.join(sourceRoot, name))
  .filter(existingFile);
if (!runtimeFiles.some((file) => path.basename(file).toLowerCase() === "codex.exe")) {
  throw new Error(`运行时目录缺少 codex.exe：${sourceRoot}`);
}

fs.rmSync(destination, { recursive: true, force: true });
fs.mkdirSync(destination, { recursive: true });
for (const source of runtimeFiles) fs.copyFileSync(source, path.join(destination, path.basename(source)));

console.log(JSON.stringify({
  sourceRoot,
  destination,
  files: runtimeFiles.map((file) => path.basename(file)),
  platform: os.platform(),
}));
