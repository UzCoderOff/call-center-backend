// Creates (or updates the password of) the first DEVELOPER account, from
// ADMIN_USERNAME / ADMIN_PASSWORD in .env. There is no open registration
// endpoint anywhere in this app on purpose — every other account is created
// by a DEVELOPER or BOSS from inside the portal, and this script is the
// only way the very first account comes into existence.
require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");

const prisma = new PrismaClient();

async function main() {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;

  if (!username || !password) {
    throw new Error("Set ADMIN_USERNAME and ADMIN_PASSWORD in .env before running the seed script.");
  }
  if (password === "change-this-before-first-run") {
    throw new Error("ADMIN_PASSWORD is still the placeholder value — set a real password in .env first.");
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const user = await prisma.user.upsert({
    where: { username },
    update: { passwordHash, role: "DEVELOPER", active: true, mustChangePassword: true, passwordChangedAt: null },
    create: { username, passwordHash, role: "DEVELOPER", mustChangePassword: true },
  });

  console.log(`DEVELOPER account ready: ${user.username} (id ${user.id})`);
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
