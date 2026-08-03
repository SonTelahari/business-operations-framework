const assert = require("node:assert/strict");
const { newDb } = require("pg-mem");
const {
  archiveSummary,
  createLegacyBusinessArchive,
  validateBusinessArchive
} = require("./business-archive");
const { Database } = require("./database");
const { exportLegacyBusiness } = require("./legacy-export-client");
const { TenantManager } = require("./tenant-manager");

async function run() {
  const fixture = legacyFixture();
  const requested = [];
  const archive = await exportLegacyBusiness({
    appUrl: "https://legacy.example.test",
    fullName: "William Winther",
    password: "not-exported-password",
    business: { name: "Frontier Firearms", location: "Van Horn", referenceId: "23" },
    materialCosts: { Softwood: { midpoint: 1.5 }, Iron: { midpoint: 2 } },
    fetchImpl: async (url, options = {}) => {
      requested.push({ url, cookie: options.headers?.cookie || "" });
      if (url.endsWith("/api/auth/login")) {
        return jsonResponse({ ok: true }, 200, { "set-cookie": "ff_session=signed-session; Path=/; HttpOnly" });
      }
      assert.equal(options.headers.cookie, "ff_session=signed-session");
      const path = new URL(url).pathname;
      const payloads = {
        "/api/bootstrap": fixture.bootstrap,
        "/api/suppliers": { ok: true, suppliers: fixture.suppliers },
        "/api/supply-orders": { ok: true, orders: fixture.supplyOrders },
        "/api/admin/users": { ok: true, users: fixture.users },
        "/api/admin/audit": { ok: true, events: fixture.audit },
        "/api/finance": fixture.finance
      };
      return jsonResponse(payloads[path]);
    }
  });

  assert.equal(requested.length, 7);
  assert.equal(archive.business.configuration.business.name, "Frontier Firearms");
  assert.equal(archive.business.configuration.catalog.products.length, 1);
  assert.equal(archive.business.configuration.catalog.materials.find(item => item.name === "Softwood").unitCost, 1.5);
  assert.deepEqual(
    archive.business.configuration.catalog.recipes[0].ingredients,
    [{ name: "Iron", quantity: 2 }, { name: "Softwood", quantity: 2 }]
  );
  assert.deepEqual(
    archive.business.configuration.catalog.recipes.find(recipe => recipe.productName === "Fabric").ingredients,
    [{ name: "Flax", quantity: 2 }]
  );
  assert.equal(Object.prototype.hasOwnProperty.call(archive.accounts.users[0], "password"), false);
  assert.equal(archive.coverage.rawTimeEntries, false);
  assert.equal(archiveSummary(archive).ledgerAvailable, true);

  const tampered = structuredClone(archive);
  tampered.business.configuration.business.name = "Changed after export";
  assert.throws(
    () => validateBusinessArchive(tampered),
    error => error.code === "archive_fingerprint_mismatch"
  );

  const memory = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const adapter = memory.adapters.createPg();
  const database = new Database({ pool: new adapter.Pool() });
  try {
    await database.initialize();
    const tenants = new TenantManager({
      database,
      sessionSecret: "archive-test-session-secret-with-more-than-32-characters"
    });
    const result = await tenants.createWorkspaceFromArchive({
      archive,
      owner: { fullName: "William Winther", password: "new-owner-password-123" }
    });
    assert.equal(result.business.name, "Frontier Firearms");
    assert.equal(result.migration.businessDocuments.suppliers, 1);
    assert.equal(result.migration.businessDocuments.supplyOrders, 1);
    assert.equal(result.migration.accounts.staffReferences, 1);
    assert.equal(result.context.accountStore.listUsers().length, 1);
    assert.equal(result.context.accountStore.listUsers()[0].fullName, "William Winther");
    assert(result.context.accountStore.listAudit(1000).some(event => event.action === "migration.legacy_staff_reference"));
    assert.equal(result.context.businessStore.listSuppliers()[0].name, "Van Horn Smithy");
    assert.equal(result.context.businessStore.listSalesOrders()[0].customer, "Arthur Morgan");
    assert.equal(result.context.businessStore.listProductionBatches()[0].reference, "Restock Navy");
    const snapshot = await result.context.standaloneStore.snapshot();
    assert.equal(snapshot.inventory.products[0].currentStock, 5);
    assert.equal(snapshot.inventory.materials.find(row => row.ingredient === "Iron").storageCount, 40);
    assert.equal(snapshot.inventory.ledger.balance, 1094.25);
    assert.equal(snapshot.reviewExceptions[0].webhookId, "review-1");
    const finance = await result.context.standaloneStore.finance();
    assert.equal(finance.totals.revenue, 105);
    await assert.rejects(
      tenants.createWorkspaceFromArchive({
        archive,
        owner: { fullName: "Second Owner", password: "second-owner-password-123" }
      }),
      error => error.code === "archive_already_imported"
    );

    const invalidArchive = createLegacyBusinessArchive({
      ...fixture,
      bootstrap: fixture.bootstrap,
      suppliers: [{ id: "bad-supplier", name: "" }],
      source: { url: "https://legacy.example.test" },
      business: { name: "Broken Import" }
    });
    await assert.rejects(
      tenants.createWorkspaceFromArchive({
        archive: invalidArchive,
        owner: { fullName: "Broken Owner", password: "broken-owner-password-123" }
      }),
      error => error.code === "supplier_name_required"
    );
    const businesses = await database.query("SELECT status FROM businesses");
    assert.equal(businesses.rowCount, 1);
    assert.equal(businesses.rows[0].status, "active");
  } finally {
    await database.close();
  }

  console.log("Business archive export, validation, import, and rollback tests passed.");
}

function legacyFixture() {
  const at = "2026-08-01T12:00:00.000Z";
  const bootstrap = {
    ok: true,
    generatedAt: at,
    items: [{
      name: "Navy Revolver",
      label: "Revolver Navy",
      tag: "WEAPON_REVOLVER_NAVY",
      category: "Revolvers",
      price: 105,
      target: 10,
      active: true
    }],
    recipes: {
      "Navy Revolver": [["Iron", 2], ["Wood", 2]],
      Fabric: [["Flax", 2]]
    },
    recipeYields: { "Navy Revolver": 1, Fabric: 1 },
    salesOrders: [{
      id: "SO-1",
      customer: "Arthur Morgan",
      status: "Draft",
      lines: [{ name: "Navy Revolver", quantity: 1, unitPrice: 105 }],
      createdAt: at,
      updatedAt: at
    }],
    storefrontBuyOrders: [{
      id: "BO-1",
      itemName: "Iron",
      itemLabel: "Iron",
      quantity: 100,
      filledQuantity: 25,
      manualFilledQuantity: 25,
      unitPrice: 1,
      status: "Active",
      postedAt: at
    }],
    productionBatches: [{
      id: "PB-1",
      status: "In Progress",
      sourceType: "Storefront Restock",
      reference: "Restock Navy",
      createdAt: at,
      updatedAt: at,
      lines: [{
        id: "PBL-1",
        itemName: "Navy Revolver",
        requestedQuantity: 2,
        recipeYield: 1,
        completedCrafts: 1,
        recipe: [{ ingredient: "Iron", quantity: 2 }, { ingredient: "Softwood", quantity: 2 }]
      }]
    }],
    dailyCloses: [{
      id: "DC-1",
      businessDate: "2026-08-01",
      status: "Finalized",
      storefrontConfirmed: true,
      storageConfirmed: true,
      snapshot: { capturedAt: at, storefrontUnits: 5, storageUnits: 60, ledgerBalance: 1094.25 },
      createdAt: at,
      updatedAt: at,
      finalizedAt: at
    }],
    sheet: {
      ok: true,
      schemaVersion: 8,
      generatedAt: at,
      inventory: {
        products: [{ itemName: "Navy Revolver", itemLabel: "Revolver Navy", currentStock: 5, target: 10, salePrice: 105 }],
        materials: [
          { ingredient: "Iron", storageCount: 40 },
          { ingredient: "Softwood", storageCount: 20 },
          { ingredient: "Flax", storageCount: 20 },
          { ingredient: "Fabric", storageCount: 5 }
        ],
        storage: [
          { ingredient: "Iron", storageCount: 40 },
          { ingredient: "Softwood", storageCount: 20 },
          { ingredient: "Flax", storageCount: 20 },
          { ingredient: "Fabric", storageCount: 5 }
        ],
        ledger: { balance: 1094.25, countedAt: at }
      },
      reviewExceptions: [{
        webhookId: "review-1",
        status: "Open",
        reason: "unknown_item",
        receivedAt: at,
        discordTitle: "Deposit",
        discordItemName: "WEAPON_REVOLVER_UNKNOWN",
        discordItemLabel: "Unknown Revolver",
        eventType: "Stocking Movement",
        direction: "Stock In",
        quantity: 1,
        unitPrice: 90,
        rawText: "Item label: Unknown Revolver"
      }]
    }
  };
  return {
    bootstrap,
    suppliers: [{
      id: "SUP-1",
      name: "Van Horn Smithy",
      category: "Blacksmith",
      location: "Van Horn",
      products: [{ id: "SP-1", name: "Iron", unitPrice: 2 }],
      employees: [],
      createdAt: at,
      updatedAt: at
    }],
    supplyOrders: [{
      id: "PO-1",
      producer: "Van Horn Smithy",
      status: "Partially Received",
      lines: [{ id: "POL-1", name: "Iron", quantity: 50, unitPrice: 2, receivedQuantity: 10 }],
      createdAt: at,
      updatedAt: at
    }],
    users: [{
      id: "legacy-user-1",
      fullName: "Legacy Employee",
      role: "employee",
      status: "active",
      password: { hash: "must-not-export" },
      createdAt: at
    }],
    audit: [{
      id: "audit-1",
      createdAt: at,
      category: "stock",
      action: "stock.counted",
      actorName: "Legacy Employee",
      details: { quantity: 5, token: "must-not-export" }
    }],
    finance: {
      ok: true,
      generatedAt: at,
      totals: { revenue: 105, expenses: 20, profit: 85 },
      balances: {
        ownerCapitalDeposits: 500,
        ownerWithdrawals: 0,
        safekeepingDeposits: 0,
        safekeepingWithdrawals: 0
      },
      breakdown: [{ type: "Revenue", category: "Storefront Sales", label: "Navy Revolver", source: "Discord", amount: 105, count: 1 }]
    }
  };
}

function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
