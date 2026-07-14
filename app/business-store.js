const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const SUPPLY_ORDER_STATUSES = new Set(["Draft", "Active", "Ordered", "Partially Received", "Received", "Cancelled"]);

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

  getSupplyOrder(orderId) {
    const order = this.data.supplyOrders.find(candidate => candidate.id === cleanText(orderId, 100));
    return order ? structuredClone(order) : null;
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

  async receiveSupplyLine(orderId, lineId, quantity, actor) {
    return this.mutate(async () => {
      const order = this.data.supplyOrders.find(candidate => candidate.id === cleanText(orderId, 100));
      if (!order) throw businessError("Supply order not found", 404, "not_found");
      if (order.status !== "Ordered" && order.status !== "Partially Received") {
        throw businessError("Only ordered supplies can be received", 409, "order_not_receivable");
      }
      const line = order.lines.find(candidate => candidate.id === cleanText(lineId, 100));
      if (!line) throw businessError("Supply order line not found", 404, "line_not_found");
      const receivedQuantity = Math.max(0, finiteNumber(line.receivedQuantity, 0));
      const remaining = Math.max(0, Number(line.quantity || 0) - receivedQuantity);
      const receiptQuantity = finiteNumber(quantity, 0);
      if (receiptQuantity <= 0 || receiptQuantity > remaining) {
        throw businessError(`Receipt must be between 1 and ${remaining}`, 400, "invalid_receipt_quantity");
      }

      line.receivedQuantity = receivedQuantity + receiptQuantity;
      const now = new Date().toISOString();
      order.status = order.lines.every(candidate => Number(candidate.receivedQuantity || 0) >= Number(candidate.quantity || 0))
        ? "Received"
        : "Partially Received";
      order.updatedAt = now;
      order.updatedBy = cleanText(actor?.fullName, 100);
      return structuredClone(order);
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
      return {
        version: 1,
        supplyOrders: parsed.supplyOrders
          .filter(order => order && typeof order === "object")
          .map(order => order.status === "Draft" ? { ...order, status: "Active" } : order)
      };
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

  let status = SUPPLY_ORDER_STATUSES.has(input.status) ? input.status : "Draft";
  if (status === "Draft") status = "Active";
  const existingLines = new Map((existing?.lines || []).map(line => [line.id, line]));
  const lines = Array.isArray(input.lines)
    ? input.lines.slice(0, 100).map(line => cleanSupplyLine(line, existingLines.get(line.id)))
    : [];
  const removedReceivedLine = (existing?.lines || []).find(existingLine =>
    Number(existingLine.receivedQuantity || 0) > 0 && !lines.some(line => line.id === existingLine.id)
  );
  if (removedReceivedLine) {
    throw businessError("Received supply lines cannot be removed", 409, "received_line_locked");
  }
  if (new Set(["Ordered", "Partially Received", "Received"]).has(status) && !lines.length) {
    throw businessError("Add at least one material before placing the order", 400, "lines_required");
  }
  if (status !== "Cancelled" && lines.some(line => line.receivedQuantity > 0)) {
    status = lines.every(line => line.receivedQuantity >= line.quantity) ? "Received" : "Partially Received";
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

function cleanSupplyLine(line, existingLine) {
  const name = cleanText(line.name || line.label, 100);
  if (!name) throw businessError("Every supply line needs a material name", 400, "invalid_line");
  const receivedQuantity = Math.max(0, finiteNumber(existingLine?.receivedQuantity, 0));
  const quantity = Math.max(1, finiteNumber(line.quantity, 1), receivedQuantity);
  return {
    id: cleanText(line.id, 100) || crypto.randomUUID(),
    name,
    label: cleanText(line.label || name, 100),
    category: cleanText(line.category || "Recipe Ingredient", 60),
    quantity,
    unitPrice: Math.max(0, finiteNumber(line.unitPrice, 0)),
    receivedQuantity
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
