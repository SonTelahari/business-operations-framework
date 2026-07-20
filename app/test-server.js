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
}];
let failNextReceiverWrite = false;
const mockReceiver = http.createServer(async (request, response) => {
  if (request.method === "GET") {
    const materials = [...storageCounts.entries()].map(([key, storageCount]) => ({
      ingredient: key === "softwood" ? "Softwood" : key.replace(/^./, character => character.toUpperCase()),
      storageCount
    }));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      ok: true,
      generatedAt: "2026-07-13T03:30:00.000Z",
      sheets: [{ name: "Products", lastRow: 3 }],
      reviewExceptions,
      inventory: {
        products: [
          { itemName: "Navy Revolver", itemLabel: "Navy Revolver", target: 5, currentStock: 1 },
          { itemName: "Boltaction Rifle", itemLabel: "BoltAction Rifle", target: 5, currentStock: 3 }
        ],
        materials,
        storage: [...materials, { ingredient: "Navy Revolver", storageCount: 2, countedAt: "2026-07-13T03:20:00.000Z" }],
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
  const entry = payload.entry;
  if (payload.action === "resolve_exception") {
    const exception = reviewExceptions.find(candidate => candidate.webhookId === payload.exception?.webhookId);
    if (exception) {
      exception.status = "Resolved";
      exception.resolvedItem = payload.exception.itemName;
      exception.resolvedBy = payload.exception.resolvedBy;
    }
  }
  if (payload.action === "ignore_exception") {
    const exception = reviewExceptions.find(candidate => candidate.webhookId === payload.exception?.webhookId);
    if (exception) exception.status = "Ignored";
  }
  if (payload.action === "manual_operation" && entry?.kind === "Stock Count" && entry.location === "Storage") {
    if (!receiverOperationIds.has(entry.id)) {
      storageCounts.set(mockInventoryKey(entry.itemName || entry.itemLabel), Number(entry.quantity || 0));
      receiverOperationIds.add(entry.id);
    }
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
  assert.deepEqual(await health.json().then(result => [result.authMode, result.persistentAccountStore, result.supplyReceipts]), ["accounts", true, true]);

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

  const employeeAdminAttempt = await getJson(`${baseUrl}/api/admin/users`, employeeCookie);
  assert.equal(employeeAdminAttempt.response.status, 403);
  const employeeAuditAttempt = await getJson(`${baseUrl}/api/admin/audit`, employeeCookie);
  assert.equal(employeeAuditAttempt.response.status, 403);
  const employeeSupplyAttempt = await getJson(`${baseUrl}/api/supply-orders`, employeeCookie);
  assert.equal(employeeSupplyAttempt.response.status, 403);
  const employeeBuyOrderAttempt = await getJson(`${baseUrl}/api/storefront-buy-orders`, employeeCookie);
  assert.equal(employeeBuyOrderAttempt.response.status, 403);
  const employeeSupplierAttempt = await getJson(`${baseUrl}/api/suppliers`, employeeCookie);
  assert.equal(employeeSupplierAttempt.response.status, 403);
  const employeeBootstrap = await getJson(`${baseUrl}/api/bootstrap`, employeeCookie);
  assert.equal(Object.prototype.hasOwnProperty.call(employeeBootstrap.body.sheet, "reviewExceptions"), false);
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

  const partialReceipt = await post(`${baseUrl}/api/supply-orders/supply-order-1/receive`, {
    receipts: [{ lineId: "iron-line", quantity: 7 }]
  }, managerCookie);
  assert.equal(partialReceipt.response.status, 200);
  assert.equal(partialReceipt.body.order.status, "Partially Received");
  assert.equal(partialReceipt.body.order.lines[0].receivedQuantity, 7);
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
  assert.equal(storageCounts.get("iron"), 32);

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

  const managerPayrollAttempt = await post(`${baseUrl}/api/sync`, {
    action: "manual_operation",
    entry: { id: "manager-payroll", kind: "Payroll Payment", location: "Payroll", amount: 25 }
  }, managerCookie);
  assert.equal(managerPayrollAttempt.response.status, 403);
  assert.equal(managerPayrollAttempt.body.code, "admin_required");

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

  await testLegacyFallback();

  console.log("Personal accounts, manager permissions, and audit checks passed.");
}

async function testLegacyFallback() {
  const legacyPort = 4285;
  const legacyDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "still-water-legacy-business-"));
  const legacyServer = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: {
      ...process.env,
      PORT: String(legacyPort),
      APPS_SCRIPT_URL: "",
      AUTH_SESSION_SECRET: "",
      AUTH_DATA_DIR: legacyDataDirectory,
      ADMIN_FULL_NAME: "",
      ADMIN_PASSWORD: "",
      APP_AUTH_USER: "frontier-legacy",
      APP_AUTH_PASSWORD: "LegacyPassword123!",
      NODE_ENV: "test"
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  try {
    const legacyUrl = `http://127.0.0.1:${legacyPort}`;
    await waitForServer(`${legacyUrl}/health`);
    const unauthenticated = await fetch(legacyUrl);
    assert.equal(unauthenticated.status, 401);
    const authorization = `Basic ${Buffer.from("frontier-legacy:LegacyPassword123!").toString("base64")}`;
    const session = await fetch(`${legacyUrl}/api/auth/session`, { headers: { authorization } });
    assert.equal(session.status, 200);
    const result = await session.json();
    assert.equal(result.user.role, "admin");
    assert.equal(result.user.accountManagement, false);
  } finally {
    legacyServer.kill();
    await fs.promises.rm(legacyDataDirectory, { recursive: true, force: true });
  }
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
  assert.match(value, /^ff_session=/);
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
