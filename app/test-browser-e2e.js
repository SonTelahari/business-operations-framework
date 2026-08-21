const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { once } = require("node:events");
const { newDb, DataType } = require("pg-mem");
const { chromium } = require("playwright");
const { defaultSetupConfiguration } = require("./setup-config");

const PORT = 4308;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const OWNER_NAME = "Evelyn Mercer";
const OWNER_PASSWORD = "browser-owner-password-123";
const CUSTOMER_NAME = "Blackwater Provisioners";
const RESULTS_DIR = path.join(__dirname, "..", "test-results", "browser-e2e");

const memory = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
memory.public.registerFunction({ name: "hashtext", args: [DataType.text], returns: DataType.integer, implementation: () => 1 });
memory.public.registerFunction({ name: "pg_advisory_xact_lock", args: [DataType.integer], returns: DataType.integer, implementation: () => 1 });
const adapter = memory.adapters.createPg();
const pgPath = require.resolve("pg");
const originalPg = require(pgPath);
require.cache[pgPath].exports = { ...originalPg, Pool: adapter.Pool };

process.env.DATABASE_URL = "postgresql://browser-test/business";
process.env.HOSTED_MODE = "1";
process.env.HOSTED_SIGNUP_MODE = "open";
process.env.AUTH_SESSION_SECRET = "browser-e2e-session-secret-with-at-least-32-characters";
process.env.BRIDGE_API_TOKEN = "browser-e2e-bridge-secret";
process.env.APP_RELEASE = "browser-e2e";
process.env.PORT = String(PORT);
delete process.env.ADMIN_FULL_NAME;
delete process.env.ADMIN_PASSWORD;
delete process.env.DISCORD_CLIENT_ID;
delete process.env.DISCORD_CLIENT_SECRET;
delete process.env.DISCORD_REDIRECT_URI;

const { server, startServer, database } = require("./server");

async function run() {
  let browser;
  let page;
  const browserErrors = [];
  const failedRequests = [];

  await fs.rm(RESULTS_DIR, { recursive: true, force: true });
  await fs.mkdir(RESULTS_DIR, { recursive: true });

  try {
    const listening = once(server, "listening");
    await startServer();
    if (!server.listening) await listening;

    const workspace = await provisionWorkspace();
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      locale: "en-GB",
      timezoneId: "Europe/Oslo"
    });
    page = await context.newPage();
    page.on("pageerror", error => browserErrors.push(`pageerror: ${error.message}`));
    page.on("console", message => {
      if (message.type() === "error") browserErrors.push(`console: ${message.text()}`);
    });
    page.on("requestfailed", request => {
      failedRequests.push(`${request.method()} ${request.url()} - ${request.failure()?.errorText || "failed"}`);
    });

    await signIn(page, workspace.code);
    await assertWorkspaceReady(page, workspace.code);
    await exerciseBrowserCacheFailureRecovery(page, workspace.code);
    await exerciseNavigation(page);
    await updateBusinessAppearance(page);
    await exercisePersistentTimeClock(page, workspace.code);
    const customerId = await createCustomer(page);
    await createSalesOrder(page, customerId);

    await page.reload({ waitUntil: "networkidle" });
    await assertWorkspaceReady(page, workspace.code);
    await page.locator('body[data-appearance="saloon"]').waitFor({ state: "visible" });
    await openSection(page, "workbench", "#workbenchSection");
    await assertCustomerPersisted(page);
    await assertSalesOrderPersisted(page);
    await page.screenshot({ path: path.join(RESULTS_DIR, "desktop.png"), fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await openMenuSection(page, "inventory", "supplies", "#supplySection");
    await assertSupplyDemandLayout(page, { required: 12, restock: 8, sales: 4 });
    await assertNoHorizontalViewportOverflow(page);
    await page.screenshot({ path: path.join(RESULTS_DIR, "supplies-mobile.png"), fullPage: true });
    await openSection(page, "dashboard", "#dashboardSection");
    await assertNoHorizontalViewportOverflow(page);
    await page.screenshot({ path: path.join(RESULTS_DIR, "mobile.png"), fullPage: true });

    assert.deepEqual(browserErrors, [], `Browser errors:\n${browserErrors.join("\n")}`);
    assert.deepEqual(failedRequests, [], `Failed requests:\n${failedRequests.join("\n")}`);
    console.log("Browser end-to-end test passed: hosted sign-in, persistent time clock, navigation, recursive supply demand, customer, sale, reload, and responsive layout.");
  } catch (error) {
    if (page) {
      await page.screenshot({ path: path.join(RESULTS_DIR, "failure.png"), fullPage: true }).catch(() => {});
      await fs.writeFile(path.join(RESULTS_DIR, "diagnostics.json"), JSON.stringify({
        error: error.stack || error.message,
        browserErrors,
        failedRequests,
        url: page.url()
      }, null, 2));
    }
    throw error;
  } finally {
    await browser?.close().catch(() => {});
    await closeServer();
    await database.close().catch(() => {});
    require.cache[pgPath].exports = originalPg;
  }
}

async function provisionWorkspace() {
  const configuration = defaultSetupConfiguration();
  configuration.business = {
    ...configuration.business,
    name: "Browser Test Mercantile",
    ledgerName: "Mercantile Ledger",
    location: "Blackwater",
    referenceId: "browser-e2e",
    description: "Disposable browser test workspace",
    locale: "en-GB",
    timezone: "Europe/Oslo"
  };
  configuration.catalog.products = [{
    name: "Field Supply Crate",
    label: "Field Supply Crate",
    tag: "field_supply_crate",
    category: "Supplies",
    salePrice: 25,
    resellerPrice: 20,
    target: 4,
    active: true
  }];
  configuration.catalog.materials = [{
    name: "Packing Timber",
    category: "Materials",
    unit: "unit",
    unitCost: 3,
    storageTarget: 10
  }];
  configuration.catalog.recipes = [{
    productName: "Field Supply Crate",
    yield: 1,
    ingredients: [{ name: "Packing Timber", quantity: 2, sourceLocation: "Storage" }]
  }];

  const response = await fetch(`${BASE_URL}/api/setup/complete`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      configuration,
      owner: { fullName: OWNER_NAME, password: OWNER_PASSWORD }
    })
  });
  const result = await response.json();
  assert.equal(response.status, 201, JSON.stringify(result));
  assert.match(result.workspace.code, /^[A-Z0-9]{5}-[A-Z0-9]{5}$/);
  return result.workspace;
}

async function signIn(page, workspaceCode) {
  await page.goto(`${BASE_URL}/login.html?workspace=${encodeURIComponent(workspaceCode)}`, { waitUntil: "networkidle" });
  await page.locator("#workspaceCodeInput").fill(workspaceCode);
  await page.locator("#loginNameInput").fill(OWNER_NAME);
  await page.locator("#loginPasswordInput").fill(OWNER_PASSWORD);
  await Promise.all([
    page.waitForURL(url => url.origin === BASE_URL && url.pathname === "/"),
    page.locator("#loginForm button[type=submit]").click()
  ]);
}

async function assertWorkspaceReady(page, workspaceCode) {
  await page.locator("#currentUserName").filter({ hasText: OWNER_NAME }).waitFor({ state: "visible" });
  await page.locator("#currentUserRole").filter({ hasText: "Admin" }).waitFor({ state: "visible" });
  await page.locator("#currentWorkspaceCode").filter({ hasText: workspaceCode }).waitFor({ state: "visible" });
  await page.locator("#businessName").filter({ hasText: "Browser Test Mercantile" }).waitFor({ state: "visible" });
  await page.locator("#dashboardSection").waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const status = document.querySelector("#appStartupStatus");
    return status && status.classList.contains("hidden") && !status.textContent.trim();
  });
}

async function exerciseBrowserCacheFailureRecovery(page, workspaceCode) {
  await page.evaluate(() => {
    const baseKey = "business_operations_manual_operations_v1";
    Object.keys(localStorage)
      .filter(key => key.startsWith(`${baseKey}_`))
      .forEach(key => localStorage.removeItem(key));
    localStorage.setItem(baseKey, JSON.stringify([{ id: "legacy-cache-probe" }]));
  });
  await page.addInitScript(() => {
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function setItemWithQuotaProbe(key, value) {
      if (String(key).startsWith("business_operations_manual_operations_v1_")) {
        throw new DOMException("Simulated browser storage quota", "QuotaExceededError");
      }
      return originalSetItem.call(this, key, value);
    };
  });
  await page.reload({ waitUntil: "networkidle" });
  await assertWorkspaceReady(page, workspaceCode);
  assert.equal(
    await page.evaluate(() => localStorage.getItem("business_operations_manual_operations_v1") !== null),
    true,
    "a failed workspace cache migration must preserve the legacy fallback"
  );
}

async function exerciseNavigation(page) {
  await openSection(page, "workbench", "#workbenchSection");
  await openSection(page, "production", "#productionSection");
  await openSection(page, "store", "#storeSection");
  await openMenuSection(page, "inventory", "supplies", "#supplySection");
  await assertSupplyDemandLayout(page, { required: 8, restock: 8, sales: 0 });
  await page.screenshot({ path: path.join(RESULTS_DIR, "supplies-desktop.png"), fullPage: true });
  await openMenuSection(page, "management", "operations", "#operationsSection");
  await openMenuSection(page, "owner", "business-settings", "#businessSettingsSection");
  await openSection(page, "dashboard", "#dashboardSection");
}

async function updateBusinessAppearance(page) {
  await openMenuSection(page, "owner", "business-settings", "#businessSettingsSection");
  const saloonTheme = page.locator('#settingsAppearanceThemes input[value="saloon"]');
  await saloonTheme.check();
  assert.equal(await page.locator("body").getAttribute("data-appearance"), "saloon");
  const responsePromise = page.waitForResponse(response => response.url().endsWith("/api/admin/business-profile")
    && response.request().method() === "PUT");
  await page.locator("#saveBusinessSettingsButton").click();
  const response = await responsePromise;
  const result = await response.json();
  assert.equal(response.status(), 200, JSON.stringify(result));
  assert.equal(result.business.appearanceTheme, "saloon");
  await page.locator("#businessSettingsStatus").filter({ hasText: "Saved" }).waitFor();
  await page.screenshot({ path: path.join(RESULTS_DIR, "appearance-viewport.png") });
  await page.screenshot({ path: path.join(RESULTS_DIR, "appearance-settings.png"), fullPage: true });
}

async function exercisePersistentTimeClock(page, workspaceCode) {
  await openSection(page, "dashboard", "#dashboardSection");
  let responsePromise = page.waitForResponse(response => response.url().endsWith("/api/sync") && response.request().method() === "POST");
  await page.locator("#clockToggleButton").click();
  assert.equal((await responsePromise).status(), 200);
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "networkidle" });
  await assertWorkspaceReady(page, workspaceCode);
  await page.locator("#clockToggleButton").filter({ hasText: "Clock Out" }).waitFor();

  responsePromise = page.waitForResponse(response => response.url().endsWith("/api/sync") && response.request().method() === "POST");
  await page.locator("#clockToggleButton").click();
  assert.equal((await responsePromise).status(), 200);
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "networkidle" });
  await assertWorkspaceReady(page, workspaceCode);
  await page.locator("#clockToggleButton").filter({ hasText: "Clock In" }).waitFor();
  await page.locator("#timeClockList", { hasText: OWNER_NAME }).waitFor();
}

async function openSection(page, section, expectedSelector) {
  await page.locator(`.section-tabs > [data-section="${section}"]`).click();
  await page.locator(expectedSelector).waitFor({ state: "visible" });
}

async function openMenuSection(page, menu, section, expectedSelector) {
  const details = page.locator(`[data-navigation-menu="${menu}"]`);
  if (!(await details.getAttribute("open"))) await details.locator("summary").click();
  await details.locator(`[data-section="${section}"]`).click();
  await page.locator(expectedSelector).waitFor({ state: "visible" });
}

async function createCustomer(page) {
  await openSection(page, "workbench", "#workbenchSection");
  await page.locator("#newCustomerButton").click();
  await page.locator("#customerNameInput").fill(CUSTOMER_NAME);
  await page.locator("#customerTypeInput").selectOption("Business");
  await page.locator("#customerLocationInput").fill("Blackwater");
  const responsePromise = page.waitForResponse(response => response.url().endsWith("/api/customers") && response.request().method() === "POST");
  await page.locator("#saveCustomerButton").click();
  const response = await responsePromise;
  assert.equal(response.status(), 200, await response.text());
  await page.locator("#customerDataStatus").filter({ hasText: `${CUSTOMER_NAME} saved` }).waitFor();
  const card = page.locator("#customerCardList .customer-card", { hasText: CUSTOMER_NAME });
  await card.waitFor();
  assert.equal(await card.getAttribute("aria-pressed"), "true");

  await page.locator("#customerSearchInput").fill("a customer who does not exist");
  await page.locator("#customerCardList .record-empty-state").filter({ hasText: "No matching customers" }).waitFor();
  await page.locator("#customerSearchInput").fill("");
  await card.waitFor();
  return card.getAttribute("data-record-id");
}

async function createSalesOrder(page, customerId) {
  await page.locator("#newSalesOrderButton").click();
  await page.locator("#customerInput").selectOption(customerId);
  await page.locator("#itemSearchInput").fill("Field Supply Crate");
  await page.locator("#quantityInput").fill("2");
  await page.locator("#priceInput").fill("25");
  await page.locator("#addItemButton").click();
  await page.locator("#lineItemsBody tr", { hasText: "Field Supply Crate" }).waitFor();

  const responsePromise = page.waitForResponse(response => response.url().endsWith("/api/sales-orders") && response.request().method() === "POST");
  await page.locator("#saveSalesOrderButton").click();
  const response = await responsePromise;
  assert.equal(response.status(), 200, await response.text());
  await page.locator("#ordersList [data-record-id]", { hasText: CUSTOMER_NAME }).waitFor();
  assert.match(await page.locator("#orderMeta").textContent(), /Shared revision/);
}

async function assertCustomerPersisted(page) {
  const card = page.locator("#customerCardList .customer-card", { hasText: CUSTOMER_NAME });
  await card.waitFor();
  assert.match(await page.locator("#customerSavedCount").textContent(), /1 customer/);
  await card.click();
  assert.equal(await card.getAttribute("aria-pressed"), "true");
  await page.locator("#customerOrderCount").filter({ hasText: "1" }).waitFor();
  assert.match(await page.locator("#customerOutstanding").textContent(), /50/);
}

async function assertSalesOrderPersisted(page) {
  const card = page.locator("#ordersList [data-record-id]", { hasText: CUSTOMER_NAME });
  await card.waitFor();
  assert.match(await page.locator("#savedCount").textContent(), /1 active/);
  await card.click();
  assert.equal(await card.getAttribute("aria-pressed"), "true");
  await page.locator("#lineItemsBody tr", { hasText: "Field Supply Crate" }).waitFor();
  assert.equal(await page.locator("#customerInput option:checked").textContent(), `${CUSTOMER_NAME} / Blackwater`);
}

async function assertNoHorizontalViewportOverflow(page) {
  const overflow = await page.evaluate(() => ({
    viewport: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth
  }));
  assert.ok(
    overflow.documentWidth <= overflow.viewport + 2 && overflow.bodyWidth <= overflow.viewport + 2,
    `Mobile layout overflows: ${JSON.stringify(overflow)}`
  );
}

async function assertSupplyDemandLayout(page, expected) {
  const demandRow = page.locator("#supplyDemandList .supply-demand-row", { hasText: "Packing Timber" });
  await demandRow.waitFor({ state: "visible" });
  const demandText = await demandRow.textContent();
  assert.match(
    demandText,
    new RegExp(`Required\\s+${expected.required}`),
    `nested demand must show ${expected.required} base units`
  );
  assert.match(demandText, new RegExp(`${expected.restock}\\s+for storefront targets`));
  if (expected.sales) assert.match(demandText, new RegExp(`${expected.sales}\\s+for customer orders`));
  const layout = await page.evaluate(() => {
    const demand = document.querySelector(".supply-demand-panel").getBoundingClientRect();
    const editor = document.querySelector("#supplySection .active-order").getBoundingClientRect();
    return { demandBottom: demand.bottom, editorTop: editor.top };
  });
  assert.ok(layout.editorTop >= layout.demandBottom - 2, `Supply panels overlap: ${JSON.stringify(layout)}`);
}

async function closeServer() {
  if (!server.listening) return;
  const closed = once(server, "close");
  server.close();
  await closed;
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
