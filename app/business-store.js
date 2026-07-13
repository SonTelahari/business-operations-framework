const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const SUPPLY_ORDER_STATUSES = new Set(["Draft", "Ordered", "Received", "Cancelled"]);

class BusinessStore {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.data = { version: 1, supplyOrders: [] };
    this.writeQueue = Promise.resolve();
  }

  async initialize() {
    await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
    this.data = await this.readData();
  }

  listSupplyOrders() {
    return this.data.supplyOrders
      .map(order => structuredClone(order))
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  }

  async saveSupplyOrder(input, actor) {
    return this.mutate(async () => {
      const now = new Date().toISOString();
      const id = cleanText(input.id, 100) || crypto.randomUUID();
      const existingIndex = this.data.supplyOrders.findIndex(order => order.id === id);
      const existing = existingIndex >= 0 ? this.data.supplyOrders[existingIndex] : null;
      const saved = cleanSupplyOrder(input, actor, { id, now, existing });
      if (existingIndex >= 0) this.data.supplyOrders[existingIndex] = saved;
      else this.data.supplyOrders.unshift(saved);
      return structuredClone(saved);
    });
  }

  async removeSupplyOrder(orderId) {
    return this.mutate(async () => {
      const id = cleanText(orderId, 100);
      const existing = this.data.supplyOrders.find(order => order.id === id);
      if (!existing) throw businessError("Supply order not found", 404, "not_found");
      this.data.supplyOrders = this.data.supplyOrders.filter(order => order.id !== id);
      return structuredClone(existing);
    });
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
      if (!Array.isArray(parsed.supplyOrders)) parsed.supplyOrders = [];
      return { version: 1, supplyOrders: parsed.supplyOrders };
    } catch (error) {
      if (error.code === "ENOENT") return { version: 1, supplyOrders: [] };
      throw new Error(`Unable to read business store: ${error.message}`);
    }
  }

  async persist() {
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await fs.promises.writeFile(temporaryPath, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    await fs.promises.rename(temporaryPath, this.filePath);
  }
}

function cleanSupplyOrder(input, actor, { id, now, existing }) {
  const producer = cleanText(input.producer, 100);
  if (!producer) throw businessError("Producer is required", 400, "producer_required");

  const status = SUPPLY_ORDER_STATUSES.has(input.status) ? input.status : "Draft";
  const lines = Array.isArray(input.lines) ? input.lines.slice(0, 100).map(cleanSupplyLine) : [];
  if (status !== "Draft" && !lines.length) {
    throw businessError("Add at least one material before placing the order", 400, "lines_required");
  }

  return {
    id,
    producer,
    status,
    expectedDate: cleanDate(input.expectedDate),
    requestedBy: cleanText(actor?.fullName || input.requestedBy, 100),
    notes: cleanText(input.notes, 1500),
    lines,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    updatedBy: cleanText(actor?.fullName, 100)
  };
}

function cleanSupplyLine(line) {
  const name = cleanText(line.name || line.label, 100);
  if (!name) throw businessError("Every supply line needs a material name", 400, "invalid_line");
  return {
    id: cleanText(line.id, 100) || crypto.randomUUID(),
    name,
    label: cleanText(line.label || name, 100),
    category: cleanText(line.category || "Recipe Ingredient", 60),
    quantity: Math.max(1, finiteNumber(line.quantity, 1)),
    unitPrice: Math.max(0, finiteNumber(line.unitPrice, 0))
  };
}

function cleanDate(value) {
  const date = cleanText(value, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "";
}

function cleanText(value, limit) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, limit);
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function businessError(message, status, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

module.exports = { BusinessStore, SUPPLY_ORDER_STATUSES, businessError };
