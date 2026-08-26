const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { version } = require("../package.json");

const releaseRoot = path.resolve(__dirname, "..", "release");

function renameArtifact(sourceName, targetName) {
  const source = path.join(releaseRoot, sourceName);
  const target = path.join(releaseRoot, targetName);
  if (!fs.existsSync(source)) return false;
  if (fs.existsSync(target)) fs.rmSync(target, { force: true });
  fs.renameSync(source, target);
  return true;
}

renameArtifact(
  `ChatSwitch-${version}-win-x64.zip`,
  `ChatSwitch-${version}-portable-win-x64.zip`,
);
renameArtifact(
  `ChatSwitch-${version}-win-x64.msi`,
  `ChatSwitch-${version}-setup-win-x64.msi`,
);

const aliases = [
  [`ChatSwitch-${version}-portable-win-x64.zip`, "ChatSwitch-portable-win-x64.zip"],
  [`ChatSwitch-${version}-setup-win-x64.msi`, "ChatSwitch-setup-win-x64.msi"],
];
for (const [versionedName, stableName] of aliases) {
  const source = path.join(releaseRoot, versionedName);
  if (fs.existsSync(source)) fs.copyFileSync(source, path.join(releaseRoot, stableName));
}

const files = aliases.flatMap(([versionedName, stableName]) => [versionedName, stableName])
  .flatMap((name) => {
    const file = path.join(releaseRoot, name);
    if (!fs.existsSync(file)) return [];
    const content = fs.readFileSync(file);
    return [{ name, size: content.length, sha256: crypto.createHash("sha256").update(content).digest("hex") }];
  });
fs.writeFileSync(
  path.join(releaseRoot, "release-manifest.json"),
  `${JSON.stringify({ version, files }, null, 2)}\n`,
  "utf8",
);
