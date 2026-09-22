const crypto = require("crypto");
const prisma = require("../lib/prisma");

// 20 bytes -> 40 hex chars. Long enough that guessing one is not a
// realistic attack, short enough to type by hand if someone ever has to.
function generateCandidate() {
  return crypto.randomBytes(20).toString("hex");
}

// Collisions are astronomically unlikely at this length, but check anyway
// rather than trust that — the check is one cheap indexed lookup.
async function generateUniqueEmployeeId() {
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = generateCandidate();
    const existing = await prisma.employee.findUnique({
      where: { employeeId: candidate },
      select: { id: true },
    });
    if (!existing) return candidate;
  }
  throw new Error("Failed to generate a unique employeeId after 5 attempts");
}

module.exports = { generateUniqueEmployeeId };
