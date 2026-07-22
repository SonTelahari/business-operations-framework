const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { AccountStore, SESSION_MAX_AGE_SECONDS } = require("./auth");
const { BusinessStore } = require("./business-store");

const root = __dirname;
loadEnvFile(path.join(root, "..", "discord-bridge", ".env"));
const port = Number(process.env.PORT || 4273);
const authUser = process.env.APP_AUTH_USER || "frontier";
const authPassword = process.env.APP_AUTH_PASSWORD || "";
const sessionSecret = process.env.AUTH_SESSION_SECRET || "";
const accountAuthEnabled = Boolean(sessionSecret);
const accountDataDirectory = process.env.AUTH_DATA_DIR
  || process.env.RAILWAY_VOLUME_MOUNT_PATH
  || path.join(root, ".data");
const accountStore = accountAuthEnabled
  ? new AccountStore({ filePath: path.join(accountDataDirectory, "users.json"), sessionSecret })
  : null;
const businessStore = new BusinessStore({ filePath: path.join(accountDataDirectory, "business.json") });
const loginAttempts = new Map();
let supplyReceiptQueue = Promise.resolve();
let productionProgressQueue = Promise.resolve();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png"
};
const publicFiles = new Set([
  "/index.html",
  "/login.html",
  "/styles.css",
  "/app.js",
  "/login.js",
  "/pricing.js",
  "/items.js",
  "/recipes.js",
  "/supply-telegram.js",
  "/inventory-counts.js",
  "/assets/frontier-firearms-logo.png"
]);

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname === "/health/sheet") {
      const snapshot = await readSheetSnapshot();
      const inventory = snapshot?.inventory;
      sendJson(response, {
        ok: Boolean(snapshot?.ok),
        error: snapshot?.error || "",
        schemaVersion: snapshot?.schemaVersion || null,
        generatedAt: snapshot?.generatedAt || "",
        inventoryFields: inventory && typeof inventory === "object" ? Object.keys(inventory) : [],
        ledgerAvailable: Number.isFinite(Number(inventory?.ledger?.balance))
      });
      return;
    }
    if (url.pathname === "/health") {
      sendJson(response, {
        ok: true,
        service: "frontier-firearms-still-water-app",
        sheetConfigured: Boolean(process.env.APPS_SCRIPT_URL),
        authConfigured: accountAuthEnabled || Boolean(authPassword),
        authMode: accountAuthEnabled ? "accounts" : authPassword ? "legacy-basic" : "none",
        persistentAccountStore: accountAuthEnabled && Boolean(process.env.AUTH_DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH),
        persistentBusinessStore: Boolean(process.env.AUTH_DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH),
        supplyReceipts: true,
        storefrontBuyOrders: true,
        webhookReview: true,
        productionBatches: true,
        sharedSalesOrders: true,
        dailyCloses: true,
        financeReporting: true,
        productInsights: true,
        uptimeSeconds: Math.round(process.uptime())
      });
      return;
    }

    if (accountAuthEnabled) {
      const user = accountStore.verifySession(readCookie(request, "ff_session"));
      if (await handleAccountRoute(request, response, url, user)) return;
      if (!user) {
        if (url.pathname.startsWith("/api/")) {
          sendJson(response, { ok: false, error: "Authentication required", code: "authentication_required" }, 401);
        } else {
          redirect(response, "/login.html");
        }
        return;
      }
      if (url.pathname === "/login.html") {
        redirect(response, "/");
        return;
      }
      if (await handleSupplierRoute(request, response, url, user)) return;
      if (await handleSupplyOrderRoute(request, response, url, user)) return;
      if (await handleStorefrontBuyOrderRoute(request, response, url, user)) return;
      if (await handleSalesOrderRoute(request, response, url, user)) return;
      if (await handleProductionBatchRoute(request, response, url, user)) return;
      if (await handleDailyCloseRoute(request, response, url, user)) return;
      if (await handleProductInsightRoute(request, response, url, user)) return;
      if (await handleFinanceRoute(request, response, url, user)) return;
      if (url.pathname === "/api/bootstrap") {
        sendJson(response, await getBootstrapData(user));
        return;
      }
      if (url.pathname === "/api/sync" && request.method === "POST") {
        const payload = await readJsonBody(request);
        if (requiresAdmin(payload) && user.role !== "admin") {
          sendJson(response, { ok: false, error: "Admin access required", code: "admin_required" }, 403);
          return;
        }
        if (requiresManagement(payload) && !isManagementRole(user)) {
          sendJson(response, { ok: false, error: "Manager access required", code: "manager_required" }, 403);
          return;
        }
        stampEmployee(payload, user);
        const syncResult = await syncGuiPayload(payload);
        await auditGuiPayload(payload, user, syncResult).catch(error => {
          console.error("Unable to write GUI audit event:", error.message);
        });
        sendJson(response, syncResult);
        return;
      }
    } else {
      if (authPassword && !isAuthorized(request)) {
        response.writeHead(401, {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
          "WWW-Authenticate": 'Basic realm="Frontier Firearms - Still Water", charset="UTF-8"'
        });
        response.end("Authentication required");
        return;
      }
      const user = {
        id: "legacy-admin",
        fullName: authUser,
        role: "admin",
        status: "active",
        accountManagement: false
      };
      if (url.pathname === "/api/auth/session" && request.method === "GET") {
        sendJson(response, {
          ok: true,
          user
        });
        return;
      }
      if (url.pathname === "/api/auth/logout" && request.method === "POST") {
        sendJson(response, { ok: true });
        return;
      }
      if (await handleSupplierRoute(request, response, url, user)) return;
      if (await handleSupplyOrderRoute(request, response, url, user)) return;
      if (await handleStorefrontBuyOrderRoute(request, response, url, user)) return;
      if (await handleSalesOrderRoute(request, response, url, user)) return;
      if (await handleProductionBatchRoute(request, response, url, user)) return;
      if (await handleDailyCloseRoute(request, response, url, user)) return;
      if (await handleProductInsightRoute(request, response, url, user)) return;
      if (await handleFinanceRoute(request, response, url, user)) return;
      if (url.pathname === "/api/bootstrap") {
        sendJson(response, await getBootstrapData(null));
        return;
      }
      if (url.pathname === "/api/sync" && request.method === "POST") {
        sendJson(response, await syncGuiPayload(await readJsonBody(request)));
        return;
      }
    }

    serveStatic(response, url.pathname === "/" ? "/index.html" : url.pathname);
  } catch (error) {
    console.error("App request failed:", error);
    sendJson(response, { ok: false, error: "The request could not be completed" }, 500);
  }
});

async function handleAccountRoute(request, response, url, user) {
  if (isPublicAsset(url.pathname)) {
    serveStatic(response, url.pathname);
    return true;
  }
  if (url.pathname === "/api/auth/session" && request.method === "GET") {
    sendJson(response, { ok: true, user: user ? { ...user, accountManagement: true } : null });
    return true;
  }
  if (url.pathname === "/api/auth/register" && request.method === "POST") {
    if (!allowAuthAttempt(request)) {
      sendJson(response, { ok: false, error: "Too many attempts. Try again later.", code: "rate_limited" }, 429);
      return true;
    }
    return handleAccountAction(response, async () => {
      const body = await readJsonBody(request);
      const registration = await accountStore.register(body.fullName, body.password);
      sendJson(response, { ok: true, user: registration }, 201);
    });
  }
  if (url.pathname === "/api/auth/login" && request.method === "POST") {
    if (!allowAuthAttempt(request)) {
      sendJson(response, { ok: false, error: "Too many attempts. Try again later.", code: "rate_limited" }, 429);
      return true;
    }
    return handleAccountAction(response, async () => {
      const body = await readJsonBody(request);
      const authenticatedUser = await accountStore.authenticate(body.fullName, body.password);
      setSessionCookie(response, request, accountStore.createSession(authenticatedUser));
      sendJson(response, { ok: true, user: authenticatedUser });
    });
  }
  if (url.pathname === "/api/auth/logout" && request.method === "POST") {
    if (user) {
      await accountStore.recordAudit({
        category: "authentication",
        action: "auth.logout",
        actorId: user.id,
        actorName: user.fullName,
        subjectId: user.id,
        subjectName: user.fullName
      }).catch(error => console.error("Unable to write logout audit event:", error.message));
    }
    clearSessionCookie(response, request);
    sendJson(response, { ok: true });
    return true;
  }
  if (url.pathname === "/api/admin/users" && request.method === "GET") {
    if (!requireManagement(response, user)) return true;
    sendJson(response, { ok: true, users: accountStore.listUsers() });
    return true;
  }
  if (url.pathname === "/api/admin/audit" && request.method === "GET") {
    if (!requireManagement(response, user)) return true;
    sendJson(response, { ok: true, events: accountStore.listAudit(url.searchParams.get("limit")) });
    return true;
  }

  const userAction = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/(approve|disable|reject|promote|demote)$/);
  if (userAction && request.method === "POST") {
    const [, userId, action] = userAction;
    if ((action === "promote" || action === "demote") && !requireAdmin(response, user)) return true;
    if (action !== "promote" && action !== "demote" && !requireManagement(response, user)) return true;
    return handleAccountAction(response, async () => {
      const result = action === "approve"
        ? await accountStore.approve(userId, user)
        : action === "disable"
          ? await accountStore.disable(userId, user)
          : action === "reject"
            ? await accountStore.reject(userId, user)
            : await accountStore.setRole(userId, action === "promote" ? "manager" : "employee", user);
      sendJson(response, { ok: true, user: result });
    });
  }
  return false;
}

async function handleAccountAction(response, callback) {
  try {
    await callback();
  } catch (error) {
    sendJson(response, {
      ok: false,
      error: error.message || "Account request failed",
      code: error.code || "account_error"
    }, error.status || 500);
  }
  return true;
}

function requireAdmin(response, user) {
  if (!user) {
    sendJson(response, { ok: false, error: "Authentication required", code: "authentication_required" }, 401);
    return false;
  }
  if (user.role !== "admin") {
    sendJson(response, { ok: false, error: "Admin access required", code: "admin_required" }, 403);
    return false;
  }
  return true;
}

function requireManagement(response, user) {
  if (!user) {
    sendJson(response, { ok: false, error: "Authentication required", code: "authentication_required" }, 401);
    return false;
  }
  if (!isManagementRole(user)) {
    sendJson(response, { ok: false, error: "Manager access required", code: "manager_required" }, 403);
    return false;
  }
  return true;
}

function isManagementRole(user) {
  return user?.role === "admin" || user?.role === "manager";
}

async function handleSupplierRoute(request, response, url, user) {
  if (!url.pathname.startsWith("/api/suppliers")) return false;
  if (!requireManagement(response, user)) return true;

  try {
    if (url.pathname === "/api/suppliers" && request.method === "GET") {
      sendJson(response, { ok: true, suppliers: businessStore.listSuppliers() });
      return true;
    }
    if (url.pathname === "/api/suppliers" && request.method === "POST") {
      const supplier = await businessStore.saveSupplier(await readJsonBody(request), user);
      await recordSupplierAudit("supplier.saved", supplier, user);
      sendJson(response, { ok: true, supplier, suppliers: businessStore.listSuppliers() });
      return true;
    }
    if (request.method === "DELETE" && url.pathname.startsWith("/api/suppliers/")) {
      const supplierId = decodeURIComponent(url.pathname.slice("/api/suppliers/".length));
      const supplier = await businessStore.removeSupplier(supplierId);
      await recordSupplierAudit("supplier.removed", supplier, user);
      sendJson(response, { ok: true, supplier, suppliers: businessStore.listSuppliers() });
      return true;
    }
    sendJson(response, { ok: false, error: "Supplier route not found", code: "not_found" }, 404);
  } catch (error) {
    sendJson(response, {
      ok: false,
      error: error.message || "Supplier request failed",
      code: error.code || "supplier_error"
    }, error.status || 500);
  }
  return true;
}

async function handleFinanceRoute(request, response, url, user) {
  if (url.pathname !== "/api/finance") return false;
  if (!requireAdmin(response, user)) return true;
  if (request.method !== "GET") {
    sendJson(response, { ok: false, error: "Finance route not found", code: "not_found" }, 404);
    return true;
  }

  const from = cleanDateParameter(url.searchParams.get("from"));
  const to = cleanDateParameter(url.searchParams.get("to"));
  if (from && to && from > to) {
    sendJson(response, { ok: false, error: "Finance start date must be before the end date", code: "invalid_finance_period" }, 400);
    return true;
  }

  const finance = await readAppsScriptAction("finance", { from, to });
  if (!finance?.ok || !finance.totals || !finance.balances) {
    sendJson(response, {
      ok: false,
      error: finance?.error || "The live Apps Script is outdated and does not expose finance data. Deploy the current webhook/Code.gs version.",
      code: "finance_snapshot_unavailable"
    }, 502);
    return true;
  }
  const reconciledFinance = mergeRecordedPurchaseFinance(finance, buildRecordedPurchaseFinance(from, to));
  const sheet = await readSheetSnapshot();
  const commitments = buildFinanceCommitments(sheet);
  const ledgerBalance = finiteOrNull(finance.ledger?.balance ?? sheet?.inventory?.ledger?.balance);
  const safekeepingHeld = Number(reconciledFinance.balances.safekeeping || 0);
  const businessCash = ledgerBalance === null ? null : ledgerBalance - safekeepingHeld;
  const availableAfterCommitments = businessCash === null ? null : businessCash - commitments.total;
  sendJson(response, {
    ok: true,
    generatedAt: new Date().toISOString(),
    period: { from: finance.from || from, to: finance.to || to },
    totals: reconciledFinance.totals,
    balances: reconciledFinance.balances,
    breakdown: reconciledFinance.breakdown,
    monthly: reconciledFinance.monthly,
    coverage: reconciledFinance.coverage,
    cash: {
      ledgerBalance,
      safekeepingHeld,
      businessCash,
      committed: commitments.total,
      availableAfterCommitments
    },
    commitments
  });
  return true;
}

async function handleProductInsightRoute(request, response, url, user) {
  const route = url.pathname.match(/^\/api\/product-insights\/([^/]+)$/);
  if (!route) return false;
  if (!requireManagement(response, user)) return true;
  if (request.method !== "GET") {
    sendJson(response, { ok: false, error: "Product insight route not found", code: "not_found" }, 404);
    return true;
  }

  const requested = decodeURIComponent(route[1]);
  const catalog = readCatalogFiles();
  const requestedKey = inventoryKey(requested);
  const item = catalog.items.find(candidate => [
    candidate.name,
    candidate.label,
    candidate.tag,
    ...(Array.isArray(candidate.aliases) ? candidate.aliases : [])
  ].some(value => inventoryKey(value) === requestedKey));
  if (!item) {
    sendJson(response, { ok: false, error: "Product not found", code: "product_not_found" }, 404);
    return true;
  }

  const finance = await readAppsScriptAction("finance");
  if (!finance?.ok || !Array.isArray(finance.breakdown)) {
    sendJson(response, {
      ok: false,
      error: finance?.error || "Sales history is temporarily unavailable",
      code: "product_sales_unavailable"
    }, 502);
    return true;
  }

  const productKeys = new Set([
    item.name,
    item.label,
    item.tag,
    ...(Array.isArray(item.aliases) ? item.aliases : [])
  ].map(inventoryKey).filter(Boolean));
  const channels = new Map();
  finance.breakdown.forEach(row => {
    if (row.type !== "Revenue" || !productKeys.has(inventoryKey(row.label))) return;
    const category = String(row.category || "Other Sales");
    const current = channels.get(category) || { category, revenue: 0, transactions: 0 };
    current.revenue += Number(row.amount || 0);
    current.transactions += Number(row.count || 0);
    channels.set(category, current);
  });
  const channelRows = [...channels.values()]
    .map(channel => ({
      ...channel,
      revenue: roundFinanceMoney(channel.revenue),
      averageTransaction: channel.transactions
        ? roundFinanceMoney(channel.revenue / channel.transactions)
        : 0
    }))
    .sort((a, b) => b.revenue - a.revenue || a.category.localeCompare(b.category));
  const revenue = roundFinanceMoney(channelRows.reduce((sum, channel) => sum + channel.revenue, 0));
  const transactions = channelRows.reduce((sum, channel) => sum + channel.transactions, 0);
  sendJson(response, {
    ok: true,
    generatedAt: finance.generatedAt || new Date().toISOString(),
    item: { name: item.name, label: item.label, category: item.category },
    sales: {
      revenue,
      transactions,
      averageTransaction: transactions ? roundFinanceMoney(revenue / transactions) : 0,
      channels: channelRows
    }
  });
  return true;
}

function buildFinanceCommitments(sheet) {
  const supplyLines = [];
  businessStore.listSupplyOrders()
    .filter(order => order.status === "Ordered" || order.status === "Partially Received")
    .forEach(order => order.lines.forEach(line => {
      const quantity = Math.max(0, Number(line.quantity || 0) - Number(line.receivedQuantity || 0));
      const unitPrice = Math.max(0, Number(line.unitPrice || 0));
      if (!quantity) return;
      supplyLines.push({
        orderId: order.id,
        producer: order.producer,
        label: line.label || line.name,
        quantity,
        unitPrice,
        amount: roundFinanceMoney(quantity * unitPrice)
      });
    }));

  const buyOrderLines = businessStore.listStorefrontBuyOrders()
    .filter(order => order.status === "Active" || order.status === "Paused")
    .map(order => {
      const quantity = Math.max(0, Number(order.quantity || 0) - Number(order.filledQuantity || 0));
      const unitPrice = Math.max(0, Number(order.unitPrice || 0));
      return {
        orderId: order.id,
        label: order.itemLabel || order.itemName,
        quantity,
        unitPrice,
        amount: roundFinanceMoney(quantity * unitPrice)
      };
    })
    .filter(line => line.quantity > 0);

  const restock = buildRestockCommitment(sheet, [...supplyLines, ...buyOrderLines]);
  const supplyOrders = roundFinanceMoney(supplyLines.reduce((sum, line) => sum + line.amount, 0));
  const storefrontBuyOrders = roundFinanceMoney(buyOrderLines.reduce((sum, line) => sum + line.amount, 0));
  const total = roundFinanceMoney(supplyOrders + storefrontBuyOrders + restock.amount);
  return {
    total,
    supplyOrders,
    storefrontBuyOrders,
    missingStock: restock.amount,
    supplyLines,
    buyOrderLines,
    restockLines: restock.lines,
    missingProducts: restock.missingProducts,
    unpricedLines: restock.unpricedLines
  };
}

function buildRestockCommitment(sheet, committedPurchaseLines) {
  const catalog = readCatalogFiles();
  const inventory = sheet?.inventory || {};
  const demand = new Map();
  const missingProducts = [];
  const storage = new Map();
  const storageRows = Array.isArray(inventory.storage) && inventory.storage.length
    ? inventory.storage
    : inventory.materials;
  (Array.isArray(storageRows) ? storageRows : []).forEach(row => {
    const name = row.ingredient || row.itemName || row.itemLabel || row.name;
    storage.set(inventoryKey(name), Math.max(0, Number(row.storageCount ?? row.quantity ?? 0)));
  });
  (Array.isArray(inventory.products) ? inventory.products : []).forEach(product => {
    const name = product.itemName || product.itemLabel;
    const storefrontMissing = Math.max(0, Number(product.target || 0) - Number(product.currentStock || 0));
    const storageAvailable = storage.get(inventoryKey(name)) || 0;
    const missing = Math.max(0, storefrontMissing - storageAvailable);
    if (!missing) return;
    const recipe = catalog.recipes[name];
    missingProducts.push({
      label: product.itemLabel || name,
      quantity: missing,
      storefrontMissing,
      storageAvailable,
      recipeAvailable: Boolean(recipe)
    });
    if (!recipe) return;
    const batches = Math.ceil(missing / Math.max(1, Number(catalog.recipeYields[name] || 1)));
    recipe.forEach(([ingredient, quantity]) => {
      const key = inventoryKey(ingredient);
      const current = demand.get(key) || { ingredient, quantity: 0 };
      current.quantity += Number(quantity || 0) * batches;
      demand.set(key, current);
    });
  });

  const ordered = new Map();
  committedPurchaseLines.forEach(line => {
    const key = inventoryKey(line.label);
    ordered.set(key, (ordered.get(key) || 0) + Number(line.quantity || 0));
  });

  const lines = [];
  let unpricedLines = 0;
  demand.forEach((line, key) => {
    const quantity = Math.max(0, line.quantity - (storage.get(key) || 0) - (ordered.get(key) || 0));
    if (!quantity) return;
    const unitPrice = preferredFinanceMaterialPrice(line.ingredient, catalog.pricing);
    if (!unitPrice) unpricedLines += 1;
    lines.push({
      label: line.ingredient,
      quantity,
      unitPrice,
      amount: roundFinanceMoney(quantity * unitPrice)
    });
  });
  lines.sort((a, b) => b.amount - a.amount || a.label.localeCompare(b.label));
  return {
    amount: roundFinanceMoney(lines.reduce((sum, line) => sum + line.amount, 0)),
    lines,
    missingProducts,
    unpricedLines
  };
}

function preferredFinanceMaterialPrice(name, pricing) {
  const key = inventoryKey(name);
  const supplierPrices = businessStore.listSuppliers().flatMap(supplier =>
    supplier.products
      .filter(product => inventoryKey(product.name || product.label) === key)
      .map(product => Number(product.unitPrice || 0))
      .filter(price => price > 0)
  );
  if (supplierPrices.length) return Math.min(...supplierPrices);
  const matched = Object.entries(pricing?.materials || {})
    .find(([material]) => inventoryKey(material) === key);
  return Math.max(0, Number(matched?.[1]?.midpoint || 0));
}

function cleanDateParameter(value) {
  const date = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "";
}

function roundFinanceMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function buildRecordedPurchaseFinance(from, to) {
  const breakdown = new Map();
  const monthly = new Map();
  let expenses = 0;
  let receiptCount = 0;
  let legacyReceiptCount = 0;
  let supplierReceiptExpenses = 0;
  let manualBuyOrderUnits = 0;
  let manualBuyOrderExpenses = 0;

  function addExpense({ date, amount, category, label, source }) {
    if (!date || (from && date < from) || (to && date > to) || !amount) return false;
    expenses += amount;
    const key = `${category}|${label}|${source}`;
    const existing = breakdown.get(key) || {
      type: "Expense",
      category,
      label,
      source,
      amount: 0,
      count: 0
    };
    existing.amount += amount;
    existing.count += 1;
    breakdown.set(key, existing);
    const month = date.slice(0, 7);
    const monthEntry = monthly.get(month) || { month, revenue: 0, expenses: 0, profit: 0 };
    monthEntry.expenses += amount;
    monthly.set(month, monthEntry);
    return true;
  }

  businessStore.listSupplyOrders().forEach(order => {
    order.lines.forEach(line => {
      (Array.isArray(line.receipts) ? line.receipts : []).forEach(receipt => {
        const date = financeDateKey(receipt.receivedAt);
        const amount = roundFinanceMoney(Number(receipt.quantity || 0) * Number(receipt.unitPrice || 0));
        if (!addExpense({
          date,
          amount,
          category: "Supplier Purchases",
          label: line.label || line.name || "Supplier materials",
          source: order.producer || "Supplier"
        })) return;
        receiptCount += 1;
        supplierReceiptExpenses += amount;
        if (String(receipt.id || "").startsWith("legacy-receipt:")) legacyReceiptCount += 1;
      });
    });
  });

  const buyOrders = businessStore.listStorefrontBuyOrders();
  buyOrders.forEach(order => {
    const quantity = Math.max(0, Number(order.manualFilledQuantity || 0));
    const amount = roundFinanceMoney(quantity * Number(order.unitPrice || 0));
    if (!addExpense({
      date: financeDateKey(order.updatedAt || order.postedAt),
      amount,
      category: "Storefront Buy Orders",
      label: order.itemLabel || order.itemName || "Buy order purchase",
      source: "Manual fill"
    })) return;
    manualBuyOrderUnits += quantity;
    manualBuyOrderExpenses += amount;
  });

  return {
    expenses: roundFinanceMoney(expenses),
    breakdown: [...breakdown.values()].map(row => ({ ...row, amount: roundFinanceMoney(row.amount) })),
    monthly: [...monthly.values()].map(row => ({
      ...row,
      expenses: roundFinanceMoney(row.expenses),
      profit: roundFinanceMoney(row.revenue - row.expenses)
    })),
    coverage: {
      supplierReceipts: receiptCount,
      legacySupplierReceipts: legacyReceiptCount,
      supplierReceiptExpenses: roundFinanceMoney(supplierReceiptExpenses),
      buyOrdersReviewed: buyOrders.length,
      webhookBuyOrderFills: buyOrders.reduce((sum, order) => sum + (order.fillEvents || []).length, 0),
      manualBuyOrderUnits,
      manualBuyOrderExpenses: roundFinanceMoney(manualBuyOrderExpenses)
    }
  };
}

function mergeRecordedPurchaseFinance(finance, recorded) {
  const totals = {
    revenue: roundFinanceMoney(finance.totals.revenue),
    expenses: roundFinanceMoney(Number(finance.totals.expenses || 0) + recorded.expenses),
    profit: 0
  };
  totals.profit = roundFinanceMoney(totals.revenue - totals.expenses);
  const monthly = new Map((Array.isArray(finance.monthly) ? finance.monthly : []).map(row => [row.month, {
    month: row.month,
    revenue: Number(row.revenue || 0),
    expenses: Number(row.expenses || 0),
    profit: Number(row.profit || 0)
  }]));
  recorded.monthly.forEach(row => {
    const existing = monthly.get(row.month) || { month: row.month, revenue: 0, expenses: 0, profit: 0 };
    existing.expenses = roundFinanceMoney(existing.expenses + row.expenses);
    existing.profit = roundFinanceMoney(existing.revenue - existing.expenses);
    monthly.set(row.month, existing);
  });
  return {
    totals,
    balances: finance.balances,
    breakdown: [...(Array.isArray(finance.breakdown) ? finance.breakdown : []), ...recorded.breakdown]
      .sort((a, b) => a.type.localeCompare(b.type) || Number(b.amount || 0) - Number(a.amount || 0)),
    monthly: [...monthly.values()].sort((a, b) => a.month.localeCompare(b.month)),
    coverage: {
      ...(finance.coverage && typeof finance.coverage === "object" ? finance.coverage : {}),
      ...recorded.coverage
    }
  };
}

function financeDateKey(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

async function handleSupplyOrderRoute(request, response, url, user) {
  if (!url.pathname.startsWith("/api/supply-orders")) return false;
  if (!requireManagement(response, user)) return true;

  try {
    if (url.pathname === "/api/supply-orders" && request.method === "GET") {
      sendJson(response, { ok: true, orders: businessStore.listSupplyOrders() });
      return true;
    }
    if (url.pathname === "/api/supply-orders" && request.method === "POST") {
      const order = await businessStore.saveSupplyOrder(await readJsonBody(request), user);
      await recordSupplyOrderAudit("supply_order.saved", order, user);
      sendJson(response, { ok: true, order, orders: businessStore.listSupplyOrders() });
      return true;
    }
    const receiptRoute = url.pathname.match(/^\/api\/supply-orders\/([^/]+)\/receive$/);
    if (receiptRoute && request.method === "POST") {
      const orderId = decodeURIComponent(receiptRoute[1]);
      const payload = await readJsonBody(request);
      const operation = supplyReceiptQueue.then(() => receiveSupplyOrder(orderId, payload, user));
      supplyReceiptQueue = operation.catch(() => {});
      sendJson(response, await operation);
      return true;
    }
    if (request.method === "DELETE" && url.pathname.startsWith("/api/supply-orders/")) {
      const orderId = decodeURIComponent(url.pathname.slice("/api/supply-orders/".length));
      const order = await businessStore.removeSupplyOrder(orderId);
      await recordSupplyOrderAudit("supply_order.removed", order, user);
      sendJson(response, { ok: true, order, orders: businessStore.listSupplyOrders() });
      return true;
    }
    sendJson(response, { ok: false, error: "Supply order route not found", code: "not_found" }, 404);
  } catch (error) {
    sendJson(response, {
      ok: false,
      error: error.message || "Supply order request failed",
      code: error.code || "supply_order_error"
    }, error.status || 500);
  }
  return true;
}

async function handleStorefrontBuyOrderRoute(request, response, url, user) {
  if (!url.pathname.startsWith("/api/storefront-buy-orders")) return false;
  if (!requireManagement(response, user)) return true;

  try {
    if (url.pathname === "/api/storefront-buy-orders" && request.method === "GET") {
      await reconcileStorefrontBuyOrdersFromSheet();
      sendJson(response, { ok: true, orders: businessStore.listStorefrontBuyOrders() });
      return true;
    }
    if (url.pathname === "/api/storefront-buy-orders" && request.method === "POST") {
      const order = await businessStore.saveStorefrontBuyOrder(await readJsonBody(request), user);
      await recordStorefrontBuyOrderAudit("storefront_buy_order.saved", order, user);
      sendJson(response, { ok: true, order, orders: businessStore.listStorefrontBuyOrders() });
      return true;
    }
    const fillRoute = url.pathname.match(/^\/api\/storefront-buy-orders\/([^/]+)\/fill$/);
    if (fillRoute && request.method === "POST") {
      const orderId = decodeURIComponent(fillRoute[1]);
      const payload = await readJsonBody(request);
      const order = await businessStore.setStorefrontBuyOrderFill(orderId, payload.filledQuantity, user);
      await recordStorefrontBuyOrderAudit("storefront_buy_order.fill_adjusted", order, user);
      sendJson(response, { ok: true, order, orders: businessStore.listStorefrontBuyOrders() });
      return true;
    }
    if (request.method === "DELETE" && url.pathname.startsWith("/api/storefront-buy-orders/")) {
      const orderId = decodeURIComponent(url.pathname.slice("/api/storefront-buy-orders/".length));
      const order = await businessStore.removeStorefrontBuyOrder(orderId);
      await recordStorefrontBuyOrderAudit("storefront_buy_order.removed", order, user);
      sendJson(response, { ok: true, order, orders: businessStore.listStorefrontBuyOrders() });
      return true;
    }
    sendJson(response, { ok: false, error: "Storefront buy order route not found", code: "not_found" }, 404);
    return true;
  } catch (error) {
    sendJson(response, { ok: false, error: error.message, code: error.code || "storefront_buy_order_failed" }, error.status || 500);
    return true;
  }
}

async function handleSalesOrderRoute(request, response, url, user) {
  if (!url.pathname.startsWith("/api/sales-orders")) return false;

  try {
    if (url.pathname === "/api/sales-orders" && request.method === "GET") {
      sendJson(response, { ok: true, orders: businessStore.listSalesOrders() });
      return true;
    }
    if (url.pathname === "/api/sales-orders/import" && request.method === "POST") {
      const payload = await readJsonBody(request);
      const result = await businessStore.importSalesOrders(payload.orders, user);
      await recordSalesOrderImportAudit(result, user);
      sendJson(response, { ok: true, ...result });
      return true;
    }
    if (url.pathname === "/api/sales-orders" && request.method === "POST") {
      const order = await businessStore.saveSalesOrder(await readJsonBody(request), user);
      await recordSalesOrderAudit("sales_order.saved", order, user);
      sendJson(response, { ok: true, order, orders: businessStore.listSalesOrders() });
      return true;
    }
    if (request.method === "DELETE" && url.pathname.startsWith("/api/sales-orders/")) {
      const orderId = decodeURIComponent(url.pathname.slice("/api/sales-orders/".length));
      const linkedBatch = businessStore.listProductionBatches().find(batch =>
        batch.sourceType === "Customer Order"
        && batch.sourceId === orderId
        && batch.status !== "Cancelled"
      );
      if (linkedBatch) {
        throw salesOrderError(
          "This order is linked to production and must be cancelled instead of removed",
          409,
          "sales_order_has_production"
        );
      }
      const order = await businessStore.removeSalesOrder(orderId);
      await recordSalesOrderAudit("sales_order.removed", order, user);
      sendJson(response, { ok: true, order, orders: businessStore.listSalesOrders() });
      return true;
    }
    sendJson(response, { ok: false, error: "Sales order route not found", code: "not_found" }, 404);
  } catch (error) {
    sendJson(response, {
      ok: false,
      error: error.message || "Sales order request failed",
      code: error.code || "sales_order_error"
    }, error.status || 500);
  }
  return true;
}

function salesOrderError(message, status, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

async function handleDailyCloseRoute(request, response, url, user) {
  if (!url.pathname.startsWith("/api/daily-closes")) return false;
  if (!requireManagement(response, user)) return true;

  try {
    if (url.pathname === "/api/daily-closes" && request.method === "GET") {
      sendJson(response, { ok: true, closes: businessStore.listDailyCloses() });
      return true;
    }
    if (url.pathname === "/api/daily-closes" && request.method === "POST") {
      const close = await businessStore.saveDailyClose(await readJsonBody(request), await buildDailyCloseSnapshot(), user);
      await recordDailyCloseAudit("daily_close.saved", close, user);
      sendJson(response, { ok: true, close, closes: businessStore.listDailyCloses() });
      return true;
    }
    const actionRoute = url.pathname.match(/^\/api\/daily-closes\/([^/]+)\/(finalize|reopen)$/);
    if (actionRoute && request.method === "POST") {
      const closeId = decodeURIComponent(actionRoute[1]);
      const action = actionRoute[2];
      if (action === "reopen") {
        if (!requireAdmin(response, user)) return true;
        const close = await businessStore.reopenDailyClose(closeId, user);
        await recordDailyCloseAudit("daily_close.reopened", close, user);
        sendJson(response, { ok: true, close, closes: businessStore.listDailyCloses() });
        return true;
      }
      const payload = await readJsonBody(request);
      const close = await businessStore.finalizeDailyClose(
        closeId,
        payload.revision,
        await buildDailyCloseSnapshot(),
        user
      );
      await recordDailyCloseAudit("daily_close.finalized", close, user);
      sendJson(response, { ok: true, close, closes: businessStore.listDailyCloses() });
      return true;
    }
    sendJson(response, { ok: false, error: "Daily close route not found", code: "not_found" }, 404);
  } catch (error) {
    sendJson(response, {
      ok: false,
      error: error.message || "Daily close request failed",
      code: error.code || "daily_close_error"
    }, error.status || 500);
  }
  return true;
}

async function handleProductionBatchRoute(request, response, url, user) {
  if (!url.pathname.startsWith("/api/production-batches")) return false;

  try {
    if (url.pathname === "/api/production-batches" && request.method === "GET") {
      sendJson(response, { ok: true, batches: businessStore.listProductionBatches() });
      return true;
    }
    if (url.pathname === "/api/production-batches" && request.method === "POST") {
      if (!requireManagement(response, user)) return true;
      const prepared = prepareProductionBatch(await readJsonBody(request));
      const batch = await businessStore.createProductionBatch(prepared, user);
      await recordProductionBatchAudit("production_batch.created", batch, user);
      sendJson(response, { ok: true, batch, batches: businessStore.listProductionBatches() });
      return true;
    }

    const actionRoute = url.pathname.match(/^\/api\/production-batches\/([^/]+)\/(start|progress|cancel)$/);
    if (actionRoute && request.method === "POST") {
      const batchId = decodeURIComponent(actionRoute[1]);
      const action = actionRoute[2];
      if (action === "start") {
        const batch = await businessStore.startProductionBatch(batchId, user);
        await recordProductionBatchAudit("production_batch.started", batch, user);
        sendJson(response, { ok: true, batch, batches: businessStore.listProductionBatches() });
        return true;
      }
      if (action === "progress") {
        const payload = await readJsonBody(request);
        const operation = productionProgressQueue.then(() => recordProductionProgress(batchId, payload, user));
        productionProgressQueue = operation.catch(() => {});
        sendJson(response, await operation);
        return true;
      }
      if (!requireManagement(response, user)) return true;
      const batch = await businessStore.cancelProductionBatch(batchId, user);
      await recordProductionBatchAudit("production_batch.cancelled", batch, user);
      sendJson(response, { ok: true, batch, batches: businessStore.listProductionBatches() });
      return true;
    }

    sendJson(response, { ok: false, error: "Production batch route not found", code: "not_found" }, 404);
  } catch (error) {
    sendJson(response, {
      ok: false,
      error: error.message || "Production batch request failed",
      code: error.code || "production_batch_error"
    }, error.status || 500);
  }
  return true;
}

function prepareProductionBatch(input) {
  const catalog = readCatalogFiles();
  const itemByKey = new Map();
  catalog.items.forEach(item => {
    [item.name, item.label, item.tag, ...(Array.isArray(item.aliases) ? item.aliases : [])].forEach(value => {
      const key = inventoryKey(value);
      if (key && !itemByKey.has(key)) itemByKey.set(key, item);
    });
  });
  const lines = new Map();
  (Array.isArray(input.lines) ? input.lines : []).slice(0, 50).forEach(sourceLine => {
    const item = itemByKey.get(inventoryKey(sourceLine.itemName || sourceLine.name || sourceLine.itemLabel));
    if (!item) throw productionError("Production batches can only contain catalog products", 400, "production_item_unknown");
    const recipe = catalog.recipes[item.name];
    if (!Array.isArray(recipe) || !recipe.length) {
      throw productionError(`No recipe is available for ${item.label || item.name}`, 400, "production_recipe_missing");
    }
    const quantity = Number(sourceLine.requestedQuantity || sourceLine.quantity);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw productionError("Production quantities must be positive whole numbers", 400, "invalid_production_quantity");
    }
    const existing = lines.get(item.name) || {
      id: crypto.randomUUID(),
      itemName: item.name,
      itemLabel: item.label || item.name,
      requestedQuantity: 0,
      recipeYield: Math.max(1, Number(catalog.recipeYields[item.name] || 1)),
      recipe: recipe.map(([ingredient, componentQuantity]) => ({
        ingredient: canonicalInventoryName(ingredient),
        quantity: Number(componentQuantity || 0)
      }))
    };
    existing.requestedQuantity += quantity;
    lines.set(item.name, existing);
  });
  return {
    id: String(input.id || crypto.randomUUID()),
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    reference: input.reference,
    dueDate: input.dueDate,
    priority: input.priority,
    assignedTo: input.assignedTo,
    notes: input.notes,
    lines: [...lines.values()]
  };
}

async function recordProductionProgress(batchId, payload, user) {
  let batch = businessStore.getProductionBatch(batchId);
  if (!batch) throw productionError("Production batch not found", 404, "not_found");

  if (!batch.pendingProgress) {
    const pending = await prepareProductionProgress(batch, payload, user);
    batch = await businessStore.beginProductionProgress(batchId, pending, user);
  }
  const pending = batch.pendingProgress;
  for (const entry of pending.operations) {
    const result = await syncGuiPayload({ action: "manual_operation", entry });
    if (!result.ok) {
      throw productionError(
        `Sheet update paused: ${result.error || "unknown error"}. The same progress is saved and can be retried safely.`,
        502,
        "production_sync_pending"
      );
    }
  }

  const updated = await businessStore.commitProductionProgress(batchId, pending.id, user);
  const auditAction = updated.status === "Completed" ? "production_batch.completed" : "production_batch.progressed";
  await recordProductionBatchAudit(auditAction, updated, user, pending);
  return { ok: true, batch: updated, batches: businessStore.listProductionBatches() };
}

async function prepareProductionProgress(batch, payload, user) {
  const requested = new Map((Array.isArray(payload.completions) ? payload.completions : [])
    .map(completion => [String(completion.lineId || ""), Number(completion.completedCrafts)]));
  const targets = [];
  const operations = [];
  const requiredMaterials = new Map();

  batch.lines.forEach(line => {
    if (!requested.has(line.id)) return;
    const completedCrafts = requested.get(line.id);
    if (!Number.isInteger(completedCrafts)
      || completedCrafts <= Number(line.completedCrafts || 0)
      || completedCrafts > Number(line.plannedCrafts || 0)) {
      throw productionError("Completed craft cycles must increase without exceeding the plan", 400, "invalid_production_progress");
    }
    const previousCrafts = Number(line.completedCrafts || 0);
    const craftDelta = completedCrafts - previousCrafts;
    targets.push({ lineId: line.id, previousCrafts, completedCrafts });
    line.recipe.forEach(component => {
      const quantity = Number(component.quantity || 0) * craftDelta;
      const itemName = canonicalInventoryName(component.ingredient);
      const key = inventoryKey(itemName);
      requiredMaterials.set(key, {
        itemName,
        quantity: Number(requiredMaterials.get(key)?.quantity || 0) + quantity
      });
      operations.push(productionOperation({
        batch,
        line,
        previousCrafts,
        completedCrafts,
        suffix: `use:${key}`,
        kind: "Production Use",
        itemName,
        quantity,
        employee: user.fullName
      }));
    });
    if (batch.sourceType !== "Storefront Restock") {
      operations.push(productionOperation({
        batch,
        line,
        previousCrafts,
        completedCrafts,
        suffix: "output",
        kind: "Production Output",
        itemName: line.itemName,
        itemLabel: line.itemLabel,
        quantity: craftDelta * Number(line.recipeYield || 1),
        employee: user.fullName
      }));
    }
  });
  if (!targets.length) {
    throw productionError("Enter at least one newly completed craft cycle", 400, "production_progress_required");
  }

  const snapshot = await readSheetSnapshot();
  if (!snapshot?.ok || !Array.isArray(snapshot.inventory?.materials)) {
    throw productionError(
      `Storage could not be checked${snapshot?.error ? `: ${snapshot.error}` : ""}`,
      502,
      "production_storage_unavailable"
    );
  }
  const storage = materialStorageCounts(snapshot.inventory.materials);
  const reservedBefore = productionReservationsBefore(batch.id);
  const shortages = [...requiredMaterials.entries()].map(([key, requirement]) => ({
    ...requirement,
    available: Math.max(0,
      Number(storage.get(key)?.quantity || 0) - Number(reservedBefore.get(key) || 0)
    )
  })).filter(requirement => requirement.available < requirement.quantity);
  if (shortages.length) {
    const summary = shortages.map(line => `${line.itemName} ${line.available}/${line.quantity}`).join(", ");
    throw productionError(`Not enough materials in storage: ${summary}`, 409, "production_material_shortage");
  }

  return {
    id: crypto.randomUUID(),
    targets,
    operations,
    createdAt: new Date().toISOString(),
    createdBy: user.fullName
  };
}

function productionReservationsBefore(batchId) {
  const reserved = new Map();
  for (const batch of businessStore.listProductionBatches()) {
    if (batch.id === batchId) break;
    if (batch.status !== "Planned" && batch.status !== "In Progress") continue;
    batch.lines.forEach(line => {
      const remainingCrafts = Math.max(0, Number(line.plannedCrafts || 0) - Number(line.completedCrafts || 0));
      line.recipe.forEach(component => {
        const key = inventoryKey(component.ingredient);
        reserved.set(key, Number(reserved.get(key) || 0) + remainingCrafts * Number(component.quantity || 0));
      });
    });
  }
  return reserved;
}

function productionOperation({ batch, line, previousCrafts, completedCrafts, suffix, kind, itemName, itemLabel, quantity, employee }) {
  const fingerprint = `${batch.id}:${line.id}:${previousCrafts}:${completedCrafts}:${suffix}`;
  const id = `production-${crypto.createHash("sha256").update(fingerprint).digest("hex").slice(0, 28)}`;
  return {
    id,
    kind,
    location: "Storage",
    itemName,
    itemLabel: itemLabel || itemName,
    quantity,
    amount: 0,
    employee,
    note: `Production batch ${batch.reference || batch.id}: ${line.itemLabel || line.itemName}`
  };
}

function productionError(message, status, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

async function reconcileStorefrontBuyOrdersFromSheet(sheetSnapshot = null) {
  const snapshot = sheetSnapshot || await readSheetSnapshot();
  const purchases = snapshot?.inventory?.buyOrderPurchases;
  if (Array.isArray(purchases)) await businessStore.reconcileStorefrontBuyOrders(purchases);
  return snapshot;
}

async function receiveSupplyOrder(orderId, payload, user) {
  const requestedReceipts = Array.isArray(payload.receipts) ? payload.receipts.slice(0, 100) : [];
  if (!requestedReceipts.length) {
    throw supplyOrderError("Enter at least one quantity to receive", 400, "receipts_required");
  }

  const order = businessStore.getSupplyOrder(orderId);
  if (!order) throw supplyOrderError("Supply order not found", 404, "not_found");
  if (order.status !== "Ordered" && order.status !== "Partially Received") {
    throw supplyOrderError("Only ordered supplies can be received", 409, "order_not_receivable");
  }

  const seenLineIds = new Set();
  requestedReceipts.forEach(receipt => {
    const lineId = String(receipt.lineId || "").trim();
    const line = order.lines.find(candidate => candidate.id === lineId);
    const quantity = Number(receipt.quantity);
    if (!line) throw supplyOrderError("Supply order line not found", 404, "line_not_found");
    if (seenLineIds.has(lineId)) {
      throw supplyOrderError("Each material can only appear once in a receipt", 400, "duplicate_receipt_line");
    }
    const remaining = Math.max(0, Number(line.quantity || 0) - Number(line.receivedQuantity || 0));
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > remaining) {
      throw supplyOrderError(`Receipt for ${line.label || line.name} must be between 1 and ${remaining}`, 400, "invalid_receipt_quantity");
    }
    seenLineIds.add(lineId);
  });

  const sheetSnapshot = await readSheetSnapshot();
  if (!sheetSnapshot?.ok || !Array.isArray(sheetSnapshot.inventory?.materials)) {
    throw supplyOrderError(
      `Storage could not be read from the Sheet${sheetSnapshot?.error ? `: ${sheetSnapshot.error}` : ""}`,
      502,
      "storage_snapshot_unavailable"
    );
  }
  const storage = materialStorageCounts(sheetSnapshot.inventory.materials);
  const processed = [];
  let updatedOrder = order;

  for (const requested of requestedReceipts) {
    const currentOrder = businessStore.getSupplyOrder(orderId);
    const line = currentOrder.lines.find(candidate => candidate.id === String(requested.lineId || "").trim());
    const quantity = Number(requested.quantity);
    const previouslyReceived = Number(line.receivedQuantity || 0);
    const cumulativeReceived = previouslyReceived + quantity;
    const key = inventoryKey(line.name || line.label);
    const currentStorage = storage.get(key) || { quantity: 0, name: canonicalInventoryName(line.name || line.label) };
    const absoluteCount = Number(currentStorage.quantity || 0) + quantity;
    const operationId = `supply-receipt:${orderId}:${line.id}:${cumulativeReceived}`;
    const itemName = currentStorage.name || canonicalInventoryName(line.name || line.label);
    const syncResult = await syncGuiPayload({
      action: "manual_operation",
      entry: {
        id: operationId,
        createdAt: new Date().toISOString(),
        kind: "Stock Count",
        location: "Storage",
        itemName,
        itemLabel: itemName,
        itemTag: "",
        quantity: absoluteCount,
        employee: user.fullName,
        amount: "",
        note: `Received ${quantity} from ${currentOrder.producer} / supply order ${currentOrder.id}`
      }
    });
    if (!syncResult?.ok) {
      throw supplyOrderError(
        `Storage update failed for ${line.label || line.name}: ${syncResult?.error || "Sheet rejected the receipt"}`,
        502,
        "supply_receipt_sync_failed"
      );
    }

    updatedOrder = await businessStore.receiveSupplyLine(orderId, line.id, quantity, user, {
      id: operationId,
      receivedAt: new Date().toISOString(),
      unitPrice: line.unitPrice
    });
    storage.set(key, { quantity: absoluteCount, name: itemName });
    const receipt = {
      id: operationId,
      lineId: line.id,
      itemName,
      quantity,
      receivedQuantity: cumulativeReceived,
      storageCount: absoluteCount
    };
    processed.push(receipt);
    await recordSupplyReceiptAudit(updatedOrder, line, receipt, user);
  }

  return { ok: true, order: updatedOrder, orders: businessStore.listSupplyOrders(), receipts: processed };
}

function materialStorageCounts(materials) {
  const counts = new Map();
  materials.forEach(material => {
    const name = material.ingredient || material.itemName || material.itemLabel || material.name;
    const key = inventoryKey(name);
    if (!key) return;
    counts.set(key, {
      quantity: Number.isFinite(Number(material.storageCount)) ? Number(material.storageCount) : 0,
      name: canonicalInventoryName(name)
    });
  });
  return counts;
}

function inventoryKey(value) {
  const key = String(value || "").trim().toLowerCase();
  return key === "wood" || key === "soft wood" || key === "softwood" ? "softwood" : key;
}

function canonicalInventoryName(value) {
  return inventoryKey(value) === "softwood" ? "Softwood" : String(value || "").trim();
}

function supplyOrderError(message, status, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

async function recordSupplyOrderAudit(action, order, user) {
  if (!accountStore) return;
  await accountStore.recordAudit({
    category: "procurement",
    action,
    actorId: user.id,
    actorName: user.fullName,
    subjectId: order.id,
    subjectName: order.producer,
    fingerprint: `${action}:${order.id}:${order.updatedAt}`,
    details: {
      producer: order.producer,
      status: order.status,
      lineCount: order.lines.length,
      total: order.lines.reduce((sum, line) => sum + Number(line.quantity || 0) * Number(line.unitPrice || 0), 0)
    }
  });
}

async function recordSalesOrderAudit(action, order, user) {
  if (!accountStore) return;
  await accountStore.recordAudit({
    category: "sales",
    action,
    actorId: user.id,
    actorName: user.fullName,
    subjectId: order.id,
    subjectName: order.customer || "Unnamed customer",
    fingerprint: `${action}:${order.id}:${order.revision}`,
    details: {
      status: order.status,
      priority: order.priority,
      handler: order.handler,
      lineCount: order.lines.length,
      subtotal: order.lines.reduce((sum, line) => sum + Number(line.quantity || 0) * Number(line.unitPrice || 0), 0),
      revision: order.revision
    }
  });
}

async function recordSalesOrderImportAudit(result, user) {
  if (!accountStore || !result.imported) return;
  await accountStore.recordAudit({
    category: "sales",
    action: "sales_order.imported",
    actorId: user.id,
    actorName: user.fullName,
    subjectId: user.id,
    subjectName: user.fullName,
    fingerprint: `sales_order.imported:${user.id}:${result.imported}:${Date.now()}`,
    details: {
      imported: result.imported,
      skipped: result.skipped
    }
  });
}

async function recordDailyCloseAudit(action, close, user) {
  if (!accountStore) return;
  const difference = Number.isFinite(close.countedLedgerBalance) && Number.isFinite(close.snapshot?.ledgerBalance)
    ? close.countedLedgerBalance - close.snapshot.ledgerBalance
    : null;
  await accountStore.recordAudit({
    category: "reconciliation",
    action,
    actorId: user.id,
    actorName: user.fullName,
    subjectId: close.id,
    subjectName: close.businessDate,
    fingerprint: `${action}:${close.id}:${close.revision}`,
    details: {
      status: close.status,
      revision: close.revision,
      ledgerDifference: difference,
      storefrontConfirmed: close.storefrontConfirmed,
      storageConfirmed: close.storageConfirmed,
      openIssues: close.snapshot?.issues?.length || 0
    }
  });
}

async function recordStorefrontBuyOrderAudit(action, order, user) {
  if (!accountStore) return;
  await accountStore.recordAudit({
    category: "procurement",
    action,
    actorId: user.id,
    actorName: user.fullName,
    subjectId: order.id,
    subjectName: order.itemLabel || order.itemName,
    details: {
      status: order.status,
      quantity: order.quantity,
      filledQuantity: order.filledQuantity,
      unitPrice: order.unitPrice
    }
  });
}

async function recordSupplierAudit(action, supplier, user) {
  if (!accountStore) return;
  await accountStore.recordAudit({
    category: "procurement",
    action,
    actorId: user.id,
    actorName: user.fullName,
    subjectId: supplier.id,
    subjectName: supplier.name,
    fingerprint: `${action}:${supplier.id}:${supplier.updatedAt}`,
    details: {
      category: supplier.category,
      location: supplier.location,
      products: supplier.products.length,
      employeeContacts: supplier.employees.length
    }
  }).catch(error => console.error("Unable to write supplier audit event:", error.message));
}

async function recordProductionBatchAudit(action, batch, user, progress = null) {
  if (!accountStore) return;
  const plannedCrafts = batch.lines.reduce((sum, line) => sum + Number(line.plannedCrafts || 0), 0);
  const completedCrafts = batch.lines.reduce((sum, line) => sum + Number(line.completedCrafts || 0), 0);
  const progressedCrafts = (progress?.targets || []).reduce((sum, target) => {
    return sum + Math.max(0, Number(target.completedCrafts || 0) - Number(target.previousCrafts || 0));
  }, 0);
  await accountStore.recordAudit({
    category: "production",
    action,
    actorId: user.id,
    actorName: user.fullName,
    subjectId: batch.id,
    subjectName: batch.reference || batch.sourceType,
    fingerprint: `${action}:${batch.id}:${progress?.id || batch.updatedAt}`,
    details: {
      status: batch.status,
      sourceType: batch.sourceType,
      reference: batch.reference,
      lineCount: batch.lines.length,
      plannedCrafts,
      completedCrafts,
      progressedCrafts,
      assignedTo: batch.assignedTo
    }
  });
}

async function recordSupplyReceiptAudit(order, line, receipt, user) {
  if (!accountStore) return;
  await accountStore.recordAudit({
    category: "procurement",
    action: "supply_order.received",
    actorId: user.id,
    actorName: user.fullName,
    subjectId: order.id,
    subjectName: order.producer,
    fingerprint: receipt.id,
    details: {
      producer: order.producer,
      status: order.status,
      item: line.label || line.name,
      quantity: receipt.quantity,
      unitPrice: line.unitPrice,
      amount: roundFinanceMoney(Number(receipt.quantity || 0) * Number(line.unitPrice || 0)),
      receivedQuantity: receipt.receivedQuantity,
      storageCount: receipt.storageCount
    }
  });
}

function requiresAdmin(payload) {
  if (payload.action !== "manual_operation") return false;
  return new Set([
    "Payroll Payment",
    "Owner Capital Deposit",
    "Owner Withdrawal",
    "Safekeeping Deposit",
    "Safekeeping Withdrawal"
  ]).has(payload.entry?.kind);
}

function requiresManagement(payload) {
  return payload.action === "stock_target"
    || payload.action === "manual_operation"
    || payload.action === "resolve_exception"
    || payload.action === "ignore_exception";
}

function stampEmployee(payload, user) {
  if ((payload.action === "manual_operation" || payload.action === "time_clock") && payload.entry) {
    payload.entry.employee = user.fullName;
  }
  if ((payload.action === "resolve_exception" || payload.action === "ignore_exception") && payload.exception) {
    payload.exception.resolvedBy = user.fullName;
  }
}

async function auditGuiPayload(payload, user, syncResult) {
  if ((payload.action === "resolve_exception" || payload.action === "ignore_exception") && payload.exception) {
    const resolved = payload.action === "resolve_exception";
    await accountStore.recordAudit({
      category: "webhook",
      action: resolved ? "webhook_exception.resolved" : "webhook_exception.ignored",
      actorId: user.id,
      actorName: user.fullName,
      subjectId: payload.exception.webhookId,
      subjectName: payload.exception.itemName || payload.exception.discordItemLabel || "Webhook event",
      fingerprint: `${payload.action}:${payload.exception.webhookId}`,
      details: {
        item: payload.exception.itemName,
        quantity: payload.exception.quantity,
        eventType: payload.exception.eventType,
        direction: payload.exception.direction,
        rememberMapping: payload.exception.rememberMapping,
        note: payload.exception.note,
        sheetSync: Boolean(syncResult?.ok)
      }
    });
    return;
  }
  if (payload.action === "time_clock" && payload.entry) {
    const clockedOut = Boolean(payload.entry.clockOut);
    await accountStore.recordAudit({
      category: "time_clock",
      action: clockedOut ? "clock.out" : "clock.in",
      actorId: user.id,
      actorName: user.fullName,
      subjectId: user.id,
      subjectName: user.fullName,
      fingerprint: `clock:${payload.entry.id}:${clockedOut ? "out" : "in"}`,
      details: {
        clockIn: payload.entry.clockIn,
        clockOut: payload.entry.clockOut,
        durationMinutes: payload.entry.durationMinutes,
        sheetSync: Boolean(syncResult?.ok)
      }
    });
    return;
  }
  if (payload.action === "manual_operation" && payload.entry) {
    const financeKinds = new Set([
      "Owner Capital Deposit",
      "Owner Withdrawal",
      "Safekeeping Deposit",
      "Safekeeping Withdrawal"
    ]);
    const financeEntry = financeKinds.has(payload.entry.kind);
    await accountStore.recordAudit({
      category: financeEntry ? "finance" : "operations",
      action: financeEntry ? "finance.funds_recorded" : "operation.recorded",
      actorId: user.id,
      actorName: user.fullName,
      subjectId: user.id,
      subjectName: user.fullName,
      fingerprint: `operation:${payload.entry.id}`,
      details: {
        kind: payload.entry.kind,
        location: payload.entry.location,
        item: payload.entry.itemLabel || payload.entry.itemName,
        quantity: payload.entry.quantity,
        amount: payload.entry.amount,
        note: payload.entry.note,
        sheetSync: Boolean(syncResult?.ok)
      }
    });
    return;
  }
  if (payload.action === "stock_target" && payload.target) {
    const removed = Boolean(payload.target.deleting) || Number(payload.target.target) === 0;
    await accountStore.recordAudit({
      category: "operations",
      action: removed ? "target.removed" : "target.updated",
      actorId: user.id,
      actorName: user.fullName,
      subjectId: user.id,
      subjectName: user.fullName,
      fingerprint: `target:${payload.target.itemTag || payload.target.itemName || payload.target.itemLabel}:${payload.target.updatedAt || ""}:${removed}`,
      details: {
        item: payload.target.itemLabel || payload.target.itemName,
        target: payload.target.target,
        sheetSync: Boolean(syncResult?.ok)
      }
    });
  }
}

function serveStatic(response, pathname) {
  if (!publicFiles.has(pathname)) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }
  const filePath = path.normalize(path.join(root, pathname));
  if (!filePath.startsWith(root)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    response.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": pathname.endsWith(".html") ? "no-store" : "public, max-age=300"
    });
    response.end(data);
  });
}

function isPublicAsset(pathname) {
  return pathname === "/login.html"
    || pathname === "/login.js"
    || pathname === "/styles.css"
    || pathname === "/assets/frontier-firearms-logo.png";
}

function readCookie(request, name) {
  const cookies = String(request.headers.cookie || "").split(";");
  for (const cookie of cookies) {
    const separator = cookie.indexOf("=");
    if (separator === -1) continue;
    if (cookie.slice(0, separator).trim() === name) {
      return decodeURIComponent(cookie.slice(separator + 1).trim());
    }
  }
  return "";
}

function setSessionCookie(response, request, token) {
  const secure = isHttps(request) ? "; Secure" : "";
  response.setHeader(
    "Set-Cookie",
    `ff_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECONDS}${secure}`
  );
}

function clearSessionCookie(response, request) {
  const secure = isHttps(request) ? "; Secure" : "";
  response.setHeader("Set-Cookie", `ff_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}

function isHttps(request) {
  return process.env.NODE_ENV === "production"
    || String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";
}

function redirect(response, location) {
  response.writeHead(302, { Location: location, "Cache-Control": "no-store" });
  response.end();
}

function allowAuthAttempt(request) {
  const now = Date.now();
  const windowStart = now - 15 * 60 * 1000;
  const key = String(request.headers["x-forwarded-for"] || request.socket.remoteAddress || "unknown")
    .split(",")[0]
    .trim();
  const attempts = (loginAttempts.get(key) || []).filter(timestamp => timestamp > windowStart);
  attempts.push(now);
  loginAttempts.set(key, attempts);
  if (loginAttempts.size > 500) {
    for (const [candidate, timestamps] of loginAttempts) {
      if (!timestamps.some(timestamp => timestamp > windowStart)) loginAttempts.delete(candidate);
    }
  }
  return attempts.length <= 20;
}

function isAuthorized(request) {
  const header = String(request.headers.authorization || "");
  const match = header.match(/^Basic\s+(.+)$/i);
  if (!match) return false;

  try {
    const decoded = Buffer.from(match[1], "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator === -1) return false;
    return safeEqual(decoded.slice(0, separator), authUser)
      && safeEqual(decoded.slice(separator + 1), authPassword);
  } catch {
    return false;
  }
}

function safeEqual(actual, expected) {
  const actualBuffer = Buffer.from(String(actual));
  const expectedBuffer = Buffer.from(String(expected));
  return actualBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

startServer().catch(error => {
  console.error("Unable to start Still Water app:", error.message);
  process.exitCode = 1;
});

async function startServer() {
  await businessStore.initialize();
  if (accountAuthEnabled) {
    await accountStore.initialize({
      adminFullName: process.env.ADMIN_FULL_NAME || "",
      adminPassword: process.env.ADMIN_PASSWORD || ""
    });
  }
  server.listen(port, () => {
    const mode = accountAuthEnabled ? "personal accounts" : authPassword ? "legacy Basic Auth" : "no authentication";
    console.log(`Frontier Firearms - Still Water app running at http://localhost:${port} with ${mode}`);
  });
}

function sendJson(response, payload, status = payload.ok === false ? 503 : 200) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

function readJsonBody(request) {
  return new Promise(resolve => {
    let body = "";
    request.on("data", chunk => {
      body += chunk;
      if (body.length > 1_000_000) request.destroy();
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        resolve({});
      }
    });
    request.on("error", () => resolve({}));
  });
}

async function getBootstrapData(user) {
  const data = readCatalogFiles();
  const sheetSnapshot = await readSheetSnapshot();
  const canManage = !user || isManagementRole(user);
  if (canManage) await reconcileStorefrontBuyOrdersFromSheet(sheetSnapshot);
  if (sheetSnapshot?.inventory) delete sheetSnapshot.inventory.buyOrderPurchases;
  if (!canManage && sheetSnapshot) {
    delete sheetSnapshot.reviewExceptions;
    if (sheetSnapshot.inventory) delete sheetSnapshot.inventory.ledger;
  }
  const dailyCloses = canManage
    ? businessStore.listDailyCloses()
    : businessStore.listDailyCloses()
      .filter(close => close.status === "Finalized")
      .slice(0, 20)
      .map(employeeDailyCloseView);
  return {
    source: sheetSnapshot ? "apps-script-and-local-app-files" : "local-app-files",
    generatedAt: new Date().toISOString(),
    user,
    sheetConfigured: Boolean(process.env.APPS_SCRIPT_URL),
    sheet: sheetSnapshot,
    categories: data.categories,
    items: data.items,
    recipeCount: Object.keys(data.recipes).length,
    recipes: data.recipes,
    recipeYields: data.recipeYields,
    salesOrders: businessStore.listSalesOrders(),
    storefrontBuyOrders: canManage ? businessStore.listStorefrontBuyOrders() : [],
    productionBatches: businessStore.listProductionBatches(),
    dailyCloses,
    syncTargets: {
      stockCounts: "/api/sync",
      manualMovements: "/api/sync",
      ledgerAdjustments: "/api/sync",
      stockTargets: "/api/sync",
      timeClock: "/api/sync",
      supplyOrders: "/api/supply-orders",
      storefrontBuyOrders: "/api/storefront-buy-orders",
      webhookReview: "/api/sync",
      productionBatches: "/api/production-batches",
      salesOrders: "/api/sales-orders",
      dailyCloses: "/api/daily-closes",
      finance: "/api/finance"
    }
  };
}

function employeeDailyCloseView(close) {
  const snapshot = close?.snapshot || {};
  return {
    id: close.id,
    businessDate: close.businessDate,
    status: close.status,
    handoffNotes: close.handoffNotes || "",
    priorityNotes: close.priorityNotes || "",
    snapshot: {
      capturedAt: snapshot.capturedAt || "",
      openSalesOrders: Number(snapshot.openSalesOrders || 0),
      activeProductionBatches: Number(snapshot.activeProductionBatches || 0),
      issues: Array.isArray(snapshot.issues) ? snapshot.issues : []
    },
    finalizedAt: close.finalizedAt || "",
    finalizedBy: close.finalizedBy || ""
  };
}

async function buildDailyCloseSnapshot() {
  const capturedAt = new Date().toISOString();
  const businessDate = businessDateKey(capturedAt);
  const sheet = await readSheetSnapshot();
  const inventory = sheet?.inventory || {};
  const activeSalesOrders = businessStore.listSalesOrders()
    .filter(order => order.status !== "Completed" && order.status !== "Cancelled");
  const overdueSalesOrders = activeSalesOrders.filter(order => order.deliveryDate && order.deliveryDate < businessDate);
  const activeProductionBatches = businessStore.listProductionBatches()
    .filter(batch => batch.status === "Planned" || batch.status === "In Progress");
  const expectedSupplyDeliveries = businessStore.listSupplyOrders()
    .filter(order => order.status === "Ordered" || order.status === "Partially Received")
    .filter(order => order.expectedDate && order.expectedDate <= businessDate);
  const openStorefrontBuyOrders = businessStore.listStorefrontBuyOrders()
    .filter(order => order.status === "Active" || order.status === "Paused");
  const openReviewExceptions = (Array.isArray(sheet?.reviewExceptions) ? sheet.reviewExceptions : [])
    .filter(exception => exception.status === "Open");

  const issues = [
    ...overdueSalesOrders.map(order => ({
      type: "Overdue Sale",
      label: order.customer || "Unnamed customer",
      detail: `${order.status} / due ${order.deliveryDate}`
    })),
    ...activeSalesOrders.filter(order => order.priority === "Expedite" || order.status === "Paused").map(order => ({
      type: order.status === "Paused" ? "Paused Sale" : "Expedited Sale",
      label: order.customer || "Unnamed customer",
      detail: order.deliveryDate ? `Due ${order.deliveryDate}` : "In-store order"
    })),
    ...activeProductionBatches.map(batch => ({
      type: "Production",
      label: batch.reference || batch.sourceType,
      detail: `${batch.status}${batch.dueDate ? ` / due ${batch.dueDate}` : ""}`
    })),
    ...expectedSupplyDeliveries.map(order => ({
      type: "Supply Delivery",
      label: order.producer || "Unassigned producer",
      detail: `${order.status} / expected ${order.expectedDate}`
    })),
    ...openStorefrontBuyOrders.map(order => ({
      type: "Storefront Buy Order",
      label: order.itemLabel || order.itemName,
      detail: `${Number(order.filledQuantity || 0)} of ${Number(order.quantity || 0)} filled`
    })),
    ...openReviewExceptions.slice(0, 20).map(exception => ({
      type: "Webhook Review",
      label: exception.discordItemLabel || exception.discordItemName || "Unrecognized event",
      detail: exception.reason || "Needs review"
    }))
  ];

  const storageRows = Array.isArray(inventory.storage) && inventory.storage.length
    ? inventory.storage
    : inventory.materials;
  return {
    capturedAt,
    sheetGeneratedAt: sheet?.generatedAt || "",
    storefrontUnits: sumInventorySnapshot(inventory.products, ["currentStock", "quantity"]),
    storageUnits: sumInventorySnapshot(storageRows, ["storageCount", "quantity"]),
    ledgerBalance: finiteOrNull(inventory.ledger?.balance),
    openSalesOrders: activeSalesOrders.length,
    overdueSalesOrders: overdueSalesOrders.length,
    activeProductionBatches: activeProductionBatches.length,
    expectedSupplyDeliveries: expectedSupplyDeliveries.length,
    openStorefrontBuyOrders: openStorefrontBuyOrders.length,
    openReviewExceptions: openReviewExceptions.length,
    issues
  };
}

function sumInventorySnapshot(rows, fields) {
  if (!Array.isArray(rows)) return null;
  const counts = new Map();
  rows.forEach(row => {
    const key = inventoryKey(row?.itemName || row?.itemLabel || row?.ingredient || row?.name);
    if (!key) return;
    const field = fields.find(candidate => Number.isFinite(Number(row?.[candidate])));
    if (!field) return;
    counts.set(key, Math.max(0, Number(row[field])));
  });
  return [...counts.values()].reduce((sum, value) => sum + value, 0);
}

function finiteOrNull(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function businessDateKey(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: process.env.BUSINESS_TIME_ZONE || "Europe/Oslo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(value));
  const byType = new Map(parts.map(part => [part.type, part.value]));
  return `${byType.get("year")}-${byType.get("month")}-${byType.get("day")}`;
}

async function readSheetSnapshot() {
  return readAppsScriptAction("bootstrap");
}

async function readAppsScriptAction(action, parameters = {}) {
  if (!process.env.APPS_SCRIPT_URL) return null;

  try {
    const url = new URL(process.env.APPS_SCRIPT_URL);
    url.searchParams.set("action", action);
    Object.entries(parameters).forEach(([key, value]) => {
      if (value !== "" && value !== null && value !== undefined) url.searchParams.set(key, String(value));
    });
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(45000)
    });
    if (!response.ok) return { ok: false, error: `Apps Script ${response.status}` };
    const text = await response.text();
    return parseJsonText(text) || { ok: false, error: "Apps Script returned a non-JSON response" };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function syncGuiPayload(payload) {
  if (!process.env.APPS_SCRIPT_URL) {
    return {
      ok: false,
      localOnly: true,
      error: "APPS_SCRIPT_URL is not configured"
    };
  }

  try {
    const response = await fetch(process.env.APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        source: "frontier-gui",
        ...payload
      }),
      signal: AbortSignal.timeout(15000)
    });
    const text = await response.text();
    const result = parseJsonText(text);
    if (!response.ok) return { ok: false, error: `Apps Script ${response.status}`, body: text };
    if (!result) return { ok: false, error: "Apps Script returned a non-JSON response" };
    return result;
  } catch (error) {
    return {
      ok: false,
      error: error.message
    };
  }
}

function readCatalogFiles() {
  const context = { window: {} };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, "items.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(root, "recipes.js"), "utf8"), context);
  const pricing = require(path.join(root, "pricing.js"));
  return {
    categories: context.window.FRONTIER_CATEGORIES || [],
    items: context.window.FRONTIER_ITEMS || [],
    recipes: context.window.FRONTIER_RECIPES || {},
    recipeYields: context.window.FRONTIER_RECIPE_YIELDS || {},
    pricing
  };
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;

  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function parseJsonText(value) {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return null;
  }
}
