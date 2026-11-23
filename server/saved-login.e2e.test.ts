// A happy-dom page behind a stand-in agent-browser: nothing reaches a real browser, the user's data or port 8799.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";

import { runControlLunabot } from "../scripts/control-lunabot.ts";
import { browserFixture } from "./testing/fake-browser-fixture.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { LOGIN_FORM } from "./testing/fake-login-page.ts";

// Obvious fakes only.
const PASSWORD = "fake-E2E-Passw0rd!";
const USERNAME = "alice@example.com";
const INVOICES = { url: "https://example.com/invoices", html: "<title>Invoices</title><h1>March invoices</h1>" };


it.skipIf(process.platform === "win32")("saves a login from the sign-in card with the Microsoft sign-in page it shows, and fill_login signs in there in one call without the bot ever seeing the password", async () => {
  const browser = await browserFixture("https://login.microsoftonline.com/common/oauth2/authorize?client_id=fake");
  const { page, api, evidence, answered } = browser;
  page.answer = () => ({ navigate: INVOICES });
  try {
    expect((await api("PATCH", "/api/config", { features: { browser: true } })).status).toBe(200);
    const bot = (await api("POST", "/api/bots", { name: "Signer" })).body.bot;
    // A temporary browser: nothing of the stand-in's is saved or restored.
    expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "browser", browserProfile: "guest" })).status).toBe(200);
    writeFileSync(browser.planPath, JSON.stringify({ [bot.id]: { turns: [
      { steps: [{ tool: "request_sign_in", arguments: { site: "https://example.com/invoices", reason: "The invoices are behind a login." } }],
        reply: "I asked you to sign in to example.com." },
      // A careless bot repeats the password in its reply; the transcript must not keep it.
      { steps: [{ tool: "fill_login", arguments: {} }], reply: `Signed in. The password was ${PASSWORD}.` },
    ] } }));

    await runControlLunabot(["send", "--bot", bot.id, "--task", bot.threadId, "--text", "Download this month's invoices.", "--url", browser.base]);
    await expect.poll(() => evidence().length, { timeout: 20_000 }).toBe(1);
    const messages = async () => (await api("GET", `/api/threads/${bot.threadId}/messages`)).body.messages as any[];
    await expect.poll(async () => (await messages()).some((message) => message.kind === "signin"), { timeout: 15_000 }).toBe(true);
    const card = (await messages()).find((message) => message.kind === "signin");

    const target = await api("GET", `/api/bots/${bot.id}/sign-in-cards/${card.id}/save-login?threadId=${bot.threadId}`);
    expect(target).toMatchObject({ status: 200, body: { site: "example.com", signInHost: "login.microsoftonline.com" } });
    const saved = await api("POST", `/api/bots/${bot.id}/sign-in-cards/${card.id}/save-login`,
      { threadId: bot.threadId, username: USERNAME, password: PASSWORD, signInHost: "login.microsoftonline.com" });
    expect(saved).toMatchObject({ status: 200, body: { done: true, resumed: true, saved: true, site: "example.com and login.microsoftonline.com" } });
    expect(saved.text).not.toContain(PASSWORD);

    await expect.poll(() => evidence().length, { timeout: 20_000 }).toBe(2);
    const resumed = evidence()[1];
    expect(JSON.stringify(resumed.prompt)).toContain("the person saved a login for example.com and login.microsoftonline.com. Open its login page in your browser and call fill_login there: it fills the form and submits it.");
    expect(resumed.system).toContain(`Your saved logins, for fill_login on these sites and their sign-in pages: example.com (${USERNAME}).`);
    const [filled] = answered(1, "fill_login");
    expect(filled.isError).toBeFalsy();
    expect(filled.content[0].text).toBe(`Filled the username and the password for ${USERNAME} on login.microsoftonline.com and submitted it; the page is now https://example.com/invoices (“Invoices”). Check you are signed in.`);
    expect(page.sent).toEqual([{ email: USERNAME, password: PASSWORD, csrf: "token-not-a-secret" }]);
    expect(page.pressed).toEqual(["Enter"]);
    expect([...browser.proxies]).toEqual([expect.stringMatching(/^socks5:\/\/127\.0\.0\.1:[1-9]\d*$/u)]);

    const logins = await api("GET", "/api/logins");
    expect(logins.body.logins).toEqual([expect.objectContaining({ site: "example.com", hosts: ["example.com", "login.microsoftonline.com"], exactHost: false, source: "card", bots: [bot.id] })]);
    await expect.poll(async () => (await messages()).some((message) => message.role === "bot" && String(message.text).startsWith("Signed in.")), { timeout: 15_000 }).toBe(true);
    const reply = (await messages()).find((message) => message.role === "bot" && String(message.text).startsWith("Signed in."));
    expect(reply.text).toBe("Signed in. The password was ••••••.");
    expect(JSON.stringify(evidence())).not.toContain(PASSWORD);
    expect(JSON.stringify(browser.engineArgs)).not.toContain(PASSWORD);
    expect(JSON.stringify(await messages())).not.toContain(PASSWORD);
    expect(logins.text).not.toContain(PASSWORD);
    expect(readFileSync(join(browser.fixture.info.dataDir, "logins.json.enc")).includes(Buffer.from(PASSWORD))).toBe(false);
  } finally {
    await browser.close();
  }
}, 120_000);

it.skipIf(process.platform === "win32")("fills a login saved for example.com on its subdomains, refuses eval on that page right after, offers no github.io login to another github.io name, and clears a refused login", async () => {
  const browser = await browserFixture("https://accounts.example.com/login");
  const { page, api, evidence, answered } = browser;
  try {
    expect((await api("PATCH", "/api/config", { features: { browser: true } })).status).toBe(200);
    const bot = (await api("POST", "/api/bots", { name: "Filler" })).body.bot;
    expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "browser", browserProfile: "guest" })).status).toBe(200);
    expect((await api("POST", "/api/logins", { site: "example.com", username: USERNAME, password: PASSWORD })).status).toBe(201);
    expect((await api("POST", "/api/logins", { site: "alice.github.io", username: "alice", password: "fake-pages-pass" })).status).toBe(201);
    const readPassword = { server: "browser", tool: "agent_browser_eval", arguments: { script: "document.querySelector('#password').value" } };
    writeFileSync(browser.planPath, JSON.stringify({ [bot.id]: { turns: [
      { steps: [{ tool: "fill_login", arguments: { submit: false } }, { ...readPassword, expectError: true }], reply: "Filled, not sent." },
      { steps: [{ tool: "fill_login", arguments: {}, expectError: true }], reply: "No login here." },
      { steps: [{ tool: "fill_login", arguments: {}, expectError: true }], reply: "The site refused it." },
    ] } }));
    const turn = async (text: string, count: number) => {
      await runControlLunabot(["send", "--bot", bot.id, "--task", bot.threadId, "--text", text, "--url", browser.base]);
      await expect.poll(() => evidence().length, { timeout: 20_000 }).toBe(count);
      expect(await runControlLunabot(["wait", "--bot", bot.id, "--task", bot.threadId, "--timeout", "20", "--url", browser.base])).toMatchObject({ status: "settled" });
    };

    await turn("Sign in to example.com.", 1);
    expect(answered(0, "fill_login")[0].content[0].text).toBe(`Filled the username and the password for ${USERNAME} on accounts.example.com. Submit the form now (its sign-in button, or Enter). The password is cleared from the page in 60 seconds. You never see the password; do not read it back from the page.`);
    const [evaluated] = answered(0, "agent_browser_eval");
    expect(evaluated).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/^A saved password was just filled on this page, so agent_browser_eval is refused here/u) }] });
    expect(page.field("#password").value).toBe(PASSWORD);
    expect(page.sent).toEqual([]);

    page.navigate("https://bob.github.io/login", LOGIN_FORM);
    await turn("Sign in to Bob's page.", 2);
    expect(answered(1, "fill_login")[0].content[0].text).toBe(`No saved login for bob.github.io. A login fills on its own site and the sign-in hosts saved with it, never on another site. Your saved logins: alice.github.io (alice), example.com (${USERNAME}). Open that site's login page, or call request_sign_in so the person signs in.`);
    expect(page.typed).toEqual([USERNAME, PASSWORD]);

    page.navigate("https://www.example.com/login", LOGIN_FORM);
    page.answer = () => ({ error: "Incorrect password." });
    await turn("Try www.", 3);
    expect(answered(2, "fill_login")[0].content[0].text).toBe(`The site did not accept the login for ${USERNAME} on www.example.com. It said: “Incorrect password.”. Check the saved login in Settings → Logins, or call request_sign_in. The password was cleared from the page.`);
    expect(page.sent).toHaveLength(1);
    expect(page.field("#password").value).toBe("");
    expect(JSON.stringify(evidence())).not.toContain(PASSWORD);
    expect(JSON.stringify(browser.engineArgs)).not.toContain(PASSWORD);
  } finally {
    await browser.close();
  }
}, 120_000);

it.skipIf(process.platform === "win32")("fills a login kept to one bot on its guest browser even while another bot uses guest too, since each guest browser is its own", async () => {
  const browser = await browserFixture("https://accounts.example.com/login");
  const { page, api, evidence, answered } = browser;
  try {
    expect((await api("PATCH", "/api/config", { features: { browser: true } })).status).toBe(200);
    const capacity = (await api("POST", "/api/bots", { name: "Capacity" })).body.bot;
    const costs = (await api("POST", "/api/bots", { name: "Costs" })).body.bot;
    for (const bot of [capacity, costs]) expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "browser", browserProfile: "guest" })).status).toBe(200);
    expect((await api("POST", "/api/logins", { site: "example.com", username: USERNAME, password: PASSWORD, bots: [capacity.id] })).status).toBe(201);
    const logins = (await api("GET", "/api/logins")).body.logins as Array<{ bots: unknown }>;
    expect(logins).toEqual([expect.objectContaining({ bots: [capacity.id] })]);
    writeFileSync(browser.planPath, JSON.stringify({ [capacity.id]: { turns: [{ steps: [{ tool: "fill_login", arguments: { submit: false } }], reply: "Filled." }] } }));

    await runControlLunabot(["send", "--bot", capacity.id, "--task", capacity.threadId, "--text", "Sign in to example.com.", "--url", browser.base]);
    await expect.poll(() => evidence().length, { timeout: 20_000 }).toBe(1);
    expect(answered(0, "fill_login")[0].isError).toBeFalsy();
    expect(evidence()[0].system).toContain(`example.com (${USERNAME})`);
    expect(page.sent).toEqual([]);
    expect(JSON.stringify(evidence())).not.toContain(PASSWORD);
  } finally {
    await browser.close();
  }
}, 120_000);

// Auto mounts this computer only on macOS and Windows, and the stand-in browser is a shebang script.
it.runIf(process.platform === "darwin")("on Auto, signs in in the bot's own browser beside this computer, never on the person's screen", async () => {
  // What the desktop app hands its own server once computer control is ready; the driver itself never runs here.
  const record = join(mkdtempSync(join(tmpdir(), "omb-saved-login-cua-")), "cua-connection.json");
  writeFileSync(record, JSON.stringify({
    mode: "embedded", status: "ready", socketPath: join(dirname(record), "cua.sock"), mcpCommand: "/fixture/cua-driver", mcpArgs: ["mcp"], mcpEnv: {},
  }), { mode: 0o600 });
  const browser = await browserFixture("https://example.com/login", record);
  const { page, api, evidence, answered } = browser;
  page.answer = () => ({ navigate: INVOICES });
  try {
    expect((await api("PATCH", "/api/config", { features: { browser: true } })).status).toBe(200);
    const bot = (await api("POST", "/api/bots", { name: "Statements" })).body.bot;
    expect((await api("PATCH", `/api/bots/${bot.id}`, { browserProfile: "guest" })).status).toBe(200);
    expect((await api("POST", "/api/logins", { site: "example.com", username: USERNAME, password: PASSWORD, bots: [bot.id] })).status).toBe(201);
    writeFileSync(browser.planPath, JSON.stringify({ [bot.id]: { turns: [
      { steps: [{ tool: "fill_login", arguments: {} }], reply: "Signed in." },
    ] } }));

    await runControlLunabot(["send", "--bot", bot.id, "--task", bot.threadId, "--text", "Sign in to example.com and get the invoices.", "--url", browser.base]);
    await expect.poll(() => evidence().length, { timeout: 20_000 }).toBe(1);
    const [turn] = evidence();
    expect(turn.system).toContain("Two surfaces are mounted");
    expect(turn.system).toContain("Web tasks → the built-in browser");
    expect(turn.system).toContain("use, in this order: a connected app that does it, your built-in browser, a cloud computer if select_computer offers one");
    const [filled] = answered(0, "fill_login");
    expect(filled.isError).toBeFalsy();
    expect(filled.content[0].text).toBe(`Filled the username and the password for ${USERNAME} on example.com and submitted it; the page is now https://example.com/invoices (“Invoices”). Check you are signed in.`);
    expect(page.sent).toEqual([{ email: USERNAME, password: PASSWORD, csrf: "token-not-a-secret" }]);
    // The person's own screen was never touched, so nothing asked to use it.
    const messages = (await api("GET", `/api/threads/${bot.threadId}/messages?limit=100`)).body.messages as any[];
    expect(messages.some((message) => message.card?.tool === "use_your_computer")).toBe(false);
    expect(JSON.stringify(evidence())).not.toContain(PASSWORD);
    expect(JSON.stringify(browser.engineArgs)).not.toContain(PASSWORD);
  } finally {
    await browser.close();
    await removeTempDir(dirname(record));
  }
}, 120_000);
