// Recomputes the missed-call follow-up status of every call in the database.
// Normally unnecessary — each sync reconciles the numbers it touched — but
// useful after changing the rules in src/services/followUp.js, or if a
// reconciliation ever failed mid-sync (that's logged as
// "follow-up reconciliation failed").
//
//   npm run followups:rebuild
require("dotenv").config();
const prisma = require("../src/lib/prisma");
const { reconcileFollowUps } = require("../src/services/followUp");

async function main() {
  // Missed calls that somehow never got an initial status.
  await prisma.callLog.updateMany({
    where: { missed: true, followUp: null, phoneKey: null },
    data: { followUp: "no_number" },
  });
  await prisma.callLog.updateMany({
    where: { missed: true, followUp: null, phoneKey: { not: null } },
    data: { followUp: "pending" },
  });

  const keys = await prisma.callLog.findMany({
    where: { phoneKey: { not: null } },
    distinct: ["phoneKey"],
    select: { phoneKey: true },
  });
  const changed = await reconcileFollowUps(keys.map((k) => k.phoneKey));
  console.log(`Checked ${keys.length} phone numbers, updated ${changed} missed call(s).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
