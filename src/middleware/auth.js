const { verifySessionToken } = require("../lib/tokens");
const prisma = require("../lib/prisma");

// DEVELOPER and BOSS see everything ("managers"). LAWYER: only their own
// calendar and the cases assigned to them. EMPLOYEE: per their settings.
// Anything not explicitly opened to a role is closed to it.
const ROLES = ["DEVELOPER", "BOSS", "LAWYER", "EMPLOYEE"];
const MANAGER_ROLES = ["BOSS", "DEVELOPER"];
const isManager = (user) => Boolean(user) && MANAGER_ROLES.includes(user.role);
const isLawyer = (user) => Boolean(user) && user.role === "LAWYER";

// Verifies the session cookie and attaches the current user (with their
// linked Employee record, if any) to req.user. The account is re-fetched
// from the DB on every request — not just decoded from the token — so a
// deactivated account or a role change takes effect immediately.
async function requireAuth(req, res, next) {
  try {
    const token = req.cookies?.session;
    if (!token) return res.status(401).json({ error: "unauthorized" });

    const decoded = verifySessionToken(token);
    const user = await prisma.user.findUnique({
      where: { id: decoded.sub },
      include: { employee: true },
    });

    if (!user || !user.active) {
      return res.status(401).json({ error: "unauthorized" });
    }

    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: "unauthorized" });
  }
}

// requireRole("BOSS", "DEVELOPER") -> only those roles may proceed.
// Must run after requireAuth.
function requireRole(...allowedRoles) {
  for (const role of allowedRoles) {
    if (!ROLES.includes(role)) {
      throw new Error(`requireRole: unknown role "${role}"`);
    }
  }
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: "forbidden" });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole, ROLES, MANAGER_ROLES, isManager, isLawyer };
