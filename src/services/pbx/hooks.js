const http = require("http");
const env = require("../../config/env");

// What Asterisk asks Ledger while a call is going on, on 127.0.0.1 at
// PBX_HOOK_PORT — a listener of its own, which the web proxy (Caddy, which
// forwards the internet to :4000 from 127.0.0.1) never reaches — and only
// with PBX_HOOK_SECRET:
//
//   POST /pbx/wake  s=<secret>&ext=203&call=<id>&from=<number>
//        -> how many seconds to wait for that phone to come up ("0": it
//           can't be woken — ring whoever is next)
//   POST /pbx/caller  s=<secret>&num=<number>
//        -> the Ledger client's name for that number, "" if unknown
//   POST /pbx/test-call  s=<secret>&ext=203&kind=client|unknown
//        -> "1": a test call rings that phone in a few seconds (testCall.js)

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 4096) req.destroy();
    });
    req.on("end", () => resolve(new URLSearchParams(body)));
  });
}

async function handle(req, res, handlers) {
  const reply = (status, text) => {
    res.writeHead(status, { "Content-Type": "text/plain" });
    res.end(String(text));
  };
  try {
    if (req.method === "GET" && req.url === "/pbx/health") return reply(200, "ok");
    if (req.method !== "POST") return reply(404, "not found");
    const params = await readBody(req);
    if (!env.pbx.hookSecret || params.get("s") !== env.pbx.hookSecret) return reply(403, "forbidden");
    if (req.url === "/pbx/wake") return reply(200, await handlers.wake({ ext: params.get("ext"), call: params.get("call"), from: params.get("from") }));
    if (req.url === "/pbx/caller" && handlers.caller) return reply(200, await handlers.caller({ num: params.get("num") }));
    if (req.url === "/pbx/test-call" && handlers.testCall) return reply(200, await handlers.testCall({ ext: params.get("ext"), kind: params.get("kind") }));
    return reply(404, "not found");
  } catch (err) {
    console.error("[pbx] hook failed:", err.message);
    return reply(500, req.url === "/pbx/caller" ? "" : "0");
  }
}

function start(handlers) {
  const server = http.createServer((req, res) => handle(req, res, handlers));
  server.on("error", (err) => console.error(`[pbx] hook listener: ${err.message}`));
  server.listen(env.pbx.hookPort, "127.0.0.1", () => console.log(`[pbx] hooks on 127.0.0.1:${env.pbx.hookPort}`));
  return server;
}

module.exports = { start };
