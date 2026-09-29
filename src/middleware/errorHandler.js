const env = require("../config/env");

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  // Expected answers (404, 403, a bad request) are one line; real failures
  // get the whole stack.
  if (err.status && err.status < 500) console.warn(`${req.method} ${req.originalUrl}: ${err.status} ${err.message}`);
  else console.error(err);
  const status = err.status || 500;
  res.status(status).json({
    error: status === 500 ? "internal_server_error" : err.message,
    // Stack traces only ever go to server logs / a dev environment response,
    // never to a production client.
    // Only on a developer's own machine: Prisma messages can contain names
    // and phone numbers.
    ...(env.nodeEnv === "development" && status === 500 ? { detail: err.message } : {}),
  });
}

module.exports = errorHandler;
