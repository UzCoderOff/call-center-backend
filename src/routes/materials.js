const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const prisma = require("../lib/prisma");
const env = require("../config/env");
const { events } = require("../lib/events");
const { requireAuth, requireRole, MANAGER_ROLES, isManager } = require("../middleware/auth");
const { badRequest, parseId } = require("../utils/params");
const { INCOMING_DIR, removeQuietly } = require("../utils/fileStorage");
const { resolvePlayableRecording } = require("../utils/audioTranscode");
const m = require("../services/materials");

// Training materials: the call-center script, how to work with clients,
// rules — for new staff to learn from and everyone to look things up in.
//
//   GET    /api/materials                   what I can see (+ read or not)
//   GET    /api/materials/:id               one material, with its files
//   POST   /api/materials/:id/read          "I've read it"
//   GET    /api/materials/files/:fileId     a file (PDF, audio, picture…)
// Managers (boss, developer):
//   GET    /api/materials/options           positions and people to choose from
//   POST   /api/materials                   create
//   PATCH  /api/materials/:id               edit; askAgain: everyone reads it again
//   DELETE /api/materials/:id               archive (restorable)
//   POST   /api/materials/:id/restore
//   DELETE /api/materials/:id/permanent     only an archived one, with its files
//   GET    /api/materials/:id/readers       who has read it and who hasn't
//   POST   /api/materials/:id/uploads       start a file upload …
//   PUT    /api/materials/uploads/:uploadId  … send it in pieces …
//   POST   /api/materials/uploads/:uploadId/finish
//   DELETE /api/materials/files/:fileId
//
// Files go up in pieces of under 1 MB: the portal reaches this server
// through Vercel's proxy (and maybe nginx), and small requests go through
// any proxy's size limit and survive a slow phone connection (a failed piece
// is simply sent again).

fs.mkdirSync(env.materialsDir, { recursive: true });

const router = express.Router();
router.use(requireAuth);
const managersOnly = requireRole(...MANAGER_ROLES);

const FILE_SELECT = { id: true, name: true, mimeType: true, size: true, createdAt: true };

function notFound() {
  const err = new Error("not_found");
  err.status = 404;
  return err;
}

// The people a material can be for, as inAudience() expects them.
const PERSON_SELECT = {
  id: true,
  username: true,
  name: true,
  role: true,
  active: true,
  employee: { select: { id: true, name: true, active: true, positionId: true, position: { select: { name: true } } } },
};
const personName = (u) => u.employee?.name || u.name || u.username;

async function candidatePeople() {
  return prisma.user.findMany({ where: { active: true }, select: PERSON_SELECT });
}

function fileKind(file) {
  return m.fileTypeOf(file.name)?.kind || "document";
}

function publicFile(file) {
  return { ...file, kind: fileKind(file) };
}

// What the list shows about one material.
function listItem(material, user, extra = {}) {
  const read = material.reads?.find((r) => r.userId === user.id) || null;
  return {
    id: material.id,
    title: material.title,
    category: material.category,
    required: material.required,
    published: material.published,
    archivedAt: material.archivedAt,
    version: material.version,
    updatedAt: material.updatedAt,
    hasText: Boolean(material.body),
    hasLink: Boolean(material.linkUrl),
    files: (material.files || []).map(publicFile),
    read: m.isRead(material, read),
    readAt: read?.readAt ?? null,
    ...extra,
  };
}

async function loadMaterial(id) {
  const material = await prisma.material.findUnique({
    where: { id: parseId(id) },
    include: { audience: true, files: { select: FILE_SELECT, orderBy: { id: "asc" } } },
  });
  if (!material) throw notFound();
  return material;
}

// Loads a material the signed-in person may see — or a 404, so nobody learns
// that a material they aren't meant for exists.
async function loadVisible(req, id) {
  const material = await loadMaterial(id);
  if (!m.canSee(material, req.user)) throw notFound();
  return material;
}

// "Read by 7 of 10" for each material, computed once for the whole list.
function readCounts(materials, people, reads) {
  const out = new Map();
  for (const material of materials) {
    const audience = people.filter((p) => m.inAudience(material, p));
    const ids = new Set(audience.map((p) => p.id));
    const readers = reads.filter((r) => r.materialId === material.id && ids.has(r.userId) && r.version >= material.version);
    out.set(material.id, { audienceCount: audience.length, readCount: readers.length });
  }
  return out;
}

router.get("/", async (req, res, next) => {
  try {
    const manager = isManager(req.user);
    const archived = manager && req.query.archived === "true";
    const rows = await prisma.material.findMany({
      where: manager ? { archivedAt: archived ? { not: null } : null } : { archivedAt: null, published: true },
      include: {
        audience: true,
        files: { select: FILE_SELECT, orderBy: { id: "asc" } },
        reads: manager ? true : { where: { userId: req.user.id } },
      },
      orderBy: [{ required: "desc" }, { updatedAt: "desc" }],
    });
    const visible = rows.filter((row) => m.canSee(row, req.user));

    if (!manager) return res.json(visible.map((row) => listItem(row, req.user)));

    const people = await candidatePeople();
    const counts = readCounts(visible, people, visible.flatMap((row) => row.reads));
    res.json(visible.map((row) => listItem(row, req.user, { forEveryone: row.forEveryone, audience: m.audienceOf(row.audience), ...counts.get(row.id) })));
  } catch (err) {
    next(err);
  }
});

// Everything the editor offers to choose from.
router.get("/options", managersOnly, async (req, res, next) => {
  try {
    const [positions, people, categories] = await Promise.all([
      prisma.position.findMany({
        orderBy: { name: "asc" },
        select: { id: true, name: true, _count: { select: { employees: { where: { active: true, userId: { not: null } } } } } },
      }),
      candidatePeople(),
      prisma.material.findMany({ where: { category: { not: null }, archivedAt: null }, distinct: ["category"], select: { category: true } }),
    ]);
    res.json({
      positions: positions.map((p) => ({ id: p.id, name: p.name, count: p._count.employees })),
      lawyerCount: people.filter((p) => p.role === "LAWYER").length,
      people: people
        // The boss and the developer see every material anyway.
        .filter((p) => !MANAGER_ROLES.includes(p.role) && (p.role !== "EMPLOYEE" || p.employee?.active))
        .map((p) => ({ id: p.id, name: personName(p), role: p.role, position: p.employee?.position?.name ?? null }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      categories: categories.map((c) => c.category).sort(),
      maxFileBytes: m.MAX_FILE_BYTES,
      fileTypes: Object.keys(m.FILE_TYPES),
    });
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const material = await loadVisible(req, req.params.id);
    const read = await prisma.materialRead.findUnique({ where: { materialId_userId: { materialId: material.id, userId: req.user.id } } });
    const { audience, files, createdById, ...rest } = material;
    res.json({
      ...rest,
      files: files.map(publicFile),
      read: m.isRead(material, read),
      readAt: read?.readAt ?? null,
      // Read before, but the material changed since and was sent again.
      readOlderVersion: Boolean(read) && !m.isRead(material, read),
      ...(isManager(req.user) ? { audience: m.audienceOf(audience) } : {}),
    });
  } catch (err) {
    next(err);
  }
});

router.post("/:id/read", async (req, res, next) => {
  try {
    const material = await loadVisible(req, req.params.id);
    const key = { materialId_userId: { materialId: material.id, userId: req.user.id } };
    const read = await prisma.materialRead.upsert({
      where: key,
      create: { materialId: material.id, userId: req.user.id, version: material.version },
      update: { version: material.version, readAt: new Date() },
    });
    res.json({ read: true, readAt: read.readAt });
  } catch (err) {
    next(err);
  }
});

// Who it's for and whether they've read it — for chasing up new staff.
router.get("/:id/readers", managersOnly, async (req, res, next) => {
  try {
    const material = await loadMaterial(req.params.id);
    const [people, reads] = await Promise.all([
      candidatePeople(),
      prisma.materialRead.findMany({ where: { materialId: material.id } }),
    ]);
    const readBy = new Map(reads.map((r) => [r.userId, r]));
    const rows = people
      .filter((p) => m.inAudience(material, p))
      .map((p) => {
        const read = readBy.get(p.id);
        return {
          userId: p.id,
          name: personName(p),
          role: p.role,
          position: p.employee?.position?.name ?? null,
          read: m.isRead(material, read),
          readAt: read?.readAt ?? null,
          readOlderVersion: Boolean(read) && !m.isRead(material, read),
        };
      })
      .sort((a, b) => Number(a.read) - Number(b.read) || a.name.localeCompare(b.name));
    res.json({ version: material.version, people: rows });
  } catch (err) {
    next(err);
  }
});

function audit(db, req, action, entityId, detail) {
  return db.auditLog.create({ data: { userId: req.user.id, action, entity: "material", entityId, detail } });
}

function knownErrors(err, res, next) {
  if (err.code === "P2003") return res.status(400).json({ error: "invalid_reference" });
  if (err.code === "P2025") return res.status(404).json({ error: "not_found" });
  return next(err);
}

// Tell the people it's for (Telegram) — when it's visible and the manager
// asked for it.
function announce(material, req) {
  if (material.published && !material.archivedAt && req.body?.notify === true) {
    events.emit("material.published", { materialId: material.id, byUserId: req.user.id });
  }
}

router.post("/", managersOnly, async (req, res, next) => {
  try {
    const data = m.normalizeMaterial(req.body, { creating: true });
    const audience = m.normalizeAudience(req.body?.audience) ?? [];
    const material = await prisma.material.create({
      data: { ...data, createdById: req.user.id, audience: { create: audience } },
    });
    announce(material, req);
    res.status(201).json(material);
  } catch (err) {
    knownErrors(err, res, next);
  }
});

router.patch("/:id", managersOnly, async (req, res, next) => {
  try {
    const existing = await loadMaterial(req.params.id);
    const data = m.normalizeMaterial(req.body);
    const audience = m.normalizeAudience(req.body?.audience);
    // "Ask everyone to read it again" — earlier reads no longer count.
    if (req.body?.askAgain === true) data.version = existing.version + 1;
    const material = await prisma.$transaction(async (tx) => {
      if (audience !== undefined) {
        await tx.materialAudience.deleteMany({ where: { materialId: existing.id } });
        if (audience.length > 0) await tx.materialAudience.createMany({ data: audience.map((a) => ({ ...a, materialId: existing.id })) });
      }
      return tx.material.update({ where: { id: existing.id }, data });
    });
    announce(material, req);
    res.json(material);
  } catch (err) {
    knownErrors(err, res, next);
  }
});

router.delete("/:id", managersOnly, async (req, res, next) => {
  try {
    const existing = await loadMaterial(req.params.id);
    await prisma.$transaction([
      prisma.material.update({ where: { id: existing.id }, data: { archivedAt: new Date() } }),
      audit(prisma, req, "material.archive", existing.id, { title: existing.title }),
    ]);
    res.status(204).end();
  } catch (err) {
    knownErrors(err, res, next);
  }
});

router.post("/:id/restore", managersOnly, async (req, res, next) => {
  try {
    const existing = await loadMaterial(req.params.id);
    const [material] = await prisma.$transaction([
      prisma.material.update({ where: { id: existing.id }, data: { archivedAt: null } }),
      audit(prisma, req, "material.restore", existing.id, { title: existing.title }),
    ]);
    res.json(material);
  } catch (err) {
    knownErrors(err, res, next);
  }
});

// Gone for good — only from the archive, so it takes two deliberate steps.
router.delete("/:id/permanent", managersOnly, async (req, res, next) => {
  try {
    const existing = await loadMaterial(req.params.id);
    if (!existing.archivedAt) return res.status(409).json({ error: "archive_first" });
    const files = await prisma.materialFile.findMany({ where: { materialId: existing.id } });
    await prisma.$transaction([
      prisma.material.delete({ where: { id: existing.id } }),
      audit(prisma, req, "material.delete", existing.id, { title: existing.title, body: existing.body, files: files.map((f) => f.name) }),
    ]);
    for (const f of files) removeQuietly(path.join(env.materialsDir, f.path));
    res.status(204).end();
  } catch (err) {
    knownErrors(err, res, next);
  }
});

// ------------------------------------------------------------------- files

// Uploads in progress, by id. In memory on purpose: an upload cut off by a
// restart is simply started again. Abandoned ones are cleared after an hour.
// Under 1 MB: the default request limit of common web servers (nginx), in
// case one sits in front of this API.
const CHUNK_BYTES = 900 * 1024;
const UPLOAD_TTL_MS = 60 * 60 * 1000;
const uploads = new Map();

function dropUpload(id) {
  const upload = uploads.get(id);
  if (!upload) return;
  uploads.delete(id);
  removeQuietly(upload.tempPath);
}

setInterval(() => {
  const now = Date.now();
  for (const [id, upload] of uploads) if (now - upload.touchedAt > UPLOAD_TTL_MS) dropUpload(id);
}, 10 * 60 * 1000).unref();

function ownUpload(req) {
  const upload = uploads.get(String(req.params.uploadId));
  if (!upload || upload.userId !== req.user.id) throw notFound();
  return upload;
}

router.post("/:id/uploads", managersOnly, async (req, res, next) => {
  try {
    const material = await loadMaterial(req.params.id);
    const name = m.cleanFileName(req.body?.name);
    const size = Number(req.body?.size);
    const type = m.fileTypeOf(name);
    if (!type) return res.status(400).json({ error: "file_type_not_allowed" });
    if (!Number.isInteger(size) || size <= 0) throw badRequest("invalid size");
    if (size > m.MAX_FILE_BYTES) return res.status(413).json({ error: "file_too_large", maxBytes: m.MAX_FILE_BYTES });
    if (material.files.length >= m.MAX_FILES) return res.status(409).json({ error: "too_many_files" });

    const id = crypto.randomBytes(16).toString("hex");
    const tempPath = path.join(INCOMING_DIR, `material-${id}.part`);
    fs.writeFileSync(tempPath, "");
    uploads.set(id, { id, materialId: material.id, userId: req.user.id, name, size, type, tempPath, received: 0, busy: false, touchedAt: Date.now() });
    res.status(201).json({ uploadId: id, chunkBytes: CHUNK_BYTES });
  } catch (err) {
    next(err);
  }
});

// One piece, at ?offset= (the bytes received so far). A piece that arrives
// twice or out of order gets 409 with where to continue from.
router.put(
  "/uploads/:uploadId",
  managersOnly,
  express.raw({ type: "application/octet-stream", limit: CHUNK_BYTES + 1024 }),
  async (req, res, next) => {
    let upload;
    try {
      upload = ownUpload(req);
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw badRequest("empty piece");
      if (upload.busy || Number(req.query.offset) !== upload.received) {
        return res.status(409).json({ error: "wrong_offset", received: upload.received });
      }
      if (upload.received + req.body.length > upload.size) {
        dropUpload(upload.id);
        return res.status(400).json({ error: "larger_than_announced" });
      }
      upload.busy = true;
      await fs.promises.appendFile(upload.tempPath, req.body);
      upload.received += req.body.length;
      upload.touchedAt = Date.now();
      res.json({ received: upload.received });
    } catch (err) {
      next(err);
    } finally {
      if (upload) upload.busy = false;
    }
  }
);

router.post("/uploads/:uploadId/finish", managersOnly, async (req, res, next) => {
  let upload;
  try {
    upload = ownUpload(req);
    if (upload.busy || upload.received !== upload.size) return res.status(409).json({ error: "incomplete", received: upload.received });
    uploads.delete(upload.id);
    const stored = `${upload.materialId}-${crypto.randomBytes(8).toString("hex")}${upload.type.ext}`;
    fs.renameSync(upload.tempPath, path.join(env.materialsDir, stored));
    const file = await prisma.materialFile.create({
      data: { materialId: upload.materialId, name: upload.name, path: stored, mimeType: upload.type.mime, size: upload.size },
      select: FILE_SELECT,
    });
    res.status(201).json(publicFile(file));
  } catch (err) {
    if (upload) removeQuietly(upload.tempPath);
    knownErrors(err, res, next);
  }
});

router.delete("/uploads/:uploadId", managersOnly, (req, res, next) => {
  try {
    dropUpload(ownUpload(req).id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.delete("/files/:fileId", managersOnly, async (req, res, next) => {
  try {
    const file = await prisma.materialFile.findUnique({ where: { id: parseId(req.params.fileId, "fileId") } });
    if (!file) throw notFound();
    await prisma.$transaction([
      prisma.materialFile.delete({ where: { id: file.id } }),
      audit(prisma, req, "material.file.delete", file.materialId, { name: file.name, size: file.size }),
    ]);
    removeQuietly(path.join(env.materialsDir, file.path));
    res.status(204).end();
  } catch (err) {
    knownErrors(err, res, next);
  }
});

// Pictures, audio, video and PDFs open in place; office documents (and
// anything with ?download=1) are downloaded under their own name.
router.get("/files/:fileId", async (req, res, next) => {
  try {
    const file = await prisma.materialFile.findUnique({ where: { id: parseId(req.params.fileId, "fileId") } });
    if (!file) throw notFound();
    await loadVisible(req, file.materialId);

    const type = m.fileTypeOf(file.name) || { mime: "application/octet-stream", kind: "document" };
    let absolutePath = path.join(env.materialsDir, file.path);
    let contentType = type.mime;
    const download = req.query.download === "1" || type.kind === "document";
    if (type.convert && !download) {
      // A phone recording (AMR): an MP3 copy browsers can play.
      const playable = await resolvePlayableRecording(`materials/${file.path}`, () => absolutePath);
      absolutePath = playable.absolutePath;
      contentType = playable.contentType;
    }
    if (!fs.existsSync(absolutePath)) return res.status(404).json({ error: "file_missing" });

    if (download) res.attachment(file.name);
    else res.set("Content-Disposition", "inline");
    res.sendFile(absolutePath, {
      headers: {
        "Content-Type": contentType,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.CHUNK_BYTES = CHUNK_BYTES;
