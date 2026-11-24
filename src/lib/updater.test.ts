import { afterEach, expect, it } from "vitest";
import { setLocale } from "@/lib/i18n";
import { updaterMessage } from "@/lib/updater";
import { connectionMessage } from "@/components/OrganizationSettings";

afterEach(() => setLocale("en"));

it("translates fixed native update words at render time, retaining raw diagnostics and exact English", () => {
  const state = { status: "handed-off", message: "The install did not finish: The install took too long.", messageKey: "native.update.installFailed", messageParams: { reason: "The install took too long.", timedOut: "true" } } as const;
  expect(updaterMessage(state)).toBe(state.message);
  setLocale("zh");
  expect(updaterMessage(state)).toBe("安装未完成：安装耗时过长。");
  expect(updaterMessage({ ...state, messageParams: { reason: "E: dpkg lock" } })).toBe("安装未完成：E: dpkg lock");
  expect(updaterMessage({ ...state, messageParams: {} })).toBe(state.message);
  expect(updaterMessage({ ...state, messageKey: "native.update.future" })).toBe(state.message);
  expect(updaterMessage({ ...state, messageKey: "native.lend.terminal.title" })).toBe(state.message);
  expect(updaterMessage({ status: "installing", message: "Installing the update. Enter your password if asked.", messageKey: "native.update.installing" })).toBe("正在安装更新。如被询问请输入你的密码。");
  const failed = { status: "error", message: "Couldn't check for updates. Offline detail", messageKey: "native.update.checkFailed", messageParams: { error: "Offline detail" } } as const;
  expect(updaterMessage(failed)).toBe("无法检查更新。Offline detail");
  expect(updaterMessage({ ...failed, messageCode: "network" })).toContain("无法检查更新。");
  expect(updaterMessage({ ...failed, messageCode: "network" })).not.toContain("Offline detail");
  setLocale("en");
  expect(updaterMessage({ ...failed, messageCode: "network" })).toBe(failed.message);
});

it("says the updater's own words in the app's language, and keeps a message main could not classify", () => {
  setLocale("zh");
  expect(updaterMessage({ status: "error", message: "Not enough disk space to prepare the update. Free some space, then try again.", messageCode: "disk" }))
    .toBe("磁盘空间不足，无法准备更新。请释放一些空间后重试。");
  const restart = { status: "error", retryable: false, message: "Not enough disk space… Quit and reopen Luna Bot before trying the update again.", messageCode: "disk" } as const;
  expect(updaterMessage(restart)).toMatch(/请释放一些空间后重试。 再次尝试更新前，请先退出并重新打开 Luna Bot。$/);
  expect(updaterMessage(restart, { restart: false })).toBe("磁盘空间不足，无法准备更新。请释放一些空间后重试。");
  expect(updaterMessage({ status: "error", message: "HttpError: 418" })).toBe("HttpError: 418");
  expect(updaterMessage(null)).toBeUndefined();
  setLocale("en");
  expect(updaterMessage({ status: "installing", message: "Restart is taking longer than expected. Quit and reopen Luna Bot to finish the update.", messageCode: "slowRestart" }))
    .toBe("Restart is taking longer than expected. Quit and reopen Luna Bot to finish the update.");
});

it("says the company connection's lines in the app's language, in order, and keeps a line that comes with no codes", () => {
  setLocale("zh");
  expect(connectionMessage({ message: "Disconnected on this computer. The portal was unreachable; …", messageCodes: ["disconnected", "portalUnreachable"] }))
    .toBe("已在这台电脑上断开连接。 管理门户无法访问；请让你的管理员也在那里撤销此设备。");
  expect(connectionMessage({ message: "An older desktop's words." })).toBe("An older desktop's words.");
  expect(connectionMessage({ message: "Unknown.", messageCodes: ["somethingNew" as never] })).toBe("Unknown.");
});
