const { version } = require("../package.json");

const APP_VERSION = String(version || "0.0.0");
const USER_AGENT = `ChatSwitch/${APP_VERSION}`;
const RELEASE_REPOSITORY = "MttJelly/chatswitch";
const LATEST_RELEASE_API = `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/latest`;

function normalizeVersion(value) {
  const match = String(value || "").trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/i);
  return match ? match.slice(1, 4).map(Number) : null;
}

function compareVersions(left, right) {
  const leftParts = normalizeVersion(left);
  const rightParts = normalizeVersion(right);
  if (!leftParts || !rightParts) throw new Error(`无法比较版本：${left} / ${right}`);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] > rightParts[index] ? 1 : -1;
  }
  return 0;
}

function updateFromRelease(currentVersion, release) {
  const latestVersion = String(release?.tag_name || "").replace(/^v/i, "");
  if (!normalizeVersion(latestVersion) || !release?.html_url) {
    throw new Error("GitHub 最新 Release 缺少有效版本或下载地址。");
  }
  const comparison = compareVersions(currentVersion, latestVersion);
  const status = comparison < 0 ? "available" : comparison > 0 ? "ahead" : "current";
  const messages = {
    available: `发现新版本 v${latestVersion}，当前为 v${currentVersion}。`,
    ahead: `当前为开发版本 v${currentVersion}，GitHub 最新发布版为 v${latestVersion}。`,
    current: `当前已是最新版本 v${currentVersion}。`,
  };
  return {
    status,
    currentVersion,
    latestVersion,
    releaseUrl: release.html_url,
    publishedAt: release.published_at || null,
    message: messages[status],
  };
}

module.exports = {
  APP_VERSION,
  LATEST_RELEASE_API,
  RELEASE_REPOSITORY,
  USER_AGENT,
  compareVersions,
  normalizeVersion,
  updateFromRelease,
};
