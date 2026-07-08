declare function require(module: "fs"): typeof import("fs");
declare function require(module: "path"): typeof import("path");

const QUEUE_CAPACITY = 1024;
const BATCH_SIZE = 64;
const FLUSH_INTERVAL_MS = 100;

let instance: JsonlLogWriter | null = null;

export function getJsonlLogWriter(): JsonlLogWriter | null {
  if (instance === null) {
    try {
      const enabled = process.env.JSONL_LOG_ENABLED === "1";
      if (!enabled) return null;
      const fs = require("fs") as typeof import("fs");
      const path = require("path") as typeof import("path");
      const logPath = process.env.JSONL_LOG_PATH || path.join(process.cwd(), "data", "request-logs.jsonl");
      const dir = path.dirname(logPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      instance = new JsonlLogWriter(logPath, fs);
    } catch {
      return null;
    }
  }
  return instance;
}

class JsonlLogWriter {
  private queue: object[] = [];
  private pendingResolver: (() => void) | null = null;
  private logPath: string;
  private fd: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private fs: typeof import("fs");

  constructor(logPath: string, fsModule: typeof import("fs")) {
    this.logPath = logPath;
    this.fs = fsModule;
    this.timer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
  }

  async enqueue(record: object) {
    if (this.queue.length >= QUEUE_CAPACITY) {
      await new Promise<void>((resolve) => { this.pendingResolver = resolve; });
    }
    this.queue.push(record);
  }

  private openFile() {
    try {
      this.fd = this.fs.openSync(this.logPath, "a");
    } catch (err) {
      console.error("[jsonl-log] 无法打开日志文件:", err);
      this.fd = null;
    }
  }

  private ensureFd() {
    if (this.fd === null) this.openFile();
    return this.fd;
  }

  private flush() {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, Math.min(BATCH_SIZE, this.queue.length));
    const lines = batch.map((r) => JSON.stringify(r)).join("\n") + "\n";
    const fd = this.ensureFd();
    if (fd === null) return;
    try {
      this.fs.writeSync(fd, lines);
    } catch (err) {
      console.error("[jsonl-log] 写入失败:", err);
      try {
        this.fs.closeSync(fd);
      } catch {
        // ignore close error
      }
      this.fd = null;
    }
    if (this.pendingResolver && this.queue.length < QUEUE_CAPACITY) {
      this.pendingResolver();
      this.pendingResolver = null;
    }
  }

  shutdown() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.flush();
    while (this.queue.length > 0) {
      this.flush();
    }
    if (this.fd !== null) {
      try {
        this.fs.closeSync(this.fd);
      } catch {
        // ignore
      }
      this.fd = null;
    }
  }
}
