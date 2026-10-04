const prisma = require("../../lib/prisma");
const state = require("./state");
const { isExtension } = require("./numbers");
const { clientScope } = require("../../lib/clientAccess");
const { callerLabel } = require("./caller");

// The phone tests anyone can dial (extensions.conf [phone-tests]): 601 —
// Ledger rings you back in a few seconds as one of your own clients (to see
// what the call screen shows about a client); 602 — from a number Ledger
// doesn't know. The test call isn't a real call: it's not saved anywhere
// (LEDGER_KIND=internal) and plays a recording when answered.

const DELAY_MS = 4000;
const UNKNOWN_NUMBER = "+998000000000";
const lastAt = new Map(); // ext -> ms, one test call at a time

// A client of theirs with a number: the one they worked on last.
async function sampleClient(ext) {
  const row = await prisma.pbxExtension.findUnique({ where: { ext }, include: { employee: { include: { user: { include: { employee: true } } } } } });
  const user = row?.employee?.user;
  if (!user) return null;
  return prisma.client.findFirst({
    where: { AND: [clientScope(user), { phones: { some: {} } }, { archivedAt: null }] },
    orderBy: { updatedAt: "desc" },
    include: { phones: { orderBy: { id: "asc" }, take: 1 } },
  });
}

// Asterisk asks (hooks.js): { ext, kind: "client" | "unknown" } -> "1" when a
// test call is on its way.
async function testCall({ ext, kind }) {
  if (!isExtension(ext) || !state.ami?.ready) return "0";
  if (Date.now() - (lastAt.get(ext) || 0) < 20 * 1000) return "0";
  let number = UNKNOWN_NUMBER;
  let name = "";
  if (kind === "client") {
    const client = await sampleClient(ext);
    if (client) {
      number = client.phones[0].phone;
      name = callerLabel(client.name);
    }
  }
  lastAt.set(ext, Date.now());
  setTimeout(() => {
    state.ami
      .action({
        Action: "Originate",
        Channel: `Local/${ext}@ring-person/n`,
        Application: "Playback",
        Data: "demo-congrats&demo-instruct&demo-moreinfo",
        CallerID: name ? `"${name}" <${number}>` : `<${number}>`,
        Variable: [`LEDGER_CALL=test-${ext}-${Date.now()}`, "LEDGER_KIND=internal"],
        Timeout: 40000,
        Async: "true",
      })
      .catch((err) => console.error(`[pbx] test call to ${ext} failed:`, err.message));
  }, DELAY_MS).unref();
  return "1";
}

module.exports = { testCall, UNKNOWN_NUMBER };
