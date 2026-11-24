// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { ConfigStatus } from "@/state/store";

const fixture = vi.hoisted(() => ({
  config: null as Partial<ConfigStatus> | null,
  bots: [{ id: "b1", name: "Pepper" }, { id: "b2", name: "Salt" }],
  dispatch: vi.fn(),
  api: vi.fn(),
}));
vi.mock("@/state/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/store")>()),
  api: fixture.api,
  useStore: () => ({ state: { config: fixture.config, bots: fixture.bots }, dispatch: fixture.dispatch }),
}));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));

const { ChannelsSettings } = await import("./ChannelsSettings");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  fixture.dispatch = vi.fn();
  fixture.api.mockReset();
  fixture.api.mockImplementation(async (path: string) => path === "/api/email" ? { state: "connected", accounts: [{ address: "bot@acme.test" }] } : { feishu: {}, dingtalk: {}, wecom: {}, botMail: {} });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = async () => act(async () => root.render(createElement(ChannelsSettings)));
const openForm = async (key: string) => {
  const row = host.querySelector(`[data-channel="${key}"]`)!;
  const edit = [...row.querySelectorAll("button")].filter((button) => !button.disabled).at(-1)!;
  await act(async () => edit.dispatchEvent(new MouseEvent("click", { bubbles: true })));
};
const setInput = async (key: string, field: string, value: string) => {
  const input = host.querySelector(`[data-channel="${key}"] [data-channel-field="${field}"]`)! as HTMLInputElement | HTMLSelectElement;
  const select = input.tagName === "SELECT";
  await act(async () => {
    Object.getOwnPropertyDescriptor(select ? HTMLSelectElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event(select ? "change" : "input", { bubbles: true }));
  });
};
const submit = async (key: string) => {
  const form = host.querySelector(`[data-channel-form="${key}"]`)!;
  await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
};
const puts = () => fixture.api.mock.calls.filter(([path, init]) => path === "/api/config" && (init as RequestInit)?.method === "PUT")
  .map(([, init]) => JSON.parse((init as RequestInit).body as string));

it("saves a Feishu channel without echoing the blank secret field", async () => {
  fixture.config = { feishu: { configured: false, botId: "", appId: "" } };
  await render();
  await openForm("feishu");
  await setInput("feishu", "appId", "cli_abc");
  await setInput("feishu", "appSecret", "s3cret");
  await setInput("feishu", "botId", "b2");
  await submit("feishu");
  expect(puts()).toEqual([{ feishu: { appId: "cli_abc", appSecret: "s3cret", botId: "b2" } }]);
  expect(fixture.dispatch).toHaveBeenCalledWith({ type: "configStatus", config: expect.anything() });
});

it("keeps a stored secret when the field is left blank on a configured channel", async () => {
  fixture.config = { feishu: { configured: true, botId: "b1", appId: "cli_old" } };
  await render();
  await openForm("feishu");
  // The echoed app id is prefilled; only the answering bot changes.
  await setInput("feishu", "botId", "b2");
  await submit("feishu");
  expect(puts()).toEqual([{ feishu: { appId: "cli_old", botId: "b2" } }]);
});

it("saves every WeCom field and disconnects by clearing them", async () => {
  fixture.config = { wecom: { configured: false, botId: "", corpId: "", agentId: "" } };
  await render();
  await openForm("wecom");
  await setInput("wecom", "corpId", "ww1");
  await setInput("wecom", "corpSecret", "cs");
  await setInput("wecom", "token", "tk");
  await setInput("wecom", "encodingAesKey", "key");
  await setInput("wecom", "agentId", "1000002");
  await setInput("wecom", "botId", "b1");
  await submit("wecom");
  expect(puts()).toEqual([{ wecom: { corpId: "ww1", corpSecret: "cs", token: "tk", encodingAesKey: "key", agentId: "1000002", botId: "b1" } }]);

  fixture.config = { wecom: { configured: true, botId: "b1", corpId: "ww1", agentId: "1000002" } };
  await render();
  const row = host.querySelector('[data-channel="wecom"]')!;
  const off = [...row.querySelectorAll("button")].find((button) => button !== [...row.querySelectorAll("button")].at(-1))!;
  await act(async () => off.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await act(async () => off.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  expect(puts().at(-1)).toEqual({ wecom: { corpId: "", corpSecret: "", token: "", encodingAesKey: "", agentId: "", botId: "" } });
});

it("offers the connected email accounts for the bot mailbox", async () => {
  fixture.config = { botMail: { configured: false, address: "", botId: "" } };
  await render();
  await openForm("botMail");
  await setInput("botMail", "address", "bot@acme.test");
  await setInput("botMail", "botId", "b1");
  await submit("botMail");
  expect(puts()).toEqual([{ botMail: { address: "bot@acme.test", botId: "b1" } }]);
});

it("the SMS row saves the answering bot and this fork's owner numbers", async () => {
  fixture.config = { sms: { configured: false, botId: "" } };
  await render();
  await openForm("sms");
  const form = host.querySelector('[data-channel-form="sms"]')!;
  expect([...form.querySelectorAll("[data-channel-field]")].map((field) => field.getAttribute("data-channel-field"))).toEqual(["owners", "botId"]);
  await setInput("sms", "botId", "b2");
  await submit("sms");
  expect(puts()).toEqual([{ sms: { owners: "", botId: "b2" } }]);
});

it("the WeChat row asks only for the answering bot", async () => {
  fixture.config = { wechat: { configured: false, botId: "" } };
  await render();
  await openForm("wechat");
  const form = host.querySelector('[data-channel-form="wechat"]')!;
  expect([...form.querySelectorAll("[data-channel-field]")].map((field) => field.getAttribute("data-channel-field"))).toEqual(["botId"]);
  await setInput("wechat", "botId", "b2");
  await submit("wechat");
  expect(puts()).toEqual([{ wechat: { botId: "b2" } }]);
});
