const fs = require("node:fs");
const path = require("node:path");

const START_MENU_PARTS = ["Microsoft", "Windows", "Start Menu", "Programs"];

function quoteWindowsArgument(value) {
  return `"${String(value || "").replace(/"/g, '\\"')}"`;
}

function notificationShortcutArguments({ isPackaged, userData, applicationRoot }) {
  if (isPackaged) return "";
  return `--user-data-dir=${quoteWindowsArgument(userData)} ${quoteWindowsArgument(applicationRoot)}`;
}

function windowsTaskbarDetails(options = {}) {
  const target = options.target;
  const args = notificationShortcutArguments(options);
  return {
    appId: options.appUserModelId,
    appIconPath: options.icon || target,
    appIconIndex: 0,
    relaunchCommand: `${quoteWindowsArgument(target)}${args ? ` ${args}` : ""}`,
    relaunchDisplayName: "ChatSwitch",
  };
}

function sameWindowsPath(left, right) {
  if (!left || !right) return false;
  return path.resolve(left).toLocaleLowerCase("en-US") === path.resolve(right).toLocaleLowerCase("en-US");
}

function ensureWindowsNotificationIdentity(options = {}) {
  if ((options.platform || process.platform) !== "win32") return { status: "skipped" };
  const fsApi = options.fsApi || fs;
  const shellApi = options.shellApi;
  if (!shellApi?.writeShortcutLink || !shellApi?.readShortcutLink) {
    throw new TypeError("A Windows shortcut API is required.");
  }

  const programsDirectory = path.join(options.appData, ...START_MENU_PARTS);
  const shortcutPath = path.join(programsDirectory, "ChatSwitch.lnk");
  const legacyShortcutPaths = [
    path.join(programsDirectory, "ThreadLattice.lnk"),
    path.join(programsDirectory, "Synclattice.lnk"),
    path.join(programsDirectory, "Share Master.lnk"),
    path.join(programsDirectory, "Electron.lnk"),
  ];
  fsApi.mkdirSync(programsDirectory, { recursive: true });

  const shortcut = {
    target: options.target,
    args: options.args || "",
    cwd: options.cwd || path.dirname(options.target),
    description: "ChatSwitch",
    icon: options.icon || options.target,
    iconIndex: 0,
    appUserModelId: options.appUserModelId,
    toastActivatorClsid: options.toastActivatorClsid,
  };
  const operation = fsApi.existsSync(shortcutPath) ? "replace" : "create";
  if (!shellApi.writeShortcutLink(shortcutPath, operation, shortcut)) {
    throw new Error("Unable to register the ChatSwitch notification shortcut.");
  }

  let removedLegacy = false;
  for (const legacyShortcutPath of legacyShortcutPaths) {
    if (!fsApi.existsSync(legacyShortcutPath)) continue;
    try {
      const legacy = shellApi.readShortcutLink(legacyShortcutPath);
      const oldProductAppId = new Set([
        "com.synclattice.desktop",
        "com.synclattice.desktop.dev",
        "com.sharemaster.desktop",
        "com.sharemaster.desktop.dev",
        "com.threadlattice.desktop",
        "com.threadlattice.desktop.dev",
      ]).has(legacy?.appUserModelId);
      const matchesCurrentIdentity = legacy?.appUserModelId === options.appUserModelId
        && sameWindowsPath(legacy.target, options.target);
      // Old product identities are unambiguously ours even when the executable
      // path changed during an upgrade; a current identity still needs a path match.
      if (oldProductAppId || matchesCurrentIdentity) {
        fsApi.unlinkSync(legacyShortcutPath);
        removedLegacy = true;
      }
    } catch {
      // Preserve shortcuts that cannot be positively identified as ours.
    }
  }

  return { status: "registered", shortcutPath, operation, removedLegacy };
}

module.exports = {
  ensureWindowsNotificationIdentity,
  notificationShortcutArguments,
  quoteWindowsArgument,
  windowsTaskbarDetails,
};
