const env = require("../config/env");

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  console.error(err);
  const status = err.status || 500;
  res.status(status).json({
    error: status === 500 ? "internal_server_error" : err.message,
    // Stack traces only ever go to server logs / a dev environment response,
    // never to a production client.
    ...(env.nodeEnv !== "production" && status === 500 ? { detail: err.message } : {}),
  });
}

module.exports = errorHandler;
