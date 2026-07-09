import net from "node:net";
import tls from "node:tls";

export type SmtpServerConfig = {
  host: string;
  port: number;
  secure: boolean;
  auth?: { user: string; pass: string };
  connectionTimeoutMs?: number;
  greetingHostname?: string;
};

export type SmtpMessage = {
  from: { address: string; name?: string };
  to: string;
  subject: string;
  text: string;
  html?: string;
};

export type SmtpSendItem = { to: string; ok: boolean; error?: string };

export type SmtpSendResult = {
  sent: number;
  failed: number;
  errors: string[];
  items: SmtpSendItem[];
};

const DEFAULT_TIMEOUT_MS = 20_000;

function encodeWord(value: string): string {
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function buildMimeMessage(msg: SmtpMessage): string {
  const boundary = `----=_ModelGate_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const fromHeader = msg.from.name
    ? `${encodeWord(msg.from.name)} <${msg.from.address}>`
    : `<${msg.from.address}>`;
  const subject = encodeWord(msg.subject);
  const date = new Date().toUTCString();
  const messageId = `<${Date.now()}-${Math.random().toString(36).slice(2)}@${msg.from.address.split("@")[1] || "modelgate"}>`;

  const headers = [
    `From: ${fromHeader}`,
    `To: <${msg.to}>`,
    `Subject: ${subject}`,
    `Date: ${date}`,
    `Message-ID: ${messageId}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].join("\r\n");

  const textPart = [
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(msg.text, "utf8").toString("base64"),
  ].join("\r\n");

  const htmlPart = msg.html
    ? [
        `--${boundary}`,
        "Content-Type: text/html; charset=UTF-8",
        "Content-Transfer-Encoding: base64",
        "",
        Buffer.from(msg.html, "utf8").toString("base64"),
      ].join("\r\n")
    : "";

  const closing = `--${boundary}--`;

  return [headers, "", textPart, htmlPart, closing].filter((part) => part !== "").join("\r\n");
}

function escapeBodyLine(line: string): string {
  return line.startsWith(".") ? `.${line}` : line;
}

class SmtpTransport {
  private socket!: net.Socket | tls.TLSSocket;
  private buffer = "";
  private pending: { resolve: (lines: string[]) => void; reject: (err: Error) => void } | null = null;
  private pendingLines: string[] = [];
  private destroyed = false;
  private readonly onDataBound: (chunk: Buffer) => void;
  private readonly onErrorBound: (err: Error) => void;
  private readonly onTimeoutBound: () => void;

  constructor(private config: SmtpServerConfig) {
    this.onDataBound = (chunk) => this.onData(chunk);
    this.onErrorBound = (err) => this.onError(err);
    this.onTimeoutBound = () => this.socket.destroy(new Error("SMTP 连接超时"));
    this.socket = config.secure
      ? tls.connect({ host: config.host, port: config.port, timeout: config.connectionTimeoutMs ?? DEFAULT_TIMEOUT_MS })
      : net.connect({ host: config.host, port: config.port, timeout: config.connectionTimeoutMs ?? DEFAULT_TIMEOUT_MS });
    this.attach(this.socket);
  }

  private attach(socket: net.Socket | tls.TLSSocket) {
    this.socket = socket;
    socket.on("data", this.onDataBound);
    socket.on("error", this.onErrorBound);
    socket.on("timeout", this.onTimeoutBound);
  }

  private detach(socket: net.Socket | tls.TLSSocket) {
    socket.removeListener("data", this.onDataBound);
    socket.removeListener("error", this.onErrorBound);
    socket.removeListener("timeout", this.onTimeoutBound);
  }

  private onData(chunk: Buffer) {
    this.buffer += chunk.toString("binary");
    let idx: number;
    while ((idx = this.buffer.indexOf("\r\n")) !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      this.handleLine(line);
    }
  }

  private handleLine(line: string) {
    if (!this.pending) return;
    this.pendingLines.push(line);
    const separator = line[3];
    if (separator === " " || separator === undefined) {
      const lines = this.pendingLines;
      this.pendingLines = [];
      const waiter = this.pending;
      this.pending = null;
      waiter.resolve(lines);
    }
  }

  private onError(err: Error) {
    if (this.pending) {
      const waiter = this.pending;
      this.pending = null;
      waiter.reject(err);
    }
    this.destroyed = true;
  }

  private writeLine(line: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.destroyed) {
        reject(new Error("SMTP 连接已关闭"));
        return;
      }
      this.socket.write(`${line}\r\n`, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private waitResponse(): Promise<string[]> {
    if (this.pending) return Promise.reject(new Error("SMTP 协议冲突：已有待处理命令"));
    if (this.destroyed) return Promise.reject(new Error("SMTP 连接已关闭"));
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
    });
  }

  private async sendCommand(command: string): Promise<string[]> {
    await this.writeLine(command);
    const lines = await this.waitResponse();
    const code = Number((lines[0] ?? "000").slice(0, 3));
    if (code >= 400) {
      throw new Error(`SMTP 错误 ${code}: ${lines.join(" ").trim()}`);
    }
    return lines;
  }

  private supportsStarttls(lines: string[]): boolean {
    return lines.some((line) => /^[0-9]{3}[- ]?.*\bSTARTTLS\b/i.test(line));
  }

  private async upgradeTls(): Promise<void> {
    const underlying = this.socket as net.Socket;
    this.detach(underlying);
    await new Promise<void>((resolve, reject) => {
      const secure = tls.connect(
        { socket: underlying, host: this.config.host, timeout: this.config.connectionTimeoutMs ?? DEFAULT_TIMEOUT_MS },
        () => resolve(),
      );
      secure.on("error", (err) => reject(err));
      this.attach(secure);
    });
  }

  async connect(): Promise<void> {
    const greeting = await this.waitResponse();
    const greetingCode = Number((greeting[0] ?? "000").slice(0, 3));
    if (greetingCode >= 400) throw new Error(`SMTP 握手失败: ${greeting.join(" ").trim()}`);

    const hostname = this.config.greetingHostname || "localhost";
    let capabilities = await this.sendCommand(`EHLO ${hostname}`);

    if (!this.config.secure && this.supportsStarttls(capabilities)) {
      await this.sendCommand("STARTTLS");
      await this.upgradeTls();
      capabilities = await this.sendCommand(`EHLO ${hostname}`);
    }

    if (this.config.auth?.user) {
      const plain = Buffer.from(`\0${this.config.auth.user}\0${this.config.auth.pass}`).toString("base64");
      try {
        await this.sendCommand(`AUTH PLAIN ${plain}`);
      } catch {
        await this.sendCommand("AUTH LOGIN");
        await this.sendCommand(Buffer.from(this.config.auth.user).toString("base64"));
        await this.sendCommand(Buffer.from(this.config.auth.pass).toString("base64"));
      }
    }
  }

  async sendMessage(msg: SmtpMessage): Promise<void> {
    await this.sendCommand(`MAIL FROM:<${msg.from.address}>`);
    await this.sendCommand(`RCPT TO:<${msg.to}>`);
    await this.sendCommand("DATA");
    const raw = buildMimeMessage(msg);
    const body = raw
      .split("\r\n")
      .map(escapeBodyLine)
      .join("\r\n");
    await this.writeLine(body);
    await this.writeLine(".");
    await this.waitResponse();
  }

  async quit(): Promise<void> {
    try {
      await this.sendCommand("QUIT");
    } catch {
      // ignore
    }
    this.detach(this.socket);
    this.socket.destroy();
  }
}

export async function sendSmtpMessages(
  server: SmtpServerConfig,
  messages: SmtpMessage[],
): Promise<SmtpSendResult> {
  if (messages.length === 0) return { sent: 0, failed: 0, errors: [], items: [] };
  const transport = new SmtpTransport(server);
  const errors: string[] = [];
  const items: SmtpSendItem[] = [];
  try {
    await transport.connect();
    for (const message of messages) {
      try {
        await transport.sendMessage(message);
        items.push({ to: message.to, ok: true });
      } catch (err) {
        const message2 = err instanceof Error ? err.message : String(err);
        items.push({ to: message.to, ok: false, error: message2 });
        errors.push(`${message.to}: ${message2}`);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push(`连接失败: ${message}`);
    const done = new Set(items.map((it) => it.to));
    for (const msg of messages) {
      if (!done.has(msg.to)) items.push({ to: msg.to, ok: false, error: `连接失败: ${message}` });
    }
  } finally {
    await transport.quit().catch(() => undefined);
  }
  const sent = items.filter((it) => it.ok).length;
  return { sent, failed: messages.length - sent, errors, items };
}
