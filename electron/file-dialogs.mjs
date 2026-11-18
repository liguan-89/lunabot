/** The file and system-dialog IPC handlers: save/open/pick/reveal, diagnostics
 * export, the clipboard write and the terminal hand-off. Every path that comes
 * from the renderer is validated by the save-file helpers before it reaches
 * disk; secrets never ride along. */
import { BrowserWindow, clipboard, desktopCapturer, dialog, shell } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeClipboardText } from "./clipboard-write.mjs";
import { diagnosticsFileName } from "./diagnostics.mjs";
import { defaultSaveName, openFolder, openHtmlCopy, openLogsFolder, revealInFolder, withSavableFile } from "./save-file.mjs";
import { openBlankTerminal } from "./terminal-launch.mjs";

export function installFileDialogs({
  ipcMain,
  localOnly,
  localOrHome,
  app,
  nativeT,
  logDir,
  remoteAccess,
  diagnostics,
}) {
  // From main so macOS attributes the Screen Recording prompt to the app, not the server.
  ipcMain.handle("screen:frame", localOnly("screen:frame", async () => {
    if (process.platform !== "darwin" && process.platform !== "win32") return null;
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 1280, height: 800 },
    });
    return sources[0]?.thumbnail.toDataURL() ?? null;
  }));

  // Renderer-controlled text must never become a process argument: the user reviews and pastes it.
  ipcMain.handle("engine:open-terminal", localOnly("engine:open-terminal", async (_event, command) => {
    if (typeof command !== "string" || !command.trim()) return false;
    clipboard.writeText(command);
    return openBlankTerminal();
  }));

  ipcMain.handle("clipboard:write-text", localOnly("clipboard:write-text", (_event, text) => writeClipboardText(clipboard, text)));

  ipcMain.handle("desktop:pick-folder", localOnly("desktop:pick-folder", async (event, current) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const result = await dialog.showOpenDialog(win, {
      title: nativeT("native.picker.workingFolder"),
      properties: ["openDirectory", "createDirectory"],
      ...(typeof current === "string" && current ? { defaultPath: current } : {}),
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  }));

  // Secrets are never read, and the report is redacted again on the way out.
  ipcMain.handle("desktop:export-diagnostics", localOrHome("desktop:export-diagnostics", async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const report = await diagnostics();
    const result = await dialog.showSaveDialog(owner, {
      title: nativeT("native.picker.diagnostics"),
      defaultPath: diagnosticsFileName(),
      filters: [{ name: nativeT("native.picker.textFilter"), extensions: ["txt"] }],
    });
    if (result.canceled || !result.filePath) return null;
    if (process.platform === "win32") {
      fs.writeFileSync(result.filePath, report, { mode: 0o600 });
    } else {
      const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW;
      const handle = fs.openSync(result.filePath, flags, 0o600);
      try {
        fs.fchmodSync(handle, 0o600);
        fs.writeFileSync(handle, report, "utf8");
      } finally {
        fs.closeSync(handle);
      }
    }
    return result.filePath;
  }));

  // The path is renderer-controlled: it must resolve inside ~/.lunabot to a regular file, never a symlink escape.
  ipcMain.handle("desktop:save-file", localOnly("desktop:save-file", async (event, rawPath) => {
    return withSavableFile(rawPath, { home: os.homedir() }, async ({ defaultName, copyTo }) => {
      const parent = BrowserWindow.fromWebContents(event.sender);
      const defaultPath = await defaultSaveName(app.getPath("downloads"), defaultName);
      const choice = await dialog.showSaveDialog(parent ?? undefined, {
        title: nativeT("native.picker.saveWhere"),
        message: nativeT("native.picker.saveWhere"),
        defaultPath,
        buttonLabel: nativeT("native.picker.save"),
        properties: ["createDirectory", "showOverwriteConfirmation"],
      });
      if (choice.canceled || !choice.filePath) return null;
      await copyTo(choice.filePath);
      shell.showItemInFolder(choice.filePath);
      return choice.filePath;
    });
  }));
  ipcMain.handle("desktop:reveal-file", localOnly("desktop:reveal-file", async (_event, rawPath) => { if (remoteAccess()) throw new Error("That file is on the computer this app is connected to"); return revealInFolder(rawPath, { reveal: (target) => shell.showItemInFolder(target) }); }));
  ipcMain.handle("desktop:open-folder", localOnly("desktop:open-folder", async (_event, rawPath) => { if (remoteAccess()) throw new Error("That folder is on the computer this app is connected to"); return openFolder(rawPath, { open: (target) => shell.openPath(target) }); }));
  ipcMain.handle("desktop:open-html", localOnly("desktop:open-html", (_event, source, name) => openHtmlCopy(source, name, { dir: path.join(app.getPath("userData"), "open-html"), t: nativeT, open: (file) => shell.openPath(file) })));
  ipcMain.handle("desktop:open-logs", localOrHome("desktop:open-logs", () => openLogsFolder(logDir, { open: (folder) => shell.openPath(folder) })));
}
