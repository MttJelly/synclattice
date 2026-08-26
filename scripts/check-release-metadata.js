const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { compareVersions } = require("../src/app-version");

const root = path.resolve(__dirname, "..");
const packageJson = require(path.join(root, "package.json"));
const packageLock = require(path.join(root, "package-lock.json"));
const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
const failures = [];

if (packageLock.version !== packageJson.version || packageLock.packages?.[""]?.version !== packageJson.version) {
  failures.push("package.json 与 package-lock.json 的版本不一致。");
}
if (!changelog.includes(`## [${packageJson.version}]`)) {
  failures.push(`CHANGELOG.md 缺少 ${packageJson.version} 版本条目。`);
}
for (const stableAsset of ["ChatSwitch-portable-win-x64.zip", "ChatSwitch-setup-win-x64.msi"]) {
  if (!readme.includes(`/releases/latest/download/${stableAsset}`)) {
    failures.push(`README.md 缺少稳定下载链接：${stableAsset}`);
  }
}

const hardcodedVersionPattern = /ChatSwitch\/\d+\.\d+\.\d+/;
for (const relative of ["src/codex-server.js", "src/relay-balance.js", "src/claude-models.js"]) {
  if (hardcodedVersionPattern.test(fs.readFileSync(path.join(root, relative), "utf8"))) {
    failures.push(`${relative} 仍包含硬编码客户端版本。`);
  }
}

if (process.argv.includes("--git")) {
  try {
    const configuredBase = String(process.env.CHATSWITCH_BASE_REVISION || "").trim();
    let baseline = configuredBase && !/^0+$/.test(configuredBase) ? configuredBase : null;
    if (!baseline) {
      const headPackage = JSON.parse(execFileSync("git", ["show", "HEAD:package.json"], { cwd: root, encoding: "utf8" }));
      baseline = headPackage.version === packageJson.version ? "HEAD^" : "HEAD";
    }
    const previousPackage = JSON.parse(execFileSync("git", ["show", `${baseline}:package.json`], { cwd: root, encoding: "utf8" }));
    if (compareVersions(packageJson.version, previousPackage.version) <= 0) {
      failures.push(`本次 GitHub 更新必须提升版本：当前 ${packageJson.version}，基线 ${previousPackage.version}。`);
    }
  } catch (error) {
    failures.push(`无法核对 Git 基线版本：${error.message}`);
  }
}

if (failures.length) throw new Error(`发布元数据检查失败：\n- ${failures.join("\n- ")}`);
console.log(JSON.stringify({ ok: true, version: packageJson.version }));
