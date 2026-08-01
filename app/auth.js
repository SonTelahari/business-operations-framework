const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { promisify } = require("node:util");

const scrypt = promisify(crypto.scrypt);
const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const AUDIT_LIMIT = 5000;

class AccountStore {
  constructor({ filePath = "", sessionSecret, repository = null }) {
    this.filePath = filePath;
    this.sessionSecret = sessionSecret;
    this.repository = repository;
    this.data = { version: 2, users: [], audit: [] };
    this.writeQueue = Promise.resolve();
  }

  async initialize({ adminFullName = "", adminPassword = "" } = {}) {
    if (!this.repository) {
      await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
    }
    this.data = await this.readData();

    if (!this.data.users.length) {
      if (adminFullName || adminPassword) {
        if (!adminFullName || !adminPassword) {
          throw new Error("ADMIN_FULL_NAME and ADMIN_PASSWORD must both be set when pre-provisioning an owner");
        }
        await this.provisionInitialAdmin(adminFullName, adminPassword, "Environment setup");
      }
    }
  }

  hasUsers() {
    return this.data.users.length > 0;
  }

  async provisionInitialAdmin(fullName, plainPassword, source = "First launch") {
    const cleanedName = validateFullName(fullName);
    validatePassword(plainPassword);
    return this.mutate(async () => {
      if (this.data.users.length) {
        throw accountError("The initial owner account has already been created", 409, "initial_admin_exists");
      }
      const now = new Date().toISOString();
      const user = {
        id: crypto.randomUUID(),
        fullName: cleanedName,
        loginKey: loginKey(cleanedName),
        role: "admin",
        status: "active",
        password: await hashPassword(plainPassword),
        sessionVersion: 1,
        createdAt: now,
        approvedAt: now,
        approvedBy: "system",
        lastLoginAt: ""
      };
      this.data.users.push(user);
      this.appendAudit({
        category: "account",
        action: "account.admin_created",
        actorName: "System",
        subjectId: user.id,
        subjectName: user.fullName,
        details: { role: "admin", source }
      });
      return publicUser(user);
    });
  }

  async register(fullName, plainPassword) {
    const cleanedName = validateFullName(fullName);
    validatePassword(plainPassword);

    return this.mutate(async () => {
      const key = loginKey(cleanedName);
      if (this.data.users.some(user => user.loginKey === key)) {
        throw accountError("An account with that character name already exists", 409, "name_taken");
      }
      const user = {
        id: crypto.randomUUID(),
        fullName: cleanedName,
        loginKey: key,
        role: "employee",
        status: "pending",
        password: await hashPassword(plainPassword),
        sessionVersion: 1,
        createdAt: new Date().toISOString(),
        approvedAt: "",
        approvedBy: "",
        lastLoginAt: ""
      };
      this.data.users.push(user);
      this.appendAudit({
        category: "account",
        action: "account.requested",
        actorId: user.id,
        actorName: user.fullName,
        subjectId: user.id,
        subjectName: user.fullName,
        details: { role: user.role }
      });
      return publicUser(user);
    });
  }

  async authenticate(fullName, plainPassword) {
    const user = this.data.users.find(candidate => candidate.loginKey === loginKey(fullName));
    if (!user || !(await verifyPassword(plainPassword, user.password))) {
      throw accountError("Character name or password is incorrect", 401, "invalid_credentials");
    }
    if (user.status === "pending") {
      throw accountError("Your account is waiting for admin approval", 403, "approval_pending");
    }
    if (user.status !== "active") {
      throw accountError("This account is disabled", 403, "account_disabled");
    }

    await this.mutate(async () => {
      user.lastLoginAt = new Date().toISOString();
      this.appendAudit({
        category: "authentication",
        action: "auth.login",
        actorId: user.id,
        actorName: user.fullName,
        subjectId: user.id,
        subjectName: user.fullName
      });
    });
    return publicUser(user);
  }

  getUserById(id) {
    const user = this.data.users.find(candidate => candidate.id === id);
    return user ? publicUser(user) : null;
  }

  listUsers() {
    return this.data.users
      .map(publicUser)
      .sort((a, b) => statusOrder(a.status) - statusOrder(b.status) || a.fullName.localeCompare(b.fullName));
  }

  listAudit(limit = 500) {
    const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 500));
    return this.data.audit.slice(0, safeLimit).map(publicAuditEvent);
  }

  async approve(userId, actor) {
    return this.mutate(async () => {
      const user = this.requireUser(userId);
      this.requireCanManage(actor, user);
      const previousStatus = user.status;
      user.status = "active";
      user.approvedAt = new Date().toISOString();
      user.approvedBy = actor.fullName;
      user.sessionVersion += 1;
      this.appendAudit({
        category: "staff",
        action: previousStatus === "disabled" ? "account.reactivated" : "account.approved",
        actorId: actor.id,
        actorName: actor.fullName,
        subjectId: user.id,
        subjectName: user.fullName,
        details: { previousStatus, status: user.status }
      });
      return publicUser(user);
    });
  }

  async disable(userId, actor) {
    return this.mutate(async () => {
      const user = this.requireUser(userId);
      this.requireCanManage(actor, user);
      if (user.id === actor.id) {
        throw accountError("You cannot disable your own account", 400, "self_disable");
      }
      if (user.role === "admin" && this.activeAdminCount() <= 1) {
        throw accountError("At least one active admin is required", 400, "last_admin");
      }
      user.status = "disabled";
      user.sessionVersion += 1;
      this.appendAudit({
        category: "staff",
        action: "account.disabled",
        actorId: actor.id,
        actorName: actor.fullName,
        subjectId: user.id,
        subjectName: user.fullName,
        details: { status: user.status }
      });
      return publicUser(user);
    });
  }

  async reject(userId, actor) {
    return this.mutate(async () => {
      const user = this.requireUser(userId);
      this.requireCanManage(actor, user);
      if (user.status !== "pending") {
        throw accountError("Only pending registrations can be rejected", 400, "not_pending");
      }
      this.data.users = this.data.users.filter(candidate => candidate.id !== userId);
      this.appendAudit({
        category: "staff",
        action: "account.rejected",
        actorId: actor.id,
        actorName: actor.fullName,
        subjectId: user.id,
        subjectName: user.fullName
      });
      return { id: userId };
    });
  }

  async setRole(userId, role, actor) {
    return this.mutate(async () => {
      if (actor.role !== "admin") {
        throw accountError("Admin access required to change roles", 403, "admin_required");
      }
      if (!new Set(["manager", "employee"]).has(role)) {
        throw accountError("Role must be manager or employee", 400, "invalid_role");
      }
      const user = this.requireUser(userId);
      if (user.id === actor.id) {
        throw accountError("You cannot change your own role", 400, "self_role_change");
      }
      if (user.status !== "active") {
        throw accountError("Only active accounts can change roles", 400, "inactive_role_change");
      }
      if (user.role === "admin") {
        throw accountError("Admin accounts cannot be changed here", 400, "admin_role_change");
      }
      const previousRole = user.role;
      user.role = role;
      user.sessionVersion += 1;
      this.appendAudit({
        category: "staff",
        action: "account.role_changed",
        actorId: actor.id,
        actorName: actor.fullName,
        subjectId: user.id,
        subjectName: user.fullName,
        details: { previousRole, role }
      });
      return publicUser(user);
    });
  }

  async recordAudit(event) {
    return this.mutate(async () => this.appendAudit(event));
  }

  createSession(user) {
    const stored = this.data.users.find(candidate => candidate.id === user.id);
    if (!stored || stored.status !== "active") throw accountError("Account is not active", 401, "inactive");
    const payload = Buffer.from(JSON.stringify({
      userId: stored.id,
      version: stored.sessionVersion,
      expiresAt: Date.now() + SESSION_MAX_AGE_SECONDS * 1000
    })).toString("base64url");
    return `${payload}.${sign(payload, this.sessionSecret)}`;
  }

  verifySession(token) {
    if (!token || !token.includes(".")) return null;
    const [payload, signature] = token.split(".", 2);
    if (!safeEqual(signature, sign(payload, this.sessionSecret))) return null;

    try {
      const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      if (decoded.expiresAt <= Date.now()) return null;
      const user = this.data.users.find(candidate => candidate.id === decoded.userId);
      if (!user || user.status !== "active" || user.sessionVersion !== decoded.version) return null;
      return publicUser(user);
    } catch {
      return null;
    }
  }

  requireUser(userId) {
    const user = this.data.users.find(candidate => candidate.id === userId);
    if (!user) throw accountError("Account not found", 404, "not_found");
    return user;
  }

  activeAdminCount() {
    return this.data.users.filter(user => user.role === "admin" && user.status === "active").length;
  }

  requireCanManage(actor, target) {
    if (actor.role === "admin") return;
    if (actor.role === "manager" && target.role === "employee") return;
    throw accountError("You cannot manage this account", 403, "staff_access_denied");
  }

  appendAudit(event) {
    const fingerprint = String(event.fingerprint || "").slice(0, 200);
    if (fingerprint && this.data.audit.some(entry => entry.fingerprint === fingerprint)) {
      return this.data.audit.find(entry => entry.fingerprint === fingerprint);
    }
    const saved = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      category: String(event.category || "general").slice(0, 40),
      action: String(event.action || "activity.recorded").slice(0, 80),
      actorId: String(event.actorId || "").slice(0, 100),
      actorName: String(event.actorName || "System").slice(0, 100),
      subjectId: String(event.subjectId || "").slice(0, 100),
      subjectName: String(event.subjectName || event.actorName || "").slice(0, 100),
      details: cleanAuditDetails(event.details),
      fingerprint
    };
    this.data.audit.unshift(saved);
    if (this.data.audit.length > AUDIT_LIMIT) this.data.audit.length = AUDIT_LIMIT;
    return saved;
  }

  async mutate(callback) {
    const operation = this.writeQueue.then(async () => {
      const result = await callback();
      await this.persist();
      return result;
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  async readData() {
    try {
      const parsed = this.repository
        ? await this.repository.load()
        : JSON.parse(await fs.promises.readFile(this.filePath, "utf8"));
      if (!parsed) return { version: 2, users: [], audit: [] };
      if (!Array.isArray(parsed.users)) throw new Error("users must be an array");
      if (!Array.isArray(parsed.audit)) parsed.audit = [];
      parsed.version = 2;
      return parsed;
    } catch (error) {
      if (error.code === "ENOENT") return { version: 2, users: [], audit: [] };
      throw new Error(`Unable to read account store: ${error.message}`);
    }
  }

  async persist() {
    if (this.repository) {
      await this.repository.save(this.data);
      return;
    }
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await fs.promises.writeFile(temporaryPath, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    await fs.promises.rename(temporaryPath, this.filePath);
  }
}

async function hashPassword(plainPassword) {
  const salt = crypto.randomBytes(16).toString("base64url");
  const derived = await scrypt(String(plainPassword), salt, 64);
  return { algorithm: "scrypt", salt, hash: derived.toString("base64url") };
}

async function verifyPassword(plainPassword, stored) {
  if (!stored || stored.algorithm !== "scrypt" || !stored.salt || !stored.hash) return false;
  const derived = await scrypt(String(plainPassword), stored.salt, 64);
  return safeEqual(derived.toString("base64url"), stored.hash);
}

function validateFullName(value) {
  const cleaned = cleanFullName(value);
  if (cleaned.length < 3 || cleaned.length > 80 || !cleaned.includes(" ")) {
    throw accountError("Enter your character's first and last name", 400, "invalid_name");
  }
  return cleaned;
}

function validatePassword(value) {
  const password = String(value || "");
  if (password.length < 10 || password.length > 128) {
    throw accountError("Password must be between 10 and 128 characters", 400, "invalid_password");
  }
}

function cleanFullName(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function loginKey(value) {
  return cleanFullName(value).toLocaleLowerCase("en-US");
}

function publicUser(user) {
  return {
    id: user.id,
    fullName: user.fullName,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt,
    approvedAt: user.approvedAt,
    approvedBy: user.approvedBy,
    lastLoginAt: user.lastLoginAt
  };
}

function publicAuditEvent(event) {
  return {
    id: event.id,
    createdAt: event.createdAt,
    category: event.category,
    action: event.action,
    actorId: event.actorId,
    actorName: event.actorName,
    subjectId: event.subjectId,
    subjectName: event.subjectName,
    details: event.details || {}
  };
}

function cleanAuditDetails(details) {
  if (!details || typeof details !== "object" || Array.isArray(details)) return {};
  return Object.fromEntries(Object.entries(details).slice(0, 20).map(([key, value]) => {
    const cleanKey = String(key).slice(0, 60);
    const cleanValue = typeof value === "number" || typeof value === "boolean"
      ? value
      : String(value ?? "").slice(0, 300);
    return [cleanKey, cleanValue];
  }));
}

function statusOrder(status) {
  return ({ pending: 0, active: 1, disabled: 2 })[status] ?? 3;
}

function sign(payload, secret) {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

function safeEqual(actual, expected) {
  const actualBuffer = Buffer.from(String(actual));
  const expectedBuffer = Buffer.from(String(expected));
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function accountError(message, status, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

module.exports = {
  AccountStore,
  SESSION_MAX_AGE_SECONDS,
  accountError,
  publicUser
};
