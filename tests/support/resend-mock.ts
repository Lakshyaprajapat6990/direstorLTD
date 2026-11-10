import http from "node:http";

export interface ResendMessage {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html: string;
}

// A stand-in for the Resend REST API (https://api.resend.com), used to test the application's Resend integration without
// sending a real email. It checks the bearer key, records every message POSTed to /emails and can be told to fail.
export class ResendMock {
  readonly messages: ResendMessage[] = [];
  readonly authHeaders: string[] = [];
  mode: "ok" | "restricted" | "fail" = "ok";
  private server?: http.Server;

  constructor(
    readonly port: number,
    readonly key = "re_test_key_not_real",
  ) {}

  start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const send = (status: number, body: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(body));
        };
        const auth = String(req.headers.authorization ?? "");
        this.authHeaders.push(auth);
        if (auth !== `Bearer ${this.key}`) return send(401, { statusCode: 401, name: "invalid_api_key", message: "API key is invalid" });
        if (req.method === "GET" && req.url === "/domains") return this.mode === "restricted" ? send(401, { statusCode: 401, name: "restricted_api_key", message: "This API key is restricted to only send emails" }) : send(200, { data: [] });
        if (req.method === "POST" && req.url === "/emails") {
          if (this.mode === "fail") return send(403, { statusCode: 403, name: "validation_error", message: "You can only send testing emails to your own email address" });
          this.messages.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          return send(200, { id: `mock-${this.messages.length}` });
        }
        send(404, { statusCode: 404, name: "not_found", message: "Route not found" });
      });
    });
    return new Promise((resolve) => this.server!.listen(this.port, "127.0.0.1", resolve));
  }

  stop(): Promise<void> {
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  countFor(email: string) {
    return this.messages.filter((m) => m.to.includes(email)).length;
  }

  async waitFor(email: string, ms = 8000): Promise<ResendMessage | undefined> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const m = [...this.messages].reverse().find((x) => x.to.includes(email));
      if (m) return m;
      await new Promise((r) => setTimeout(r, 100));
    }
    return undefined;
  }
}
