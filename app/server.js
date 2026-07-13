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
  "/inventory-counts.js",
  "/assets/frontier-firearms-logo.png"
]);

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
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
      if (await handleSupplyOrderRoute(request, response, url, user)) return;
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
      if (await handleSupplyOrderRoute(request, response, url, user)) return;
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

    updatedOrder = await businessStore.receiveSupplyLine(orderId, line.id, quantity, user);
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
      receivedQuantity: receipt.receivedQuantity,
      storageCount: receipt.storageCount
    }
  });
}

function requiresAdmin(payload) {
  if (payload.action !== "manual_operation") return false;
  return payload.entry?.kind === "Payroll Payment";
}

function requiresManagement(payload) {
  return payload.action === "stock_target" || payload.action === "manual_operation";
}

function stampEmployee(payload, user) {
  if ((payload.action === "manual_operation" || payload.action === "time_clock") && payload.entry) {
    payload.entry.employee = user.fullName;
  }
}

async function auditGuiPayload(payload, user, syncResult) {
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
    await accountStore.recordAudit({
      category: "operations",
      action: "operation.recorded",
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
    syncTargets: {
      stockCounts: "/api/sync",
      manualMovements: "/api/sync",
      ledgerAdjustments: "/api/sync",
      stockTargets: "/api/sync",
      timeClock: "/api/sync",
      supplyOrders: "/api/supply-orders"
    }
  };
}

async function readSheetSnapshot() {
  if (!process.env.APPS_SCRIPT_URL) return null;

  try {
    const url = new URL(process.env.APPS_SCRIPT_URL);
    url.searchParams.set("action", "bootstrap");
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15000)
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
  return {
    categories: context.window.FRONTIER_CATEGORIES || [],
    items: context.window.FRONTIER_ITEMS || [],
    recipes: context.window.FRONTIER_RECIPES || {}
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
