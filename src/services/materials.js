const path = require("path");
const { badRequest } = require("../utils/params");
const { MANAGER_ROLES } = require("../middleware/auth");

// Training materials — the rules, kept free of the database so they can be
// tested on their own. Routes: src/routes/materials.js.

// Only these file types can be uploaded. The type a file is served with
// comes from its extension here — never from what the uploader's browser
// claimed — and nothing that a browser would run (HTML, SVG, scripts) is on
// the list. "kind" decides how the portal shows it.
const FILE_TYPES = {
  ".pdf": { mime: "application/pdf", kind: "pdf" },
  ".doc": { mime: "application/msword", kind: "document" },
  ".docx": { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", kind: "document" },
  ".xls": { mime: "application/vnd.ms-excel", kind: "document" },
  ".xlsx": { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", kind: "document" },
  ".ppt": { mime: "application/vnd.ms-powerpoint", kind: "document" },
  ".pptx": { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", kind: "document" },
  ".txt": { mime: "text/plain; charset=utf-8", kind: "document" },
  ".jpg": { mime: "image/jpeg", kind: "image" },
  ".jpeg": { mime: "image/jpeg", kind: "image" },
  ".png": { mime: "image/png", kind: "image" },
  ".webp": { mime: "image/webp", kind: "image" },
  ".gif": { mime: "image/gif", kind: "image" },
  ".mp3": { mime: "audio/mpeg", kind: "audio" },
  ".m4a": { mime: "audio/mp4", kind: "audio" },
  ".ogg": { mime: "audio/ogg", kind: "audio" },
  ".opus": { mime: "audio/ogg", kind: "audio" },
  ".wav": { mime: "audio/wav", kind: "audio" },
  // Phone call recordings (a good call as an example): converted to MP3
  // when played, like the recordings on the Calls page.
  ".amr": { mime: "audio/amr", kind: "audio", convert: true },
  ".3gp": { mime: "audio/3gpp", kind: "audio", convert: true },
  ".mp4": { mime: "video/mp4", kind: "video" },
  ".webm": { mime: "video/webm", kind: "video" },
  ".mov": { mime: "video/quicktime", kind: "video" },
};

// Big videos belong on YouTube or Google Drive (added as a link): they play
// better there and don't fill the server's disk.
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_FILES = 20;

// Who a material can be meant for besides positions and named people: the
// lawyers' accounts as a group. (The boss and the developer see every
// material anyway.)
const AUDIENCE_ROLES = ["LAWYER"];

function fileTypeOf(name) {
  const ext = path.extname(String(name || "")).toLowerCase();
  const type = FILE_TYPES[ext];
  return type ? { ext, ...type } : null;
}

// A file name to show and to download as: no folders, no control
// characters, not absurdly long, extension kept.
function cleanFileName(name) {
  const base = path.basename(String(name || "").replace(/\\/g, "/"));
  const clean = base.replace(/[\u0000-\u001f\u007f"]/g, "").trim();
  if (clean.length <= 120) return clean || "fayl";
  const ext = path.extname(clean).slice(0, 10);
  return clean.slice(0, 120 - ext.length) + ext;
}

function text(value, field, max, { required = false } = {}) {
  if (value === undefined && !required) return undefined;
  if (value === undefined || value === null || (typeof value === "string" && !value.trim())) {
    if (required) throw badRequest(`${field} is required`);
    return null;
  }
  if (typeof value !== "string") throw badRequest(`invalid ${field}`);
  const clean = value.replace(/\r\n/g, "\n").trim();
  if (clean.length > max) throw badRequest(`${field} is too long`);
  return clean;
}

// Only web links: a "javascript:" link on a staff page would be a way in.
function webLink(value) {
  const clean = text(value, "linkUrl", 1000);
  if (clean == null) return clean;
  let url;
  try {
    url = new URL(clean);
  } catch {
    throw badRequest("invalid linkUrl");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw badRequest("invalid linkUrl");
  return url.toString();
}

function flag(value, field) {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw badRequest(`invalid ${field}`);
  return value;
}

// The editable fields of a material from a request body. `creating`: the
// title is required and missing flags get their defaults.
function normalizeMaterial(b = {}, { creating = false } = {}) {
  const data = {
    title: text(b.title, "title", 160, { required: creating || b.title !== undefined }),
    category: text(b.category, "category", 60),
    body: text(b.body, "body", 50000),
    linkUrl: webLink(b.linkUrl),
    required: flag(b.required, "required"),
    published: flag(b.published, "published"),
    forEveryone: flag(b.forEveryone, "forEveryone"),
  };
  for (const key of Object.keys(data)) if (data[key] === undefined) delete data[key];
  return data;
}

function idList(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 500) throw badRequest(`invalid ${field}`);
  const ids = value.map(Number);
  if (ids.some((n) => !Number.isInteger(n) || n <= 0)) throw badRequest(`invalid ${field}`);
  return [...new Set(ids)];
}

// { positionIds: [], roles: ["LAWYER"], userIds: [] } -> MaterialAudience rows
// (without materialId). undefined: the audience isn't being changed.
function normalizeAudience(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw badRequest("invalid audience");
  const roles = value.roles === undefined || value.roles === null ? [] : value.roles;
  if (!Array.isArray(roles) || roles.some((r) => !AUDIENCE_ROLES.includes(r))) throw badRequest("invalid audience roles");
  return [
    ...idList(value.positionIds, "positionIds").map((positionId) => ({ positionId })),
    ...[...new Set(roles)].map((role) => ({ role })),
    ...idList(value.userIds, "userIds").map((userId) => ({ userId })),
  ];
}

// The audience rows back in the request's shape, for the editor.
function audienceOf(rows = []) {
  return {
    positionIds: rows.filter((a) => a.positionId).map((a) => a.positionId),
    roles: rows.filter((a) => a.role).map((a) => a.role),
    userIds: rows.filter((a) => a.userId).map((a) => a.userId),
  };
}

// Is `person` one of the people this material is for? `person`: a User with
// its employee ({ active, positionId }) when it has one. Managers are only
// counted when named — they see every material regardless (see canSee).
function inAudience(material, person) {
  if (!person?.active) return false;
  if (person.role === "EMPLOYEE" && !person.employee?.active) return false;
  const rows = material.audience || [];
  if (rows.some((a) => a.userId === person.id)) return true;
  if (MANAGER_ROLES.includes(person.role)) return false;
  if (material.forEveryone) return true;
  const positionId = person.employee?.positionId ?? null;
  return rows.some((a) => (a.role && a.role === person.role) || (a.positionId && a.positionId === positionId));
}

// Managers see everything, drafts and archived ones included; everyone
// else sees published materials meant for them.
function canSee(material, user) {
  if (MANAGER_ROLES.includes(user.role)) return true;
  return material.published && !material.archivedAt && inAudience(material, user);
}

// Read means read at the current version: "ask everyone to read it again"
// raises the version.
function isRead(material, read) {
  return Boolean(read) && read.version >= material.version;
}

module.exports = {
  FILE_TYPES,
  MAX_FILE_BYTES,
  MAX_FILES,
  AUDIENCE_ROLES,
  fileTypeOf,
  cleanFileName,
  normalizeMaterial,
  normalizeAudience,
  audienceOf,
  inAudience,
  canSee,
  isRead,
};
