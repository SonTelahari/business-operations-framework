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
          storageTarget: material.storageTarget,
          active: true,
          aliases: []
        });
      }
      for (const product of configuration.catalog.products || []) {
        await upsertCatalogItem(client, this.businessId, {
          ...product,
          type: "product",
          unit: "unit",
          unitCost: 0,
          storageTarget: product.storageTarget
        });
      }

      for (const recipe of configuration.catalog.recipes || []) {
        const inserted = await client.query(`
          INSERT INTO recipe_definitions (
            business_id, id, product_name, normalized_product_name, output_quantity, active
          ) VALUES ($1, $2, $3, $4, $5, true)
          ON CONFLICT (business_id, normalized_product_name) DO NOTHING
          RETURNING id
        `, [this.businessId, recipe.id, recipe.productName, inventoryKey(recipe.productName), recipe.yield]);
        if (!inserted.rowCount) continue;
        for (let index = 0; index < recipe.ingredients.length; index += 1) {
          const ingredient = recipe.ingredients[index];
          await client.query(`
            INSERT INTO recipe_ingredients (
              business_id, recipe_id, position, ingredient_name, normalized_ingredient_name, quantity, source_location
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (business_id, recipe_id, position) DO NOTHING
          `, [
            this.businessId,
            inserted.rows[0].id,
            index,
            ingredient.name,
            inventoryKey(ingredient.name),
            ingredient.quantity,
            productionSourceType(ingredient.sourceLocation)
          ]);
        }
      }
    });
  }

  async importLegacySnapshot({ snapshot, finance = null, audit = [], actor = "Legacy import", fingerprint = "" }) {
    if (!snapshot?.ok || !snapshot.inventory) {
      throw storeError("Legacy import requires a valid bootstrap snapshot", 400, "invalid_import_snapshot");
    }
    const sourceFingerprint = cleanText(fingerprint, 200)
      || crypto.createHash("sha256").update(JSON.stringify({ snapshot, finance, audit })).digest("hex");
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
      const materialsByKey = new Map(materials.map(material => [
        inventoryKey(material.ingredient || material.itemName || material.name),
        material
      ]));

      for (const product of products) {
        const name = cleanText(product.itemName || product.itemLabel, 150);
        if (!name) continue;
        const material = materialsByKey.get(inventoryKey(name));
        const type = product.itemType === "both" || material ? "both" : "product";
        await upsertCatalogItem(client, this.businessId, {
          id: legacyCatalogId("product", name),
          type,
          name,
          label: cleanText(product.itemLabel, 150) || name,
          tag: cleanText(product.itemTag, 150),
          category: cleanText(product.category, 100) || "Imported products",
          unit: cleanText(material?.unit || material?.unitName, 50) || "unit",
          unitCost: number(material?.unitCost),
          salePrice: number(product.salePrice),
          target: number(product.target),
          storageTarget: number(product.storageTarget ?? material?.storageTarget),
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
            storageTarget: number(material.storageTarget),
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
      const recipes = Array.isArray(snapshot.recipes) ? snapshot.recipes : [];
      for (const rawRecipe of recipes) {
        const recipe = normalizeRecipe(rawRecipe);
        const id = cleanText(rawRecipe.id, 120) || legacyCatalogId("recipe", recipe.productName);
        await client.query(`
          INSERT INTO recipe_definitions (
            business_id, id, product_name, normalized_product_name, output_quantity, active, updated_at
          ) VALUES ($1, $2, $3, $4, $5, true, now())
          ON CONFLICT (business_id, normalized_product_name) DO UPDATE SET
            product_name = EXCLUDED.product_name,
            output_quantity = EXCLUDED.output_quantity,
            active = true,
            updated_at = now()
        `, [this.businessId, id, recipe.productName, inventoryKey(recipe.productName), recipe.yield]);
        const storedRecipe = await client.query(`
          SELECT id FROM recipe_definitions
          WHERE business_id = $1 AND normalized_product_name = $2
        `, [this.businessId, inventoryKey(recipe.productName)]);
        const recipeId = storedRecipe.rows[0].id;
        await client.query("DELETE FROM recipe_ingredients WHERE business_id = $1 AND recipe_id = $2", [this.businessId, recipeId]);
        for (let index = 0; index < recipe.ingredients.length; index += 1) {
          const ingredient = recipe.ingredients[index];
          await client.query(`
            INSERT INTO recipe_ingredients (
              business_id, recipe_id, position, ingredient_name, normalized_ingredient_name, quantity, source_location
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
          `, [
            this.businessId, recipeId, index, ingredient.name, inventoryKey(ingredient.name),
            ingredient.quantity, productionSourceType(ingredient.sourceLocation)
          ]);
        }
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
      const auditedFunds = legacyFundAuditEntries(audit);
      const balanceEntries = [
        ["ownerCapitalDeposits", "Owner Capital", "Owner Funds", "Owner Capital", "Cash In"],
        ["ownerWithdrawals", "Owner Capital", "Owner Funds", "Owner Capital", "Cash Out"],
        ["safekeepingDeposits", "Safekeeping", "Safekeeping", "Safekeeping Funds", "Cash In"],
        ["safekeepingWithdrawals", "Safekeeping", "Safekeeping", "Safekeeping Funds", "Cash Out"]
      ];
      for (let index = 0; index < balanceEntries.length; index += 1) {
        const [balanceKey, type, category, label, direction] = balanceEntries[index];
        const reportedAmount = number(balances[balanceKey]);
        const auditEntries = auditedFunds.filter(entry => entry.balanceKey === balanceKey);
        if (reportedAmount > 0 || !auditEntries.length) {
          await insertFinance(client, this.businessId, {
            eventId: `${batchId}:balance:${index}`, occurredAt, type, category, label,
            source: "Legacy Import", direction, amount: reportedAmount, metadata: { batchId }
          });
          continue;
        }
        for (let auditIndex = 0; auditIndex < auditEntries.length; auditIndex += 1) {
          const entry = auditEntries[auditIndex];
          await insertFinance(client, this.businessId, {
            eventId: `${batchId}:balance:${index}:audit:${auditIndex}`,
            occurredAt: entry.occurredAt,
            type,
            category,
            label,
            source: "Legacy Audit Import",
            direction,
            amount: entry.amount,
            metadata: { batchId, legacyAuditId: entry.id, note: entry.note, importedAudit: true }
          });
        }
      }

      const summary = {
        products: products.length,
        materials: materials.length,
        recipes: recipes.length,
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
    const [catalogResult, recipeResult, ingredientResult, inventoryResult, ledgerResult, exceptionResult, purchaseResult] = await Promise.all([
      this.database.query(`
        SELECT * FROM catalog_items WHERE business_id = $1 ORDER BY item_type, category, label
      `, [this.businessId]),
      this.database.query(`
        SELECT * FROM recipe_definitions
        WHERE business_id = $1 AND active = true
        ORDER BY product_name
      `, [this.businessId]),
      this.database.query(`
        SELECT * FROM recipe_ingredients
        WHERE business_id = $1
        ORDER BY recipe_id, position
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
        SELECT e.*, w.actor_name
        FROM webhook_exceptions e
        LEFT JOIN webhook_events w USING (business_id, webhook_id)
        WHERE e.business_id = $1
        ORDER BY e.created_at DESC
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
    const ingredientsByRecipe = new Map();
    ingredientResult.rows.forEach(row => {
      const ingredients = ingredientsByRecipe.get(row.recipe_id) || [];
      ingredients.push({
        name: row.ingredient_name,
        quantity: number(row.quantity),
        sourceLocation: displayProductionSource(row.source_location)
      });
      ingredientsByRecipe.set(row.recipe_id, ingredients);
    });
    const recipes = recipeResult.rows.map(row => ({
      id: row.id,
      productName: row.product_name,
      yield: number(row.output_quantity),
      ingredients: ingredientsByRecipe.get(row.id) || []
    }));
    const products = catalog.filter(isSellableCatalogItem).map(item => {
      const count = inventory.get(`sales:${item.normalizedName}`) || emptyCount(item.name);
      return {
        itemName: item.name,
        id: item.id,
        itemLabel: item.label,
        itemTag: item.itemTag,
        itemType: item.itemType,
        category: item.category,
        unitName: item.unitName,
        unitCost: item.unitCost,
        salePrice: item.salePrice,
        target: item.stockTarget,
        storageTarget: item.storageTarget,
        currentStock: Math.max(0, count.quantity),
        countedAt: count.countedAt,
        active: item.active,
        aliases: item.aliases,
        msrpLow: nullableNumber(item.metadata?.msrpLow),
        msrpHigh: nullableNumber(item.metadata?.msrpHigh),
        pricingSource: String(item.metadata?.pricingSource || "")
      };
    });
    const materials = catalog.filter(isMaterialCatalogItem).map(item => {
      const count = inventory.get(`storage:${item.normalizedName}`) || emptyCount(item.name);
      return {
        ingredient: item.name,
        id: item.id,
        name: item.name,
        label: item.label,
        itemTag: item.itemTag,
        itemType: item.itemType,
        category: item.category,
        unit: item.unitName,
        unitCost: item.unitCost,
        storageTarget: item.storageTarget,
        storageCount: Math.max(0, count.quantity),
        countedAt: count.countedAt,
        active: item.active,
        aliases: item.aliases
      };
    });
    const storefront = catalog.filter(item => item.active).map(item => {
      const count = inventory.get(`sales:${item.normalizedName}`) || emptyCount(item.name);
      return {
        itemName: item.name,
        itemLabel: item.label,
        itemTag: item.itemTag,
        itemType: item.itemType,
        category: item.category,
        salePrice: item.salePrice,
        target: isSellableCatalogItem(item) ? item.stockTarget : 0,
        storageTarget: item.storageTarget,
        currentStock: Math.max(0, count.quantity),
        countedAt: count.countedAt,
        active: item.active,
        aliases: item.aliases
      };
    });
    const storageKeys = new Set();
    const storage = [];
    for (const item of catalog) {
      const count = inventory.get(`storage:${item.normalizedName}`) || emptyCount(item.name);
      storageKeys.add(item.normalizedName);
      storage.push({
        ingredient: item.name,
        itemLabel: item.label,
        itemTag: item.itemTag,
        itemType: item.itemType,
        category: item.category,
        unitCost: item.unitCost,
        salePrice: item.salePrice,
        storageTarget: item.storageTarget,
        storageCount: Math.max(0, count.quantity),
        countedAt: count.countedAt,
        active: item.active
      });
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
      catalog,
      recipes,
      inventory: {
        products,
        materials,
        storefront,
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

  async reconcileImportedFundAudit(audit = []) {
    const importedFunds = legacyFundAuditEntries(
      (Array.isArray(audit) ? audit : []).filter(event => String(event?.id || "").startsWith("legacy-"))
    );
    if (!importedFunds.length) return { ok: true, inserted: 0, amount: 0 };
    return this.database.transaction(async client => {
      const result = await client.query(`
        SELECT entry_type, direction, COALESCE(SUM(amount), 0) AS amount
        FROM finance_events
        WHERE business_id = $1 AND source IN ('Legacy Import', 'Legacy Audit Import')
          AND entry_type IN ('Owner Capital', 'Safekeeping')
        GROUP BY entry_type, direction
      `, [this.businessId]);
      const existing = new Map(result.rows.map(row => [
        `${row.entry_type}:${row.direction}`,
        number(row.amount)
      ]));
      const grouped = new Map();
      for (const entry of importedFunds) {
        const group = grouped.get(entry.balanceKey) || [];
        group.push(entry);
        grouped.set(entry.balanceKey, group);
      }
      let inserted = 0;
      let insertedAmount = 0;
      for (const [balanceKey, entries] of grouped) {
        const descriptor = fundBalanceDescriptor(balanceKey);
        if (!descriptor) continue;
        const existingAmount = existing.get(`${descriptor.type}:${descriptor.direction}`) || 0;
        let remaining = Math.max(0, sum(entries, entry => entry.amount) - existingAmount);
        for (const entry of entries) {
          if (!(remaining > 0)) break;
          const amount = Math.min(entry.amount, remaining);
          await insertFinance(client, this.businessId, {
            eventId: `legacy-audit-fund:${entry.id}`,
            occurredAt: entry.occurredAt,
            type: descriptor.type,
            category: descriptor.category,
            label: descriptor.label,
            source: "Legacy Audit Import",
            direction: descriptor.direction,
            amount,
            metadata: { legacyAuditId: entry.id, note: entry.note, importedAudit: true, repaired: true }
          });
          remaining -= amount;
          inserted += 1;
          insertedAmount += amount;
        }
      }
      return { ok: true, inserted, amount: money(insertedAmount) };
    });
  }

  async reconcileCatalogPricesFromWebhooks() {
    return this.database.transaction(async client => {
      const result = await client.query(`
        SELECT item_name, unit_price
        FROM webhook_events
        WHERE business_id = $1 AND status = 'applied' AND event_type = 'Stocking Movement'
          AND direction = 'Stock In' AND item_name <> '' AND unit_price > 0
        ORDER BY occurred_at DESC, recorded_at DESC, webhook_id DESC
      `, [this.businessId]);
      const seen = new Set();
      const repaired = [];
      for (const row of result.rows) {
        const normalizedName = inventoryKey(row.item_name);
        if (!normalizedName || seen.has(normalizedName)) continue;
        seen.add(normalizedName);
        const update = await client.query(`
          UPDATE catalog_items
          SET sale_price = $3, updated_at = now()
          WHERE business_id = $1 AND normalized_name = $2 AND sale_price = 0
          RETURNING name
        `, [this.businessId, normalizedName, number(row.unit_price)]);
        if (update.rowCount) repaired.push(update.rows[0].name);
      }
      return { ok: true, repaired };
    });
  }

  async reconcileImportedExceptions() {
    return this.database.transaction(async client => {
      const result = await client.query(`
        SELECT e.*, w.payload
        FROM webhook_exceptions e
        JOIN webhook_events w USING (business_id, webhook_id)
        WHERE e.business_id = $1 AND e.status = 'Open'
        ORDER BY e.created_at, e.webhook_id
        FOR UPDATE
      `, [this.businessId]);
      const repaired = [];
      for (const stored of result.rows) {
        if (json(stored.payload, {}).importedFromArchive !== true) continue;
        const matched = await resolveAgainstCatalog(client, this.businessId, {
          item: cleanText(stored.resolved_item_name || stored.discord_item_label || stored.discord_item_name, 150),
          discordItemName: cleanText(stored.discord_item_name, 200),
          discordItemLabel: cleanText(stored.discord_item_label, 200),
          reviewReason: cleanText(stored.reason, 300),
          reviewRequired: true
        });
        if (matched.reviewRequired || !matched.item) continue;
        await rememberMapping(client, this.businessId, {
          discordItemName: stored.discord_item_name,
          discordItemLabel: stored.discord_item_label,
          itemName: matched.item,
          resolvedBy: "Archive reconciliation",
          webhookId: stored.webhook_id
        });
        await client.query(`
          UPDATE webhook_exceptions SET
            status = 'Resolved', resolved_item_name = $3, resolved_at = now(),
            resolved_by = 'Archive reconciliation',
            resolution_note = CASE WHEN resolution_note = ''
              THEN 'Matched to the current catalog without replaying imported history'
              ELSE resolution_note
            END,
            transaction_written = false
          WHERE business_id = $1 AND webhook_id = $2
        `, [this.businessId, stored.webhook_id, matched.item]);
        await client.query(`
          UPDATE webhook_events SET status = 'ignored', item_name = $3
          WHERE business_id = $1 AND webhook_id = $2
        `, [this.businessId, stored.webhook_id, matched.item]);
        repaired.push(stored.webhook_id);
      }
      return { ok: true, repaired };
    });
  }

  async handleGuiPayload(payload) {
    const action = String(payload?.action || "");
    if (action === "catalog_item") return this.createCatalogItem(payload.item || {});
    if (action === "catalog_item_update") return this.updateCatalogItem(payload.item || {});
    if (action === "recipe_upsert") return this.upsertRecipe(payload.recipe || {});
    if (action === "recipe_delete") return this.deleteRecipe(payload.recipe || {});
    if (action === "manual_operation") return this.recordManualOperation(payload.entry || {});
    if (action === "stock_target") return this.updateStockTarget(payload.target || {});
    if (action === "storage_target") return this.updateStorageTarget(payload.target || {});
    if (action === "time_clock") return this.recordTimeEntry(payload.entry || {});
    if (action === "resolve_exception") return this.resolveException(payload.exception || {});
    if (action === "ignore_exception") return this.ignoreException(payload.exception || {});
    throw storeError(`Unknown operation: ${action}`, 400, "unknown_operation");
  }

  async createCatalogItem(input) {
    const item = normalizeCatalogItem(input);
    return this.database.transaction(async client => {
      const created = await createCatalogItemRecord(client, this.businessId, item, {
        source: "Store Catalog",
        createdBy: cleanText(input.createdBy, 100)
      });
      return { ok: true, action: "catalog_item", item: created };
    });
  }

  async updateCatalogItem(input) {
    const item = normalizeCatalogItem(input);
    const id = cleanText(input.id, 120);
    if (!id) throw storeError("Choose a catalog good to update", 400, "catalog_item_id_required");
    return this.database.transaction(async client => {
      const existing = await client.query(`
        SELECT * FROM catalog_items WHERE business_id = $1 AND id = $2 FOR UPDATE
      `, [this.businessId, id]);
      if (!existing.rowCount) throw storeError("Catalog good not found", 404, "catalog_item_not_found");
      if (inventoryKey(existing.rows[0].name) !== inventoryKey(item.name)) {
        throw storeError("The catalog name cannot be changed after creation", 400, "catalog_item_name_locked");
      }
      const tagConflict = await client.query(`
        SELECT id FROM catalog_items
        WHERE business_id = $1 AND id <> $2 AND $3 <> '' AND lower(item_tag) = lower($3)
        LIMIT 1
      `, [this.businessId, id, item.tag]);
      if (tagConflict.rowCount) throw storeError("That game item tag already exists", 409, "catalog_item_conflict");
      const metadata = json(existing.rows[0].metadata, {});
      metadata.updatedBy = cleanText(input.updatedBy, 100);
      metadata.updatedFrom = "Catalog Ledger";
      const result = await client.query(`
        UPDATE catalog_items SET
          item_type = $3, label = $4, item_tag = $5, category = $6, unit_name = $7,
          unit_cost = $8, sale_price = $9, stock_target = $10, storage_target = $11, active = $12,
          metadata = $13::jsonb, updated_at = now()
        WHERE business_id = $1 AND id = $2
        RETURNING *
      `, [
        this.businessId, id, item.type, item.label, item.tag, item.category, item.unit,
        item.unitCost, item.salePrice, item.target, item.storageTarget, input.active !== false, JSON.stringify(metadata)
      ]);
      return { ok: true, action: "catalog_item_update", item: catalogRow(result.rows[0]) };
    });
  }

  async upsertRecipe(input) {
    const recipe = normalizeRecipe(input);
    return this.database.transaction(async client => {
      await requireCatalogItem(client, this.businessId, recipe.productName, "Recipe product");
      for (const ingredient of recipe.ingredients) {
        await requireCatalogItem(client, this.businessId, ingredient.name, "Recipe ingredient");
      }
      const existing = await client.query(`
        SELECT id FROM recipe_definitions
        WHERE business_id = $1 AND normalized_product_name = $2
        FOR UPDATE
      `, [this.businessId, inventoryKey(recipe.productName)]);
      const id = existing.rows[0]?.id || crypto.randomUUID();
      await client.query(`
        INSERT INTO recipe_definitions (
          business_id, id, product_name, normalized_product_name, output_quantity, active, updated_at
        ) VALUES ($1, $2, $3, $4, $5, true, now())
        ON CONFLICT (business_id, normalized_product_name) DO UPDATE SET
          product_name = EXCLUDED.product_name,
          output_quantity = EXCLUDED.output_quantity,
          active = true,
          updated_at = now()
      `, [this.businessId, id, recipe.productName, inventoryKey(recipe.productName), recipe.yield]);
      await client.query("DELETE FROM recipe_ingredients WHERE business_id = $1 AND recipe_id = $2", [this.businessId, id]);
      for (let index = 0; index < recipe.ingredients.length; index += 1) {
        const ingredient = recipe.ingredients[index];
        await client.query(`
          INSERT INTO recipe_ingredients (
            business_id, recipe_id, position, ingredient_name, normalized_ingredient_name, quantity, source_location
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [
          this.businessId, id, index, ingredient.name, inventoryKey(ingredient.name),
          ingredient.quantity, productionSourceType(ingredient.sourceLocation)
        ]);
      }
      return { ok: true, action: "recipe_upsert", recipe: { id, ...recipe } };
    });
  }

  async deleteRecipe(input) {
    const productName = cleanText(input.productName || input.name, 120);
    if (!productName) throw storeError("Choose a recipe to remove", 400, "recipe_product_required");
    const result = await this.database.query(`
      UPDATE recipe_definitions SET active = false, updated_at = now()
      WHERE business_id = $1 AND normalized_product_name = $2
      RETURNING id, product_name
    `, [this.businessId, inventoryKey(productName)]);
    if (!result.rowCount) throw storeError("Recipe not found", 404, "recipe_not_found");
    return { ok: true, action: "recipe_delete", recipe: { id: result.rows[0].id, productName: result.rows[0].product_name } };
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
    if (kind === "Cash Transfer In" || kind === "Cash Transfer Out") {
      await cashEvent(kind === "Cash Transfer In" ? total : -total);
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
      WHERE business_id = $1 AND item_type IN ('product', 'both')
        AND (normalized_name = $2 OR lower(label) = $2 OR lower(item_tag) = $2)
      RETURNING name
    `, [this.businessId, inventoryKey(itemName), Math.max(0, number(target.target))]);
    if (!result.rowCount) throw storeError(`Product not found: ${itemName}`, 404, "product_not_found");
    return { ok: true, action: "stock_target", itemName: result.rows[0].name };
  }

  async updateStorageTarget(target) {
    const itemName = cleanText(target.itemName || target.itemLabel, 150);
    requireItem(itemName);
    const result = await this.database.query(`
      UPDATE catalog_items SET storage_target = $3, updated_at = now()
      WHERE business_id = $1 AND active = true
        AND (normalized_name = $2 OR lower(label) = $2 OR lower(item_tag) = $2)
      RETURNING name
    `, [this.businessId, inventoryKey(itemName), Math.max(0, number(target.target))]);
    if (!result.rowCount) throw storeError(`Catalog good not found: ${itemName}`, 404, "catalog_item_not_found");
    return { ok: true, action: "storage_target", itemName: result.rows[0].name };
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
      event = await applyStoredMapping(client, this.businessId, event);
      event = await resolveAgainstCatalog(client, this.businessId, event);
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
      if (applied.stockDiscrepancy) {
        const reviewReason = "stock_count_mismatch";
        await insertException(client, this.businessId, {
          ...event,
          reviewReason,
          discordTitle: event.discordTitle || `${event.item} count discrepancy`,
          discordItemName: event.discordItemName || event.item,
          discordItemLabel: event.discordItemLabel || event.item
        }, {
          ...payload,
          app_inventory_total: applied.appInventoryTotal,
          reported_item_total: applied.reportedItemTotal,
          stock_variance: applied.stockVariance,
          transaction_already_written: true
        }, { transactionWritten: true });
        return {
          ok: true,
          webhookId: event.webhookId,
          transactionWritten: true,
          reviewRequired: true,
          reviewReason,
          ...applied
        };
      }
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
      const packageQuantity = number(correction.quantity);
      if (!(packageQuantity > 0)) throw storeError("Resolving an exception requires a positive quantity", 400, "invalid_quantity");
      const quantityMultiplier = correction.quantityMultiplier === undefined
        ? 1
        : number(correction.quantityMultiplier);
      if (quantityMultiplier < 1 || quantityMultiplier > 1000000) {
        throw storeError("Units per crate must be between 1 and 1,000,000", 400, "invalid_quantity_multiplier");
      }
      const quantity = packageQuantity * quantityMultiplier;
      let itemName = cleanText(correction.itemName, 150);
      let catalogItemCreated = false;
      let createdCatalogItem = null;
      const requestedCatalogItem = correction.newItem?.enabled
        ? correction.newItem
        : correction.newProduct?.enabled
          ? { ...correction.newProduct, type: "product", salePrice: correction.newProduct.price }
          : null;
      if (requestedCatalogItem) {
        const catalogItem = normalizeCatalogItem(requestedCatalogItem);
        createdCatalogItem = await createCatalogItemRecord(client, this.businessId, catalogItem, {
          source: "Webhook Review",
          createdBy: cleanText(correction.resolvedBy, 100) || "Manager"
        });
        itemName = createdCatalogItem.name;
        catalogItemCreated = true;
      }
      requireItem(itemName);
      const payload = json(stored.payload, {});
      const historyPreserved = payload.importedFromArchive === true;
      const transactionAlreadyWritten = Boolean(stored.transaction_written);
      const packageUnitPrice = correction.unitPrice === "" || correction.unitPrice === undefined
        ? number(stored.proposed_unit_price)
        : number(correction.unitPrice);
      const reportedItemTotal = nullableNumber(firstValue(payload, ["current_item_total", "current_stock", "stock_total"]));
      const event = normalizeWebhook({
        ...payload,
        webhook_id: webhookId,
        event_type: correction.eventType || stored.proposed_event_type,
        direction: correction.direction || stored.proposed_direction,
        item_name: itemName,
        quantity,
        unit_price: packageUnitPrice / quantityMultiplier,
        current_item_total: reportedItemTotal === null ? null : reportedItemTotal * quantityMultiplier,
        occurred_at: stored.occurred_at,
        actor: stored.actor_name,
        order_id: stored.order_id,
        review_required: false,
        review_reason: ""
      });
      event.packageQuantity = packageQuantity;
      event.quantityMultiplier = quantityMultiplier;
      event.packageUnitPrice = packageUnitPrice;
      const applied = historyPreserved || transactionAlreadyWritten
        ? { stockControlWritten: false, ledgerControlWritten: false }
        : await applyWebhookEvent(client, this.businessId, event, { applyLedger: false });
      const resolvedBy = cleanText(correction.resolvedBy, 100) || "Manager";
      if (correction.rememberMapping !== false) {
        await rememberMapping(client, this.businessId, {
          discordItemName: stored.discord_item_name,
          discordItemLabel: stored.discord_item_label,
          itemName,
          quantityMultiplier,
          resolvedBy,
          webhookId
        });
      }
      await client.query(`
        UPDATE webhook_exceptions SET
          status = 'Resolved', resolved_item_name = $3, resolved_at = now(), resolved_by = $4,
          resolution_note = $5, transaction_written = $6
        WHERE business_id = $1 AND webhook_id = $2
      `, [
        this.businessId,
        webhookId,
        itemName,
        resolvedBy,
        cleanText(correction.note, 2500),
        transactionAlreadyWritten || !historyPreserved
      ]);
      await client.query(`
        UPDATE webhook_events SET status = $3, item_name = $4, quantity = $5, unit_price = $6
        WHERE business_id = $1 AND webhook_id = $2
      `, [this.businessId, webhookId, historyPreserved ? "ignored" : "applied", itemName, quantity, event.unitPrice]);
      return {
        ok: true, action: "resolve_exception", webhookId, status: "Resolved", itemName,
        packageQuantity,
        quantityMultiplier,
        quantity,
        catalogItemCreated,
        catalogItem: createdCatalogItem,
        productCreated: catalogItemCreated && isSellableCatalogItem(createdCatalogItem),
        transactionWritten: transactionAlreadyWritten || !historyPreserved,
        transactionAlreadyWritten,
        historyPreserved,
        ...applied
      };
    });
  }

  async ignoreException(correction) {
    const webhookId = cleanText(correction.webhookId, 150);
    return this.database.transaction(async client => {
      const result = await client.query(`
        UPDATE webhook_exceptions SET
          status = 'Ignored', resolved_at = now(), resolved_by = $3, resolution_note = $4
        WHERE business_id = $1 AND webhook_id = $2 AND status = 'Open'
        RETURNING webhook_id, transaction_written
      `, [this.businessId, webhookId, cleanText(correction.resolvedBy, 100) || "Manager", cleanText(correction.note, 2500)]);
      if (!result.rowCount) {
        const existing = await client.query(`
          SELECT status FROM webhook_exceptions WHERE business_id = $1 AND webhook_id = $2
        `, [this.businessId, webhookId]);
        if (!existing.rowCount) throw storeError("Webhook exception not found", 404, "exception_not_found");
        return { ok: true, duplicate: true, action: "ignore_exception", webhookId, status: existing.rows[0].status };
      }
      const transactionWritten = Boolean(result.rows[0].transaction_written);
      await client.query(`
        UPDATE webhook_events SET status = $3 WHERE business_id = $1 AND webhook_id = $2
      `, [this.businessId, webhookId, transactionWritten ? "applied" : "ignored"]);
      return { ok: true, action: "ignore_exception", webhookId, status: "Ignored", transactionWritten };
    });
  }
}

async function upsertCatalogItem(client, businessId, item) {
  await client.query(`
    INSERT INTO catalog_items (
      business_id, id, item_type, name, normalized_name, label, item_tag, category,
      unit_name, unit_cost, sale_price, stock_target, storage_target, active, aliases, metadata, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16::jsonb, now())
    ON CONFLICT (business_id, normalized_name) DO UPDATE SET
      item_type = EXCLUDED.item_type,
      name = EXCLUDED.name,
      label = EXCLUDED.label,
      item_tag = EXCLUDED.item_tag,
      category = EXCLUDED.category,
      unit_name = EXCLUDED.unit_name,
      unit_cost = EXCLUDED.unit_cost,
      sale_price = CASE
        WHEN catalog_items.sale_price > 0 THEN catalog_items.sale_price
        ELSE EXCLUDED.sale_price
      END,
      stock_target = CASE
        WHEN catalog_items.stock_target > 0 THEN catalog_items.stock_target
        ELSE EXCLUDED.stock_target
      END,
      storage_target = CASE
        WHEN catalog_items.storage_target > 0 THEN catalog_items.storage_target
        ELSE EXCLUDED.storage_target
      END,
      active = EXCLUDED.active,
      aliases = EXCLUDED.aliases,
      metadata = EXCLUDED.metadata,
      updated_at = now()
  `, [
    businessId, item.id || crypto.randomUUID(), item.type, item.name, inventoryKey(item.name),
    item.label || item.name, item.tag || "", item.category || (item.type === "material" ? "Materials" : "Products"),
    item.unit || "unit", number(item.unitCost), number(item.salePrice), number(item.target), number(item.storageTarget), item.active !== false,
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

async function insertException(client, businessId, event, payload, { transactionWritten = false } = {}) {
  await client.query(`
    INSERT INTO webhook_exceptions (
      business_id, webhook_id, status, reason, discord_title, discord_item_name, discord_item_label,
      proposed_event_type, proposed_direction, proposed_quantity, proposed_unit_price,
      ledger_balance, current_item_total, original_payload, transaction_written
    ) VALUES ($1, $2, 'Open', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14)
  `, [
    businessId, event.webhookId, event.reviewReason, event.discordTitle, event.discordItemName,
    event.discordItemLabel, event.type, event.direction, event.quantity, event.unitPrice,
    event.ledgerBalance, event.currentItemTotal, JSON.stringify(payload), transactionWritten
  ]);
}

async function applyWebhookEvent(client, businessId, event, { applyLedger }) {
  const inventoryLocation = event.location === "storage" ? "storage" : "sales";
  const metadata = {
    webhookId: event.webhookId,
    orderId: event.orderId,
    listingItemTotal: event.currentItemTotal,
    discordChannelType: event.channelType,
    location: event.location,
    packageQuantity: event.packageQuantity || event.quantity,
    quantityMultiplier: event.quantityMultiplier || 1,
    packageUnitPrice: event.packageUnitPrice ?? event.unitPrice
  };
  const quantityDelta = event.type === "Sale" || event.direction === "Stock Out"
    ? -event.quantity
    : event.quantity;
  if (event.item && event.quantity > 0) {
    // Discord reports a price-listing total, while the app aggregates stock by product.
    await insertInventory(client, businessId, {
      eventId: `${event.webhookId}:stock`, occurredAt: event.occurredAt, source: "Discord", kind: event.type,
      location: inventoryLocation, item: event.item,
      quantityDelta,
      absoluteQuantity: null,
      unitPrice: event.unitPrice, actor: event.actor, metadata
    });
    if (inventoryLocation === "sales" && event.type === "Stocking Movement" && event.direction === "Stock In" && event.unitPrice > 0) {
      await client.query(`
        UPDATE catalog_items
        SET sale_price = $3, updated_at = now()
        WHERE business_id = $1 AND normalized_name = $2
      `, [businessId, inventoryKey(event.item), event.unitPrice]);
    }
  }
  const appInventoryTotal = event.item && event.quantity > 0
    ? await currentInventoryQuantity(client, businessId, inventoryLocation, event.item)
    : null;
  const stockVariance = appInventoryTotal === null || event.currentItemTotal === null
    ? null
    : appInventoryTotal - event.currentItemTotal;
  const stockDiscrepancy = stockVariance !== null && Math.abs(stockVariance) > 0.0005;
  if (applyLedger) {
    const derivedCash = event.location === "sales"
      ? event.type === "Sale"
        ? event.quantity * event.unitPrice
        : event.type === "Purchase" ? -(event.quantity * event.unitPrice) : 0
      : 0;
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
  if (event.location === "sales" && (event.type === "Sale" || event.type === "Purchase") && total > 0) {
    await insertFinance(client, businessId, {
      eventId: `${event.webhookId}:finance`, occurredAt: event.occurredAt,
      type: event.type === "Sale" ? "Revenue" : "Expense",
      category: event.type === "Sale" ? "Storefront Sales" : "Storefront Purchases",
      label: event.item, source: "Discord", direction: event.type === "Sale" ? "Cash In" : "Cash Out",
      amount: total, metadata: { ...metadata, quantity: event.quantity, unitPrice: event.unitPrice }
    });
  }
  return {
    stockControlWritten: false,
    listingTotalObserved: event.currentItemTotal !== null,
    reportedItemTotal: event.currentItemTotal,
    appInventoryTotal,
    stockVariance,
    stockDiscrepancy,
    ledgerControlWritten: applyLedger && event.ledgerBalance !== null
  };
}

async function currentInventoryQuantity(client, businessId, location, item) {
  const normalizedItem = inventoryKey(item);
  const result = await client.query(`
    SELECT location_type, normalized_item_name, item_name, absolute_quantity, quantity_delta, occurred_at
    FROM inventory_events
    WHERE business_id = $1 AND location_type = $2 AND normalized_item_name = $3
    ORDER BY occurred_at, recorded_at, event_id
  `, [businessId, location, normalizedItem]);
  const count = reduceInventory(result.rows).get(`${location}:${normalizedItem}`);
  return Math.max(0, number(count?.quantity));
}

async function applyStoredMapping(client, businessId, event) {
  if (!event.discordItemName && !event.discordItemLabel) return event;
  const result = await client.query(`
    SELECT canonical_item_name, quantity_multiplier FROM item_mappings
    WHERE business_id = $1 AND (
      ($2 <> '' AND lower(discord_item_name) = $2) OR
      ($3 <> '' AND lower(discord_item_label) = $3 AND (discord_item_name = '' OR $2 = ''))
    )
    ORDER BY CASE WHEN $2 <> '' AND lower(discord_item_name) = $2 THEN 0 ELSE 1 END, created_at DESC
    LIMIT 1
  `, [businessId, inventoryKey(event.discordItemName), inventoryKey(event.discordItemLabel)]);
  if (!result.rowCount) return event;
  const quantityMultiplier = Math.max(1, number(result.rows[0].quantity_multiplier) || 1);
  const packageQuantity = event.quantity;
  const packageUnitPrice = event.unitPrice;
  const reasons = event.reviewReason.split(",").filter(reason => reason && reason !== "unknown_item" && reason !== "missing_item");
  return {
    ...event,
    item: result.rows[0].canonical_item_name,
    packageQuantity,
    quantityMultiplier,
    packageUnitPrice,
    quantity: packageQuantity * quantityMultiplier,
    unitPrice: packageUnitPrice / quantityMultiplier,
    currentItemTotal: event.currentItemTotal === null ? null : event.currentItemTotal * quantityMultiplier,
    reviewReason: reasons.join(","),
    reviewRequired: reasons.length > 0
  };
}

async function resolveAgainstCatalog(client, businessId, event) {
  const result = await client.query(`
    SELECT name, normalized_name, label, item_tag, aliases
    FROM catalog_items
    WHERE business_id = $1 AND active = true
  `, [businessId]);
  const wanted = new Set(
    [event.item, event.discordItemName, event.discordItemLabel].map(inventoryKey).filter(Boolean)
  );
  const match = result.rows.find(row => [
    row.name,
    row.normalized_name,
    row.label,
    row.item_tag,
    ...json(row.aliases, [])
  ].some(value => wanted.has(inventoryKey(value))));
  let reasons = event.reviewReason.split(",").filter(Boolean);
  if (match) {
    reasons = reasons.filter(reason => reason !== "missing_item");
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
      ($3 <> '' AND lower(discord_item_label) = $3 AND (discord_item_name = '' OR $2 = ''))
    ) LIMIT 1
  `, [businessId, inventoryKey(mapping.discordItemName), inventoryKey(mapping.discordItemLabel)]);
  const id = existing.rows[0]?.id || crypto.randomUUID();
  await client.query(`
    INSERT INTO item_mappings (
      business_id, id, discord_item_name, discord_item_label, canonical_item_name,
      quantity_multiplier, created_by, source_webhook_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (business_id, id) DO UPDATE SET
      discord_item_name = EXCLUDED.discord_item_name,
      discord_item_label = EXCLUDED.discord_item_label,
      canonical_item_name = EXCLUDED.canonical_item_name,
      quantity_multiplier = EXCLUDED.quantity_multiplier,
      created_by = EXCLUDED.created_by,
      source_webhook_id = EXCLUDED.source_webhook_id,
      created_at = now()
  `, [
    businessId, id, mapping.discordItemName || "", mapping.discordItemLabel || "", mapping.itemName,
    Math.max(1, number(mapping.quantityMultiplier) || 1), mapping.resolvedBy || "", mapping.webhookId || ""
  ]);
}

async function createCatalogItemRecord(client, businessId, input, { source, createdBy = "" }) {
  const conflict = await client.query(`
    SELECT name, label, item_tag FROM catalog_items
    WHERE business_id = $1 AND (
      normalized_name = $2 OR lower(label) = $3 OR ($4 <> '' AND lower(item_tag) = $4)
    )
    LIMIT 1
  `, [businessId, inventoryKey(input.name), inventoryKey(input.label), inventoryKey(input.tag)]);
  if (conflict.rowCount) {
    throw storeError(
      `A catalog good already uses ${conflict.rows[0].label || conflict.rows[0].name}`,
      409,
      "catalog_item_conflict"
    );
  }
  const metadata = {
    source,
    createdBy
  };
  if (isSellableCatalogItem({ itemType: input.type }) && input.salePrice > 0) {
    metadata.msrpLow = input.salePrice;
    metadata.msrpHigh = input.salePrice;
    metadata.pricingSource = source;
  }
  try {
    const result = await client.query(`
      INSERT INTO catalog_items (
        business_id, id, item_type, name, normalized_name, label, item_tag, category,
        unit_name, unit_cost, sale_price, stock_target, storage_target, active, aliases, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, true, '[]'::jsonb, $14::jsonb)
      RETURNING *
    `, [
      businessId,
      crypto.randomUUID(),
      input.type,
      input.name,
      inventoryKey(input.name),
      input.label,
      input.tag,
      input.category,
      input.unit,
      input.unitCost,
      input.salePrice,
      input.target,
      input.storageTarget,
      JSON.stringify(metadata)
    ]);
    return catalogRow(result.rows[0]);
  } catch (error) {
    if (error.code === "23505") {
      throw storeError("That catalog name or game item tag already exists", 409, "catalog_item_conflict");
    }
    throw error;
  }
}

function normalizeWebhook(payload) {
  const reviewRequested = payload?.review_required === true || String(payload?.review_required || "").toLowerCase() === "true";
  const suppliedReviewReason = cleanText(firstValue(payload, ["review_reason"]), 300);
  const channelType = cleanText(firstValue(payload, ["discord_channel_type", "channel_type"]), 50) || "storefront";
  const rawType = firstValue(payload, ["event_type", "type", "action", "event"]);
  const type = normalizeType(rawType);
  const direction = normalizeDirection(firstValue(payload, ["direction", "movement", "stock_direction"]), type);
  const item = cleanText(firstValue(payload, reviewRequested
    ? ["proposed_item_name", "item_name", "item", "name", "product", "product_name"]
    : ["item_name", "item", "name", "product", "product_name"]), 150);
  const quantity = number(firstValue(payload, reviewRequested
    ? ["proposed_quantity", "qty", "quantity", "count", "amount"]
    : ["qty", "quantity", "count", "amount"]));
  const discordItemName = cleanText(firstValue(payload, ["discord_item_name"]), 200);
  const discordItemLabel = cleanText(firstValue(payload, ["discord_item_label"]), 200);
  const ledgerBalance = nullableNumber(firstValue(payload, ["shop_ledger", "ledger_balance", "current_ledger"]));
  let reasons = suppliedReviewReason.split(",").map(value => value.trim()).filter(Boolean);
  if (!item && !discordItemName && !discordItemLabel && !reasons.includes("missing_item")) reasons.push("missing_item");
  if (!(quantity > 0) && !reasons.includes("missing_quantity")) reasons.push("missing_quantity");
  const hasItemIdentity = Boolean(item || discordItemName || discordItemLabel);
  const ledgerOnly = channelType === "storage-ledger" && ledgerBalance !== null && !hasItemIdentity;
  if (ledgerOnly) {
    reasons = reasons.filter(reason => reason !== "missing_item" && reason !== "missing_quantity");
  }
  const location = channelType === "storage-ledger"
    ? hasItemIdentity ? "storage" : "ledger"
    : "sales";
  return {
    webhookId: cleanText(firstValue(payload, ["webhook_id", "id", "event_id", "discord_message_id", "order_id", "buy_order_id", "receipt_id"]), 150) || crypto.randomUUID(),
    type,
    direction,
    item,
    quantity,
    unitPrice: Math.max(0, number(firstValue(payload, ["unit_price", "price", "sale_price", "buy_price"]))),
    currentItemTotal: nullableNumber(firstValue(payload, ["current_item_total", "current_stock", "stock_total"])),
    ledgerBalance,
    occurredAt: validDate(firstValue(payload, ["timestamp", "occurred_at", "created_at"])),
    actor: cleanText(firstValue(payload, ["actor", "customer", "buyer", "seller", "player"]), 150),
    orderId: cleanText(firstValue(payload, ["order_id", "buy_order_id", "receipt_id", "transaction_id"]), 150),
    discordTitle: cleanText(firstValue(payload, ["discord_title", "title"]), 200),
    discordItemName,
    discordItemLabel,
    channelType,
    location,
    reviewRequired: reasons.length > 0 || (reviewRequested && !suppliedReviewReason && !ledgerOnly),
    reviewReason: reasons.join(",")
  };
}

function legacyFundAuditEntries(audit) {
  const descriptors = {
    "Owner Capital Deposit": "ownerCapitalDeposits",
    "Owner Withdrawal": "ownerWithdrawals",
    "Safekeeping Deposit": "safekeepingDeposits",
    "Safekeeping Withdrawal": "safekeepingWithdrawals"
  };
  return (Array.isArray(audit) ? audit : []).flatMap((event, index) => {
    if (String(event?.action || "") !== "finance.funds_recorded") return [];
    const details = json(event?.details, {});
    const balanceKey = descriptors[String(details.kind || "")];
    const amount = Math.abs(number(details.amount));
    if (!balanceKey || !(amount > 0)) return [];
    return [{
      id: cleanText(event?.id, 100) || `legacy-fund-${index}`,
      occurredAt: validDate(event?.createdAt),
      balanceKey,
      amount,
      note: cleanText(details.note, 500)
    }];
  });
}

function fundBalanceDescriptor(balanceKey) {
  return {
    ownerCapitalDeposits: { type: "Owner Capital", category: "Owner Funds", label: "Owner Capital", direction: "Cash In" },
    ownerWithdrawals: { type: "Owner Capital", category: "Owner Funds", label: "Owner Capital", direction: "Cash Out" },
    safekeepingDeposits: { type: "Safekeeping", category: "Safekeeping", label: "Safekeeping Funds", direction: "Cash In" },
    safekeepingWithdrawals: { type: "Safekeeping", category: "Safekeeping", label: "Safekeeping Funds", direction: "Cash Out" }
  }[balanceKey] || null;
}

function normalizeCatalogItem(input) {
  const requestedType = inventoryKey(input?.type || input?.itemType);
  const type = requestedType === "material" ? "material" : requestedType === "both" ? "both" : "product";
  const sellable = isSellableCatalogItem({ itemType: type });
  const name = cleanText(input?.name, 120);
  const label = cleanText(input?.label, 120) || name;
  if (!name || !label) {
    throw storeError("A catalog good requires a name and display label", 400, "invalid_catalog_item");
  }
  return {
    type,
    name,
    label,
    tag: cleanText(input?.tag || input?.itemTag, 150),
    category: cleanText(input?.category, 120)
      || (type === "material" ? "Materials" : type === "both" ? "Products and Materials" : "Products"),
    unit: cleanText(input?.unit || input?.unitName, 50) || "unit",
    unitCost: catalogNumber(input?.unitCost, "Unit cost"),
    salePrice: sellable ? catalogNumber(input?.salePrice ?? input?.price, "Sale price") : 0,
    target: sellable ? catalogNumber(input?.target ?? input?.stockTarget, "Stock target") : 0,
    storageTarget: catalogNumber(input?.storageTarget, "Storage target")
  };
}

function normalizeRecipe(input) {
  const productName = cleanText(input?.productName || input?.name, 120);
  const outputQuantity = Number(input?.yield ?? input?.outputQuantity);
  if (!productName) throw storeError("Choose the product made by this recipe", 400, "recipe_product_required");
  if (!Number.isFinite(outputQuantity) || outputQuantity <= 0) {
    throw storeError("Recipe yield must be greater than zero", 400, "invalid_recipe_yield");
  }
  const ingredients = (Array.isArray(input?.ingredients) ? input.ingredients : []).slice(0, 50).map(raw => ({
    name: cleanText(raw?.name || raw?.ingredient || raw?.[0], 120),
    quantity: Number(raw?.quantity ?? raw?.[1]),
    sourceLocation: displayProductionSource(raw?.sourceLocation ?? raw?.[2])
  }));
  if (!ingredients.length || ingredients.some(ingredient => !ingredient.name || !Number.isFinite(ingredient.quantity) || ingredient.quantity <= 0)) {
    throw storeError("Every recipe ingredient needs a good and a quantity greater than zero", 400, "invalid_recipe_ingredient");
  }
  const keys = ingredients.map(ingredient => inventoryKey(ingredient.name));
  if (new Set(keys).size !== keys.length) {
    throw storeError("Each good can only appear once in a recipe", 400, "duplicate_recipe_ingredient");
  }
  return { productName, yield: outputQuantity, ingredients };
}

async function requireCatalogItem(client, businessId, itemName, label) {
  const result = await client.query(`
    SELECT 1 FROM catalog_items
    WHERE business_id = $1 AND normalized_name = $2 AND active = true
  `, [businessId, inventoryKey(itemName)]);
  if (!result.rowCount) throw storeError(`${label} is not an active catalog good`, 400, "recipe_catalog_item_required");
}

function productionSourceType(value) {
  return inventoryKey(value).includes("store") || inventoryKey(value) === "sales" ? "sales" : "storage";
}

function displayProductionSource(value) {
  return productionSourceType(value) === "sales" ? "Storefront" : "Storage";
}

function isSellableCatalogItem(item) {
  return item?.itemType === "product" || item?.itemType === "both";
}

function isMaterialCatalogItem(item) {
  return item?.itemType === "material" || item?.itemType === "both";
}

function catalogNumber(value, label) {
  if (value === "" || value === null || value === undefined) return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw storeError(`${label} must be zero or greater`, 400, "invalid_catalog_item");
  }
  return parsed;
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
    storageTarget: number(row.storage_target),
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
    actorName: row.actor_name || cleanText(payload.actor, 150),
    eventType: row.proposed_event_type,
    direction: row.proposed_direction,
    quantity: number(row.proposed_quantity),
    unitPrice: number(row.proposed_unit_price),
    ledgerBalance: nullableNumber(row.ledger_balance),
    currentItemTotal: nullableNumber(row.current_item_total),
    appInventoryTotal: nullableNumber(payload.app_inventory_total),
    stockVariance: nullableNumber(payload.stock_variance),
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
