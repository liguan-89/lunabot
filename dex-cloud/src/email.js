import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";

const SMTP_TIMEOUT_MS = 15_000;

export class EmailUnavailable extends Error {
  constructor(message = "email delivery is not configured") {
    super(message);
    this.code = "email_unavailable";
  }
}

class SmtpConnection {
  constructor(socket) {
    this.socket = socket;
    this.buffer = "";
    this.waiters = [];
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      this.buffer += chunk;
      this.flush();
    });
    socket.on("error", (error) => this.rejectAll(error));
    socket.on("close", () => this.rejectAll(new Error("SMTP connection closed")));
  }

  flush() {
    const waiter = this.waiters[0];
    if (!waiter) return;
    const lines = this.buffer.split("\r\n");
    if (lines.length < 2) return;
    const complete = [];
    for (const line of lines.slice(0, -1)) complete.push(line);
    this.buffer = lines.at(-1);
    let end = -1;
    for (let index = 0; index < complete.length; index += 1) {
      if (/^\d{3} /.test(complete[index])) {
        end = index;
        break;
      }
    }
    if (end === -1) return;
    const response = complete.slice(0, end + 1).join("\n");
    this.buffer = complete.slice(end + 1).join("\r\n") + (complete.length > end + 1 ? "\r\n" : "") + this.buffer;
    this.waiters.shift();
    clearTimeout(waiter.timer);
    waiter.resolve(response);
    this.flush();
  }

  rejectAll(error) {
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  read() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.timer === timer);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error("SMTP timed out"));
      }, SMTP_TIMEOUT_MS);
      this.waiters.push({ resolve, reject, timer });
      this.flush();
    });
  }

  async command(line, expect) {
    this.socket.write(`${line}\r\n`);
    const response = await this.read();
    const code = Number(response.slice(0, 3));
    if (!expect.includes(code)) throw new Error(`SMTP refused ${line.split(" ")[0]}: ${response.slice(0, 120)}`);
    return response;
  }

  close() {
    this.socket.end();
  }
}

function connectSocket({ protocol, host, port }) {
  return new Promise((resolve, reject) => {
    const socket = protocol === "smtps:"
      ? tlsConnect({ host, port, servername: host, rejectUnauthorized: true }, () => resolve(socket))
      : netConnect({ host, port }, () => resolve(socket));
    socket.setTimeout(SMTP_TIMEOUT_MS, () => socket.destroy(new Error("SMTP socket timed out")));
    socket.once("error", reject);
  });
}

function upgradeToTls(socket, host) {
  return new Promise((resolve, reject) => {
    const secure = tlsConnect({ socket, servername: host, rejectUnauthorized: true }, () => resolve(secure));
    secure.once("error", reject);
  });
}

async function smtpSend({ smtp, from, to, subject, text }) {
  let socket = await connectSocket(smtp);
  let connection = new SmtpConnection(socket);
  try {
    const greeting = await connection.read();
    if (!greeting.startsWith("220 ")) throw new Error(`SMTP greeting refused: ${greeting.slice(0, 120)}`);

    let ehlo = await connection.command("EHLO dex-cloud", [250]);
    if (smtp.protocol === "smtp:" && smtp.secure) {
      await connection.command("STARTTLS", [220]);
      socket = await upgradeToTls(socket, smtp.host);
      connection = new SmtpConnection(socket);
      ehlo = await connection.command("EHLO dex-cloud", [250]);
    }
    if (smtp.user) {
      if (/AUTH[ =].*PLAIN/i.test(ehlo)) {
        const token = Buffer.from(`\u0000${smtp.user}\u0000${smtp.password}`, "utf8").toString("base64");
        await connection.command(`AUTH PLAIN ${token}`, [235]);
      } else {
        await connection.command("AUTH LOGIN", [334]);
        await connection.command(Buffer.from(smtp.user, "utf8").toString("base64"), [334]);
        await connection.command(Buffer.from(smtp.password, "utf8").toString("base64"), [235]);
      }
    }
    await connection.command(`MAIL FROM:<${from}>`, [250]);
    await connection.command(`RCPT TO:<${to}>`, [250, 251]);
    await connection.command("DATA", [354]);
    const body = [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      text,
      "",
    ].join("\r\n").replace(/^\./gm, "..");
    socket.write(`${body}\r\n.\r\n`);
    const accepted = await connection.read();
    if (!accepted.startsWith("250 ")) throw new Error(`SMTP did not accept the message: ${accepted.slice(0, 120)}`);
    await connection.command("QUIT", [221]).catch(() => {});
  } finally {
    connection.close();
  }
}

async function resendSend({ key, from, to, subject, text }) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject, text }),
    signal: AbortSignal.timeout(SMTP_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`email API refused the message (${response.status})`);
}

export function createEmailer(config, log = console.log) {
  return async function send({ to, subject, text }) {
    if (config.resendKey) return resendSend({ key: config.resendKey, from: config.emailFrom, to, subject, text });
    if (config.smtp) return smtpSend({ smtp: config.smtp, from: config.emailFrom, to, subject, text });
    if (config.devCodes) {
      log(`[dex-cloud] dev email to ${to}: ${subject}\n${text}`);
      return;
    }
    throw new EmailUnavailable();
  };
}
