const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const SUPPLY_ORDER_STATUSES = new Set(["Draft", "Active", "Ordered", "Partially Received", "Received", "Cancelled"]);
const STOREFRONT_BUY_ORDER_STATUSES = new Set(["Active", "Paused", "Filled", "Cancelled"]);

class BusinessStore {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.data = { version: 3, supplyOrders: [], suppliers: [], storefrontBuyOrders: [] };
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

  listStorefrontBuyOrders() {
    return this.data.storefrontBuyOrders
      .map(order => structuredClone(order))
      .sort((a, b) => new Date(b.postedAt) - new Date(a.postedAt));
  }

  getStorefrontBuyOrder(orderId) {
    const order = this.data.storefrontBuyOrders.find(candidate => candidate.id === cleanText(orderId, 100));
    return order ? structuredClone(order) : null;
  }

  listSuppliers() {
    return this.data.suppliers
      .map(supplier => structuredClone(supplier))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  getSupplier(supplierId) {
    const supplier = this.data.suppliers.find(candidate => candidate.id === cleanText(supplierId, 100));
    return supplier ? structuredClone(supplier) : null;
  }

  async saveSupplier(input, actor) {
    return this.mutate(async () => {
      const now = new Date().toISOString();
      const id = cleanText(input.id, 100) || crypto.randomUUID();
      const existingIndex = this.data.suppliers.findIndex(supplier => supplier.id === id);
      const existing = existingIndex >= 0 ? this.data.suppliers[existingIndex] : null;
      const saved = cleanSupplier(input, actor, { id, now, existing });
      const duplicate = this.data.suppliers.find(supplier => supplier.id !== id && normalizeKey(supplier.name) === normalizeKey(saved.name));
      if (duplicate) throw businessError("A supplier with this name already exists", 409, "supplier_name_exists");
      if (existingIndex >= 0) this.data.suppliers[existingIndex] = saved;
      else this.data.suppliers.push(saved);
      return structuredClone(saved);
    });
  }

  async removeSupplier(supplierId) {
    return this.mutate(async () => {
      const id = cleanText(supplierId, 100);
      const existing = this.data.suppliers.find(supplier => supplier.id === id);
      if (!existing) throw businessError("Supplier not found", 404, "not_found");
      this.data.suppliers = this.data.suppliers.filter(supplier => supplier.id !== id);
      return structuredClone(existing);
    });
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

  async saveStorefrontBuyOrder(input, actor) {
    return this.mutate(async () => {
      const now = new Date().toISOString();
      const id = cleanText(input.id, 100) || crypto.randomUUID();
      const existingIndex = this.data.storefrontBuyOrders.findIndex(order => order.id === id);
      const existing = existingIndex >= 0 ? this.data.storefrontBuyOrders[existingIndex] : null;
      const saved = cleanStorefrontBuyOrder(input, actor, { id, now, existing });
      if (existingIndex >= 0) this.data.storefrontBuyOrders[existingIndex] = saved;
      else this.data.storefrontBuyOrders.unshift(saved);
      return structuredClone(saved);
    });
  }

  async removeStorefrontBuyOrder(orderId) {
    return this.mutate(async () => {
      const id = cleanText(orderId, 100);
      const existing = this.data.storefrontBuyOrders.find(order => order.id === id);
      if (!existing) throw businessError("Storefront buy order not found", 404, "not_found");
      if (Number(existing.filledQuantity || 0) > 0) {
        throw businessError("Buy orders with recorded fills must be cancelled instead of removed", 409, "filled_order_locked");
      }
      this.data.storefrontBuyOrders = this.data.storefrontBuyOrders.filter(order => order.id !== id);
      return structuredClone(existing);
    });
  }

  async setStorefrontBuyOrderFill(orderId, filledQuantity, actor) {
    return this.mutate(async () => {
      const order = this.data.storefrontBuyOrders.find(candidate => candidate.id === cleanText(orderId, 100));
      if (!order) throw businessError("Storefront buy order not found", 404, "not_found");
      const matchedQuantity = matchedBuyOrderQuantity(order);
      const requested = finiteNumber(filledQuantity, -1);
      if (requested < matchedQuantity || requested > Number(order.quantity || 0)) {
        throw businessError(`Filled quantity must be between ${matchedQuantity} and ${order.quantity}`, 400, "invalid_filled_quantity");
      }
      order.manualFilledQuantity = requested - matchedQuantity;
      refreshStorefrontBuyOrder(order, actor);
      return structuredClone(order);
    });
  }

  async reconcileStorefrontBuyOrders(events) {
    const incoming = Array.isArray(events) ? events : [];
    if (!incoming.length) return this.listStorefrontBuyOrders();
    return this.mutate(async () => {
      const usedEventIds = new Set(this.data.storefrontBuyOrders.flatMap(order =>
        (order.fillEvents || []).map(event => event.eventId)
      ));
      const orders = this.data.storefrontBuyOrders
        .filter(order => order.status === "Active")
        .sort((a, b) => new Date(a.postedAt) - new Date(b.postedAt));

      incoming
        .map(cleanBuyOrderPurchaseEvent)
        .filter(event => event.eventId && event.quantity > 0 && !usedEventIds.has(event.eventId))
        .sort((a, b) => new Date(a.occurredAt) - new Date(b.occurredAt))
        .forEach(event => {
          let remainingEventQuantity = event.quantity;
          orders
            .filter(order => order.status === "Active"
              && normalizeKey(order.itemName) === normalizeKey(event.itemName)
              && new Date(order.postedAt).getTime() <= new Date(event.occurredAt).getTime())
            .forEach(order => {
              if (remainingEventQuantity <= 0) return;
              const remainingOrderQuantity = Math.max(0, Number(order.quantity || 0) - storefrontBuyOrderFilled(order));
              if (!remainingOrderQuantity) return;
              const appliedQuantity = Math.min(remainingEventQuantity, remainingOrderQuantity);
              order.fillEvents.push({
                eventId: event.eventId,
                occurredAt: event.occurredAt,
                quantity: appliedQuantity,
                unitPrice: event.unitPrice
              });
              remainingEventQuantity -= appliedQuantity;
              refreshStorefrontBuyOrder(order, { fullName: "Discord Bridge" }, event.occurredAt);
            });
          usedEventIds.add(event.eventId);
        });

      return this.listStorefrontBuyOrders();
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
      if (!Array.isArray(parsed.suppliers)) parsed.suppliers = [];
      if (!Array.isArray(parsed.storefrontBuyOrders)) parsed.storefrontBuyOrders = [];
      return {
        version: 3,
        supplyOrders: parsed.supplyOrders
          .filter(order => order && typeof order === "object")
          .map(order => order.status === "Draft" ? { ...order, status: "Active" } : order),
        suppliers: parsed.suppliers
          .filter(supplier => supplier && typeof supplier === "object")
          .map(supplier => ({
            ...supplier,
            employees: Array.isArray(supplier.employees) ? supplier.employees.slice(0, 5) : [],
            products: Array.isArray(supplier.products) ? supplier.products.slice(0, 100) : []
          })),
        storefrontBuyOrders: parsed.storefrontBuyOrders
          .filter(order => order && typeof order === "object")
          .map(order => cleanStoredStorefrontBuyOrder(order))
      };
    } catch (error) {
      if (error.code === "ENOENT") return { version: 3, supplyOrders: [], suppliers: [], storefrontBuyOrders: [] };
      throw new Error(`Unable to read business store: ${error.message}`);
    }
  }

  async persist() {
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await fs.promises.writeFile(temporaryPath, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    await fs.promises.rename(temporaryPath, this.filePath);
  }
}

function cleanStorefrontBuyOrder(input, actor, { id, now, existing }) {
  const itemName = cleanText(input.itemName || input.itemLabel, 100);
  if (!itemName) throw businessError("Item is required", 400, "item_required");
  const matchedQuantity = matchedBuyOrderQuantity(existing);
  const manualFilledQuantity = Math.max(0, finiteNumber(existing?.manualFilledQuantity, 0));
  const quantity = Math.max(1, finiteNumber(input.quantity, 1));
  if (quantity < matchedQuantity + manualFilledQuantity) {
    throw businessError("Ordered quantity cannot be lower than the amount already filled", 409, "quantity_below_filled");
  }
  let status = STOREFRONT_BUY_ORDER_STATUSES.has(input.status) ? input.status : "Active";
  if (matchedQuantity + manualFilledQuantity >= quantity) status = "Filled";
  if (status === "Filled" && matchedQuantity + manualFilledQuantity < quantity) status = "Active";

  return {
    id,
    itemName,
    itemLabel: cleanText(input.itemLabel || itemName, 100),
    quantity,
    unitPrice: Math.max(0, finiteNumber(input.unitPrice, 0)),
    postedAt: cleanDateTime(input.postedAt) || existing?.postedAt || now,
    status,
    notes: cleanText(input.notes, 1500),
    fillEvents: Array.isArray(existing?.fillEvents) ? existing.fillEvents.slice(0, 500) : [],
    manualFilledQuantity,
    filledQuantity: matchedQuantity + manualFilledQuantity,
    createdAt: existing?.createdAt || now,
    createdBy: existing?.createdBy || cleanText(actor?.fullName, 100),
    updatedAt: now,
    updatedBy: cleanText(actor?.fullName, 100)
  };
}

function cleanStoredStorefrontBuyOrder(order) {
  const fillEvents = (Array.isArray(order.fillEvents) ? order.fillEvents : [])
    .map(cleanBuyOrderPurchaseEvent)
    .filter(event => event.eventId && event.quantity > 0)
    .slice(0, 500);
  const cleaned = {
    ...order,
    itemName: cleanText(order.itemName || order.itemLabel, 100),
    itemLabel: cleanText(order.itemLabel || order.itemName, 100),
    quantity: Math.max(1, finiteNumber(order.quantity, 1)),
    unitPrice: Math.max(0, finiteNumber(order.unitPrice, 0)),
    postedAt: cleanDateTime(order.postedAt) || cleanDateTime(order.createdAt) || new Date().toISOString(),
    status: STOREFRONT_BUY_ORDER_STATUSES.has(order.status) ? order.status : "Active",
    notes: cleanText(order.notes, 1500),
    fillEvents,
    manualFilledQuantity: Math.max(0, finiteNumber(order.manualFilledQuantity, 0))
  };
  cleaned.filledQuantity = storefrontBuyOrderFilled(cleaned);
  if (cleaned.filledQuantity >= cleaned.quantity && cleaned.status !== "Cancelled") cleaned.status = "Filled";
  return cleaned;
}

function cleanBuyOrderPurchaseEvent(event) {
  return {
    eventId: cleanText(event?.eventId, 100),
    occurredAt: cleanDateTime(event?.occurredAt) || new Date(0).toISOString(),
    itemName: cleanText(event?.itemName || event?.itemLabel, 100),
    quantity: Math.max(0, finiteNumber(event?.quantity, 0)),
    unitPrice: Math.max(0, finiteNumber(event?.unitPrice, 0))
  };
}

function matchedBuyOrderQuantity(order) {
  return (order?.fillEvents || []).reduce((sum, event) => sum + Math.max(0, finiteNumber(event.quantity, 0)), 0);
}

function storefrontBuyOrderFilled(order) {
  return Math.min(
    Number(order?.quantity || Number.MAX_SAFE_INTEGER),
    matchedBuyOrderQuantity(order) + Math.max(0, finiteNumber(order?.manualFilledQuantity, 0))
  );
}

function refreshStorefrontBuyOrder(order, actor, at = new Date().toISOString()) {
  order.filledQuantity = storefrontBuyOrderFilled(order);
  if (order.status !== "Cancelled" && order.filledQuantity >= Number(order.quantity || 0)) order.status = "Filled";
  order.updatedAt = cleanDateTime(at) || new Date().toISOString();
  order.updatedBy = cleanText(actor?.fullName, 100);
}

function cleanSupplier(input, actor, { id, now, existing }) {
  const name = cleanText(input.name, 100);
  if (!name) throw businessError("Supplier name is required", 400, "supplier_name_required");
  const employeeInputs = Array.isArray(input.employees) ? input.employees : [];
  if (employeeInputs.length > 5) {
    throw businessError("A supplier can have no more than 5 employee contacts", 400, "supplier_employee_limit");
  }
  const employees = employeeInputs
    .map(contact => ({
      id: cleanText(contact.id, 100) || crypto.randomUUID(),
      name: cleanText(contact.name, 100),
      telegram: cleanText(contact.telegram, 40)
    }))
    .filter(contact => contact.name || contact.telegram);
  const products = (Array.isArray(input.products) ? input.products : []).slice(0, 100)
    .map(product => {
      const productName = cleanText(product.name || product.label, 100);
      if (!productName) throw businessError("Every supplier product needs a name", 400, "invalid_supplier_product");
      return {
        id: cleanText(product.id, 100) || crypto.randomUUID(),
        name: productName,
        label: cleanText(product.label || productName, 100),
        unitPrice: Math.max(0, finiteNumber(product.unitPrice, 0))
      };
    });
  const productKeys = products.map(product => normalizeKey(product.name));
  if (new Set(productKeys).size !== productKeys.length) {
    throw businessError("Each supplier product can only be listed once", 400, "duplicate_supplier_product");
  }

  return {
    id,
    name,
    category: cleanText(input.category, 60),
    location: cleanText(input.location, 100),
    businessTelegram: cleanText(input.businessTelegram, 40),
    ownerName: cleanText(input.ownerName, 100),
    ownerTelegram: cleanText(input.ownerTelegram, 40),
    employees,
    products,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    updatedBy: cleanText(actor?.fullName, 100)
  };
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
  const lineKeys = lines.map(line => normalizeKey(line.name));
  if (new Set(lineKeys).size !== lineKeys.length) {
    throw businessError("Each material can only appear once in a supply order", 400, "duplicate_supply_line");
  }
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

function cleanDateTime(value) {
  const text = cleanText(value, 40);
  const date = new Date(text);
  return text && !Number.isNaN(date.getTime()) ? date.toISOString() : "";
}

function cleanText(value, limit) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, limit);
}

function normalizeKey(value) {
  return cleanText(value, 200).toLocaleLowerCase("en");
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

module.exports = { BusinessStore, SUPPLY_ORDER_STATUSES, STOREFRONT_BUY_ORDER_STATUSES, businessError };
