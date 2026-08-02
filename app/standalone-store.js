const crypto = require("node:crypto");

const BUSINESS_ID = "primary";

class StandaloneStore {
  constructor(database, { businessId = BUSINESS_ID } = {}) {
    this.database = database;
    this.businessId = businessId;
  }

  async syncCatalog(configuration) {
    if (!configuration?.catalog) return;
    await this.database.transaction(async client => {
      for (const material of configuration.catalog.materials || []) {
        await upsertCatalogItem(client, this.businessId, {
          ...material,
          type: "material",
          label: material.name,
          tag: "",
          unit: material.unit,
          unitCost: material.unitCost,
          salePrice: 0,
          target: 0,
          active: true,
          aliases: []
        });
      }
      for (const product of configuration.catalog.products || []) {
        await upsertCatalogItem(client, this.businessId, {
          ...product,
          type: "product",
          unit: "unit",
          unitCost: 0
        });
      }

      await client.query("DELETE FROM recipe_ingredients WHERE business_id = $1", [this.businessId]);
      await client.query("DELETE FROM recipe_definitions WHERE business_id = $1", [this.businessId]);
      for (const recipe of configuration.catalog.recipes || []) {
        await client.query(`
          INSERT INTO recipe_definitions (
            business_id, id, product_name, normalized_product_name, output_quantity
          ) VALUES ($1, $2, $3, $4, $5)
        `, [this.businessId, recipe.id, recipe.productName, inventoryKey(recipe.productName), recipe.yield]);
        for (let index = 0; index < recipe.ingredients.length; index += 1) {
          const ingredient = recipe.ingredients[index];
          await client.query(`
            INSERT INTO recipe_ingredients (
              business_id, recipe_id, position, ingredient_name, normalized_ingredient_name, quantity
            ) VALUES ($1, $2, $3, $4, $5, $6)
          `, [
            this.businessId,
            recipe.id,
            index,
            ingredient.name,
            inventoryKey(ingredient.name),
            ingredient.quantity
          ]);
        }
      }
    });
  }

  async importLegacySnapshot({ snapshot, finance = null, actor = "Legacy import", fingerprint = "" }) {
    if (!snapshot?.ok || !snapshot.inventory) {
      throw storeError("Legacy import requires a valid bootstrap snapshot", 400, "invalid_import_snapshot");
    }
    const sourceFingerprint = cleanText(fingerprint, 200)
      || crypto.createHash("sha256").update(JSON.stringify({ snapshot, finance })).digest("hex");
    const batchId = `legacy-${sourceFingerprint.slice(0, 24)}`;
    return this.database.transaction(async client => {
      const existing = await client.query(`
        SELECT summary FROM import_batches WHERE business_id = $1 AND source_fingerprint = $2
      `, [this.businessId, sourceFingerprint]);
      if (existing.rowCount) {
        return { ok: true, duplicate: true, batchId, summary: json(existing.rows[0].summary, {}) };
      }
      const occurredAt = validDate(snapshot.generatedAt);
      const products = Array.isArray(snapshot.inventory.products) ? snapshot.inventory.products : [];
      const materials = Array.isArray(snapshot.inventory.materials) ? snapshot.inventory.materials : [];
      const storage = Array.isArray(snapshot.inventory.storage) ? snapshot.inventory.storage : materials;

      for (const product of products) {
        const name = cleanText(product.itemName || product.itemLabel, 150);
        if (!name) continue;
        await upsertCatalogItem(client, this.businessId, {
          id: legacyCatalogId("product", name),
          type: "product",
          name,
          label: cleanText(product.itemLabel, 150) || name,
          tag: cleanText(product.itemTag, 150),
          category: cleanText(product.category, 100) || "Imported products",
          unit: "unit",
          unitCost: 0,
          salePrice: number(product.salePrice),
          target: number(product.target),
          active: product.active !== false,
          aliases: []
        });
        await insertInventory(client, this.businessId, {
          eventId: `${batchId}:sales:${legacyCatalogId("", name)}`,
          occurredAt,
          source: "Legacy Import",
          kind: "Opening Stock Count",
          location: "sales",
          item: name,
          absoluteQuantity: Math.max(0, number(product.currentStock)),
          actor,
          metadata: { batchId }
        });
      }
      for (const material of materials) {
        const name = cleanText(material.ingredient || material.itemName || material.name, 150);
        if (!name) continue;
        const productExists = products.some(product => inventoryKey(product.itemName) === inventoryKey(name));
        if (!productExists) {
          await upsertCatalogItem(client, this.businessId, {
            id: legacyCatalogId("material", name),
            type: "material",
            name,
            label: name,
            tag: "",
            category: "Imported materials",
            unit: "unit",
            unitCost: 0,
            salePrice: 0,
            target: 0,
            active: true,
            aliases: []
          });
        }
      }
      for (const row of storage) {
        const name = cleanText(row.ingredient || row.itemName || row.itemLabel || row.name, 150);
        if (!name) continue;
        await insertInventory(client, this.businessId, {
          eventId: `${batchId}:storage:${legacyCatalogId("", name)}`,
          occurredAt,
          source: "Legacy Import",
          kind: "Opening Stock Count",
          location: "storage",
          item: name,
          absoluteQuantity: Math.max(0, number(row.storageCount ?? row.currentStock ?? row.quantity)),
          actor,
          metadata: { batchId }
        });
      }
      const ledgerBalance = nullableNumber(snapshot.inventory.ledger?.balance);
      if (ledgerBalance !== null) {
        await insertLedger(client, this.businessId, {
          eventId: `${batchId}:ledger`, occurredAt, source: "Legacy Import", kind: "Opening Ledger Count",
          absoluteBalance: ledgerBalance, actor, metadata: { batchId }
        });
      }

      const reviewExceptions = Array.isArray(snapshot.reviewExceptions) ? snapshot.reviewExceptions : [];
      for (let index = 0; index < reviewExceptions.length; index += 1) {
        const exception = reviewExceptions[index];
        const webhookId = cleanText(exception.webhookId, 150) || `${batchId}:review:${index}`;
        const exceptionStatus = new Set(["Open", "Resolved", "Ignored"]).has(exception.status)
          ? exception.status
          : "Open";
        const eventStatus = exceptionStatus === "Ignored"
          ? "ignored"
          : exceptionStatus === "Resolved" && exception.transactionWritten ? "applied" : "review";
        const payload = {
          importedFromArchive: true,
          batchId,
          raw_payload: cleanText(exception.rawText, 4000)
        };
        const event = {
          webhookId,
          occurredAt: validDate(exception.receivedAt || snapshot.generatedAt),
          type: cleanText(exception.eventType, 80) || "Unknown",
          direction: cleanText(exception.direction, 80),
          item: cleanText(exception.resolvedItem || exception.discordItemLabel || exception.discordItemName, 150),
          quantity: Math.max(0, number(exception.quantity)),
          unitPrice: Math.max(0, number(exception.unitPrice)),
          actor: cleanText(exception.resolvedBy, 100),
          orderId: "",
          reviewReason: cleanText(exception.reason, 200),
          discordTitle: cleanText(exception.discordTitle, 200),
          discordItemName: cleanText(exception.discordItemName, 200),
          discordItemLabel: cleanText(exception.discordItemLabel, 200),
          ledgerBalance: nullableNumber(exception.ledgerBalance),
          currentItemTotal: nullableNumber(exception.currentItemTotal)
        };
        await insertWebhook(client, this.businessId, event, payload, eventStatus);
        await insertException(client, this.businessId, event, payload);
        await client.query(`
          UPDATE webhook_exceptions
          SET status = $3, resolved_item_name = $4, resolved_at = $5,
              resolved_by = $6, resolution_note = $7, transaction_written = $8
          WHERE business_id = $1 AND webhook_id = $2
        `, [
          this.businessId,
          webhookId,
          exceptionStatus,
          cleanText(exception.resolvedItem, 150),
          exceptionStatus === "Resolved" ? validDate(exception.resolvedAt || exception.receivedAt) : null,
          cleanText(exception.resolvedBy, 100),
          cleanText(exception.note, 1000),
          Boolean(exception.transactionWritten)
        ]);
      }

      const financeRows = Array.isArray(finance?.breakdown) ? finance.breakdown : [];
      for (let index = 0; index < financeRows.length; index += 1) {
        const row = financeRows[index];
        if (row.type !== "Revenue" && row.type !== "Expense") continue;
        await insertFinance(client, this.businessId, {
          eventId: `${batchId}:finance:${index}`,
          occurredAt,
          type: row.type,
          category: cleanText(row.category, 150) || "Imported history",
          label: cleanText(row.label, 150) || "Imported history",
          source: cleanText(row.source, 100) || "Legacy Import",
          direction: row.type === "Revenue" ? "Cash In" : "Cash Out",
          amount: number(row.amount),
          metadata: { batchId, aggregateCount: number(row.count), importedAggregate: true }
        });
      }
      const balances = finance?.balances || {};
      const balanceEntries = [
        ["Owner Capital", "Owner Funds", "Owner Capital", "Cash In", balances.ownerCapitalDeposits],
        ["Owner Capital", "Owner Funds", "Owner Capital", "Cash Out", balances.ownerWithdrawals],
        ["Safekeeping", "Safekeeping", "Safekeeping Funds", "Cash In", balances.safekeepingDeposits],
        ["Safekeeping", "Safekeeping", "Safekeeping Funds", "Cash Out", balances.safekeepingWithdrawals]
      ];
      for (let index = 0; index < balanceEntries.length; index += 1) {
        const [type, category, label, direction, amount] = balanceEntries[index];
        await insertFinance(client, this.businessId, {
          eventId: `${batchId}:balance:${index}`, occurredAt, type, category, label,
          source: "Legacy Import", direction, amount: number(amount), metadata: { batchId }
        });
      }

      const summary = {
        products: products.length,
        materials: materials.length,
        storageCounts: storage.length,
        ledgerImported: ledgerBalance !== null,
        financeRows: financeRows.length,
        webhookExceptions: reviewExceptions.length
      };
      await client.query(`
        INSERT INTO import_batches (
          business_id, id, source_type, source_fingerprint, imported_by, summary
        ) VALUES ($1, $2, 'apps-script-snapshot', $3, $4, $5::jsonb)
      `, [this.businessId, batchId, sourceFingerprint, actor, JSON.stringify(summary)]);
      return { ok: true, duplicate: false, batchId, summary };
    });
  }

  async snapshot() {
    const [catalogResult, inventoryResult, ledgerResult, exceptionResult, purchaseResult] = await Promise.all([
      this.database.query(`
        SELECT * FROM catalog_items WHERE business_id = $1 ORDER BY item_type, category, label
      `, [this.businessId]),
      this.database.query(`
        SELECT * FROM inventory_events
        WHERE business_id = $1
        ORDER BY occurred_at, recorded_at, event_id
      `, [this.businessId]),
      this.database.query(`
        SELECT * FROM ledger_events
        WHERE business_id = $1
        ORDER BY occurred_at, recorded_at, event_id
      `, [this.businessId]),
      this.database.query(`
        SELECT * FROM webhook_exceptions
        WHERE business_id = $1
        ORDER BY created_at DESC
        LIMIT 250
      `, [this.businessId]),
      this.database.query(`
        SELECT webhook_id, occurred_at, item_name, quantity, unit_price
        FROM webhook_events
        WHERE business_id = $1 AND status = 'applied' AND event_type = 'Purchase'
        ORDER BY occurred_at
      `, [this.businessId])
    ]);

    const inventory = reduceInventory(inventoryResult.rows);
    const catalog = catalogResult.rows.map(catalogRow);
    const products = catalog.filter(item => item.itemType === "product").map(item => {
      const count = inventory.get(`sales:${item.normalizedName}`) || emptyCount(item.name);
      return {
        itemName: item.name,
        itemLabel: item.label,
        itemTag: item.itemTag,
        category: item.category,
        salePrice: item.salePrice,
        target: item.stockTarget,
        currentStock: Math.max(0, count.quantity),
        countedAt: count.countedAt,
        active: item.active,
        msrpLow: nullableNumber(item.metadata?.msrpLow),
        msrpHigh: nullableNumber(item.metadata?.msrpHigh),
        pricingSource: String(item.metadata?.pricingSource || "")
      };
    });
    const materials = catalog.filter(item => item.itemType === "material").map(item => {
      const count = inventory.get(`storage:${item.normalizedName}`) || emptyCount(item.name);
      return {
        ingredient: item.name,
        storageCount: Math.max(0, count.quantity),
        countedAt: count.countedAt
      };
    });
    const storageKeys = new Set();
    const storage = [];
    for (const item of catalog) {
      const count = inventory.get(`storage:${item.normalizedName}`) || emptyCount(item.name);
      storageKeys.add(item.normalizedName);
      storage.push({ ingredient: item.name, storageCount: Math.max(0, count.quantity), countedAt: count.countedAt });
    }
    for (const [key, count] of inventory) {
      if (!key.startsWith("storage:") || storageKeys.has(count.normalizedName)) continue;
      storage.push({ ingredient: count.itemName, storageCount: Math.max(0, count.quantity), countedAt: count.countedAt });
    }

    return {
      ok: true,
      schemaVersion: 1,
      dataBackend: "postgresql",
      generatedAt: new Date().toISOString(),
      sheets: [],
      reviewExceptions: exceptionResult.rows.map(exceptionRow),
      inventory: {
        products,
        materials,
        storage,
        ledger: reduceLedger(ledgerResult.rows),
        buyOrderPurchases: purchaseResult.rows.map(row => ({
          eventId: row.webhook_id,
          occurredAt: iso(row.occurred_at),
          itemName: row.item_name,
          quantity: number(row.quantity),
          unitPrice: number(row.unit_price)
        }))
      }
    };
  }

  async finance({ from = "", to = "" } = {}) {
    const [financeResult, ledgerResult] = await Promise.all([
      this.database.query(`
        SELECT * FROM finance_events
        WHERE business_id = $1
        ORDER BY occurred_at, recorded_at, event_id
      `, [this.businessId]),
      this.database.query(`
        SELECT * FROM ledger_events
        WHERE business_id = $1
        ORDER BY occurred_at, recorded_at, event_id
      `, [this.businessId])
    ]);
    const rows = financeResult.rows.map(row => ({
      type: row.entry_type,
      category: row.category,
      label: row.label,
      source: row.source,
      direction: row.direction,
      amount: number(row.amount),
      occurredAt: iso(row.occurred_at),
      metadata: json(row.metadata, {})
    }));
    const inPeriod = rows.filter(row => inDateRange(row.occurredAt, from, to));
    const revenue = sum(inPeriod.filter(row => row.type === "Revenue"), row => row.amount);
    const expenses = sum(inPeriod.filter(row => row.type === "Expense"), row => row.amount);
    const allOwner = rows.filter(row => row.type === "Owner Capital");
    const allSafekeeping = rows.filter(row => row.type === "Safekeeping");
    const ownerCapitalDeposits = sum(allOwner.filter(row => row.direction === "Cash In"), row => row.amount);
    const ownerWithdrawals = sum(allOwner.filter(row => row.direction === "Cash Out"), row => row.amount);
    const safekeepingDeposits = sum(allSafekeeping.filter(row => row.direction === "Cash In"), row => row.amount);
    const safekeepingWithdrawals = sum(allSafekeeping.filter(row => row.direction === "Cash Out"), row => row.amount);

    return {
      ok: true,
      generatedAt: new Date().toISOString(),
      from,
      to,
      totals: { revenue, expenses, profit: money(revenue - expenses) },
      balances: {
        ownerCapitalDeposits,
        ownerWithdrawals,
        ownerCapital: money(ownerCapitalDeposits - ownerWithdrawals),
        safekeepingDeposits,
        safekeepingWithdrawals,
        safekeeping: money(safekeepingDeposits - safekeepingWithdrawals)
      },
      coverage: financeCoverage(rows),
      ledger: reduceLedger(ledgerResult.rows),
      breakdown: aggregateBreakdown(inPeriod),
      monthly: aggregateMonthly(inPeriod)
    };
  }

  async handleGuiPayload(payload) {
    const action = String(payload?.action || "");
    if (action === "manual_operation") return this.recordManualOperation(payload.entry || {});
    if (action === "stock_target") return this.updateStockTarget(payload.target || {});
    if (action === "time_clock") return this.recordTimeEntry(payload.entry || {});
    if (action === "resolve_exception") return this.resolveException(payload.exception || {});
    if (action === "ignore_exception") return this.ignoreException(payload.exception || {});
    throw storeError(`Unknown operation: ${action}`, 400, "unknown_operation");
  }

  async recordManualOperation(entry) {
    const eventId = cleanText(entry.id, 120);
    if (!eventId) throw storeError("Manual operation is missing an entry ID", 400, "entry_id_required");
    return this.database.transaction(async client => {
      if (!(await reserveOperation(client, this.businessId, eventId, "manual_operation", entry))) {
        return { ok: true, duplicate: true, action: "manual_operation", entryId: eventId };
      }
      const kind = cleanText(entry.kind, 80) || "Correction";
      const occurredAt = validDate(entry.createdAt || entry.occurredAt);
      const actor = cleanText(entry.employee, 100);
      const item = cleanText(entry.itemName || entry.itemLabel, 150);
      const quantity = Math.max(0, number(entry.quantity));
      const amount = number(entry.amount);
      const location = locationType(entry.location);
      const metadata = { note: cleanText(entry.note, 2500), paymentMethod: cleanText(entry.paymentMethod, 50) };

      if (kind === "Stock Count") {
        requireItem(item);
        await insertInventory(client, this.businessId, {
          eventId: `${eventId}:count`, occurredAt, source: "GUI", kind,
          location, item, absoluteQuantity: quantity, actor, metadata
        });
      } else if (kind === "Ledger Count") {
        await insertLedger(client, this.businessId, {
          eventId: `${eventId}:count`, occurredAt, source: "GUI", kind,
          absoluteBalance: amount, actor, metadata
        });
      } else if (kind === "Payroll Payment") {
        const total = Math.abs(amount);
        if (!(total > 0)) throw storeError("Payroll payment requires a positive amount", 400, "invalid_amount");
        if (inventoryKey(entry.paymentMethod || "Ledger") === "ledger") {
          await insertLedger(client, this.businessId, {
            eventId: `${eventId}:ledger`, occurredAt, source: "GUI", kind, amountDelta: -total, actor, metadata
          });
        }
        await insertFinance(client, this.businessId, {
          eventId: `${eventId}:finance`, occurredAt, type: "Expense", category: "Payroll",
          label: cleanText(entry.payee, 150) || "Employee Payroll", source: entry.paymentMethod || "Ledger",
          direction: "Cash Out", amount: total, metadata
        });
      } else {
        await this.applyManualMovement(client, { eventId, occurredAt, actor, item, quantity, amount, kind, location, metadata });
      }
      return { ok: true, action: "manual_operation", entryId: eventId };
    });
  }

  async applyManualMovement(client, movement) {
    const { eventId, occurredAt, actor, item, quantity, amount, kind, location, metadata } = movement;
    const total = Math.abs(amount);
    const stockEvent = async (suffix, targetLocation, delta) => {
      requireItem(item);
      if (!quantity) return;
      await insertInventory(client, this.businessId, {
        eventId: `${eventId}:${suffix}`, occurredAt, source: "GUI", kind,
        location: targetLocation, item, quantityDelta: delta, actor, metadata
      });
    };
    const cashEvent = async delta => {
      if (!delta) return;
      await insertLedger(client, this.businessId, {
        eventId: `${eventId}:ledger`, occurredAt, source: "GUI", kind, amountDelta: delta, actor, metadata
      });
    };

    if (kind === "Owner Capital Deposit" || kind === "Owner Withdrawal") {
      const incoming = kind === "Owner Capital Deposit";
      await cashEvent(incoming ? total : -total);
      await insertFinance(client, this.businessId, {
        eventId: `${eventId}:finance`, occurredAt, type: "Owner Capital", category: "Owner Funds",
        label: "Owner Capital", source: "GUI", direction: incoming ? "Cash In" : "Cash Out", amount: total, metadata
      });
      return;
    }
    if (kind === "Safekeeping Deposit" || kind === "Safekeeping Withdrawal") {
      const incoming = kind === "Safekeeping Deposit";
      await cashEvent(incoming ? total : -total);
      await insertFinance(client, this.businessId, {
        eventId: `${eventId}:finance`, occurredAt, type: "Safekeeping", category: "Safekeeping",
        label: "Safekeeping Funds", source: "GUI", direction: incoming ? "Cash In" : "Cash Out", amount: total, metadata
      });
      return;
    }
    if (kind === "P2P Sale" || kind === "Cash In") {
      if (kind === "P2P Sale") await stockEvent("stock", location === "other" ? "storage" : location, -quantity);
      await cashEvent(total);
      await insertFinance(client, this.businessId, {
        eventId: `${eventId}:finance`, occurredAt, type: "Revenue", category: kind === "P2P Sale" ? "P2P Sales" : "Other Income",
        label: item || kind, source: "GUI", direction: "Cash In", amount: total, metadata: { ...metadata, quantity }
      });
      return;
    }
    if (kind === "P2P Purchase" || kind === "Cash Out" || kind === "Payroll Payout") {
      if (kind === "P2P Purchase") await stockEvent("stock", location === "other" ? "storage" : location, quantity);
      await cashEvent(-total);
      await insertFinance(client, this.businessId, {
        eventId: `${eventId}:finance`, occurredAt, type: "Expense",
        category: kind === "P2P Purchase" ? "P2P Purchases" : kind === "Payroll Payout" ? "Payroll" : "Other Expenses",
        label: item || kind, source: "GUI", direction: "Cash Out", amount: total, metadata: { ...metadata, quantity }
      });
      return;
    }
    if (kind === "Correction") {
      await cashEvent(amount);
      return;
    }
    if (kind === "Storefront Transfer") {
      await stockEvent("storage", "storage", -quantity);
      await stockEvent("sales", "sales", quantity);
      return;
    }
    if (kind === "Storage Transfer") {
      await stockEvent("sales", "sales", -quantity);
      await stockEvent("storage", "storage", quantity);
      return;
    }
    if (kind === "Production Use" || kind === "Correction Out") {
      await stockEvent("stock", location === "other" ? "storage" : location, -quantity);
      return;
    }
    await stockEvent("stock", location === "other" ? "storage" : location, quantity);
  }

  async updateStockTarget(target) {
    const itemName = cleanText(target.itemName || target.itemLabel, 150);
    requireItem(itemName);
    const result = await this.database.query(`
      UPDATE catalog_items SET stock_target = $3, updated_at = now()
      WHERE business_id = $1 AND item_type = 'product'
        AND (normalized_name = $2 OR lower(label) = $2 OR lower(item_tag) = $2)
      RETURNING name
    `, [this.businessId, inventoryKey(itemName), Math.max(0, number(target.target))]);
    if (!result.rowCount) throw storeError(`Product not found: ${itemName}`, 404, "product_not_found");
    return { ok: true, action: "stock_target", itemName: result.rows[0].name };
  }

  async recordTimeEntry(entry) {
    const id = cleanText(entry.id, 120);
    const employee = cleanText(entry.employee, 100);
    if (!id || !employee || !entry.clockIn) {
      throw storeError("Time entry requires an ID, employee, and clock-in time", 400, "invalid_time_entry");
    }
    const existing = await this.database.query(`
      SELECT entry_id FROM time_entries WHERE business_id = $1 AND entry_id = $2
    `, [this.businessId, id]);
    await this.database.query(`
      INSERT INTO time_entries (business_id, entry_id, employee_name, clock_in, clock_out, metadata, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, now())
      ON CONFLICT (business_id, entry_id) DO UPDATE SET
        employee_name = EXCLUDED.employee_name,
        clock_in = EXCLUDED.clock_in,
        clock_out = EXCLUDED.clock_out,
        metadata = EXCLUDED.metadata,
        updated_at = now()
    `, [
      this.businessId, id, employee, validDate(entry.clockIn), entry.clockOut ? validDate(entry.clockOut) : null,
      JSON.stringify({ durationMinutes: nullableNumber(entry.durationMinutes) })
    ]);
    return { ok: true, action: "time_clock", entryId: id, updated: Boolean(existing.rowCount) };
  }

  async ingestWebhook(payload) {
    return this.database.transaction(async client => {
      let event = normalizeWebhook(payload);
      event = await resolveAgainstCatalog(client, this.businessId, event);
      event = await applyStoredMapping(client, this.businessId, event);
      const existing = await client.query(`
        SELECT status FROM webhook_events WHERE business_id = $1 AND webhook_id = $2
      `, [this.businessId, event.webhookId]);
      if (existing.rowCount) {
        return { ok: true, duplicate: true, webhookId: event.webhookId, status: existing.rows[0].status };
      }
      const status = event.reviewRequired ? "review" : "applied";
      await insertWebhook(client, this.businessId, event, payload, status);
      if (event.reviewRequired) {
        await insertException(client, this.businessId, event, payload);
        if (event.ledgerBalance !== null) await insertLedger(client, this.businessId, {
          eventId: `${event.webhookId}:ledger`, occurredAt: event.occurredAt, source: "Discord", kind: "Storefront Ledger Control",
          absoluteBalance: event.ledgerBalance, actor: event.actor, metadata: { webhookId: event.webhookId }
        });
        return {
          ok: true, webhookId: event.webhookId, reviewRequired: true,
          reviewReason: event.reviewReason, transactionWritten: false,
          stockControlWritten: false, ledgerControlWritten: event.ledgerBalance !== null
        };
      }
      const applied = await applyWebhookEvent(client, this.businessId, event, { applyLedger: true });
      return { ok: true, webhookId: event.webhookId, transactionWritten: true, ...applied };
    });
  }

  async resolveException(correction) {
    const webhookId = cleanText(correction.webhookId, 150);
    return this.database.transaction(async client => {
      const result = await client.query(`
        SELECT e.*, w.payload, w.occurred_at, w.actor_name, w.order_id
        FROM webhook_exceptions e
        JOIN webhook_events w USING (business_id, webhook_id)
        WHERE e.business_id = $1 AND e.webhook_id = $2
        FOR UPDATE
      `, [this.businessId, webhookId]);
      if (!result.rowCount) throw storeError("Webhook exception not found", 404, "exception_not_found");
      const stored = result.rows[0];
      if (stored.status !== "Open") {
        return { ok: true, duplicate: true, action: "resolve_exception", webhookId, status: stored.status };
      }
      const quantity = number(correction.quantity);
      if (!(quantity > 0)) throw storeError("Resolving an exception requires a positive quantity", 400, "invalid_quantity");
      let itemName = cleanText(correction.itemName, 150);
      let productCreated = false;
      if (correction.newProduct?.enabled) {
        const product = normalizeNewProduct(correction.newProduct);
        const created = await createReviewedProduct(client, this.businessId, product);
        itemName = created.name;
        productCreated = created.created;
      }
      requireItem(itemName);
      const payload = json(stored.payload, {});
      const event = normalizeWebhook({
        ...payload,
        webhook_id: webhookId,
        event_type: correction.eventType || stored.proposed_event_type,
        direction: correction.direction || stored.proposed_direction,
        item_name: itemName,
        quantity,
        unit_price: correction.unitPrice === "" || correction.unitPrice === undefined
          ? stored.proposed_unit_price
          : correction.unitPrice,
        occurred_at: stored.occurred_at,
        actor: stored.actor_name,
        order_id: stored.order_id,
        review_required: false,
        review_reason: ""
      });
      const applied = await applyWebhookEvent(client, this.businessId, event, { applyLedger: false });
      const resolvedBy = cleanText(correction.resolvedBy, 100) || "Manager";
      if (correction.rememberMapping !== false) {
        await rememberMapping(client, this.businessId, {
          discordItemName: stored.discord_item_name,
          discordItemLabel: stored.discord_item_label,
          itemName,
          resolvedBy,
          webhookId
        });
      }
      await client.query(`
        UPDATE webhook_exceptions SET
          status = 'Resolved', resolved_item_name = $3, resolved_at = now(), resolved_by = $4,
          resolution_note = $5, transaction_written = true
        WHERE business_id = $1 AND webhook_id = $2
      `, [this.businessId, webhookId, itemName, resolvedBy, cleanText(correction.note, 2500)]);
      await client.query(`
        UPDATE webhook_events SET status = 'applied', item_name = $3, quantity = $4, unit_price = $5
        WHERE business_id = $1 AND webhook_id = $2
      `, [this.businessId, webhookId, itemName, quantity, event.unitPrice]);
      return {
        ok: true, action: "resolve_exception", webhookId, status: "Resolved", itemName,
        productCreated, transactionWritten: true, ...applied
      };
    });
  }

  async ignoreException(correction) {
    const webhookId = cleanText(correction.webhookId, 150);
    const result = await this.database.query(`
      UPDATE webhook_exceptions SET
        status = 'Ignored', resolved_at = now(), resolved_by = $3, resolution_note = $4
      WHERE business_id = $1 AND webhook_id = $2 AND status = 'Open'
      RETURNING webhook_id
    `, [this.businessId, webhookId, cleanText(correction.resolvedBy, 100) || "Manager", cleanText(correction.note, 2500)]);
    if (!result.rowCount) {
      const existing = await this.database.query(`
        SELECT status FROM webhook_exceptions WHERE business_id = $1 AND webhook_id = $2
      `, [this.businessId, webhookId]);
      if (!existing.rowCount) throw storeError("Webhook exception not found", 404, "exception_not_found");
      return { ok: true, duplicate: true, action: "ignore_exception", webhookId, status: existing.rows[0].status };
    }
    await this.database.query(`
      UPDATE webhook_events SET status = 'ignored' WHERE business_id = $1 AND webhook_id = $2
    `, [this.businessId, webhookId]);
    return { ok: true, action: "ignore_exception", webhookId, status: "Ignored" };
  }
}

async function upsertCatalogItem(client, businessId, item) {
  await client.query(`
    INSERT INTO catalog_items (
      business_id, id, item_type, name, normalized_name, label, item_tag, category,
      unit_name, unit_cost, sale_price, stock_target, active, aliases, metadata, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15::jsonb, now())
    ON CONFLICT (business_id, normalized_name) DO UPDATE SET
      item_type = EXCLUDED.item_type,
      name = EXCLUDED.name,
      label = EXCLUDED.label,
      item_tag = EXCLUDED.item_tag,
      category = EXCLUDED.category,
      unit_name = EXCLUDED.unit_name,
      unit_cost = EXCLUDED.unit_cost,
      sale_price = EXCLUDED.sale_price,
      active = EXCLUDED.active,
      aliases = EXCLUDED.aliases,
      metadata = EXCLUDED.metadata,
      updated_at = now()
  `, [
    businessId, item.id || crypto.randomUUID(), item.type, item.name, inventoryKey(item.name),
    item.label || item.name, item.tag || "", item.category || (item.type === "material" ? "Materials" : "Products"),
    item.unit || "unit", number(item.unitCost), number(item.salePrice), number(item.target), item.active !== false,
    JSON.stringify(item.aliases || []), JSON.stringify({ source: "Business setup" })
  ]);
}

async function reserveOperation(client, businessId, eventId, operationType, payload) {
  const existing = await client.query(`
    SELECT 1 FROM operation_receipts WHERE business_id = $1 AND event_id = $2
  `, [businessId, eventId]);
  if (existing.rowCount) return false;
  const result = await client.query(`
    INSERT INTO operation_receipts (business_id, event_id, operation_type, payload)
    VALUES ($1, $2, $3, $4::jsonb)
    ON CONFLICT (business_id, event_id) DO NOTHING
    RETURNING event_id
  `, [businessId, eventId, operationType, JSON.stringify(payload)]);
  return result.rows.length > 0;
}

async function insertInventory(client, businessId, event) {
  await client.query(`
    INSERT INTO inventory_events (
      business_id, event_id, occurred_at, source, event_kind, location_type,
      item_name, normalized_item_name, quantity_delta, absolute_quantity, unit_price, actor_name, metadata
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
    ON CONFLICT (business_id, event_id) DO NOTHING
  `, [
    businessId, event.eventId, event.occurredAt, event.source, event.kind, event.location,
    event.item, inventoryKey(event.item), number(event.quantityDelta), nullableNumber(event.absoluteQuantity),
    number(event.unitPrice), event.actor || "", JSON.stringify(event.metadata || {})
  ]);
}

async function insertLedger(client, businessId, event) {
  await client.query(`
    INSERT INTO ledger_events (
      business_id, event_id, occurred_at, source, event_kind, amount_delta, absolute_balance, actor_name, metadata
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
    ON CONFLICT (business_id, event_id) DO NOTHING
  `, [
    businessId, event.eventId, event.occurredAt, event.source, event.kind, number(event.amountDelta),
    nullableNumber(event.absoluteBalance), event.actor || "", JSON.stringify(event.metadata || {})
  ]);
}

async function insertFinance(client, businessId, event) {
  if (!(number(event.amount) > 0)) return;
  await client.query(`
    INSERT INTO finance_events (
      business_id, event_id, occurred_at, entry_type, category, label, source, direction, amount, metadata
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
    ON CONFLICT (business_id, event_id) DO NOTHING
  `, [
    businessId, event.eventId, event.occurredAt, event.type, event.category, event.label,
    event.source, event.direction || "", number(event.amount), JSON.stringify(event.metadata || {})
  ]);
}

async function insertWebhook(client, businessId, event, payload, status) {
  await client.query(`
    INSERT INTO webhook_events (
      business_id, webhook_id, occurred_at, event_type, direction, item_name, quantity,
      unit_price, actor_name, order_id, status, payload
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
  `, [
    businessId, event.webhookId, event.occurredAt, event.type, event.direction, event.item,
    event.quantity, event.unitPrice, event.actor, event.orderId, status, JSON.stringify(payload)
  ]);
}

async function insertException(client, businessId, event, payload) {
  await client.query(`
    INSERT INTO webhook_exceptions (
      business_id, webhook_id, status, reason, discord_title, discord_item_name, discord_item_label,
      proposed_event_type, proposed_direction, proposed_quantity, proposed_unit_price,
      ledger_balance, current_item_total, original_payload
    ) VALUES ($1, $2, 'Open', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
  `, [
    businessId, event.webhookId, event.reviewReason, event.discordTitle, event.discordItemName,
    event.discordItemLabel, event.type, event.direction, event.quantity, event.unitPrice,
    event.ledgerBalance, event.currentItemTotal, JSON.stringify(payload)
  ]);
}

async function applyWebhookEvent(client, businessId, event, { applyLedger }) {
  const metadata = { webhookId: event.webhookId, orderId: event.orderId };
  const quantityDelta = event.type === "Sale" || event.direction === "Stock Out"
    ? -event.quantity
    : event.quantity;
  if (event.item && event.quantity > 0) {
    await insertInventory(client, businessId, {
      eventId: `${event.webhookId}:stock`, occurredAt: event.occurredAt, source: "Discord", kind: event.type,
      location: "sales", item: event.item,
      quantityDelta: event.currentItemTotal === null ? quantityDelta : 0,
      absoluteQuantity: event.currentItemTotal,
      unitPrice: event.unitPrice, actor: event.actor, metadata
    });
  }
  if (applyLedger) {
    const derivedCash = event.type === "Sale"
      ? event.quantity * event.unitPrice
      : event.type === "Purchase" ? -(event.quantity * event.unitPrice) : 0;
    if (event.ledgerBalance !== null || derivedCash) {
      await insertLedger(client, businessId, {
        eventId: `${event.webhookId}:ledger`, occurredAt: event.occurredAt, source: "Discord", kind: event.type,
        amountDelta: event.ledgerBalance === null ? derivedCash : 0,
        absoluteBalance: event.ledgerBalance,
        actor: event.actor, metadata
      });
    }
  }
  const total = money(event.quantity * event.unitPrice);
  if ((event.type === "Sale" || event.type === "Purchase") && total > 0) {
    await insertFinance(client, businessId, {
      eventId: `${event.webhookId}:finance`, occurredAt: event.occurredAt,
      type: event.type === "Sale" ? "Revenue" : "Expense",
      category: event.type === "Sale" ? "Storefront Sales" : "Storefront Purchases",
      label: event.item, source: "Discord", direction: event.type === "Sale" ? "Cash In" : "Cash Out",
      amount: total, metadata: { ...metadata, quantity: event.quantity, unitPrice: event.unitPrice }
    });
  }
  return {
    stockControlWritten: event.currentItemTotal !== null,
    ledgerControlWritten: applyLedger && event.ledgerBalance !== null
  };
}

async function applyStoredMapping(client, businessId, event) {
  if (!event.reviewRequired || !event.reviewReason.split(",").includes("unknown_item")) return event;
  const result = await client.query(`
    SELECT canonical_item_name FROM item_mappings
    WHERE business_id = $1 AND (
      ($2 <> '' AND lower(discord_item_name) = $2) OR
      ($3 <> '' AND lower(discord_item_label) = $3)
    ) ORDER BY created_at DESC LIMIT 1
  `, [businessId, inventoryKey(event.discordItemName), inventoryKey(event.discordItemLabel)]);
  if (!result.rowCount) return event;
  const reasons = event.reviewReason.split(",").filter(reason => reason && reason !== "unknown_item");
  return { ...event, item: result.rows[0].canonical_item_name, reviewReason: reasons.join(","), reviewRequired: reasons.length > 0 };
}

async function resolveAgainstCatalog(client, businessId, event) {
  const result = await client.query(`
    SELECT name, normalized_name, label, item_tag, aliases
    FROM catalog_items
    WHERE business_id = $1 AND active = true
  `, [businessId]);
  const rawWanted = [event.discordItemName, event.discordItemLabel].map(inventoryKey).filter(Boolean);
  const wanted = new Set((rawWanted.length ? rawWanted : [event.item]).map(inventoryKey).filter(Boolean));
  const match = result.rows.find(row => [
    row.name,
    row.normalized_name,
    row.label,
    row.item_tag,
    ...json(row.aliases, [])
  ].some(value => wanted.has(inventoryKey(value))));
  let reasons = event.reviewReason.split(",").filter(Boolean).filter(reason => reason !== "unknown_item");
  if (match) {
    return {
      ...event,
      item: match.name,
      reviewReason: reasons.join(","),
      reviewRequired: reasons.length > 0
    };
  }
  if ((event.item || event.discordItemName || event.discordItemLabel) && !reasons.includes("unknown_item")) {
    reasons.push("unknown_item");
  }
  return { ...event, reviewReason: reasons.join(","), reviewRequired: reasons.length > 0 };
}

async function rememberMapping(client, businessId, mapping) {
  if (!mapping.discordItemName && !mapping.discordItemLabel) return;
  const existing = await client.query(`
    SELECT id FROM item_mappings WHERE business_id = $1 AND (
      ($2 <> '' AND lower(discord_item_name) = $2) OR
      ($3 <> '' AND lower(discord_item_label) = $3)
    ) LIMIT 1
  `, [businessId, inventoryKey(mapping.discordItemName), inventoryKey(mapping.discordItemLabel)]);
  const id = existing.rows[0]?.id || crypto.randomUUID();
  await client.query(`
    INSERT INTO item_mappings (
      business_id, id, discord_item_name, discord_item_label, canonical_item_name, created_by, source_webhook_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (business_id, id) DO UPDATE SET
      discord_item_name = EXCLUDED.discord_item_name,
      discord_item_label = EXCLUDED.discord_item_label,
      canonical_item_name = EXCLUDED.canonical_item_name,
      created_by = EXCLUDED.created_by,
      source_webhook_id = EXCLUDED.source_webhook_id,
      created_at = now()
  `, [
    businessId, id, mapping.discordItemName || "", mapping.discordItemLabel || "", mapping.itemName,
    mapping.resolvedBy || "", mapping.webhookId || ""
  ]);
}

async function createReviewedProduct(client, businessId, input) {
  const byName = await client.query(`
    SELECT name, label, item_tag FROM catalog_items
    WHERE business_id = $1 AND normalized_name = $2
  `, [businessId, inventoryKey(input.name)]);
  if (byName.rowCount) {
    const existing = byName.rows[0];
    if (inventoryKey(existing.label) !== inventoryKey(input.label) || inventoryKey(existing.item_tag) !== inventoryKey(input.tag)) {
      throw storeError("That product name belongs to a different label or game item tag", 409, "product_conflict");
    }
    return { name: existing.name, created: false };
  }
  try {
    await upsertCatalogItem(client, businessId, {
      id: crypto.randomUUID(), type: "product", name: input.name, label: input.label, tag: input.tag,
      category: input.category, unit: "unit", unitCost: 0, salePrice: input.price, target: 0,
      active: true, aliases: []
    });
  } catch (error) {
    if (error.code === "23505") throw storeError("That display label or game item tag already exists", 409, "product_conflict");
    throw error;
  }
  await client.query(`
    UPDATE catalog_items SET metadata = $3::jsonb
    WHERE business_id = $1 AND normalized_name = $2
  `, [businessId, inventoryKey(input.name), JSON.stringify({
    msrpLow: input.price, msrpHigh: input.price, pricingSource: "Webhook Review"
  })]);
  return { name: input.name, created: true };
}

function normalizeWebhook(payload) {
  const reviewRequested = payload?.review_required === true || String(payload?.review_required || "").toLowerCase() === "true";
  const rawType = firstValue(payload, ["event_type", "type", "action", "event"]);
  const type = normalizeType(rawType);
  const direction = normalizeDirection(firstValue(payload, ["direction", "movement", "stock_direction"]), type);
  const item = cleanText(firstValue(payload, reviewRequested
    ? ["proposed_item_name", "item_name", "item", "name", "product", "product_name"]
    : ["item_name", "item", "name", "product", "product_name"]), 150);
  const quantity = number(firstValue(payload, reviewRequested
    ? ["proposed_quantity", "qty", "quantity", "count", "amount"]
    : ["qty", "quantity", "count", "amount"]));
  const reasons = cleanText(firstValue(payload, ["review_reason"]), 300).split(",").map(value => value.trim()).filter(Boolean);
  if (!item && !reasons.includes("missing_item")) reasons.push("missing_item");
  if (!(quantity > 0) && !reasons.includes("missing_quantity")) reasons.push("missing_quantity");
  return {
    webhookId: cleanText(firstValue(payload, ["webhook_id", "id", "event_id", "discord_message_id", "order_id", "buy_order_id", "receipt_id"]), 150) || crypto.randomUUID(),
    type,
    direction,
    item,
    quantity,
    unitPrice: Math.max(0, number(firstValue(payload, ["unit_price", "price", "sale_price", "buy_price"]))),
    currentItemTotal: nullableNumber(firstValue(payload, ["current_item_total", "current_stock", "stock_total"])),
    ledgerBalance: nullableNumber(firstValue(payload, ["shop_ledger", "ledger_balance", "current_ledger"])),
    occurredAt: validDate(firstValue(payload, ["timestamp", "occurred_at", "created_at"])),
    actor: cleanText(firstValue(payload, ["actor", "customer", "buyer", "seller", "player"]), 150),
    orderId: cleanText(firstValue(payload, ["order_id", "buy_order_id", "receipt_id", "transaction_id"]), 150),
    discordTitle: cleanText(firstValue(payload, ["discord_title", "title"]), 200),
    discordItemName: cleanText(firstValue(payload, ["discord_item_name"]), 200),
    discordItemLabel: cleanText(firstValue(payload, ["discord_item_label"]), 200),
    reviewRequired: reviewRequested || reasons.length > 0,
    reviewReason: reasons.join(",")
  };
}

function normalizeNewProduct(input) {
  const product = {
    name: cleanText(input?.name, 120), label: cleanText(input?.label, 120), tag: cleanText(input?.tag, 150),
    category: cleanText(input?.category, 120) || "Resale", price: number(input?.price)
  };
  if (!product.name || !product.label || !product.tag) {
    throw storeError("A new ware requires a name, display label, and game item tag", 400, "invalid_new_product");
  }
  if (product.price < 0) throw storeError("A new ware requires a non-negative sale price", 400, "invalid_new_product");
  return product;
}

function reduceInventory(rows) {
  const state = new Map();
  for (const row of rows) {
    const key = `${row.location_type}:${row.normalized_item_name}`;
    const current = state.get(key) || emptyCount(row.item_name, row.normalized_item_name);
    if (row.absolute_quantity !== null && row.absolute_quantity !== undefined) {
      current.quantity = number(row.absolute_quantity);
      current.countedAt = iso(row.occurred_at);
      current.netMovementSinceCount = 0;
    } else {
      const delta = number(row.quantity_delta);
      current.quantity += delta;
      if (current.countedAt) current.netMovementSinceCount += delta;
    }
    current.itemName = row.item_name || current.itemName;
    current.lastActivityAt = iso(row.occurred_at);
    state.set(key, current);
  }
  return state;
}

function reduceLedger(rows) {
  let balance = 0;
  let countedBalance = null;
  let countedAt = "";
  let netMovementSinceCount = 0;
  let lastActivityAt = "";
  for (const row of rows) {
    if (row.absolute_balance !== null && row.absolute_balance !== undefined) {
      balance = number(row.absolute_balance);
      countedBalance = balance;
      countedAt = iso(row.occurred_at);
      netMovementSinceCount = 0;
    } else {
      const delta = number(row.amount_delta);
      balance += delta;
      if (countedAt) netMovementSinceCount += delta;
    }
    lastActivityAt = iso(row.occurred_at);
  }
  return {
    balance: money(balance),
    countedBalance: countedBalance === null ? null : money(countedBalance),
    countedAt,
    netMovementSinceCount: money(netMovementSinceCount),
    lastActivityAt
  };
}

function catalogRow(row) {
  return {
    id: row.id,
    itemType: row.item_type,
    name: row.name,
    normalizedName: row.normalized_name,
    label: row.label,
    itemTag: row.item_tag,
    category: row.category,
    unitName: row.unit_name,
    unitCost: number(row.unit_cost),
    salePrice: number(row.sale_price),
    stockTarget: number(row.stock_target),
    active: row.active !== false,
    aliases: json(row.aliases, []),
    metadata: json(row.metadata, {})
  };
}

function exceptionRow(row) {
  const payload = json(row.original_payload, {});
  return {
    webhookId: row.webhook_id,
    status: row.status,
    reason: row.reason,
    receivedAt: iso(row.created_at),
    discordTitle: row.discord_title,
    discordItemName: row.discord_item_name,
    discordItemLabel: row.discord_item_label,
    eventType: row.proposed_event_type,
    direction: row.proposed_direction,
    quantity: number(row.proposed_quantity),
    unitPrice: number(row.proposed_unit_price),
    ledgerBalance: nullableNumber(row.ledger_balance),
    currentItemTotal: nullableNumber(row.current_item_total),
    resolvedItem: row.resolved_item_name,
    resolvedAt: iso(row.resolved_at),
    resolvedBy: row.resolved_by,
    note: row.resolution_note,
    rawText: String(payload.raw_payload || "").slice(0, 4000),
    transactionWritten: Boolean(row.transaction_written)
  };
}

function aggregateBreakdown(rows) {
  const groups = new Map();
  for (const row of rows.filter(item => item.type === "Revenue" || item.type === "Expense")) {
    const key = [row.type, row.category, row.label, row.source].join("\u0000");
    const current = groups.get(key) || { type: row.type, category: row.category, label: row.label, source: row.source, amount: 0, count: 0 };
    current.amount += row.amount;
    current.count += number(row.metadata?.quantity) || 1;
    groups.set(key, current);
  }
  return [...groups.values()].map(row => ({ ...row, amount: money(row.amount) })).sort((a, b) => b.amount - a.amount);
}

function aggregateMonthly(rows) {
  const months = new Map();
  for (const row of rows) {
    if (row.type !== "Revenue" && row.type !== "Expense") continue;
    const month = row.occurredAt.slice(0, 7);
    const current = months.get(month) || { month, revenue: 0, expenses: 0, profit: 0 };
    if (row.type === "Revenue") current.revenue += row.amount;
    else current.expenses += row.amount;
    current.profit = current.revenue - current.expenses;
    months.set(month, current);
  }
  return [...months.values()].map(row => ({
    month: row.month, revenue: money(row.revenue), expenses: money(row.expenses), profit: money(row.profit)
  })).sort((a, b) => a.month.localeCompare(b.month));
}

function financeCoverage(rows) {
  return {
    transactionsScanned: rows.length,
    storefrontSales: rows.filter(row => row.type === "Revenue" && row.category === "Storefront Sales").length,
    storefrontPurchases: rows.filter(row => row.type === "Expense" && row.category === "Storefront Purchases").length,
    manualMovementsScanned: rows.filter(row => row.source !== "Discord").length,
    manualEntries: rows.filter(row => row.source === "GUI").length,
    ownerFundEntries: rows.filter(row => row.type === "Owner Capital").length,
    safekeepingEntries: rows.filter(row => row.type === "Safekeeping").length,
    payrollPayments: rows.filter(row => row.category === "Payroll").length
  };
}

function firstValue(object, keys) {
  for (const key of keys) {
    if (object?.[key] !== undefined && object[key] !== null && object[key] !== "") return object[key];
  }
  return "";
}

function normalizeType(value) {
  const text = inventoryKey(value);
  if (text.includes("sale") || text.includes("sold") || text.includes("sell")) return "Sale";
  if (text.includes("purchase") || text.includes("bought") || text.includes("buy")) return "Purchase";
  if (text.includes("stock") || text.includes("movement") || text.includes("restock")) return "Stocking Movement";
  if (text.includes("craft")) return "Craft";
  return "Adjustment";
}

function normalizeDirection(value, type) {
  const text = inventoryKey(value);
  if (text.includes("out")) return "Stock Out";
  if (text.includes("in")) return "Stock In";
  if (type === "Sale") return "Stock Out";
  if (type === "Purchase") return "Purchase";
  return "Stock In";
}

function locationType(value) {
  const text = inventoryKey(value);
  if (text.includes("store") || text.includes("sales") || text.includes("showroom")) return "sales";
  if (text.includes("storage") || text.includes("warehouse")) return "storage";
  return "other";
}

function emptyCount(itemName, normalizedName = inventoryKey(itemName)) {
  return { itemName, normalizedName, quantity: 0, countedAt: "", netMovementSinceCount: 0, lastActivityAt: "" };
}

function inventoryKey(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function legacyCatalogId(type, name) {
  const digest = crypto.createHash("sha256").update(`${type}:${inventoryKey(name)}`).digest("hex").slice(0, 24);
  return `${type ? `${type}-` : ""}${digest}`;
}

function cleanText(value, maxLength) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function validDate(value) {
  const parsed = new Date(value || "");
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function iso(value) {
  if (!value) return "";
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
}

function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableNumber(value) {
  if (value === "" || value === null || value === undefined) return null;
  const parsed = Number(String(value).replace(/[$,]/g, "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function money(value) {
  return Math.round((number(value) + Number.EPSILON) * 100) / 100;
}

function sum(rows, selector) {
  return money(rows.reduce((total, row) => total + number(selector(row)), 0));
}

function inDateRange(timestamp, from, to) {
  const date = String(timestamp || "").slice(0, 10);
  return (!from || date >= from) && (!to || date <= to);
}

function json(value, fallback) {
  if (value && typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function requireItem(item) {
  if (!item) throw storeError("An item is required", 400, "item_required");
}

function storeError(message, status, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

module.exports = { StandaloneStore, inventoryKey, normalizeWebhook, reduceInventory, reduceLedger };
