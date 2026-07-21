const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const SUPPLY_ORDER_STATUSES = new Set(["Draft", "Active", "Ordered", "Partially Received", "Received", "Cancelled"]);
const STOREFRONT_BUY_ORDER_STATUSES = new Set(["Active", "Paused", "Filled", "Cancelled"]);
const PRODUCTION_BATCH_STATUSES = new Set(["Planned", "In Progress", "Completed", "Cancelled"]);
const SALES_ORDER_STATUSES = new Set(["Draft", "Paused", "Expedited", "Reserved", "Completed", "Cancelled"]);
const DAILY_CLOSE_STATUSES = new Set(["Draft", "Finalized"]);

class BusinessStore {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.data = {
      version: 6,
      salesOrders: [],
      supplyOrders: [],
      suppliers: [],
      storefrontBuyOrders: [],
      productionBatches: [],
      dailyCloses: []
    };
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

  listSalesOrders() {
    return this.data.salesOrders
      .map(order => structuredClone(order))
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  }

  getSalesOrder(orderId) {
    const order = this.data.salesOrders.find(candidate => candidate.id === cleanText(orderId, 100));
    return order ? structuredClone(order) : null;
  }

  listDailyCloses() {
    return this.data.dailyCloses
      .map(close => structuredClone(close))
      .sort((a, b) => b.businessDate.localeCompare(a.businessDate) || new Date(b.updatedAt) - new Date(a.updatedAt));
  }

  getDailyClose(closeId) {
    const close = this.data.dailyCloses.find(candidate => candidate.id === cleanText(closeId, 100));
    return close ? structuredClone(close) : null;
  }

  async saveDailyClose(input, snapshot, actor) {
    return this.mutate(async () => {
      const now = new Date().toISOString();
      const id = cleanText(input.id, 100) || crypto.randomUUID();
      const existingIndex = this.data.dailyCloses.findIndex(close => close.id === id);
      const existing = existingIndex >= 0 ? this.data.dailyCloses[existingIndex] : null;
      if (existing?.status === "Finalized") {
        throw businessError("Finalized daily closes must be reopened before editing", 409, "daily_close_finalized");
      }
      if (existing) assertRevision(input.revision, existing.revision, "daily_close_conflict");
      const businessDate = cleanDate(input.businessDate);
      if (!businessDate) throw businessError("Business date is required", 400, "business_date_required");
      const duplicate = this.data.dailyCloses.find(close => close.businessDate === businessDate && close.id !== id);
      if (duplicate) throw businessError("A daily close already exists for this date", 409, "daily_close_date_exists");
      const saved = cleanDailyClose(input, snapshot, actor, { id, now, existing });
      if (existingIndex >= 0) this.data.dailyCloses[existingIndex] = saved;
      else this.data.dailyCloses.unshift(saved);
      return structuredClone(saved);
    });
  }

  async finalizeDailyClose(closeId, revision, snapshot, actor) {
    return this.mutate(async () => {
      const close = this.data.dailyCloses.find(candidate => candidate.id === cleanText(closeId, 100));
      if (!close) throw businessError("Daily close not found", 404, "not_found");
      if (close.status === "Finalized") throw businessError("This daily close is already finalized", 409, "daily_close_finalized");
      assertRevision(revision, close.revision, "daily_close_conflict");
      if (!close.storefrontConfirmed || !close.storageConfirmed) {
        throw businessError("Confirm both storefront and storage counts before finalizing", 409, "inventory_confirmation_required");
      }
      if (!Number.isFinite(close.countedLedgerBalance)) {
        throw businessError("Enter the counted ledger balance before finalizing", 409, "ledger_count_required");
      }
      const refreshedSnapshot = cleanDailyCloseSnapshot(snapshot);
      const difference = dailyCloseLedgerDifference(close.countedLedgerBalance, refreshedSnapshot.ledgerBalance);
      if (difference !== null && Math.abs(difference) >= 0.005 && !cleanMultilineText(close.discrepancyNotes, 2500)) {
        throw businessError("Explain the ledger difference before finalizing", 409, "discrepancy_note_required");
      }
      const now = new Date().toISOString();
      close.snapshot = refreshedSnapshot;
      close.status = "Finalized";
      close.revision = Number(close.revision || 0) + 1;
      close.updatedAt = now;
      close.updatedBy = cleanText(actor?.fullName, 100);
      close.finalizedAt = now;
      close.finalizedBy = cleanText(actor?.fullName, 100);
      return structuredClone(close);
    });
  }

  async reopenDailyClose(closeId, actor) {
    return this.mutate(async () => {
      const close = this.data.dailyCloses.find(candidate => candidate.id === cleanText(closeId, 100));
      if (!close) throw businessError("Daily close not found", 404, "not_found");
      if (close.status !== "Finalized") throw businessError("Only finalized daily closes can be reopened", 409, "daily_close_not_finalized");
      const now = new Date().toISOString();
      close.status = "Draft";
      close.revision = Number(close.revision || 0) + 1;
      close.updatedAt = now;
      close.updatedBy = cleanText(actor?.fullName, 100);
      close.finalizedAt = "";
      close.finalizedBy = "";
      return structuredClone(close);
    });
  }

  async saveSalesOrder(input, actor) {
    return this.mutate(async () => {
      const now = new Date().toISOString();
      const id = cleanText(input.id, 100) || crypto.randomUUID();
      const existingIndex = this.data.salesOrders.findIndex(order => order.id === id);
      const existing = existingIndex >= 0 ? this.data.salesOrders[existingIndex] : null;
      if (existing) {
        const revision = Number(input.revision);
        if (!Number.isInteger(revision) || revision !== Number(existing.revision || 1)) {
          throw businessError(
            "This sales order was updated by someone else. Reload it before saving your changes.",
            409,
            "sales_order_conflict"
          );
        }
      }
      const saved = cleanSalesOrder(input, actor, { id, now, existing });
      if (existingIndex >= 0) this.data.salesOrders[existingIndex] = saved;
      else this.data.salesOrders.unshift(saved);
      return structuredClone(saved);
    });
  }

  async importSalesOrders(inputs, actor) {
    return this.mutate(async () => {
      const incoming = Array.isArray(inputs) ? inputs.slice(0, 250) : [];
      let imported = 0;
      let skipped = 0;
      incoming.forEach(input => {
        const id = cleanText(input?.id, 100) || crypto.randomUUID();
        if (this.data.salesOrders.some(order => order.id === id)) {
          skipped += 1;
          return;
        }
        const now = new Date().toISOString();
        this.data.salesOrders.push(cleanSalesOrder(input || {}, actor, { id, now, existing: null }));
        imported += 1;
      });
      return { imported, skipped, orders: this.listSalesOrders() };
    });
  }

  async removeSalesOrder(orderId) {
    return this.mutate(async () => {
      const id = cleanText(orderId, 100);
      const existing = this.data.salesOrders.find(order => order.id === id);
      if (!existing) throw businessError("Sales order not found", 404, "not_found");
      if (existing.status === "Completed") {
        throw businessError("Completed sales orders are retained as business records", 409, "completed_sales_order_locked");
      }
      this.data.salesOrders = this.data.salesOrders.filter(order => order.id !== id);
      return structuredClone(existing);
    });
  }

  listProductionBatches() {
    return this.data.productionBatches
      .map(batch => structuredClone(batch))
      .sort((a, b) => {
        if (a.priority !== b.priority) return a.priority === "Expedite" ? -1 : 1;
        const dueA = a.dueDate || "9999-12-31";
        const dueB = b.dueDate || "9999-12-31";
        return dueA.localeCompare(dueB) || new Date(b.updatedAt) - new Date(a.updatedAt);
      });
  }

  getProductionBatch(batchId) {
    const batch = this.data.productionBatches.find(candidate => candidate.id === cleanText(batchId, 100));
    return batch ? structuredClone(batch) : null;
  }

  async createProductionBatch(input, actor) {
    return this.mutate(async () => {
      const now = new Date().toISOString();
      const id = cleanText(input.id, 100) || crypto.randomUUID();
      const existing = this.data.productionBatches.find(batch => batch.id === id);
      if (existing) return structuredClone(existing);
      const batch = cleanProductionBatch(input, actor, { id, now });
      const duplicateSource = batch.sourceId && this.data.productionBatches.find(candidate =>
        candidate.sourceType === batch.sourceType
        && candidate.sourceId === batch.sourceId
        && candidate.status !== "Completed"
        && candidate.status !== "Cancelled"
      );
      if (duplicateSource) {
        throw businessError("This source already has an active production batch", 409, "production_source_active");
      }
      this.data.productionBatches.unshift(batch);
      return structuredClone(batch);
    });
  }

  async startProductionBatch(batchId, actor) {
    return this.mutate(async () => {
      const batch = this.data.productionBatches.find(candidate => candidate.id === cleanText(batchId, 100));
      if (!batch) throw businessError("Production batch not found", 404, "not_found");
      if (batch.status === "Cancelled" || batch.status === "Completed") {
        throw businessError("This production batch cannot be started", 409, "production_batch_closed");
      }
      if (batch.status === "Planned") {
        batch.status = "In Progress";
        batch.startedAt = new Date().toISOString();
        batch.startedBy = cleanText(actor?.fullName, 100);
        batch.updatedAt = batch.startedAt;
        batch.updatedBy = cleanText(actor?.fullName, 100);
      }
      return structuredClone(batch);
    });
  }

  async beginProductionProgress(batchId, pendingProgress, actor) {
    return this.mutate(async () => {
      const batch = this.data.productionBatches.find(candidate => candidate.id === cleanText(batchId, 100));
      if (!batch) throw businessError("Production batch not found", 404, "not_found");
      if (batch.status === "Cancelled" || batch.status === "Completed") {
        throw businessError("This production batch cannot record more work", 409, "production_batch_closed");
      }
      if (batch.pendingProgress) {
        if (batch.pendingProgress.id === cleanText(pendingProgress.id, 100)) return structuredClone(batch);
        throw businessError("Retry the pending production update before recording different progress", 409, "production_progress_pending");
      }
      batch.pendingProgress = cleanPendingProductionProgress(pendingProgress, batch);
      batch.status = "In Progress";
      batch.startedAt = batch.startedAt || new Date().toISOString();
      batch.startedBy = batch.startedBy || cleanText(actor?.fullName, 100);
      batch.updatedAt = new Date().toISOString();
      batch.updatedBy = cleanText(actor?.fullName, 100);
      return structuredClone(batch);
    });
  }

  async commitProductionProgress(batchId, pendingId, actor) {
    return this.mutate(async () => {
      const batch = this.data.productionBatches.find(candidate => candidate.id === cleanText(batchId, 100));
      if (!batch) throw businessError("Production batch not found", 404, "not_found");
      const pending = batch.pendingProgress;
      if (!pending || pending.id !== cleanText(pendingId, 100)) {
        throw businessError("Pending production update was not found", 409, "production_progress_missing");
      }
      pending.targets.forEach(target => {
        const line = batch.lines.find(candidate => candidate.id === target.lineId);
        if (line) line.completedCrafts = target.completedCrafts;
      });
      batch.pendingProgress = null;
      const completed = batch.lines.every(line => line.completedCrafts >= line.plannedCrafts);
      batch.status = completed ? "Completed" : "In Progress";
      batch.updatedAt = new Date().toISOString();
      batch.updatedBy = cleanText(actor?.fullName, 100);
      if (completed) {
        batch.completedAt = batch.updatedAt;
        batch.completedBy = batch.updatedBy;
      }
      return structuredClone(batch);
    });
  }

  async cancelProductionBatch(batchId, actor) {
    return this.mutate(async () => {
      const batch = this.data.productionBatches.find(candidate => candidate.id === cleanText(batchId, 100));
      if (!batch) throw businessError("Production batch not found", 404, "not_found");
      if (batch.pendingProgress) {
        throw businessError("Finish retrying the pending production update before cancelling", 409, "production_progress_pending");
      }
      if (batch.status === "Completed") {
        throw businessError("Completed production batches cannot be cancelled", 409, "production_batch_completed");
      }
      batch.status = "Cancelled";
      batch.updatedAt = new Date().toISOString();
      batch.updatedBy = cleanText(actor?.fullName, 100);
      return structuredClone(batch);
    });
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
      if (!Array.isArray(parsed.productionBatches)) parsed.productionBatches = [];
      if (!Array.isArray(parsed.salesOrders)) parsed.salesOrders = [];
      if (!Array.isArray(parsed.dailyCloses)) parsed.dailyCloses = [];
      return {
        version: 6,
        salesOrders: parsed.salesOrders
          .filter(order => order && typeof order === "object")
          .map(order => cleanStoredSalesOrder(order)),
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
          .map(order => cleanStoredStorefrontBuyOrder(order)),
        productionBatches: parsed.productionBatches
          .filter(batch => batch && typeof batch === "object")
          .map(batch => cleanStoredProductionBatch(batch)),
        dailyCloses: parsed.dailyCloses
          .filter(close => close && typeof close === "object")
          .map(close => cleanStoredDailyClose(close))
      };
    } catch (error) {
      if (error.code === "ENOENT") {
        return {
          version: 6,
          salesOrders: [],
          supplyOrders: [],
          suppliers: [],
          storefrontBuyOrders: [],
          productionBatches: [],
          dailyCloses: []
        };
      }
      throw new Error(`Unable to read business store: ${error.message}`);
    }
  }

  async persist() {
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await fs.promises.writeFile(temporaryPath, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    await fs.promises.rename(temporaryPath, this.filePath);
  }
}

function cleanSalesOrder(input, actor, { id, now, existing }) {
  let status = SALES_ORDER_STATUSES.has(input.status) ? input.status : "Draft";
  let priority = input.priority === "Expedite" ? "Expedite" : "Normal";
  if (status === "Expedited") priority = "Expedite";
  const lines = (Array.isArray(input.lines) ? input.lines : []).slice(0, 100).map(cleanSalesOrderLine);
  return {
    id,
    customer: cleanText(input.customer, 120),
    handler: cleanText(input.handler, 100),
    status,
    priority,
    deliveryDate: cleanDate(input.deliveryDate),
    deposit: Math.max(0, finiteNumber(input.deposit, 0)),
    lines,
    label: cleanText(input.label || "The Frontier's Finest Firearms", 250),
    notes: cleanText(input.notes, 2500),
    revision: Number(existing?.revision || 0) + 1,
    createdAt: existing?.createdAt || cleanDateTime(input.createdAt) || now,
    createdBy: existing?.createdBy || cleanText(actor?.fullName, 100),
    updatedAt: now,
    updatedBy: cleanText(actor?.fullName, 100)
  };
}

function cleanDailyClose(input, snapshot, actor, { id, now, existing }) {
  return {
    id,
    businessDate: cleanDate(input.businessDate),
    status: "Draft",
    storefrontConfirmed: Boolean(input.storefrontConfirmed),
    storageConfirmed: Boolean(input.storageConfirmed),
    countedLedgerBalance: nullableFiniteNumber(input.countedLedgerBalance),
    discrepancyNotes: cleanMultilineText(input.discrepancyNotes, 2500),
    handoffNotes: cleanMultilineText(input.handoffNotes, 4000),
    priorityNotes: cleanMultilineText(input.priorityNotes, 2500),
    snapshot: cleanDailyCloseSnapshot(snapshot),
    revision: Number(existing?.revision || 0) + 1,
    createdAt: existing?.createdAt || now,
    createdBy: existing?.createdBy || cleanText(actor?.fullName, 100),
    updatedAt: now,
    updatedBy: cleanText(actor?.fullName, 100),
    finalizedAt: "",
    finalizedBy: ""
  };
}

function cleanStoredDailyClose(close) {
  const status = DAILY_CLOSE_STATUSES.has(close.status) ? close.status : "Draft";
  return {
    id: cleanText(close.id, 100) || crypto.randomUUID(),
    businessDate: cleanDate(close.businessDate) || new Date().toISOString().slice(0, 10),
    status,
    storefrontConfirmed: Boolean(close.storefrontConfirmed),
    storageConfirmed: Boolean(close.storageConfirmed),
    countedLedgerBalance: nullableFiniteNumber(close.countedLedgerBalance),
    discrepancyNotes: cleanMultilineText(close.discrepancyNotes, 2500),
    handoffNotes: cleanMultilineText(close.handoffNotes, 4000),
    priorityNotes: cleanMultilineText(close.priorityNotes, 2500),
    snapshot: cleanDailyCloseSnapshot(close.snapshot),
    revision: Math.max(1, finiteNumber(close.revision, 1)),
    createdAt: cleanDateTime(close.createdAt) || new Date().toISOString(),
    createdBy: cleanText(close.createdBy, 100),
    updatedAt: cleanDateTime(close.updatedAt) || new Date().toISOString(),
    updatedBy: cleanText(close.updatedBy, 100),
    finalizedAt: status === "Finalized" ? cleanDateTime(close.finalizedAt) : "",
    finalizedBy: status === "Finalized" ? cleanText(close.finalizedBy, 100) : ""
  };
}

function cleanDailyCloseSnapshot(snapshot) {
  const input = snapshot && typeof snapshot === "object" ? snapshot : {};
  return {
    capturedAt: cleanDateTime(input.capturedAt) || new Date().toISOString(),
    sheetGeneratedAt: cleanDateTime(input.sheetGeneratedAt),
    storefrontUnits: nullableNonnegativeNumber(input.storefrontUnits),
    storageUnits: nullableNonnegativeNumber(input.storageUnits),
    ledgerBalance: nullableFiniteNumber(input.ledgerBalance),
    openSalesOrders: Math.max(0, finiteNumber(input.openSalesOrders, 0)),
    overdueSalesOrders: Math.max(0, finiteNumber(input.overdueSalesOrders, 0)),
    activeProductionBatches: Math.max(0, finiteNumber(input.activeProductionBatches, 0)),
    expectedSupplyDeliveries: Math.max(0, finiteNumber(input.expectedSupplyDeliveries, 0)),
    openStorefrontBuyOrders: Math.max(0, finiteNumber(input.openStorefrontBuyOrders, 0)),
    openReviewExceptions: Math.max(0, finiteNumber(input.openReviewExceptions, 0)),
    issues: (Array.isArray(input.issues) ? input.issues : []).slice(0, 100).map(issue => ({
      type: cleanText(issue?.type, 50),
      label: cleanText(issue?.label, 160),
      detail: cleanText(issue?.detail, 300)
    })).filter(issue => issue.label)
  };
}

function dailyCloseLedgerDifference(countedBalance, systemBalance) {
  if (!Number.isFinite(countedBalance) || !Number.isFinite(systemBalance)) return null;
  return countedBalance - systemBalance;
}

function assertRevision(received, expected, code) {
  const revision = Number(received);
  if (!Number.isInteger(revision) || revision !== Number(expected || 1)) {
    throw businessError("This record was updated by someone else. Reload it before saving your changes.", 409, code);
  }
}

function cleanStoredSalesOrder(order) {
  const cleaned = cleanSalesOrder(order, { fullName: order.updatedBy || order.createdBy }, {
    id: cleanText(order.id, 100) || crypto.randomUUID(),
    now: cleanDateTime(order.updatedAt) || new Date().toISOString(),
    existing: {
      revision: Math.max(0, finiteNumber(order.revision, 1) - 1),
      createdAt: cleanDateTime(order.createdAt) || new Date().toISOString(),
      createdBy: cleanText(order.createdBy, 100)
    }
  });
  cleaned.updatedAt = cleanDateTime(order.updatedAt) || cleaned.updatedAt;
  cleaned.updatedBy = cleanText(order.updatedBy, 100);
  return cleaned;
}

function cleanSalesOrderLine(line) {
  const name = cleanText(line?.name || line?.label, 120);
  if (!name) throw businessError("Every sales line needs an item", 400, "invalid_sales_line");
  const quantity = finiteNumber(line.quantity, 0);
  if (quantity <= 0) throw businessError("Sales quantities must be positive", 400, "invalid_sales_quantity");
  return {
    id: cleanText(line.id, 100) || crypto.randomUUID(),
    name,
    label: cleanText(line.label || name, 120),
    tag: cleanText(line.tag, 120),
    category: cleanText(line.category || "Manual", 80),
    quantity,
    unitPrice: Math.max(0, finiteNumber(line.unitPrice, 0)),
    custom: Boolean(line.custom)
  };
}

function cleanProductionBatch(input, actor, { id, now }) {
  const sourceType = new Set(["Customer Order", "Storefront Restock", "Manual"]).has(input.sourceType)
    ? input.sourceType
    : "Manual";
  const lines = (Array.isArray(input.lines) ? input.lines : []).slice(0, 50)
    .map(cleanProductionLine);
  if (!lines.length) throw businessError("Add at least one craftable item to the production batch", 400, "production_lines_required");
  const lineKeys = lines.map(line => normalizeKey(line.itemName));
  if (new Set(lineKeys).size !== lineKeys.length) {
    throw businessError("Each product can only appear once in a production batch", 400, "duplicate_production_line");
  }
  return {
    id,
    status: "Planned",
    sourceType,
    sourceId: cleanText(input.sourceId, 100),
    reference: cleanText(input.reference, 150),
    dueDate: cleanDate(input.dueDate),
    priority: input.priority === "Expedite" ? "Expedite" : "Normal",
    assignedTo: cleanText(input.assignedTo, 100),
    notes: cleanText(input.notes, 1500),
    lines,
    pendingProgress: null,
    startedAt: "",
    startedBy: "",
    completedAt: "",
    completedBy: "",
    createdAt: now,
    createdBy: cleanText(actor?.fullName, 100),
    updatedAt: now,
    updatedBy: cleanText(actor?.fullName, 100)
  };
}

function cleanProductionLine(line) {
  const itemName = cleanText(line.itemName || line.name || line.itemLabel, 100);
  if (!itemName) throw businessError("Every production line needs an item", 400, "invalid_production_line");
  const recipe = (Array.isArray(line.recipe) ? line.recipe : []).slice(0, 50)
    .map(component => ({
      ingredient: cleanText(component.ingredient || component[0], 100),
      quantity: Math.max(0, finiteNumber(component.quantity ?? component[1], 0))
    }))
    .filter(component => component.ingredient && component.quantity > 0);
  if (!recipe.length) throw businessError(`No recipe is available for ${itemName}`, 400, "production_recipe_missing");
  const recipeYield = Math.max(1, finiteNumber(line.recipeYield, 1));
  const requestedQuantity = Math.max(1, finiteNumber(line.requestedQuantity || line.quantity, 1));
  const plannedCrafts = Math.max(1, Math.ceil(requestedQuantity / recipeYield));
  return {
    id: cleanText(line.id, 100) || crypto.randomUUID(),
    itemName,
    itemLabel: cleanText(line.itemLabel || line.label || itemName, 100),
    requestedQuantity,
    recipeYield,
    plannedCrafts,
    completedCrafts: 0,
    recipe
  };
}

function cleanStoredProductionBatch(batch) {
  const lines = (Array.isArray(batch.lines) ? batch.lines : []).slice(0, 50).map(line => {
    const cleaned = cleanProductionLine(line);
    cleaned.id = cleanText(line.id, 100) || cleaned.id;
    cleaned.completedCrafts = Math.min(
      cleaned.plannedCrafts,
      Math.max(0, finiteNumber(line.completedCrafts, 0))
    );
    return cleaned;
  });
  const status = PRODUCTION_BATCH_STATUSES.has(batch.status) ? batch.status : "Planned";
  return {
    ...batch,
    id: cleanText(batch.id, 100) || crypto.randomUUID(),
    status,
    sourceType: new Set(["Customer Order", "Storefront Restock", "Manual"]).has(batch.sourceType)
      ? batch.sourceType
      : "Manual",
    sourceId: cleanText(batch.sourceId, 100),
    reference: cleanText(batch.reference, 150),
    dueDate: cleanDate(batch.dueDate),
    priority: batch.priority === "Expedite" ? "Expedite" : "Normal",
    assignedTo: cleanText(batch.assignedTo, 100),
    notes: cleanText(batch.notes, 1500),
    lines,
    pendingProgress: batch.pendingProgress ? cleanPendingProductionProgress(batch.pendingProgress, { lines }) : null
  };
}

function cleanPendingProductionProgress(progress, batch) {
  const targets = (Array.isArray(progress.targets) ? progress.targets : []).slice(0, 50).map(target => {
    const lineId = cleanText(target.lineId, 100);
    const line = batch.lines.find(candidate => candidate.id === lineId);
    if (!line) throw businessError("Production progress refers to an unknown line", 400, "production_line_not_found");
    const completedCrafts = finiteNumber(target.completedCrafts, -1);
    if (completedCrafts <= line.completedCrafts || completedCrafts > line.plannedCrafts) {
      throw businessError("Completed craft cycles must increase without exceeding the plan", 400, "invalid_production_progress");
    }
    return {
      lineId,
      previousCrafts: Math.max(0, finiteNumber(target.previousCrafts, line.completedCrafts)),
      completedCrafts
    };
  });
  if (!targets.length) throw businessError("Enter at least one completed craft cycle", 400, "production_progress_required");
  const operations = (Array.isArray(progress.operations) ? progress.operations : []).slice(0, 500).map(operation => ({
    id: cleanText(operation.id, 100),
    kind: cleanText(operation.kind, 40),
    location: cleanText(operation.location, 40),
    itemName: cleanText(operation.itemName, 100),
    itemLabel: cleanText(operation.itemLabel || operation.itemName, 100),
    quantity: Math.max(0, finiteNumber(operation.quantity, 0)),
    amount: finiteNumber(operation.amount, 0),
    note: cleanText(operation.note, 500),
    employee: cleanText(operation.employee, 100)
  })).filter(operation => operation.id && operation.itemName && operation.quantity > 0);
  if (!operations.length) throw businessError("Production progress has no stock movements", 400, "production_operations_required");
  return {
    id: cleanText(progress.id, 100) || crypto.randomUUID(),
    targets,
    operations,
    createdAt: cleanDateTime(progress.createdAt) || new Date().toISOString(),
    createdBy: cleanText(progress.createdBy, 100)
  };
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

function cleanMultilineText(value, limit) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, limit);
}

function normalizeKey(value) {
  return cleanText(value, 200).toLocaleLowerCase("en");
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nullableFiniteNumber(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nullableNonnegativeNumber(value) {
  const number = nullableFiniteNumber(value);
  return number === null ? null : Math.max(0, number);
}

function businessError(message, status, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

module.exports = {
  BusinessStore,
  SUPPLY_ORDER_STATUSES,
  STOREFRONT_BUY_ORDER_STATUSES,
  PRODUCTION_BATCH_STATUSES,
  SALES_ORDER_STATUSES,
  DAILY_CLOSE_STATUSES,
  businessError
};
