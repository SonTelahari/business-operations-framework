const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const port = 4283;
const receiverPort = 4282;
const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "still-water-auth-"));
const receiverPayloads = [];
const receiverOperationIds = new Set();
const storageCounts = new Map([["iron", 12]]);
const buyOrderPurchases = [];
const reviewExceptions = [{
  webhookId: "review-1",
  status: "Open",
  reason: "unknown_item",
  receivedAt: "2026-07-13T03:25:00.000Z",
  discordTitle: "Bought Item",
  discordItemName: "",
  discordItemLabel: "Custom Navy",
  eventType: "Sale",
  direction: "Stock Out",
  quantity: 1,
  unitPrice: 105,
  rawText: "Item label: Custom Navy"
}, {
  webhookId: "review-native-1",
  status: "Open",
  reason: "unknown_item",
  receivedAt: "2026-07-13T03:26:00.000Z",
  discordTitle: "Deposit",
  discordItemName: "WEAPON_REVOLVER_HIGHROLLER",
  discordItemLabel: "High Roller Revolver",
  eventType: "Stocking Movement",
  direction: "Stock In",
  quantity: 1,
  unitPrice: 135,
  rawText: "Item name: WEAPON_REVOLVER_HIGHROLLER"
}];
const inventoryProducts = [
  {
    itemName: "Navy Revolver",
    itemLabel: "Navy Revolver",
    itemTag: "WEAPON_REVOLVER_NAVY",
    category: "Revolvers",
    salePrice: 105,
    target: 5,
    currentStock: 1,
    active: true
  },
  {
    itemName: "Boltaction Rifle",
    itemLabel: "BoltAction Rifle",
    itemTag: "WEAPON_RIFLE_BOLTACTION",
    category: "Rifles",
    salePrice: 80,
    target: 5,
    currentStock: 3,
    active: true
  }
];
let failNextReceiverWrite = false;
let failReceiverAfterSuccessfulWrites = -1;
const mockReceiver = http.createServer(async (request, response) => {
  if (request.method === "GET") {
    const action = new URL(request.url, `http://127.0.0.1:${receiverPort}`).searchParams.get("action");
    if (action === "finance") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        ok: true,
        generatedAt: "2026-07-13T03:30:00.000Z",
        from: "2026-07-01",
        to: "2026-07-31",
        totals: { revenue: 300, expenses: 125, profit: 175 },
        balances: {
          ownerCapitalDeposits: 500,
          ownerWithdrawals: 50,
          ownerCapital: 450,
          safekeepingDeposits: 200,
          safekeepingWithdrawals: 25,
          safekeeping: 175
        },
        coverage: {
          transactionsScanned: 9,
          storefrontSales: 3,
          storefrontPurchases: 2,
          manualMovementsScanned: 4,
          manualEntries: 2,
          ownerFundEntries: 1,
          safekeepingEntries: 1,
          payrollPayments: 1
        },
        ledger: { balance: 6025 },
        breakdown: [
          { type: "Revenue", category: "Storefront Sales", label: "Navy Revolver", source: "Discord", amount: 300, count: 3 },
          { type: "Expense", category: "Payroll", label: "Employee Payroll", source: "Cash", amount: 125, count: 1 }
        ],
        monthly: [{ month: "2026-07", revenue: 300, expenses: 125, profit: 175 }]
      }));
      return;
    }
    const productOnlyStorageKeys = new Set(["navy revolver", "boltaction rifle"]);
    const materials = [...storageCounts.entries()].filter(([key]) => !productOnlyStorageKeys.has(key)).map(([key, storageCount]) => ({
      ingredient: key === "softwood" ? "Softwood" : key.replace(/^./, character => character.toUpperCase()),
      storageCount
    }));
    const storageRows = new Map(storageCounts);
    if (!storageRows.has("navy revolver")) storageRows.set("navy revolver", 2);
    const storage = [...storageRows.entries()].map(([key, storageCount]) => ({
      ingredient: key === "softwood" ? "Softwood" : key.replace(/^./, character => character.toUpperCase()),
      storageCount
    }));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      ok: true,
      schemaVersion: 8,
      generatedAt: "2026-07-13T03:30:00.000Z",
      sheets: [{ name: "Products", lastRow: 3 }],
      reviewExceptions,
      inventory: {
        products: inventoryProducts,
        materials,
        storage,
        ledger: {
          balance: 6025,
          countedBalance: 6000,
          countedAt: "2026-07-13T03:00:00.000Z",
          netMovementSinceCount: 25,
          lastActivityAt: "2026-07-13T03:25:00.000Z"
        },
        buyOrderPurchases
      }
    }));
    return;
  }
  const payload = await readRequestJson(request);
  receiverPayloads.push(payload);
  if (failNextReceiverWrite) {
    failNextReceiverWrite = false;
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false, error: "Simulated Sheet failure" }));
    return;
  }
  if (failReceiverAfterSuccessfulWrites === 0) {
    failReceiverAfterSuccessfulWrites = -1;
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false, error: "Simulated partial production failure" }));
    return;
  }
  if (failReceiverAfterSuccessfulWrites > 0) failReceiverAfterSuccessfulWrites -= 1;
  const entry = payload.entry;
  if (payload.action === "resolve_exception") {
    const exception = reviewExceptions.find(candidate => candidate.webhookId === payload.exception?.webhookId);
    if (exception) {
      exception.status = "Resolved";
      exception.resolvedItem = payload.exception.itemName;
      exception.resolvedBy = payload.exception.resolvedBy;
    }
    if (payload.exception?.newProduct?.enabled) {
      const product = payload.exception.newProduct;
      inventoryProducts.push({
        itemName: product.name,
        itemLabel: product.label,
        itemTag: product.tag,
        category: product.category,
        salePrice: product.price,
        target: 0,
        currentStock: Number(payload.exception.quantity || 0),
        active: true,
        msrpLow: product.price,
        msrpHigh: product.price,
        pricingSource: "Webhook Review"
      });
    }
  }
  if (payload.action === "ignore_exception") {
    const exception = reviewExceptions.find(candidate => candidate.webhookId === payload.exception?.webhookId);
    if (exception) exception.status = "Ignored";
  }
  if (payload.action === "manual_operation" && entry && !receiverOperationIds.has(entry.id)) {
    if (entry.kind === "Stock Count" && entry.location === "Storage") {
      storageCounts.set(mockInventoryKey(entry.itemName || entry.itemLabel), Number(entry.quantity || 0));
    }
    if (entry.kind === "Production Use" && entry.location === "Storage") {
      const key = mockInventoryKey(entry.itemName || entry.itemLabel);
      storageCounts.set(key, Number(storageCounts.get(key) || 0) - Number(entry.quantity || 0));
    }
    if (entry.kind === "Production Use" && entry.location === "Storefront") {
      const key = mockInventoryKey(entry.itemName || entry.itemLabel);
      const product = inventoryProducts.find(candidate => mockInventoryKey(candidate.itemName || candidate.itemLabel) === key);
      if (product) product.currentStock = Number(product.currentStock || 0) - Number(entry.quantity || 0);
    }
    if (entry.kind === "Correction Out" && entry.location === "Storage") {
      const key = mockInventoryKey(entry.itemName || entry.itemLabel);
      storageCounts.set(key, Number(storageCounts.get(key) || 0) - Number(entry.quantity || 0));
    }
    if (entry.kind === "Correction Out" && entry.location === "Storefront") {
      const key = mockInventoryKey(entry.itemName || entry.itemLabel);
      const product = inventoryProducts.find(candidate => mockInventoryKey(candidate.itemName || candidate.itemLabel) === key);
      if (product) product.currentStock = Number(product.currentStock || 0) - Number(entry.quantity || 0);
    }
    if ((entry.kind === "Correction In" || entry.kind === "Production Output") && entry.location === "Storage") {
      const key = mockInventoryKey(entry.itemName || entry.itemLabel);
      storageCounts.set(key, Number(storageCounts.get(key) || 0) + Number(entry.quantity || 0));
    }
    receiverOperationIds.add(entry.id);
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ ok: true }));
});
mockReceiver.listen(receiverPort, "127.0.0.1");
const server = spawn(process.execPath, [path.join(__dirname, "server.js")], {
  env: {
    ...process.env,
    PORT: String(port),
    APPS_SCRIPT_URL: `http://127.0.0.1:${receiverPort}/exec`,
    APP_AUTH_USER: "",
    APP_AUTH_PASSWORD: "",
    AUTH_DATA_DIR: dataDirectory,
    AUTH_SESSION_SECRET: "test-session-secret-with-enough-entropy-123456789",
    ADMIN_FULL_NAME: "Frontier Owner",
    ADMIN_PASSWORD: "OwnerPassword123!",
    NODE_ENV: "test"
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let stderr = "";
server.stderr.on("data", chunk => { stderr += chunk; });

run().catch(error => {
  console.error(error.stack || error.message);
  if (stderr) console.error(stderr);
  process.exitCode = 1;
}).finally(async () => {
  server.kill();
  mockReceiver.close();
  await fs.promises.rm(dataDirectory, { recursive: true, force: true });
});

async function run() {
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForServer(`${baseUrl}/health`);

  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(
    await health.json().then(result => [
      result.authMode,
      result.persistentAccountStore,
      result.supplyReceipts,
      result.productionBatches,
      result.sharedSalesOrders,
      result.dailyCloses,
      result.financeReporting,
      result.productInsights
    ]),
    ["accounts", true, true, true, true, true, true, true]
  );

  const firstLaunch = await post(`${baseUrl}/api/setup/complete`, {
    owner: { fullName: "Frontier Owner", password: "OwnerPassword123!" },
    configuration: {
      business: {
        name: "Frontier Firearms",
        ledgerName: "Still Water Ledger",
        location: "Van Horn",
        currency: "USD",
        locale: "en-US",
        timezone: "America/New_York"
      },
      locations: [
        { name: "Storefront", type: "sales" },
        { name: "Storage", type: "storage" }
      ],
      catalog: {
        materials: [
          { name: "Iron", unitCost: 0.25 },
          { name: "Softwood", unitCost: 0.2 },
          { name: "Revolver Handle", unitCost: 1 },
          { name: "Revolver Barrel", unitCost: 1 },
          { name: "Revolver Cylinder", unitCost: 1 },
          { name: "Bolts", unitCost: 0.05 }
        ],
        products: [
          { name: "Navy Revolver", label: "Navy Revolver", tag: "WEAPON_REVOLVER_NAVY", category: "Revolvers", salePrice: 105, target: 5 },
          { name: "Boltaction Rifle", label: "BoltAction Rifle", tag: "WEAPON_RIFLE_BOLTACTION", category: "Rifles", salePrice: 80, target: 5 }
        ],
        recipes: [{
          productName: "Navy Revolver",
          yield: 1,
          ingredients: [
            { name: "Iron", quantity: 2 },
            { name: "Softwood", quantity: 2 },
            { name: "Revolver Handle", quantity: 1 },
            { name: "Revolver Barrel", quantity: 1 },
            { name: "Revolver Cylinder", quantity: 1 },
            { name: "Bolts", quantity: 2 }
          ]
        }]
      }
    }
  });
  assert.equal(firstLaunch.response.status, 201);

  const loginPage = await fetch(`${baseUrl}/login.html`);
  assert.equal(loginPage.status, 200);
  const loginPageHtml = await loginPage.text();
  assert.match(loginPageHtml, /Request Access/);
  assert.match(loginPageHtml, /In-game Character Name/);
  assert.match(loginPageHtml, /No real-life name or personal information is requested/);

  const unauthenticatedPage = await fetch(baseUrl, { redirect: "manual" });
  assert.equal(unauthenticatedPage.status, 302);
  assert.equal(unauthenticatedPage.headers.get("location"), "/login.html");

  const unauthenticatedApi = await fetch(`${baseUrl}/api/bootstrap`);
  assert.equal(unauthenticatedApi.status, 401);

  const legacyIntegrationRoute = await getJson(`${baseUrl}/api/integrations/discord/snapshot`);
  assert.equal(legacyIntegrationRoute.response.status, 503);
  assert.equal(legacyIntegrationRoute.body.code, "database_required");

  const ownerLogin = await post(`${baseUrl}/api/auth/login`, {
    fullName: "Frontier Owner",
    password: "OwnerPassword123!"
  });
  assert.equal(ownerLogin.response.status, 200);
  assert.equal(ownerLogin.body.user.role, "admin");
  const ownerCookie = cookieFrom(ownerLogin.response);

  const authenticatedPage = await fetch(baseUrl, { headers: { cookie: ownerCookie } });
  assert.equal(authenticatedPage.status, 200);
  const authenticatedHtml = await authenticatedPage.text();
  assert.match(authenticatedHtml, /Employee Accounts/);
  assert.match(authenticatedHtml, /Employee Audit/);
  assert.match(authenticatedHtml, /Supplier Directory/);
  assert.match(authenticatedHtml, /Store Overview/);
  assert.match(authenticatedHtml, /Exceptions Inbox/);
  assert.match(authenticatedHtml, /Production Queue/);
  assert.match(authenticatedHtml, /Daily Close and Handoff/);
  assert.match(authenticatedHtml, /Profit and Loss/);
  assert.match(authenticatedHtml, /Record Capital or Safekeeping/);
  assert.match(authenticatedHtml, /Reconcile All History/);

  const inventoryResolver = await fetch(`${baseUrl}/inventory-counts.js`, { headers: { cookie: ownerCookie } });
  assert.equal(inventoryResolver.status, 200);
  assert.match(await inventoryResolver.text(), /selectLatestCounts/);

  const accountStoreLeak = await fetch(`${baseUrl}/.data/users.json`, { headers: { cookie: ownerCookie } });
  assert.equal(accountStoreLeak.status, 404);
  const serverSourceLeak = await fetch(`${baseUrl}/server.js`, { headers: { cookie: ownerCookie } });
  assert.equal(serverSourceLeak.status, 404);

  const bootstrap = await getJson(`${baseUrl}/api/bootstrap`, ownerCookie);
  assert.equal(bootstrap.response.status, 200);
  assert.equal(bootstrap.body.sheet.inventory.products[0].currentStock, 1);
  assert.equal(bootstrap.body.sheet.inventory.products[1].target, 5);
  assert.equal(bootstrap.body.sheet.inventory.materials[0].storageCount, 12);
  assert.equal(bootstrap.body.sheet.inventory.storage[1].storageCount, 2);
  assert.equal(bootstrap.body.sheet.inventory.ledger.balance, 6025);
  assert.equal(bootstrap.body.sheet.reviewExceptions[0].webhookId, "review-1");
  assert.deepEqual(bootstrap.body.productionBatches, []);
  assert.deepEqual(bootstrap.body.salesOrders, []);
  assert.deepEqual(bootstrap.body.dailyCloses, []);

  const registration = await post(`${baseUrl}/api/auth/register`, {
    fullName: "Ada Employee",
    password: "EmployeePassword123!"
  });
  assert.equal(registration.response.status, 201);
  assert.equal(registration.body.user.status, "pending");

  const duplicate = await post(`${baseUrl}/api/auth/register`, {
    fullName: "  ADA   EMPLOYEE ",
    password: "AnotherPassword123!"
  });
  assert.equal(duplicate.response.status, 409);

  const pendingLogin = await post(`${baseUrl}/api/auth/login`, {
    fullName: "Ada Employee",
    password: "EmployeePassword123!"
  });
  assert.equal(pendingLogin.response.status, 403);
  assert.equal(pendingLogin.body.code, "approval_pending");

  const usersBeforeApproval = await getJson(`${baseUrl}/api/admin/users`, ownerCookie);
  const pendingUser = usersBeforeApproval.body.users.find(user => user.fullName === "Ada Employee");
  assert.equal(pendingUser.status, "pending");

  const approval = await post(`${baseUrl}/api/admin/users/${pendingUser.id}/approve`, {}, ownerCookie);
  assert.equal(approval.response.status, 200);
  assert.equal(approval.body.user.status, "active");

  const employeeLogin = await post(`${baseUrl}/api/auth/login`, {
    fullName: "Ada Employee",
    password: "EmployeePassword123!"
  });
  assert.equal(employeeLogin.response.status, 200);
  const employeeCookie = cookieFrom(employeeLogin.response);

  const employeeSession = await getJson(`${baseUrl}/api/auth/session`, employeeCookie);
  assert.equal(employeeSession.body.user.fullName, "Ada Employee");
  assert.equal(employeeSession.body.user.accountManagement, true);
  const employeeProductInsight = await getJson(`${baseUrl}/api/product-insights/Navy%20Revolver`, employeeCookie);
  assert.equal(employeeProductInsight.response.status, 403);
  assert.equal(employeeProductInsight.body.code, "manager_required");

  const createdSalesOrder = await post(`${baseUrl}/api/sales-orders`, {
    id: "sales-order-1",
    customer: "Arthur Morgan",
    handler: "Ada Employee",
    status: "Draft",
    priority: "Normal",
    deliveryDate: "2026-07-15",
    deposit: 20,
    label: "The Frontier's Finest Firearms",
    notes: "Shared counter order",
    lines: [{
      id: "sales-line-navy",
      name: "Navy Revolver",
      label: "Navy Revolver",
      category: "Revolvers",
      quantity: 2,
      unitPrice: 105
    }]
  }, employeeCookie);
  assert.equal(createdSalesOrder.response.status, 200);
  assert.equal(createdSalesOrder.body.order.revision, 1);
  assert.equal(createdSalesOrder.body.order.updatedBy, "Ada Employee");
  assert.equal(createdSalesOrder.body.order.lines[0].quantity, 2);

  const ownerSalesOrders = await getJson(`${baseUrl}/api/sales-orders`, ownerCookie);
  assert.equal(ownerSalesOrders.response.status, 200);
  assert.equal(ownerSalesOrders.body.orders[0].customer, "Arthur Morgan");

  const updatedSalesOrder = await post(`${baseUrl}/api/sales-orders`, {
    ...createdSalesOrder.body.order,
    status: "Reserved",
    deposit: 50
  }, employeeCookie);
  assert.equal(updatedSalesOrder.response.status, 200);
  assert.equal(updatedSalesOrder.body.order.revision, 2);
  assert.equal(updatedSalesOrder.body.order.status, "Reserved");

  const staleSalesOrder = await post(`${baseUrl}/api/sales-orders`, {
    ...createdSalesOrder.body.order,
    notes: "Stale overwrite attempt"
  }, ownerCookie);
  assert.equal(staleSalesOrder.response.status, 409);
  assert.equal(staleSalesOrder.body.code, "sales_order_conflict");

  const importedSalesOrders = await post(`${baseUrl}/api/sales-orders/import`, {
    orders: [
      createdSalesOrder.body.order,
      {
        id: "legacy-sales-order",
        customer: "Legacy Customer",
        status: "Paused",
        lines: [{ name: "Varmint Rifle", label: "Varmint Rifle", quantity: 1, unitPrice: 45 }]
      }
    ]
  }, employeeCookie);
  assert.equal(importedSalesOrders.response.status, 200);
  assert.equal(importedSalesOrders.body.imported, 1);
  assert.equal(importedSalesOrders.body.skipped, 1);

  const removedImportedSalesOrder = await remove(`${baseUrl}/api/sales-orders/legacy-sales-order`, employeeCookie);
  assert.equal(removedImportedSalesOrder.response.status, 403);
  assert.equal(removedImportedSalesOrder.body.code, "manager_required");
  const managerRemovedImportedSalesOrder = await remove(`${baseUrl}/api/sales-orders/legacy-sales-order`, ownerCookie);
  assert.equal(managerRemovedImportedSalesOrder.response.status, 200);
  assert.equal(managerRemovedImportedSalesOrder.body.orders.length, 1);

  const employeeAdminAttempt = await getJson(`${baseUrl}/api/admin/users`, employeeCookie);
  assert.equal(employeeAdminAttempt.response.status, 403);
  const employeeAuditAttempt = await getJson(`${baseUrl}/api/admin/audit`, employeeCookie);
  assert.equal(employeeAuditAttempt.response.status, 403);
  const employeeSupplyAttempt = await getJson(`${baseUrl}/api/supply-orders`, employeeCookie);
  assert.equal(employeeSupplyAttempt.response.status, 403);
  const employeeBuyOrderAttempt = await getJson(`${baseUrl}/api/storefront-buy-orders`, employeeCookie);
  assert.equal(employeeBuyOrderAttempt.response.status, 403);
  const employeeFinanceAttempt = await getJson(`${baseUrl}/api/finance`, employeeCookie);
  assert.equal(employeeFinanceAttempt.response.status, 403);
  const ownerNavigationUpdate = await put(`${baseUrl}/api/admin/business-profile`, {
    navigation: { sections: { review: false, finance: true } }
  }, ownerCookie);
  assert.equal(ownerNavigationUpdate.response.status, 200);
  assert.equal(ownerNavigationUpdate.body.navigation.sections.review, false);
  assert.equal(ownerNavigationUpdate.body.navigation.sections.finance, true);
  assert.equal(ownerNavigationUpdate.body.navigation.sections.store, true);
  const employeeBusinessProfileAttempt = await put(`${baseUrl}/api/admin/business-profile`, {
    business: { name: "Unauthorized Rename" }
  }, employeeCookie);
  assert.equal(employeeBusinessProfileAttempt.response.status, 403);
  assert.equal(employeeBusinessProfileAttempt.body.code, "admin_required");
  const employeeSupplierAttempt = await getJson(`${baseUrl}/api/suppliers`, employeeCookie);
  assert.equal(employeeSupplierAttempt.response.status, 403);
  const employeeDailyCloseAttempt = await getJson(`${baseUrl}/api/daily-closes`, employeeCookie);
  assert.equal(employeeDailyCloseAttempt.response.status, 403);
  const employeeBootstrap = await getJson(`${baseUrl}/api/bootstrap`, employeeCookie);
  assert.equal(employeeBootstrap.body.navigation.sections.review, false);
  assert.equal(employeeBootstrap.body.navigation.sections.store, true);
  assert.equal(Object.prototype.hasOwnProperty.call(employeeBootstrap.body.sheet, "reviewExceptions"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(employeeBootstrap.body.sheet.inventory, "ledger"), false);
  const employeeReviewAttempt = await post(`${baseUrl}/api/sync`, {
    action: "resolve_exception",
    exception: { webhookId: "review-1", itemName: "Navy Revolver", quantity: 1 }
  }, employeeCookie);
  assert.equal(employeeReviewAttempt.response.status, 403);

  const sheetHealth = await getJson(`${baseUrl}/health/sheet`);
  assert.equal(sheetHealth.response.status, 200);
  assert.equal(sheetHealth.body.ok, true);
  assert.equal(sheetHealth.body.ledgerAvailable, true);
  assert.deepEqual(
    sheetHealth.body.inventoryFields.sort(),
    ["buyOrderPurchases", "ledger", "materials", "products", "storage"].sort()
  );

  const protectedSync = await post(`${baseUrl}/api/sync`, {
    action: "stock_target",
    target: { itemName: "Navy Revolver", target: 2 }
  }, employeeCookie);
  assert.equal(protectedSync.response.status, 403);
  const protectedStorageTarget = await post(`${baseUrl}/api/sync`, {
    action: "storage_target",
    target: { itemName: "Iron", target: 20 }
  }, employeeCookie);
  assert.equal(protectedStorageTarget.response.status, 403);

  const employeeOperationAttempt = await post(`${baseUrl}/api/sync`, {
    action: "manual_operation",
    entry: { id: "employee-count", kind: "Stock Count", itemLabel: "Iron", quantity: 10 }
  }, employeeCookie);
  assert.equal(employeeOperationAttempt.response.status, 403);

  const promoted = await post(`${baseUrl}/api/admin/users/${pendingUser.id}/promote`, {}, ownerCookie);
  assert.equal(promoted.response.status, 200);
  assert.equal(promoted.body.user.role, "manager");
  const invalidatedEmployeeSession = await getJson(`${baseUrl}/api/auth/session`, employeeCookie);
  assert.equal(invalidatedEmployeeSession.body.user, null);

  const managerLogin = await post(`${baseUrl}/api/auth/login`, {
    fullName: "Ada Employee",
    password: "EmployeePassword123!"
  });
  assert.equal(managerLogin.response.status, 200);
  assert.equal(managerLogin.body.user.role, "manager");
  const managerCookie = cookieFrom(managerLogin.response);

  const managerUsers = await getJson(`${baseUrl}/api/admin/users`, managerCookie);
  assert.equal(managerUsers.response.status, 200);
  const managerFinanceAttempt = await getJson(`${baseUrl}/api/finance`, managerCookie);
  assert.equal(managerFinanceAttempt.response.status, 403);
  assert.equal(managerFinanceAttempt.body.code, "admin_required");
  const managerBusinessProfileAttempt = await put(`${baseUrl}/api/admin/business-profile`, {
    business: { name: "Manager Rename" }
  }, managerCookie);
  assert.equal(managerBusinessProfileAttempt.response.status, 403);
  assert.equal(managerBusinessProfileAttempt.body.code, "admin_required");
  const managerProductInsight = await getJson(`${baseUrl}/api/product-insights/Navy%20Revolver`, managerCookie);
  assert.equal(managerProductInsight.response.status, 200);
  assert.equal(managerProductInsight.body.item.name, "Navy Revolver");
  assert.equal(managerProductInsight.body.sales.revenue, 300);
  assert.equal(managerProductInsight.body.sales.transactions, 3);
  assert.equal(managerProductInsight.body.sales.averageTransaction, 100);
  assert.equal(managerProductInsight.body.sales.channels[0].category, "Storefront Sales");
  const missingProductInsight = await getJson(`${baseUrl}/api/product-insights/Unknown%20Product`, managerCookie);
  assert.equal(missingProductInsight.response.status, 404);
  assert.equal(missingProductInsight.body.code, "product_not_found");

  const createdDailyClose = await post(`${baseUrl}/api/daily-closes`, {
    id: "daily-close-2026-07-13",
    businessDate: "2026-07-13",
    storefrontConfirmed: false,
    storageConfirmed: true,
    countedLedgerBalance: 6020,
    discrepancyNotes: "Five dollars held for change.",
    priorityNotes: "Finish the Morgan order.",
    handoffNotes: "Foundry delivery is expected next shift."
  }, managerCookie);
  assert.equal(createdDailyClose.response.status, 200);
  assert.equal(createdDailyClose.body.close.revision, 1);
  assert.equal(createdDailyClose.body.close.snapshot.storefrontUnits, 4);
  assert.equal(createdDailyClose.body.close.snapshot.storageUnits, 14);
  assert.equal(createdDailyClose.body.close.snapshot.ledgerBalance, 6025);
  assert.equal(createdDailyClose.body.close.snapshot.openSalesOrders, 1);

  const incompleteFinalization = await post(
    `${baseUrl}/api/daily-closes/daily-close-2026-07-13/finalize`,
    { revision: 1 },
    managerCookie
  );
  assert.equal(incompleteFinalization.response.status, 409);
  assert.equal(incompleteFinalization.body.code, "inventory_confirmation_required");

  const updatedDailyClose = await post(`${baseUrl}/api/daily-closes`, {
    ...createdDailyClose.body.close,
    storefrontConfirmed: true,
    discrepancyNotes: ""
  }, managerCookie);
  assert.equal(updatedDailyClose.response.status, 200);
  assert.equal(updatedDailyClose.body.close.revision, 2);

  const unexplainedFinalization = await post(
    `${baseUrl}/api/daily-closes/daily-close-2026-07-13/finalize`,
    { revision: updatedDailyClose.body.close.revision },
    managerCookie
  );
  assert.equal(unexplainedFinalization.response.status, 409);
  assert.equal(unexplainedFinalization.body.code, "discrepancy_note_required");

  const notedDailyClose = await post(`${baseUrl}/api/daily-closes`, {
    ...updatedDailyClose.body.close,
    discrepancyNotes: "Five dollars held for change."
  }, managerCookie);
  assert.equal(notedDailyClose.response.status, 200);
  assert.equal(notedDailyClose.body.close.revision, 3);

  const staleDailyClose = await post(`${baseUrl}/api/daily-closes`, {
    ...createdDailyClose.body.close,
    handoffNotes: "Stale handoff overwrite"
  }, managerCookie);
  assert.equal(staleDailyClose.response.status, 409);
  assert.equal(staleDailyClose.body.code, "daily_close_conflict");

  const finalizedDailyClose = await post(
    `${baseUrl}/api/daily-closes/daily-close-2026-07-13/finalize`,
    { revision: notedDailyClose.body.close.revision },
    managerCookie
  );
  assert.equal(finalizedDailyClose.response.status, 200);
  assert.equal(finalizedDailyClose.body.close.status, "Finalized");
  assert.equal(finalizedDailyClose.body.close.revision, 4);
  assert.equal(finalizedDailyClose.body.close.finalizedBy, "Ada Employee");

  const editFinalizedDailyClose = await post(`${baseUrl}/api/daily-closes`, {
    ...finalizedDailyClose.body.close,
    handoffNotes: "Editing a signed record"
  }, managerCookie);
  assert.equal(editFinalizedDailyClose.response.status, 409);
  assert.equal(editFinalizedDailyClose.body.code, "daily_close_finalized");

  const managerReopenDailyClose = await post(
    `${baseUrl}/api/daily-closes/daily-close-2026-07-13/reopen`,
    {},
    managerCookie
  );
  assert.equal(managerReopenDailyClose.response.status, 403);
  const reopenedDailyClose = await post(
    `${baseUrl}/api/daily-closes/daily-close-2026-07-13/reopen`,
    {},
    ownerCookie
  );
  assert.equal(reopenedDailyClose.response.status, 200);
  assert.equal(reopenedDailyClose.body.close.status, "Draft");
  assert.equal(reopenedDailyClose.body.close.revision, 5);

  const resavedDailyClose = await post(`${baseUrl}/api/daily-closes`, {
    ...reopenedDailyClose.body.close,
    handoffNotes: "Foundry delivery is expected next shift. Rechecked by the owner."
  }, managerCookie);
  const refinalizedDailyClose = await post(
    `${baseUrl}/api/daily-closes/daily-close-2026-07-13/finalize`,
    { revision: resavedDailyClose.body.close.revision },
    managerCookie
  );
  assert.equal(refinalizedDailyClose.response.status, 200);
  assert.equal(refinalizedDailyClose.body.close.status, "Finalized");

  const duplicateDailyClose = await post(`${baseUrl}/api/daily-closes`, {
    id: "duplicate-daily-close",
    businessDate: "2026-07-13"
  }, managerCookie);
  assert.equal(duplicateDailyClose.response.status, 409);
  assert.equal(duplicateDailyClose.body.code, "daily_close_date_exists");

  const emptySuppliers = await getJson(`${baseUrl}/api/suppliers`, managerCookie);
  assert.equal(emptySuppliers.response.status, 200);
  assert.deepEqual(emptySuppliers.body.suppliers, []);
  const savedSupplier = await post(`${baseUrl}/api/suppliers`, {
    id: "supplier-foundry",
    name: "Van Horn Foundry",
    category: "Blacksmith",
    location: "Van Horn",
    businessTelegram: "SWB-VH22",
    ownerName: "Maeve Smith",
    ownerTelegram: "SW-221",
    employees: [
      { id: "contact-one", name: "Jon Bell", telegram: "SW-222" },
      { id: "contact-two", name: "Anna Bell", telegram: "SW-223" }
    ],
    products: [
      { id: "product-iron", name: "Iron", label: "Iron", unitPrice: 1.5 },
      { id: "product-rifle-barrel", name: "Rifle Barrel", label: "Rifle Barrel", unitPrice: 8 }
    ]
  }, managerCookie);
  assert.equal(savedSupplier.response.status, 200);
  assert.equal(savedSupplier.body.supplier.updatedBy, "Ada Employee");
  assert.equal(savedSupplier.body.supplier.employees.length, 2);
  assert.equal(savedSupplier.body.supplier.products[1].unitPrice, 8);
  const updatedSupplier = await post(`${baseUrl}/api/suppliers`, {
    ...savedSupplier.body.supplier,
    products: savedSupplier.body.supplier.products.map(product =>
      product.name === "Rifle Barrel" ? { ...product, unitPrice: 8.5 } : product
    )
  }, managerCookie);
  assert.equal(updatedSupplier.response.status, 200);
  assert.equal(updatedSupplier.body.supplier.products.find(product => product.name === "Rifle Barrel").unitPrice, 8.5);
  const ownerSuppliers = await getJson(`${baseUrl}/api/suppliers`, ownerCookie);
  assert.equal(ownerSuppliers.response.status, 200);
  assert.equal(ownerSuppliers.body.suppliers[0].businessTelegram, "SWB-VH22");
  const tooManyContacts = await post(`${baseUrl}/api/suppliers`, {
    id: "supplier-too-many",
    name: "Overstaffed Supplier",
    employees: Array.from({ length: 6 }, (_, index) => ({ name: `Contact ${index + 1}`, telegram: `SW-${index + 1}` }))
  }, managerCookie);
  assert.equal(tooManyContacts.response.status, 400);
  assert.equal(tooManyContacts.body.code, "supplier_employee_limit");
  const duplicateSupplier = await post(`${baseUrl}/api/suppliers`, {
    id: "supplier-duplicate",
    name: " van horn foundry "
  }, managerCookie);
  assert.equal(duplicateSupplier.response.status, 409);
  assert.equal(duplicateSupplier.body.code, "supplier_name_exists");

  const emptySupplyOrders = await getJson(`${baseUrl}/api/supply-orders`, managerCookie);
  assert.equal(emptySupplyOrders.response.status, 200);
  assert.deepEqual(emptySupplyOrders.body.orders, []);

  const emptyBuyOrders = await getJson(`${baseUrl}/api/storefront-buy-orders`, managerCookie);
  assert.equal(emptyBuyOrders.response.status, 200);
  assert.deepEqual(emptyBuyOrders.body.orders, []);
  const savedBuyOrder = await post(`${baseUrl}/api/storefront-buy-orders`, {
    id: "buy-order-nitrite",
    itemName: "Nitrite",
    itemLabel: "Nitrite",
    quantity: 10,
    unitPrice: 1,
    postedAt: "2026-07-13T03:00:00.000Z",
    status: "Active",
    notes: "Storefront posting"
  }, managerCookie);
  assert.equal(savedBuyOrder.response.status, 200);
  assert.equal(savedBuyOrder.body.order.filledQuantity, 0);
  const financeWithBuyOrder = await getJson(`${baseUrl}/api/finance?from=2026-07-01&to=2026-07-31`, ownerCookie);
  assert.equal(financeWithBuyOrder.response.status, 200);
  assert.deepEqual(financeWithBuyOrder.body.totals, { revenue: 300, expenses: 125, profit: 175 });
  assert.equal(financeWithBuyOrder.body.cash.ledgerBalance, 6025);
  assert.equal(financeWithBuyOrder.body.cash.safekeepingHeld, 175);
  assert.equal(financeWithBuyOrder.body.cash.businessCash, 5850);
  assert.equal(financeWithBuyOrder.body.commitments.storefrontBuyOrders, 10);
  assert.equal(financeWithBuyOrder.body.coverage.storefrontSales, 3);
  assert.equal(financeWithBuyOrder.body.coverage.supplierReceipts, 0);
  assert.equal(financeWithBuyOrder.body.coverage.buyOrdersReviewed, 1);
  assert(financeWithBuyOrder.body.commitments.missingStock >= 0);
  assert.equal(
    financeWithBuyOrder.body.commitments.missingProducts.find(product => product.label === "Navy Revolver").quantity,
    2,
    "finished guns in storage must offset the storefront shortage before material cash is reserved"
  );
  buyOrderPurchases.push({
    eventId: "buy-fill-1",
    occurredAt: "2026-07-13T04:00:00.000Z",
    itemName: "Nitrite",
    quantity: 4,
    unitPrice: 1
  });
  const partiallyFilledBuyOrders = await getJson(`${baseUrl}/api/storefront-buy-orders`, managerCookie);
  assert.equal(partiallyFilledBuyOrders.body.orders[0].filledQuantity, 4);
  assert.equal(partiallyFilledBuyOrders.body.orders[0].status, "Active");
  const repeatedBuyOrderRead = await getJson(`${baseUrl}/api/storefront-buy-orders`, managerCookie);
  assert.equal(repeatedBuyOrderRead.body.orders[0].filledQuantity, 4, "a webhook purchase must only fill once");
  const manualBuyOrderFill = await post(`${baseUrl}/api/storefront-buy-orders/buy-order-nitrite/fill`, {
    filledQuantity: 6
  }, managerCookie);
  assert.equal(manualBuyOrderFill.response.status, 200);
  assert.equal(manualBuyOrderFill.body.order.filledQuantity, 6);
  buyOrderPurchases.push({
    eventId: "buy-fill-2",
    occurredAt: "2026-07-13T05:00:00.000Z",
    itemName: "Nitrite",
    quantity: 4,
    unitPrice: 1
  });
  const completedBuyOrders = await getJson(`${baseUrl}/api/storefront-buy-orders`, managerCookie);
  assert.equal(completedBuyOrders.body.orders[0].filledQuantity, 10);
  assert.equal(completedBuyOrders.body.orders[0].status, "Filled");
  const filledBuyOrderRemoval = await remove(`${baseUrl}/api/storefront-buy-orders/buy-order-nitrite`, managerCookie);
  assert.equal(filledBuyOrderRemoval.response.status, 409);
  assert.equal(filledBuyOrderRemoval.body.code, "filled_order_locked");
  const activatedSupplyOrder = await post(`${baseUrl}/api/supply-orders`, {
    id: "supply-order-active",
    producer: "Blackwater Textiles",
    status: "Draft",
    notes: "Planning materials before placing the order",
    lines: []
  }, managerCookie);
  assert.equal(activatedSupplyOrder.response.status, 200);
  assert.equal(activatedSupplyOrder.body.order.status, "Active");
  assert.equal(activatedSupplyOrder.body.order.lines.length, 0);
  assert(activatedSupplyOrder.body.orders.some(order => order.id === "supply-order-active" && order.status === "Active"));
  const duplicateSupplyLine = await post(`${baseUrl}/api/supply-orders`, {
    id: "supply-order-duplicate-line",
    producer: "Van Horn Foundry",
    status: "Ordered",
    lines: [
      { id: "iron-line-one", name: "Iron", quantity: 5, unitPrice: 1.5 },
      { id: "iron-line-two", name: " iron ", quantity: 5, unitPrice: 1.5 }
    ]
  }, managerCookie);
  assert.equal(duplicateSupplyLine.response.status, 400);
  assert.equal(duplicateSupplyLine.body.code, "duplicate_supply_line");
  const savedSupplyOrder = await post(`${baseUrl}/api/supply-orders`, {
    id: "supply-order-1",
    producer: "Van Horn Foundry",
    status: "Ordered",
    expectedDate: "2026-07-15",
    requestedBy: "Spoofed Name",
    notes: "Collect at the works",
    lines: [{ id: "iron-line", name: "Iron", label: "Iron", quantity: 20, unitPrice: 1.5 }]
  }, managerCookie);
  assert.equal(savedSupplyOrder.response.status, 200);
  assert.equal(savedSupplyOrder.body.order.requestedBy, "Ada Employee");
  assert.equal(savedSupplyOrder.body.order.lines[0].quantity, 20);
  assert.equal(savedSupplyOrder.body.order.lines[0].receivedQuantity, 0);
  const sharedSupplyOrders = await getJson(`${baseUrl}/api/supply-orders`, ownerCookie);
  assert.equal(sharedSupplyOrders.body.orders[0].producer, "Van Horn Foundry");
  const financeWithSupplyOrder = await getJson(`${baseUrl}/api/finance`, ownerCookie);
  assert.equal(financeWithSupplyOrder.response.status, 200);
  assert.equal(financeWithSupplyOrder.body.commitments.supplyOrders, 30);
  assert.equal(financeWithSupplyOrder.body.commitments.storefrontBuyOrders, 0);
  assert.equal(
    financeWithSupplyOrder.body.cash.availableAfterCommitments,
    financeWithSupplyOrder.body.cash.businessCash - financeWithSupplyOrder.body.commitments.total
  );

  const partialReceipt = await post(`${baseUrl}/api/supply-orders/supply-order-1/receive`, {
    receipts: [{ lineId: "iron-line", quantity: 7 }]
  }, managerCookie);
  assert.equal(partialReceipt.response.status, 200);
  assert.equal(partialReceipt.body.order.status, "Partially Received");
  assert.equal(partialReceipt.body.order.lines[0].receivedQuantity, 7);
  assert.equal(partialReceipt.body.order.lines[0].receipts.length, 1);
  assert.equal(partialReceipt.body.order.lines[0].receipts[0].quantity, 7);
  assert.equal(partialReceipt.body.order.lines[0].receipts[0].unitPrice, 1.5);
  assert.equal(storageCounts.get("iron"), 19);
  assert.equal(partialReceipt.body.receipts[0].storageCount, 19);
  assert.equal(receiverPayloads.at(-1).entry.kind, "Stock Count");
  assert.equal(receiverPayloads.at(-1).entry.location, "Storage");
  assert.equal(receiverPayloads.at(-1).entry.quantity, 19);

  const ownerPartialView = await getJson(`${baseUrl}/api/supply-orders`, ownerCookie);
  assert.equal(ownerPartialView.body.orders[0].status, "Partially Received");
  const completeReceipt = await post(`${baseUrl}/api/supply-orders/supply-order-1/receive`, {
    receipts: [{ lineId: "iron-line", quantity: 13 }]
  }, managerCookie);
  assert.equal(completeReceipt.response.status, 200);
  assert.equal(completeReceipt.body.order.status, "Received");
  assert.equal(completeReceipt.body.order.lines[0].receivedQuantity, 20);
  assert.equal(completeReceipt.body.order.lines[0].receipts.length, 2);
  assert.equal(storageCounts.get("iron"), 32);
  const financeAfterSupplyReceipts = await getJson(`${baseUrl}/api/finance?from=2026-07-01&to=2099-12-31`, ownerCookie);
  assert.deepEqual(financeAfterSupplyReceipts.body.totals, { revenue: 300, expenses: 157, profit: 143 });
  assert.equal(financeAfterSupplyReceipts.body.coverage.supplierReceipts, 2);
  assert.equal(financeAfterSupplyReceipts.body.coverage.supplierReceiptExpenses, 30);
  assert.equal(financeAfterSupplyReceipts.body.coverage.manualBuyOrderUnits, 2);
  assert.equal(financeAfterSupplyReceipts.body.coverage.manualBuyOrderExpenses, 2);
  assert(financeAfterSupplyReceipts.body.breakdown.some(row =>
    row.category === "Supplier Purchases" && row.label === "Iron" && row.amount === 30 && row.count === 2
  ));

  const writesBeforeRepeat = receiverPayloads.length;
  const repeatedReceipt = await post(`${baseUrl}/api/supply-orders/supply-order-1/receive`, {
    receipts: [{ lineId: "iron-line", quantity: 1 }]
  }, managerCookie);
  assert.equal(repeatedReceipt.response.status, 409);
  assert.equal(repeatedReceipt.body.code, "order_not_receivable");
  assert.equal(receiverPayloads.length, writesBeforeRepeat);
  assert.equal(storageCounts.get("iron"), 32);

  const failedOrder = await post(`${baseUrl}/api/supply-orders`, {
    id: "supply-order-failed",
    producer: "Van Horn Foundry",
    status: "Ordered",
    lines: [{ id: "failed-iron-line", name: "Iron", label: "Iron", quantity: 5, unitPrice: 1.5 }]
  }, managerCookie);
  assert.equal(failedOrder.response.status, 200);
  failNextReceiverWrite = true;
  const failedReceipt = await post(`${baseUrl}/api/supply-orders/supply-order-failed/receive`, {
    receipts: [{ lineId: "failed-iron-line", quantity: 2 }]
  }, managerCookie);
  assert.equal(failedReceipt.response.status, 502);
  assert.equal(failedReceipt.body.code, "supply_receipt_sync_failed");
  const failedOrderAfterReceipt = (await getJson(`${baseUrl}/api/supply-orders`, managerCookie)).body.orders
    .find(order => order.id === "supply-order-failed");
  assert.equal(failedOrderAfterReceipt.status, "Ordered");
  assert.equal(failedOrderAfterReceipt.lines[0].receivedQuantity, 0);
  assert.equal(storageCounts.get("iron"), 32);

  const workerRegistration = await post(`${baseUrl}/api/auth/register`, {
    fullName: "Grace Worker",
    password: "WorkerPassword123!"
  });
  assert.equal(workerRegistration.response.status, 201);
  const worker = (await getJson(`${baseUrl}/api/admin/users`, managerCookie)).body.users
    .find(user => user.fullName === "Grace Worker");
  const managerApproval = await post(`${baseUrl}/api/admin/users/${worker.id}/approve`, {}, managerCookie);
  assert.equal(managerApproval.response.status, 200);

  const managerTarget = await post(`${baseUrl}/api/sync`, {
    action: "stock_target",
    target: { itemName: "Navy Revolver", itemLabel: "Navy Revolver", target: 2, updatedAt: "2026-07-13T10:00:00.000Z" }
  }, managerCookie);
  assert.equal(managerTarget.response.status, 200);
  const managerStorageTarget = await post(`${baseUrl}/api/sync`, {
    action: "storage_target",
    target: { itemName: "Iron", itemLabel: "Iron", target: 20, updatedAt: "2026-07-13T10:01:00.000Z" }
  }, managerCookie);
  assert.equal(managerStorageTarget.response.status, 200);

  const managerAdjustment = await post(`${baseUrl}/api/sync`, {
    action: "manual_operation",
    entry: { id: "manager-ledger", kind: "Ledger Count", location: "Ledger", amount: 250, note: "Opening count" }
  }, managerCookie);
  assert.equal(managerAdjustment.response.status, 200);

  const managerReview = await post(`${baseUrl}/api/sync`, {
    action: "resolve_exception",
    exception: {
      webhookId: "review-1",
      itemName: "Navy Revolver",
      eventType: "Sale",
      direction: "Stock Out",
      quantity: 1,
      unitPrice: 105,
      rememberMapping: true,
      note: "Mapped custom label"
    }
  }, managerCookie);
  assert.equal(managerReview.response.status, 200);
  assert.equal(receiverPayloads.at(-1).exception.resolvedBy, "Ada Employee");
  assert.equal((await getJson(`${baseUrl}/api/bootstrap`, managerCookie)).body.sheet.reviewExceptions[0].status, "Resolved");

  const nativeReview = await post(`${baseUrl}/api/sync`, {
    action: "resolve_exception",
    exception: {
      webhookId: "review-native-1",
      itemName: "Antique High Roller Revolver",
      eventType: "Stocking Movement",
      direction: "Stock In",
      quantity: 1,
      unitPrice: 135,
      rememberMapping: true,
      note: "Approved native resale weapon",
      newProduct: {
        enabled: true,
        name: "Antique High Roller Revolver",
        label: "High Roller Revolver",
        tag: "WEAPON_REVOLVER_HIGHROLLER",
        category: "Revolvers",
        price: 135
      }
    }
  }, managerCookie);
  assert.equal(nativeReview.response.status, 200);
  assert.equal(receiverPayloads.at(-1).exception.newProduct.tag, "WEAPON_REVOLVER_HIGHROLLER");
  assert.equal(receiverPayloads.at(-1).exception.resolvedBy, "Ada Employee");
  const nativeBootstrap = await getJson(`${baseUrl}/api/bootstrap`, managerCookie);
  const nativeWare = nativeBootstrap.body.items.find(item => item.name === "Antique High Roller Revolver");
  assert.equal(nativeWare.label, "High Roller Revolver");
  assert.equal(nativeWare.tag, "WEAPON_REVOLVER_HIGHROLLER");
  assert.equal(nativeWare.category, "Revolvers");
  assert.equal(nativeWare.price, 135);
  assert.equal(Object.prototype.hasOwnProperty.call(nativeBootstrap.body.recipes, nativeWare.name), false);
  const nativeInsight = await getJson(
    `${baseUrl}/api/product-insights/${encodeURIComponent(nativeWare.name)}`,
    managerCookie
  );
  assert.equal(nativeInsight.response.status, 200);
  assert.equal(nativeInsight.body.item.name, "Antique High Roller Revolver");
  assert.equal(nativeInsight.body.sales.revenue, 0);

  const managerPayrollAttempt = await post(`${baseUrl}/api/sync`, {
    action: "manual_operation",
    entry: { id: "manager-payroll", kind: "Payroll Payment", location: "Payroll", amount: 25 }
  }, managerCookie);
  assert.equal(managerPayrollAttempt.response.status, 403);
  assert.equal(managerPayrollAttempt.body.code, "admin_required");
  const managerOwnerFundsAttempt = await post(`${baseUrl}/api/sync`, {
    action: "manual_operation",
    entry: { id: "manager-owner-funds", kind: "Owner Capital Deposit", location: "Ledger", amount: 200 }
  }, managerCookie);
  assert.equal(managerOwnerFundsAttempt.response.status, 403);
  assert.equal(managerOwnerFundsAttempt.body.code, "admin_required");

  const ownerFundsEntry = await post(`${baseUrl}/api/sync`, {
    action: "manual_operation",
    entry: { id: "owner-funds", kind: "Safekeeping Deposit", location: "Ledger", amount: 200, employee: "Spoofed" }
  }, ownerCookie);
  assert.equal(ownerFundsEntry.response.status, 200);
  assert.equal(receiverPayloads.at(-1).entry.employee, "Frontier Owner");

  const managerPromotionAttempt = await post(`${baseUrl}/api/admin/users/${worker.id}/promote`, {}, managerCookie);
  assert.equal(managerPromotionAttempt.response.status, 403);
  const ownerAccount = managerUsers.body.users.find(user => user.role === "admin");
  const managerOwnerAttempt = await post(`${baseUrl}/api/admin/users/${ownerAccount.id}/disable`, {}, managerCookie);
  assert.equal(managerOwnerAttempt.response.status, 403);

  const workerLogin = await post(`${baseUrl}/api/auth/login`, {
    fullName: "Grace Worker",
    password: "WorkerPassword123!"
  });
  const workerCookie = cookieFrom(workerLogin.response);
  const workerBootstrap = await getJson(`${baseUrl}/api/bootstrap`, workerCookie);
  assert.equal(Object.prototype.hasOwnProperty.call(workerBootstrap.body.sheet.inventory, "ledger"), false);
  assert.equal(workerBootstrap.body.dailyCloses.length, 1);
  assert.equal(workerBootstrap.body.dailyCloses[0].status, "Finalized");
  assert.equal(Object.prototype.hasOwnProperty.call(workerBootstrap.body.dailyCloses[0], "countedLedgerBalance"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(workerBootstrap.body.dailyCloses[0].snapshot, "ledgerBalance"), false);
  assert.match(workerBootstrap.body.dailyCloses[0].handoffNotes, /Foundry delivery/);

  const workerCreateProduction = await post(`${baseUrl}/api/production-batches`, {
    reference: "Worker-created batch",
    lines: [{ itemName: "Navy Revolver", quantity: 1 }]
  }, workerCookie);
  assert.equal(workerCreateProduction.response.status, 403);

  const workerOrderMismatch = await post(`${baseUrl}/api/production-batches`, {
    sourceType: "Customer Order",
    sourceId: "sales-order-1",
    reference: "Wrong quantity",
    lines: [{ itemName: "Navy Revolver", quantity: 3 }]
  }, workerCookie);
  assert.equal(workerOrderMismatch.response.status, 400);
  assert.equal(workerOrderMismatch.body.code, "production_order_mismatch");

  [
    ["softwood", 20],
    ["revolver handle", 10],
    ["revolver barrel", 10],
    ["revolver cylinder", 10],
    ["bolts", 20]
  ].forEach(([key, quantity]) => storageCounts.set(key, quantity));
  const createdProduction = await post(`${baseUrl}/api/production-batches`, {
    id: "production-navy-two",
    sourceType: "Customer Order",
    sourceId: "sales-order-1",
    reference: "Order 42",
    dueDate: "2026-07-15",
    assignedTo: "Grace Worker",
    lines: [{ itemName: "Navy Revolver", quantity: 2 }]
  }, workerCookie);
  assert.equal(createdProduction.response.status, 200);
  assert.equal(createdProduction.body.batch.status, "Planned");
  assert.equal(createdProduction.body.batch.createdBy, "Grace Worker");
  assert.equal(createdProduction.body.batch.assignedTo, "Ada Employee");
  assert.equal(createdProduction.body.batch.lines[0].plannedCrafts, 2);
  assert.equal(createdProduction.body.order.status, "In Production");
  const productionLineId = createdProduction.body.batch.lines[0].id;

  const editQueuedProductionOrder = await post(`${baseUrl}/api/sales-orders`, {
    ...createdProduction.body.order,
    lines: createdProduction.body.order.lines.map(line => ({ ...line, quantity: line.quantity + 1 }))
  }, workerCookie);
  assert.equal(editQueuedProductionOrder.response.status, 409);
  assert.equal(editQueuedProductionOrder.body.code, "sales_order_production_locked");

  const completeActiveProductionOrder = await post(`${baseUrl}/api/sales-orders`, {
    ...createdProduction.body.order,
    status: "Completed"
  }, workerCookie);
  assert.equal(completeActiveProductionOrder.response.status, 409);
  assert.equal(completeActiveProductionOrder.body.code, "sales_order_production_active");

  const workerRestockAttempt = await post(`${baseUrl}/api/production-batches`, {
    sourceType: "Storefront Restock",
    reference: "Unauthorized restock",
    lines: [{ itemName: "Navy Revolver", quantity: 1 }]
  }, workerCookie);
  assert.equal(workerRestockAttempt.response.status, 403);
  assert.equal(workerRestockAttempt.body.code, "customer_order_production_required");

  const duplicateProductionSource = await post(`${baseUrl}/api/production-batches`, {
    sourceType: "Customer Order",
    sourceId: "sales-order-1",
    lines: [{ itemName: "Navy Revolver", quantity: 1 }]
  }, managerCookie);
  assert.equal(duplicateProductionSource.response.status, 409);
  assert.equal(duplicateProductionSource.body.code, "production_source_active");

  const workerProductionList = await getJson(`${baseUrl}/api/production-batches`, workerCookie);
  assert.equal(workerProductionList.response.status, 200);
  assert.equal(workerProductionList.body.batches[0].reference, "Order 42");
  const startedProduction = await post(`${baseUrl}/api/production-batches/production-navy-two/start`, {}, workerCookie);
  assert.equal(startedProduction.response.status, 200);
  assert.equal(startedProduction.body.batch.status, "In Progress");

  const writesBeforeProduction = receiverPayloads.length;
  const partialProduction = await post(`${baseUrl}/api/production-batches/production-navy-two/progress`, {
    completions: [{ lineId: productionLineId, completedCrafts: 1 }]
  }, workerCookie);
  assert.equal(partialProduction.response.status, 200);
  assert.equal(partialProduction.body.batch.lines[0].completedCrafts, 1);
  assert.equal(partialProduction.body.batch.status, "In Progress");
  const productionWrites = receiverPayloads.slice(writesBeforeProduction).filter(payload => payload.action === "manual_operation");
  assert(productionWrites.some(payload => payload.entry.kind === "Production Use" && payload.entry.itemName === "Iron"));
  assert(productionWrites.some(payload => payload.entry.kind === "Production Output" && payload.entry.itemName === "Navy Revolver"));
  assert.equal(productionWrites.some(payload => payload.entry.kind === "Correction In"), false);
  assert.equal(storageCounts.get("iron"), 30);
  assert.equal(storageCounts.get("navy revolver"), 1);

  const repeatProductionWrites = receiverPayloads.length;
  const repeatedProduction = await post(`${baseUrl}/api/production-batches/production-navy-two/progress`, {
    completions: [{ lineId: productionLineId, completedCrafts: 1 }]
  }, workerCookie);
  assert.equal(repeatedProduction.response.status, 400);
  assert.equal(receiverPayloads.length, repeatProductionWrites);

  const completedProduction = await post(`${baseUrl}/api/production-batches/production-navy-two/progress`, {
    completions: [{ lineId: productionLineId, completedCrafts: 2 }]
  }, workerCookie);
  assert.equal(completedProduction.response.status, 200);
  assert.equal(completedProduction.body.batch.status, "Completed");
  assert.equal(completedProduction.body.order.status, "Ready");
  assert.equal(storageCounts.get("navy revolver"), 2);

  const reopenReadyProductionOrder = await post(`${baseUrl}/api/sales-orders`, {
    ...completedProduction.body.order,
    status: "Draft"
  }, workerCookie);
  assert.equal(reopenReadyProductionOrder.response.status, 409);
  assert.equal(reopenReadyProductionOrder.body.code, "sales_order_ready_locked");

  const writesBeforeDelivery = receiverPayloads.length;
  const deliveredProductionOrder = await post(`${baseUrl}/api/sales-orders`, {
    ...completedProduction.body.order,
    status: "Completed"
  }, workerCookie);
  assert.equal(deliveredProductionOrder.response.status, 200);
  assert.equal(deliveredProductionOrder.body.order.status, "Completed");
  assert.equal(deliveredProductionOrder.body.fulfillmentSynced, true);
  const deliveryWrites = receiverPayloads.slice(writesBeforeDelivery).filter(payload => payload.action === "manual_operation");
  assert(deliveryWrites.some(payload => payload.entry.kind === "Correction Out"
    && payload.entry.location === "Storage"
    && payload.entry.itemName === "Navy Revolver"
    && payload.entry.quantity === 2));
  assert.equal(storageCounts.get("navy revolver"), 0);
  storageCounts.set("navy revolver", 2);

  const internalOrder = await post(`${baseUrl}/api/sales-orders`, {
    id: "internal-stock-order",
    orderType: "Internal Craft",
    customer: "Not a customer",
    handler: "Grace Worker",
    status: "Reserved",
    priority: "Normal",
    deposit: 250,
    label: "Build Navy reserve stock",
    lines: [{ name: "Navy Revolver", label: "Navy Revolver", category: "Revolvers", quantity: 2, unitPrice: 105 }]
  }, workerCookie);
  assert.equal(internalOrder.response.status, 200);
  assert.equal(internalOrder.body.order.orderType, "Internal Craft");
  assert.equal(internalOrder.body.order.customer, "");
  assert.equal(internalOrder.body.order.deposit, 0);
  assert.equal(internalOrder.body.order.lines[0].unitPrice, 0);

  const completeInternalWithoutProduction = await post(`${baseUrl}/api/sales-orders`, {
    ...internalOrder.body.order,
    status: "Completed"
  }, workerCookie);
  assert.equal(completeInternalWithoutProduction.response.status, 400);
  assert.equal(completeInternalWithoutProduction.body.code, "internal_craft_status_managed");

  const internalAllocationAttempt = await post(`${baseUrl}/api/production-batches`, {
    id: "internal-stock-allocation-attempt",
    sourceType: "Internal Craft",
    sourceId: internalOrder.body.order.id,
    lines: [{ itemName: "Navy Revolver", quantity: 1 }],
    stockAllocations: [{ itemName: "Navy Revolver", storageQuantity: 1 }]
  }, workerCookie);
  assert.equal(internalAllocationAttempt.response.status, 400);
  assert.equal(internalAllocationAttempt.body.code, "internal_craft_stock_allocation_forbidden");

  [
    ["iron", 20],
    ["softwood", 20],
    ["revolver handle", 10],
    ["revolver barrel", 10],
    ["revolver cylinder", 10],
    ["bolts", 20]
  ].forEach(([key, quantity]) => storageCounts.set(key, quantity));
  const internalStorageBefore = storageCounts.get("navy revolver");
  const internalProduction = await post(`${baseUrl}/api/production-batches`, {
    id: "internal-stock-production",
    sourceType: "Internal Craft",
    sourceId: internalOrder.body.order.id,
    reference: "Build Navy reserve stock",
    lines: [{ itemName: "Navy Revolver", quantity: 2 }]
  }, workerCookie);
  assert.equal(internalProduction.response.status, 200);
  assert.equal(internalProduction.body.batch.sourceType, "Internal Craft");
  assert.equal(internalProduction.body.batch.lines[0].requestedQuantity, 2);
  assert.deepEqual(internalProduction.body.batch.stockAllocations, []);
  assert.equal(internalProduction.body.order.status, "In Production");

  const internalWritesBefore = receiverPayloads.length;
  const completedInternalProduction = await post(
    `${baseUrl}/api/production-batches/internal-stock-production/progress`,
    { completions: [{ lineId: internalProduction.body.batch.lines[0].id, completedCrafts: 2 }] },
    workerCookie
  );
  assert.equal(completedInternalProduction.response.status, 200);
  assert.equal(completedInternalProduction.body.batch.status, "Completed");
  assert.equal(completedInternalProduction.body.order.status, "Completed");
  assert.equal(storageCounts.get("navy revolver"), internalStorageBefore + 2);
  const internalWrites = receiverPayloads.slice(internalWritesBefore).filter(payload => payload.action === "manual_operation");
  assert(internalWrites.some(payload => payload.entry.kind === "Production Use"));
  assert(internalWrites.some(payload => payload.entry.kind === "Production Output"
    && payload.entry.location === "Storage"
    && payload.entry.itemName === "Navy Revolver"
    && payload.entry.quantity === 2));
  assert.equal(internalWrites.some(payload => payload.entry.kind === "Correction Out"), false);
  assert(internalWrites.every(payload => Number(payload.entry.amount || 0) === 0));
  storageCounts.set("navy revolver", 2);

  const mixedFulfillmentOrder = await post(`${baseUrl}/api/sales-orders`, {
    id: "sales-order-stock-mix",
    customer: "Sadie Adler",
    handler: "Grace Worker",
    status: "Reserved",
    priority: "Normal",
    lines: [{ name: "Navy Revolver", label: "Navy Revolver", category: "Revolvers", quantity: 5, unitPrice: 105 }]
  }, workerCookie);
  assert.equal(mixedFulfillmentOrder.response.status, 200);
  const mixedFulfillment = await post(`${baseUrl}/api/production-batches`, {
    id: "production-stock-mix",
    sourceType: "Customer Order",
    sourceId: "sales-order-stock-mix",
    reference: "Use two finished revolvers",
    lines: [{ itemName: "Navy Revolver", quantity: 3 }],
    stockAllocations: [{ itemName: "Navy Revolver", storageQuantity: 2, storefrontQuantity: 0 }]
  }, workerCookie);
  assert.equal(mixedFulfillment.response.status, 200);
  assert.equal(mixedFulfillment.body.batch.lines[0].requestedQuantity, 3);
  assert.equal(mixedFulfillment.body.batch.stockAllocations[0].storageQuantity, 2);
  assert.equal(mixedFulfillment.body.order.status, "In Production");

  const competingOrder = await post(`${baseUrl}/api/sales-orders`, {
    id: "sales-order-stock-competing",
    customer: "Charles Smith",
    handler: "Grace Worker",
    status: "Reserved",
    priority: "Normal",
    lines: [{ name: "Navy Revolver", label: "Navy Revolver", category: "Revolvers", quantity: 1, unitPrice: 105 }]
  }, workerCookie);
  assert.equal(competingOrder.response.status, 200);
  const competingAllocation = await post(`${baseUrl}/api/production-batches`, {
    id: "production-stock-competing",
    sourceType: "Customer Order",
    sourceId: "sales-order-stock-competing",
    stockAllocations: [{ itemName: "Navy Revolver", storageQuantity: 1, storefrontQuantity: 0 }]
  }, workerCookie);
  assert.equal(competingAllocation.response.status, 409);
  assert.equal(competingAllocation.body.code, "production_stock_allocation_shortage");

  const cancelledMixedFulfillment = await post(`${baseUrl}/api/production-batches/production-stock-mix/cancel`, {}, managerCookie);
  assert.equal(cancelledMixedFulfillment.response.status, 200);
  assert.equal(
    cancelledMixedFulfillment.body.orders.find(order => order.id === "sales-order-stock-mix").status,
    "Reserved"
  );
  const stockOnlyFulfillment = await post(`${baseUrl}/api/production-batches`, {
    id: "production-stock-only",
    sourceType: "Customer Order",
    sourceId: "sales-order-stock-competing",
    reference: "Ready from existing stock",
    stockAllocations: [{ itemName: "Navy Revolver", storageQuantity: 1, storefrontQuantity: 0 }]
  }, workerCookie);
  assert.equal(stockOnlyFulfillment.response.status, 200);
  assert.equal(stockOnlyFulfillment.body.batch.lines.length, 0);
  assert.equal(stockOnlyFulfillment.body.batch.status, "Completed");
  assert.equal(stockOnlyFulfillment.body.order.status, "Ready");
  const deliveredStockOnly = await post(`${baseUrl}/api/sales-orders`, {
    ...stockOnlyFulfillment.body.order,
    status: "Completed"
  }, workerCookie);
  assert.equal(deliveredStockOnly.response.status, 200);
  assert.equal(deliveredStockOnly.body.fulfillmentSynced, true);
  assert.equal(storageCounts.get("navy revolver"), 1);

  const restockProduction = await post(`${baseUrl}/api/production-batches`, {
    id: "production-restock-one",
    sourceType: "Storefront Restock",
    reference: "Storefront refill",
    lines: [{ itemName: "Navy Revolver", quantity: 1 }]
  }, managerCookie);
  assert.equal(restockProduction.response.status, 200);
  const restockLineId = restockProduction.body.batch.lines[0].id;
  const startedRestock = await post(`${baseUrl}/api/production-batches/production-restock-one/start`, {}, workerCookie);
  assert.equal(startedRestock.response.status, 200);
  const writesBeforeRestock = receiverPayloads.length;
  const completedRestock = await post(`${baseUrl}/api/production-batches/production-restock-one/progress`, {
    completions: [{ lineId: restockLineId, completedCrafts: 1 }]
  }, workerCookie);
  assert.equal(completedRestock.response.status, 200);
  assert.equal(completedRestock.body.batch.status, "Completed");
  const restockWrites = receiverPayloads.slice(writesBeforeRestock).filter(payload => payload.action === "manual_operation");
  assert(restockWrites.some(payload => payload.entry.kind === "Production Use"));
  assert.equal(
    restockWrites.some(payload => payload.entry.kind === "Production Output" || payload.entry.kind === "Correction In"),
    false,
    "restock output must wait for the storefront webhook instead of creating finished stock twice"
  );
  assert.equal(storageCounts.get("navy revolver"), 1);
  inventoryProducts.push({
    itemName: "Bolts",
    itemLabel: "Bolts",
    itemTag: "bolts",
    category: "Components",
    salePrice: 0.1,
    target: 0,
    currentStock: 4,
    active: true
  });
  const mixedSourceProduction = await post(`${baseUrl}/api/production-batches`, {
    id: "production-mixed-source",
    sourceType: "Manual",
    reference: "Use storefront bolts",
    lines: [{
      itemName: "Navy Revolver",
      quantity: 1,
      ingredientSources: { bolts: "Storefront" }
    }]
  }, managerCookie);
  assert.equal(mixedSourceProduction.response.status, 200);
  assert.equal(
    mixedSourceProduction.body.batch.lines[0].recipe.find(component => component.ingredient === "Bolts").sourceLocation,
    "Storefront"
  );
  const mixedSourceLineId = mixedSourceProduction.body.batch.lines[0].id;
  const mixedSourceWritesBefore = receiverPayloads.length;
  const completedMixedSource = await post(`${baseUrl}/api/production-batches/production-mixed-source/progress`, {
    completions: [{ lineId: mixedSourceLineId, completedCrafts: 1 }]
  }, workerCookie);
  assert.equal(completedMixedSource.response.status, 200);
  const mixedSourceWrites = receiverPayloads.slice(mixedSourceWritesBefore).filter(payload => payload.action === "manual_operation");
  assert(mixedSourceWrites.some(payload => payload.entry.kind === "Production Use"
    && payload.entry.itemName === "Bolts"
    && payload.entry.location === "Storefront"));
  assert.equal(inventoryProducts.find(product => product.itemName === "Bolts").currentStock, 2);
  inventoryProducts.splice(inventoryProducts.findIndex(product => product.itemName === "Bolts"), 1);

  const cancelCompletedProduction = await post(`${baseUrl}/api/production-batches/production-navy-two/cancel`, {}, managerCookie);
  assert.equal(cancelCompletedProduction.response.status, 409);
  const removeProductionSalesOrder = await remove(`${baseUrl}/api/sales-orders/sales-order-1`, managerCookie);
  assert.equal(removeProductionSalesOrder.response.status, 409);
  assert.equal(removeProductionSalesOrder.body.code, "sales_order_has_production");

  const retryProduction = await post(`${baseUrl}/api/production-batches`, {
    id: "production-retry",
    sourceType: "Manual",
    reference: "Retry-safe batch",
    lines: [{ itemName: "Navy Revolver", quantity: 1 }]
  }, managerCookie);
  const retryLineId = retryProduction.body.batch.lines[0].id;
  const ironBeforeRetry = storageCounts.get("iron");
  failReceiverAfterSuccessfulWrites = 1;
  const failedProduction = await post(`${baseUrl}/api/production-batches/production-retry/progress`, {
    completions: [{ lineId: retryLineId, completedCrafts: 1 }]
  }, workerCookie);
  assert.equal(failedProduction.response.status, 502);
  assert.equal(failedProduction.body.code, "production_sync_pending");
  assert.equal(storageCounts.get("iron"), ironBeforeRetry - 2);
  const pendingProduction = (await getJson(`${baseUrl}/api/production-batches`, workerCookie)).body.batches
    .find(batch => batch.id === "production-retry");
  assert.equal(pendingProduction.pendingProgress.targets[0].completedCrafts, 1);
  const retriedProduction = await post(`${baseUrl}/api/production-batches/production-retry/progress`, {
    completions: [{ lineId: retryLineId, completedCrafts: 1 }]
  }, workerCookie);
  assert.equal(retriedProduction.response.status, 200);
  assert.equal(retriedProduction.body.batch.status, "Completed");
  assert.equal(storageCounts.get("iron"), ironBeforeRetry - 2, "retry must not consume a material twice");

  [
    ["iron", 2],
    ["softwood", 2],
    ["revolver handle", 1],
    ["revolver barrel", 1],
    ["revolver cylinder", 1],
    ["bolts", 2]
  ].forEach(([key, quantity]) => storageCounts.set(key, quantity));
  await post(`${baseUrl}/api/production-batches`, {
    id: "production-reserved-first",
    sourceType: "Manual",
    reference: "First reserved batch",
    dueDate: "2026-07-14",
    lines: [{ itemName: "Navy Revolver", quantity: 1 }]
  }, managerCookie);
  const reservedSecond = await post(`${baseUrl}/api/production-batches`, {
    id: "production-reserved-second",
    sourceType: "Manual",
    reference: "Second reserved batch",
    dueDate: "2026-07-16",
    lines: [{ itemName: "Navy Revolver", quantity: 1 }]
  }, managerCookie);
  const reservedSecondLineId = reservedSecond.body.batch.lines[0].id;
  const blockedByReservation = await post(`${baseUrl}/api/production-batches/production-reserved-second/progress`, {
    completions: [{ lineId: reservedSecondLineId, completedCrafts: 1 }]
  }, workerCookie);
  assert.equal(blockedByReservation.response.status, 409);
  assert.equal(blockedByReservation.body.code, "production_material_shortage");
  await post(`${baseUrl}/api/production-batches/production-reserved-first/cancel`, {}, managerCookie);
  await post(`${baseUrl}/api/production-batches/production-reserved-second/cancel`, {}, managerCookie);

  const clockPayload = {
    action: "time_clock",
    entry: { id: "grace-shift", clockIn: "2026-07-13T10:30:00.000Z", clockOut: "", durationMinutes: "" }
  };
  assert.equal((await post(`${baseUrl}/api/sync`, clockPayload, workerCookie)).response.status, 200);
  assert.equal((await post(`${baseUrl}/api/sync`, clockPayload, workerCookie)).response.status, 200);

  const managerDisabledWorker = await post(`${baseUrl}/api/admin/users/${worker.id}/disable`, {}, managerCookie);
  assert.equal(managerDisabledWorker.response.status, 200);
  assert.equal((await getJson(`${baseUrl}/api/auth/session`, workerCookie)).body.user, null);
  const managerReactivatedWorker = await post(`${baseUrl}/api/admin/users/${worker.id}/approve`, {}, managerCookie);
  assert.equal(managerReactivatedWorker.response.status, 200);

  const removedSupplier = await remove(`${baseUrl}/api/suppliers/supplier-foundry`, managerCookie);
  assert.equal(removedSupplier.response.status, 200);
  assert.deepEqual(removedSupplier.body.suppliers, []);

  const managerAudit = await getJson(`${baseUrl}/api/admin/audit?limit=1000`, managerCookie);
  assert.equal(managerAudit.response.status, 200);
  assert(managerAudit.body.events.some(event => event.action === "account.role_changed"));
  assert(managerAudit.body.events.some(event => event.action === "operation.recorded" && event.actorName === "Ada Employee"));
  assert(managerAudit.body.events.some(event => event.action === "supply_order.saved" && event.subjectName === "Van Horn Foundry"));
  assert(managerAudit.body.events.some(event => event.action === "supply_order.received" && event.details.quantity === 7));
  assert(managerAudit.body.events.some(event => event.action === "supplier.saved" && event.subjectName === "Van Horn Foundry"));
  assert(managerAudit.body.events.some(event => event.action === "supplier.removed" && event.subjectName === "Van Horn Foundry"));
  assert(managerAudit.body.events.some(event => event.action === "storefront_buy_order.saved" && event.subjectName === "Nitrite"));
  assert(managerAudit.body.events.some(event => event.action === "storefront_buy_order.fill_adjusted" && event.details.filledQuantity === 6));
  assert(managerAudit.body.events.some(event => event.action === "webhook_exception.resolved" && event.actorName === "Ada Employee"));
  assert(managerAudit.body.events.some(event => event.action === "production_batch.created" && event.subjectName === "Order 42"));
  assert(managerAudit.body.events.some(event => event.action === "production_batch.completed" && event.actorName === "Grace Worker"));
  assert(managerAudit.body.events.some(event => event.action === "sales_order.internal_craft_completed" && event.subjectName === "Build Navy reserve stock"));
  assert(managerAudit.body.events.some(event => event.action === "sales_order.saved" && event.subjectName === "Arthur Morgan"));
  assert(managerAudit.body.events.some(event => event.action === "sales_order.imported" && event.actorName === "Ada Employee"));
  assert(managerAudit.body.events.some(event => event.action === "sales_order.removed" && event.subjectName === "Legacy Customer"));
  assert(managerAudit.body.events.some(event => event.action === "daily_close.saved" && event.subjectName === "2026-07-13"));
  assert(managerAudit.body.events.some(event => event.action === "daily_close.finalized" && event.details.ledgerDifference === -5));
  assert(managerAudit.body.events.some(event => event.action === "daily_close.reopened" && event.actorName === "Frontier Owner"));
  assert.equal(managerAudit.body.events.filter(event => event.action === "clock.in" && event.subjectName === "Grace Worker").length, 1);

  const removedSupplyOrder = await remove(`${baseUrl}/api/supply-orders/supply-order-1`, managerCookie);
  assert.equal(removedSupplyOrder.response.status, 200);
  const removedFailedOrder = await remove(`${baseUrl}/api/supply-orders/supply-order-failed`, managerCookie);
  assert.equal(removedFailedOrder.response.status, 200);
  const removedActiveOrder = await remove(`${baseUrl}/api/supply-orders/supply-order-active`, managerCookie);
  assert.equal(removedActiveOrder.response.status, 200);
  assert.deepEqual(removedActiveOrder.body.orders, []);

  const demoted = await post(`${baseUrl}/api/admin/users/${pendingUser.id}/demote`, {}, ownerCookie);
  assert.equal(demoted.response.status, 200);
  assert.equal(demoted.body.user.role, "employee");
  const invalidatedManagerSession = await getJson(`${baseUrl}/api/auth/session`, managerCookie);
  assert.equal(invalidatedManagerSession.body.user, null);

  const disabled = await post(`${baseUrl}/api/admin/users/${pendingUser.id}/disable`, {}, ownerCookie);
  assert.equal(disabled.response.status, 200);
  const disabledSession = await getJson(`${baseUrl}/api/auth/session`, employeeCookie);
  assert.equal(disabledSession.body.user, null);

  const accountFile = await fs.promises.readFile(path.join(dataDirectory, "users.json"), "utf8");
  assert.doesNotMatch(accountFile, /OwnerPassword123|EmployeePassword123|WorkerPassword123/);
  assert.match(accountFile, /"algorithm": "scrypt"/);

  const logout = await post(`${baseUrl}/api/auth/logout`, {}, ownerCookie);
  assert.equal(logout.response.status, 200);
  assert.match(logout.response.headers.get("set-cookie") || "", /Max-Age=0/);

  console.log("Personal accounts, manager permissions, and audit checks passed.");
}

async function post(url, payload, cookie = "") {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...(cookie ? { cookie } : {})
    },
    body: JSON.stringify(payload)
  });
  return { response, body: await response.json() };
}

async function put(url, payload, cookie = "") {
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...(cookie ? { cookie } : {})
    },
    body: JSON.stringify(payload)
  });
  return { response, body: await response.json() };
}

async function readRequestJson(request) {
  let body = "";
  for await (const chunk of request) body += chunk;
  return JSON.parse(body || "{}");
}

function mockInventoryKey(value) {
  const key = String(value || "").trim().toLowerCase();
  return key === "wood" || key === "soft wood" || key === "softwood" ? "softwood" : key;
}

async function getJson(url, cookie = "") {
  const response = await fetch(url, {
    headers: { accept: "application/json", ...(cookie ? { cookie } : {}) }
  });
  return { response, body: await response.json() };
}

async function remove(url, cookie = "") {
  const response = await fetch(url, {
    method: "DELETE",
    headers: { accept: "application/json", ...(cookie ? { cookie } : {}) }
  });
  return { response, body: await response.json() };
}

function cookieFrom(response) {
  const value = response.headers.get("set-cookie") || "";
  assert.match(value, /^business_session=/);
  return value.split(";", 1)[0];
}

async function waitForServer(url) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for app server test process.");
}
