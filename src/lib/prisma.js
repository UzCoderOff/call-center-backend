const { PrismaClient } = require("@prisma/client");

// A single shared client for the whole process. Creating a new PrismaClient
// per request would exhaust the SQLite connection and leak file handles.
const prisma = new PrismaClient();

module.exports = prisma;
