import net from "node:net";

// A tiny SMTP server for tests: it speaks real SMTP (so the application's mail code, nodemailer and all, runs unchanged) and keeps
// every accepted message in memory. It is a LOCAL TEST LISTENER, not a mailbox: a message arriving here proves the application
// handed a correct message to an SMTP server, nothing about delivery to a real inbox.
export interface SunkMail {
  from: string;
  to: string[];
  raw: string;
  // The message body with quoted-printable decoded (so links and addresses can be read back).
  text: string;
}

const decodeQuotedPrintable = (s: string) => s.replace(/=\r?\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

export class SmtpSink {
  readonly messages: SunkMail[] = [];
  private server: net.Server;
  constructor(private port: number) {
    this.server = net.createServer((socket) => this.session(socket));
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, "127.0.0.1", () => resolve());
    });
  }
  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private session(socket: net.Socket) {
    let buf = "";
    let from = "";
    let to: string[] = [];
    let data: string | null = null;
    const reply = (line: string) => socket.write(line + "\r\n");
    reply("220 sink ESMTP");
    socket.on("error", () => undefined);
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      for (;;) {
        if (data !== null) {
          const end = buf.indexOf("\r\n.\r\n");
          if (end === -1) return;
          data = buf.slice(0, end);
          buf = buf.slice(end + 5);
          const raw = data;
          this.messages.push({ from, to, raw, text: decodeQuotedPrintable(raw) });
          data = null;
          from = "";
          to = [];
          reply("250 queued");
          continue;
        }
        const nl = buf.indexOf("\r\n");
        if (nl === -1) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === "EHLO") reply("250-sink\r\n250 8BITMIME");
        else if (cmd === "HELO") reply("250 sink");
        else if (cmd === "MAIL") {
          from = /<([^>]*)>/.exec(line)?.[1] ?? "";
          reply("250 ok");
        }
        else if (cmd === "RCPT") {
          to.push(/<([^>]*)>/.exec(line)?.[1] ?? "");
          reply("250 ok");
        }
        else if (cmd === "DATA") {
          data = "";
          reply("354 go ahead");
        }
        else if (cmd === "RSET") reply("250 ok");
        else if (cmd === "NOOP") reply("250 ok");
        else if (cmd === "QUIT") {
          reply("221 bye");
          socket.end();
        }
        else reply("502 not implemented");
      }
    });
  }

  async waitFor(to: string, ms = 8000): Promise<SunkMail | null> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const m = [...this.messages].reverse().find((x) => x.to.includes(to));
      if (m) return m;
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  }
  countFor(to: string) {
    return this.messages.filter((x) => x.to.includes(to)).length;
  }
}
