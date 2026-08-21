const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = __dirname;
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.webmanifest"), "utf8"));
const serviceWorker = fs.readFileSync(path.join(root, "service-worker.js"), "utf8");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
const setupScript = fs.readFileSync(path.join(root, "setup.js"), "utf8");
const setupHtml = fs.readFileSync(path.join(root, "setup.html"), "utf8");
const appHtml = fs.readFileSync(path.join(root, "index.html"), "utf8").replace(/\r\n/g, "\n");
const styles = fs.readFileSync(path.join(root, "styles.css"), "utf8");
const productionInventoryScript = fs.readFileSync(path.join(root, "production-inventory.js"), "utf8");

assert.equal(manifest.name, "Business Operations Ledger");
assert.equal(manifest.display, "standalone");
assert.equal(manifest.scope, "/");
assert(manifest.icons.some(icon => icon.sizes === "192x192"));
assert(manifest.icons.some(icon => icon.sizes === "512x512"));
assert(manifest.icons.some(icon => icon.purpose === "maskable"));

for (const privateRoute of ['startsWith("/api/")', 'startsWith("/auth/")', 'startsWith("/health")']) {
  assert(serviceWorker.includes(privateRoute), `service worker must exclude ${privateRoute}`);
}
assert(serviceWorker.includes('request.mode === "navigate"'));
assert(!serviceWorker.includes("/index.html"), "authenticated HTML must not be pre-cached");
assert(server.includes('"Service-Worker-Allowed"'));
assert(server.includes('pathname === "/service-worker.js"'));
assert(server.includes('"X-Content-Type-Options", "nosniff"'), "hosted responses must prevent MIME sniffing");
assert(server.includes('"X-Frame-Options", "DENY"'), "the authenticated ledger must not be frameable");
assert(server.includes('const databaseReady = await probeDatabase()'), "hosted readiness must verify PostgreSQL instead of reporting a constant");

for (const htmlFile of ["index.html", "login.html", "profile.html", "setup.html"]) {
  const html = fs.readFileSync(path.join(root, htmlFile), "utf8");
  assert(html.includes('rel="manifest" href="/manifest.webmanifest"'), `${htmlFile} must link the manifest`);
  assert(html.includes('src="/pwa.js"'), `${htmlFile} must load the PWA controller`);
}

assert(setupScript.includes('select data-field="productName" required'), "recipe outputs must use a catalog dropdown");
assert(setupScript.includes('select data-field="ingredientName" required'), "recipe ingredients must use catalog dropdowns");
assert(setupScript.includes("data-add-ingredient-row"), "recipe cards must support additional ingredient rows");
assert(setupScript.includes("collectRecipeIngredients"), "recipe dropdown rows must serialize as structured ingredients");
assert(setupScript.includes('addRecipeRow({}, { prepend: true, focus: true })'), "new first-launch recipes must be inserted at the top and focused");
assert(!setupScript.includes("parseIngredients("), "first-launch recipes must not require free-form ingredient parsing");
assert(styles.includes(".inventory-overview-table thead th"), "store inventory headers must stick by cell inside their scroll panes");
assert(styles.includes("background: var(--paper)"), "sticky store inventory headers must hide scrolling row text");
assert(
  /\.supply-workspace\s*\{[^}]*"active summary"[^}]*"saved summary"[^}]*"suppliers suppliers"/s.test(styles),
  "the Supplies desktop grid must keep the editor, summary, orders, and supplier directory in explicit tracks"
);
assert(
  /@media \(max-width: 980px\)[\s\S]*?\.supply-workspace\s*\{[^}]*"active"[^}]*"summary"[^}]*"saved"[^}]*"suppliers"/s.test(styles),
  "the Supplies narrow layout must stack every panel in a named track"
);
assert(appHtml.includes('id="openCatalogItemDialogButton"'), "the Store tab must expose manager catalog creation");
assert(appHtml.includes('id="catalogItemTypeInput"'), "manual catalog creation must distinguish products and materials");
assert(appHtml.includes('<option value="both">Product and material</option>'), "manual catalog creation must support dual-purpose goods");
assert(appHtml.includes('data-section="catalog"'), "managers must have a catalog management tab");
assert(appHtml.includes('id="recipeEditorForm"'), "catalog management must expose a recipe editor");
assert(appHtml.includes('id="productionSourceDialog"'), "production queues must confirm ingredient source locations");
assert(appHtml.includes('src="production-planner.js?v=20260820-multistage-production"'), "the production UI must load the shared multi-stage planner");
assert(appHtml.includes('src="production-inventory.js?v=20260821-static-route"'), "the production UI must load shared inventory calculations");
assert(appHtml.indexOf('src="production-inventory.js') < appHtml.indexOf('src="app.js'), "shared inventory calculations must load before the application");
assert(server.includes('"/production-inventory.js"'), "the hosted server must serve the browser production inventory dependency");
assert(appHtml.includes('id="confirmProductionSourceButton"'), "customer fulfillment must confirm existing-stock allocations");
assert(appHtml.includes('id="orderTypeSelect"'), "the workbench must expose customer-sale and internal-craft modes");
assert(appHtml.includes('<option value="Internal Craft">Internal Craft</option>'), "internal stock builds must be selectable from the workbench");
assert(appHtml.includes('<option value="Counter Sale">Over-the-counter Cash Sale</option>'), "cash sales must be distinct from registered customer orders");
assert(appHtml.includes('id="customerInput"'), "customer orders must select a registered customer");
assert(appHtml.includes('id="resellerPricingInput"'), "sales orders must allow a per-order bulk pricing override");
assert(appHtml.includes('id="customerPanel"'), "the sales workspace must expose a customer register");
assert(appHtml.includes('id="customerResellerPricingInput"'), "customer records must support a default pricing tier");
assert(appHtml.includes('id="customerHistoryList"'), "customer records must expose sales history");
assert(appHtml.includes('id="catalogItemResellerPriceInput"'), "catalog goods must store a bulk or reseller price");
assert(appHtml.includes('id="storefrontOverviewValue"'), "the Store overview must show storefront value");
assert(appHtml.includes('id="storageOverviewValue"'), "the Store overview must show storage value");
assert(appHtml.includes('<div class="management-only">\n              <span>Storefront Value</span>'), "storefront value must remain management-only");
assert(appHtml.includes('<button class="primary-button" id="queueOrderProductionButton"'), "employees must be able to queue customer-order production");
assert(appHtml.includes('<option value="Mine">Assigned to Me</option>'), "employees need an assigned production view");
assert(appHtml.includes('id="cancelOrderButton" class="danger-button management-only"'), "order cancellation must remain a direct management-only action");
assert(appHtml.includes('id="salesOrderStatus"'), "Sales must display its server-managed status without an editable dropdown");
assert(!appHtml.includes('id="statusSelect"'), "Sales status must not be freely editable");
assert(!appHtml.includes('id="newOrderButton"') && !appHtml.includes('id="saveOrderButton"'), "workflow controls must not remain in the account header");
for (const localAction of [
  "newSalesOrderButton",
  "saveSalesOrderButton",
  "newSupplyOrderButton",
  "saveSupplyOrderButton",
  "newBuyOrderButton",
  "saveBuyOrderButton",
  "newDailyCloseButton",
  "saveDailyCloseButton"
]) {
  assert(appHtml.includes(`id="${localAction}"`), `${localAction} must live inside its workflow tab`);
}
assert.equal((appHtml.match(/data-dashboard-section=/g) || []).length, 10, "each dashboard summary must expose a navigation destination");
assert(appHtml.includes('data-dashboard-section="restock"'), "missing-stock summaries must link directly to Restock");
assert(appHtml.includes('id="reviewItemTypeInput"'), "webhook review must create either product or material goods");
assert(appHtml.includes('id="reviewPackageConversionInput"'), "webhook review must identify crated goods");
assert(appHtml.includes('id="reviewUnitsPerPackageInput"'), "webhook review must capture units per crate");
assert(appHtml.includes('id="reviewActorName"'), "webhook review must expose the character responsible for storage movements");
assert(appHtml.includes('id="reviewCashCategoryInput"'), "cash webhooks must require an operational classification");
assert(appHtml.includes('id="reviewCashReferenceInput"'), "cash reviews must retain a counterparty or operational reference");
assert(appHtml.includes('id="reviewCashRemaining"'), "split cash reviews must show the unassigned remainder");
assert(appHtml.includes('id="reviewCashAllocationList"'), "split cash reviews must retain each saved allocation");
assert(appHtml.includes('id="webhookLogBody"'), "webhook review must expose a recent delivery log");
assert(appHtml.includes('id="webhookLogStatusFilter"'), "the webhook delivery log must filter by result");
assert(appHtml.includes('id="workspaceSwitcherButton"'), "authenticated users must have an in-ledger business switcher");
assert(appHtml.includes('id="workspaceDialog"'), "the business switcher must expose linked and pending jobs");
assert(appHtml.includes('id="linkJobWorkspaceInput"'), "password users must be able to link an approved job explicitly");
const appScript = fs.readFileSync(path.join(root, "app.js"), "utf8");
assert(appScript.includes('addGoods(itemCatalog, "product")'), "catalog fallback must classify sellable goods as products");
assert(appScript.includes('addGoods(ingredientCatalog, "material")'), "catalog fallback must classify recipe ingredients as materials");
assert(appScript.includes("function renderReviewPackageMode"), "crate conversion must preview the resulting inventory units");
assert(appScript.includes("function resolveCashReviewException"), "cash reviews must use a dedicated ledger workflow");
assert(appScript.includes("function inferCashReview(entry)"), "cash review mode must recover from stale stock-movement payloads");
assert(appScript.includes('elements.ignoreReview.classList.toggle("hidden", cash)'), "cash webhook reviews must not be dismissible");
assert(appScript.includes("function renderWebhookLog"), "the review workspace must render retained webhook activity");
assert(appScript.includes("let reviewEditorDirty = false"), "webhook review must track unsaved editor changes");
assert(appScript.includes("preserveReviewEditor: true"), "background refreshes must preserve unsaved webhook review input");
assert(appScript.includes("function renderCustomerWorkspace"), "the sales workspace must render customer statistics and history");
assert(appScript.includes("function renderRecordCollection"), "workspace directories must share one selectable-record renderer");
assert(appScript.includes("function recordButtonMarkup"), "grouped order registers must share the standard record control");
assert(appScript.includes('aria-pressed="${selected}"'), "selectable record controls must expose their active state accessibly");
assert((appScript.match(/renderRecordCollection\(\{/g) || []).length >= 6, "customers, suppliers, sales, buy orders, and production must use the shared record renderer");
assert(appScript.includes("bindRecordSelection(elements.supplyOrdersList, loadSupplyOrder)"), "grouped supply orders must use the shared selection binding");
assert(appScript.includes("function setWorkspaceDataStatus"), "workspace editors must share status feedback behavior");
assert(appScript.includes("function setButtonBusy"), "workspace save controls must share pending-state behavior");
assert(appHtml.includes('class="directory-layout"'), "customer and supplier editors must share the directory layout");
assert((appHtml.match(/class="workspace-data-status"/g) || []).length >= 5, "record workspaces must expose consistent live status regions");
assert(styles.includes(".record-empty-state"), "record registers must use an instructive shared empty state");
assert(appScript.includes("function catalogPriceForTier"), "order lines must resolve catalog prices by pricing tier");
assert(appScript.includes("resellerPrice > 0 ? resellerPrice : storefrontPrice"), "goods without a bulk price must fall back to storefront pricing");
assert(appScript.includes("function updateOrderPricingTier"), "staff must be able to override the customer pricing tier per order");
assert(appScript.includes("let customerDirty = false"), "background refreshes must preserve unsaved customer edits");
assert(appScript.includes("function isCounterSaleOrder"), "counter sales must use their own workflow");
assert(styles.includes(".customer-history-list"), "customer sales history must use a bounded ledger list");
assert(appScript.includes("if (!keepDraft) renderReviewEditor(activeEntry)"), "review refreshes must not overwrite a dirty active editor");
assert(appScript.includes("let storefrontBuyOrderDirty = false"), "storefront buy orders must track unsaved editor changes");
assert(appScript.includes("refreshed && !storefrontBuyOrderDirty"), "buy-order refreshes must preserve unsaved input");
assert(appScript.includes("function renderSectionWorkspace("), "workspace navigation must use section-scoped rendering");
assert(appScript.includes("renderSectionWorkspace(activeSection, { preserveReviewEditor })"), "background refreshes must redraw only the active workspace");
assert.equal((appScript.match(/^\s*render\(\);\s*$/gm) || []).length, 2, "full-application rendering must be limited to initial startup and authenticated session setup");
assert(appScript.includes("let supplyOrderDirty = false"), "supply orders must preserve unsaved editor changes");
assert(appScript.includes("let supplierDirty = false"), "supplier records must preserve unsaved editor changes");
assert(appScript.includes('window.addEventListener("beforeunload"'), "leaving the app must warn about unsaved drafts");
assert(styles.includes(".section-button.has-unsaved-draft::after"), "tabs with unsaved drafts must show a stable visual marker");
assert(appScript.includes('calculateInventoryValuation("Storefront"'), "storefront value must be calculated from current counts");
assert(appScript.includes('calculateInventoryValuation("Storage"'), "storage value must be calculated from current counts");
assert(appScript.includes('function completeActiveOrder()'), "customer-order completion must respect linked production");
assert(appScript.includes('function renderSalesOrderActions()'), "Sales action buttons must reflect the current order state");
assert(appScript.includes('function handleDashboardShortcut(event)'), "dashboard summaries must route to their workflow tabs");
assert(appScript.includes('shortcut.disabled = !allowed'), "dashboard shortcuts must respect role and tab access");
assert(appScript.includes('await saveActiveOrder({ syncInputs: false })'), "direct Sales transitions must survive form synchronization");
assert(appScript.includes('data-line-quantity='), "sales order lines must expose editable quantity controls");
assert(appScript.includes('function updateLineQuantity('), "sales order quantity corrections must update the active line in place");
assert(appScript.includes('Boolean(productionBatchForOrder(activeOrder.id))'), "sales order quantities must lock after production is linked");
assert(appScript.includes('function productionBatchForOrder(orderId)'), "orders must link directly to their production batch");
assert(appScript.includes('function planRecipeStages('), "production and restock plans must expand nested recipes");
assert(appScript.includes('function productionBatchInventoryState('), "production readiness must net intermediate work in progress");
assert(appScript.includes('function getProductionAvailableCounts('), "production planning must subtract goods reserved for open customer orders");
assert(appScript.includes('FRONTIER_PRODUCTION_INVENTORY.productionInventoryState'), "the browser must delegate production consumption to the shared inventory module");
assert(appScript.includes('FRONTIER_PRODUCTION_INVENTORY.finishedStockReservations'), "the browser must delegate customer stock reservations to the shared inventory module");
assert(server.includes('require("./production-inventory")'), "the server must load the shared production inventory module");
assert(server.includes('productionInventory.productionInventoryState'), "the server must delegate production consumption to the shared inventory module");
assert(server.includes('productionInventory.finishedStockReservations'), "the server must delegate customer stock reservations to the shared inventory module");
assert(productionInventoryScript.includes('completedCrafts * Number(line.recipeYield || 1)'), "completed customer-order output must remain reserved until the order closes");
assert(appScript.includes('const storefrontCounts = getProductionAvailableCounts().Storefront'), "storefront restock must treat customer-reserved goods as unavailable");
assert(appScript.includes('class="production-progress-row${lineCompleted ? " production-line-completed" : ""}"'), "completed production lines must expose a distinct row state");
assert(appScript.includes('${lineCompleted ? "Complete" : `${formatNumber(completedCrafts)} / ${formatNumber(plannedCrafts)}`}'), "completed production lines must replace the small cycle count with a clear label");
assert(styles.includes('.production-line-name.completed::before'), "completed production lines must render a leading check marker");
assert(appScript.includes('function isInternalCraftOrder(order)'), "the client must keep internal crafts distinct from customer sales");
assert(appScript.includes('sourceType: orderProductionSourceType(activeOrder)'), "internal crafts must queue with their own production source type");
assert(appScript.includes('signal: AbortSignal.timeout(45000)'), "production queue requests must stop waiting after a bounded timeout");
assert(appScript.includes('elements.productionSourceStatus.textContent = `Unable to queue production:'), "production queue failures must remain visible inside the open source dialog");
assert(appScript.includes('if (queued) closeProductionSourceDialog()'), "the source dialog must only close after a successful queue request");
assert(appScript.includes('function switchWorkspace(event)'), "the ledger must support workspace switching without another login");
assert(appScript.includes('function linkWorkspaceJob(event)'), "the ledger must support credential-verified local job linking");
assert(appScript.includes("function workspaceStorageKey(baseKey)"), "browser fallback data must be scoped to the active business");
assert(appScript.includes("function loadWorkspaceLocalState()"), "workspace switching must reload only that business's fallback data");
assert(appScript.includes("localStorage.setItem(workspaceStorageKey(OPERATIONS_KEY)"), "pending manual operations must not cross business boundaries");
assert(appScript.includes("function hydrateSharedTimeClock(snapshot)"), "time-clock state must recover from the shared database");
assert(appScript.includes("hydrateSharedTimeClock(nextSnapshot)"), "background refreshes must reconcile the active shift");
assert(appHtml.includes('data-section="business-settings"'), "administrators must have a business settings tab");
assert(appHtml.includes('id="businessSettingsForm"'), "business settings must expose a profile editor");
assert(appHtml.includes('id="settingsLogoPreview"'), "business settings must preview branding changes");
assert(appHtml.includes('id="settingsAppearanceThemes"'), "business settings must expose per-business counter themes");
assert(appHtml.includes('id="settingsNavigationTabs"'), "business settings must expose per-business navigation controls");
assert(appScript.includes("function applyAppearanceTheme("), "saved appearance choices must update the ledger scene");
assert(styles.includes('counter-gunsmith.jpg'), "the ledger frame must use a trade-specific counter background");
assert(styles.includes('ledger-oxblood-leather.jpg'), "the ledger cover must use the leather texture asset");
assert(appHtml.includes('data-navigation-menu="inventory"'), "manager inventory pages must be grouped under one navigation menu");
assert(appHtml.includes('data-navigation-menu="management"'), "manager operations pages must be grouped under one navigation menu");
assert(appHtml.includes('data-navigation-menu="owner"'), "administrator pages must be grouped under an owner menu");
assert(appHtml.includes('id="managementNavCount"'), "open review work must remain visible on the collapsed management menu");
assert(appScript.includes("function bootstrapApplication()"), "the client must guard initial rendering before loading the authenticated session");
assert(appScript.includes("if (elements.managementNavCount)"), "grouped navigation badges must tolerate mixed-version app assets during rolling deploys");
assert(appScript.includes("function scheduleSessionRetry(error)"), "transient session failures must retry without starting a login redirect loop");
assert(appScript.includes('reportWorkspaceStartupIssue("Authenticated workspace render failed"'), "authenticated rendering failures must remain separate from authentication failures");
assert(appScript.includes('reportWorkspaceStartupIssue("Workspace data startup failed"'), "workspace data failures must not sign out an authenticated user");
assert(appHtml.includes('id="appStartupStatus"'), "render failures must be visible without opening developer tools");
assert(appScript.includes('["Account and navigation", renderRole]'), "account identity and role navigation must render before optional workspace panels");
assert(appScript.includes("const failures = []"), "workspace panels must render independently so one failure cannot freeze the ledger");
assert(appHtml.includes('id="discordSettingsForm"'), "business settings must expose editable Discord channels");
assert(appHtml.includes('id="discordStorageLedgerChannelIdInput"'), "business settings must distinguish storage and ledger events");
assert(setupHtml.includes('id="discordStorageLedgerChannelIdInput"'), "first launch must collect the storage and ledger event channel");
assert(appScript.includes("function loadDiscordSettings"), "administrators must be able to load saved Discord routing");
assert(appScript.includes("function saveDiscordSettings"), "administrators must be able to update Discord routing");
assert(appScript.includes("NAVIGATION_TAB_DEFINITIONS"), "the client must define the configurable workspace tabs");
assert(appScript.includes("NAVIGATION_GROUP_DEFINITIONS"), "business settings must mirror the grouped workspace navigation");
assert(appScript.includes("function applyNavigationVisibility()"), "saved navigation choices must update the visible tabs");
assert(appScript.includes("function updateNavigationMenus()"), "navigation menus must inherit active and visibility state from their pages");
assert(appScript.includes("function closeNavigationMenus("), "navigation menus must close predictably after use");
assert(appScript.includes("if (!isNavigationSectionEnabled(section)) return false"), "hidden tabs must also be rejected by the section access guard");
assert(styles.includes(".business-navigation-tabs"), "navigation controls must have a responsive ledger layout");
assert(styles.includes(".navigation-menu-panel"), "grouped navigation must use a bounded ledger menu");
assert(styles.includes(".navigation-menu.has-unsaved-draft"), "grouped navigation must surface unsaved child drafts");
assert(styles.includes(".dashboard-stat-link:hover"), "dashboard shortcuts must provide a visible hover affordance");
assert(styles.includes(".dashboard-stat-link:focus-visible"), "dashboard shortcuts must provide a keyboard focus affordance");
const loginHtml = fs.readFileSync(path.join(root, "login.html"), "utf8");
assert(loginHtml.includes('id="loginBusinessDescription"'), "the sign-in cover must display the configured business description");

function pngSize(fileName) {
  const data = fs.readFileSync(path.join(root, "assets", fileName));
  assert.equal(data.toString("ascii", 1, 4), "PNG");
  return [data.readUInt32BE(16), data.readUInt32BE(20)];
}

assert.deepEqual(pngSize("operations-ledger-192.png"), [192, 192]);
assert.deepEqual(pngSize("operations-ledger-512.png"), [512, 512]);
assert.deepEqual(pngSize("operations-ledger-maskable-512.png"), [512, 512]);

console.log("PWA tests passed");
