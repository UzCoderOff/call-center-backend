// The API on each of its addresses (config/env.js, HOST): one listener per
// address, all serving the same app. No addresses: every address, as before.

// "127.0.0.1:4000", "[::1]:4000", or "port 4000" for every address.
function label(host, port) {
  if (!host) return `port ${port}`;
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

function listenOne(app, port, host) {
  return new Promise((resolve, reject) => {
    const args = host ? [port, host] : [port];
    const server = app.listen(...args, (err) => {
      if (err) {
        err.where = label(host, port);
        return reject(err);
      }
      resolve({ server, where: label(host, server.address().port) });
    });
  });
}

// IPv6 switched off on this machine: nothing can reach ::1 there either.
const NO_IPV6 = ["EADDRNOTAVAIL", "EAFNOSUPPORT"];

// Resolves with [{ server, where }] once every address is up. An IPv6
// address the machine doesn't have is skipped with a warning while another
// address is up; any other failure (the port taken by another copy)
// rejects, with err.where saying which address.
async function listenAll(app, port, hosts = []) {
  const list = hosts.length ? hosts : [null];
  const results = await Promise.allSettled(list.map((host) => listenOne(app, port, host)));
  const up = [];
  let failure = null;
  results.forEach((r, i) => {
    if (r.status === "fulfilled") up.push(r.value);
    else if (list[i] && list[i].includes(":") && NO_IPV6.includes(r.reason.code)) console.warn(`not listening on ${r.reason.where}: ${r.reason.message}`);
    else failure = failure || r.reason;
  });
  if (!failure && up.length === 0) failure = Object.assign(new Error("no address to listen on"), { where: list.map((h) => label(h, port)).join(", ") });
  if (failure) {
    for (const { server } of up) server.close();
    throw failure;
  }
  return up;
}

module.exports = { listenAll };
