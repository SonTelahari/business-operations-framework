const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { promisify } = require("node:util");

const scrypt = promisify(crypto.scrypt);
const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

class AccountStore {
  constructor({ filePath, sessionSecret }) {
    this.filePath = filePath;
    this.sessionSecret = sessionSecret;
    this.data = { version: 1, users: [] };
    this.writeQueue = Promise.resolve();
  }

  async initialize({ adminFullName, adminPassword }) {
    await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
    this.data = await this.readData();

    if (!this.data.users.length) {
      if (!adminFullName || !adminPassword) {
        throw new Error("ADMIN_FULL_NAME and ADMIN_PASSWORD are required for the first account");
      }
      const now = new Date().toISOString();
      const password = await hashPassword(adminPassword);
      this.data.users.push({
        id: crypto.randomUUID(),
        fullName: cleanFullName(adminFullName),
        loginKey: loginKey(adminFullName),
        role: "admin",
        status: "active",
        password,
        sessionVersion: 1,
        createdAt: now,
        approvedAt: now,
        approvedBy: "system",
        lastLoginAt: ""
      });
      await this.persist();
    }
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

  async approve(userId, admin) {
    return this.mutate(async () => {
      const user = this.requireUser(userId);
      user.status = "active";
      user.approvedAt = new Date().toISOString();
      user.approvedBy = admin.fullName;
      user.sessionVersion += 1;
      return publicUser(user);
    });
  }

  async disable(userId, admin) {
    return this.mutate(async () => {
      const user = this.requireUser(userId);
      if (user.id === admin.id) {
        throw accountError("You cannot disable your own account", 400, "self_disable");
      }
      if (user.role === "admin" && this.activeAdminCount() <= 1) {
        throw accountError("At least one active admin is required", 400, "last_admin");
      }
      user.status = "disabled";
      user.sessionVersion += 1;
      return publicUser(user);
    });
  }

  async reject(userId) {
    return this.mutate(async () => {
      const user = this.requireUser(userId);
      if (user.status !== "pending") {
        throw accountError("Only pending registrations can be rejected", 400, "not_pending");
      }
      this.data.users = this.data.users.filter(candidate => candidate.id !== userId);
      return { id: userId };
    });
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
      const parsed = JSON.parse(await fs.promises.readFile(this.filePath, "utf8"));
      if (!Array.isArray(parsed.users)) throw new Error("users must be an array");
      return parsed;
    } catch (error) {
      if (error.code === "ENOENT") return { version: 1, users: [] };
      throw new Error(`Unable to read account store: ${error.message}`);
    }
  }

  async persist() {
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
