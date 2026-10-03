const net = require("net");
const { EventEmitter } = require("events");

// A small client for Asterisk's manager interface (AMI) on 127.0.0.1: log
// in, send actions, hear events. It reconnects by itself (Asterisk restarts,
// the backend starts first). Everything else in src/services/pbx goes
// through it.
//
//   const ami = new Ami({ host, port, user, secret });
//   ami.on("ready", …)          logged in (again)
//   ami.on("event", (e) => …)   every event, e.g. { Event: "ContactStatus", … }
//   await ami.action({ Action: "Reload", Module: "res_pjsip.so" })
//   await ami.actionList({ Action: "QueueStatus", Queue: "callcenter" })  -> the events
class Ami extends EventEmitter {
  constructor({ host, port, user, secret, log = console }) {
    super();
    this.options = { host, port, user, secret };
    this.log = log;
    this.socket = null;
    this.ready = false;
    this.buffer = "";
    this.pending = new Map(); // ActionID -> { resolve, reject, list, events, timer }
    this.nextId = 1;
    this.retryMs = 1000;
    this.stopped = false;
  }

  start() {
    this.stopped = false;
    this.connect();
    return this;
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.socket?.destroy();
  }

  connect() {
    const socket = net.createConnection({ host: this.options.host, port: this.options.port });
    this.socket = socket;
    this.buffer = "";
    this.greeted = false;
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("error", (err) => {
      if (this.retryMs <= 1000) this.log.warn(`[pbx] AMI: ${err.message}`);
    });
    socket.on("close", () => {
      const was = this.ready;
      this.ready = false;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("AMI connection closed"));
      }
      this.pending.clear();
      if (was) this.emit("down");
      if (this.stopped) return;
      this.retryTimer = setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 30000);
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    // The first line is a banner without a blank line after it.
    if (!this.greeted) {
      const nl = this.buffer.indexOf("\r\n");
      if (nl < 0) return;
      this.greeted = true;
      this.buffer = this.buffer.slice(nl + 2);
      this.login();
    }
    let end;
    while ((end = this.buffer.indexOf("\r\n\r\n")) >= 0) {
      const block = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 4);
      if (block.trim()) this.onMessage(parseMessage(block));
    }
  }

  async login() {
    try {
      const res = await this.send({ Action: "Login", Username: this.options.user, Secret: this.options.secret, Events: "on" });
      if (res.Response !== "Success") throw new Error(res.Message || "login refused");
      this.ready = true;
      this.retryMs = 1000;
      this.log.log("[pbx] connected to Asterisk");
      this.emit("ready");
    } catch (err) {
      this.log.warn(`[pbx] AMI login failed: ${err.message}`);
      this.socket?.destroy();
    }
  }

  onMessage(msg) {
    const id = msg.ActionID;
    const p = id ? this.pending.get(id) : null;
    if (p) {
      if (msg.Response) {
        // A list action: its events follow, ending with EventList: Complete.
        if (p.list && msg.Response === "Success") return;
        if (p.list) return this.finish(id, new Error(msg.Message || "AMI error"), true);
        return this.finish(id, msg);
      }
      if (msg.Event) {
        if (msg.EventList === "Complete") return this.finish(id, p.events);
        p.events.push(msg);
        return;
      }
    }
    if (msg.Event) this.emit("event", msg);
  }

  finish(id, value, failed = false) {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    if (failed) p.reject(value);
    else p.resolve(value);
  }

  send(fields, { list = false, timeoutMs = 10000 } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) return reject(new Error("AMI not connected"));
      const id = `ledger-${this.nextId++}`;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`AMI ${fields.Action}: no answer`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, list, events: [], timer });
      this.socket.write(formatMessage({ ...fields, ActionID: id }));
    });
  }

  action(fields) {
    if (!this.ready) return Promise.reject(new Error("AMI not connected"));
    return this.send(fields);
  }

  actionList(fields) {
    if (!this.ready) return Promise.reject(new Error("AMI not connected"));
    return this.send(fields, { list: true });
  }
}

function parseMessage(block) {
  const msg = {};
  for (const line of block.split("\r\n")) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    // Repeated keys (e.g. ChanVariable) are kept as the last one.
    msg[key] = value;
  }
  return msg;
}

function formatMessage(fields) {
  let out = "";
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    // A value can't break into the next line (it would become another field).
    out += `${key}: ${String(value).replace(/[\r\n]/g, " ")}\r\n`;
  }
  return `${out}\r\n`;
}

module.exports = { Ami, parseMessage, formatMessage };
