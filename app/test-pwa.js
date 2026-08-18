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
assert(appHtml.includes('id="openCatalogItemDialogButton"'), "the Store tab must expose manager catalog creation");
assert(appHtml.includes('id="catalogItemTypeInput"'), "manual catalog creation must distinguish products and materials");
assert(appHtml.includes('<option value="both">Product and material</option>'), "manual catalog creation must support dual-purpose goods");
assert(appHtml.includes('data-section="catalog"'), "managers must have a catalog management tab");
assert(appHtml.includes('id="recipeEditorForm"'), "catalog management must expose a recipe editor");
assert(appHtml.includes('id="productionSourceDialog"'), "production queues must confirm ingredient source locations");
assert(appHtml.includes('id="confirmProductionSourceButton"'), "customer fulfillment must confirm existing-stock allocations");
assert(appHtml.includes('id="orderTypeSelect"'), "the workbench must expose customer-sale and internal-craft modes");
assert(appHtml.includes('<option value="Internal Craft">Internal Craft</option>'), "internal stock builds must be selectable from the workbench");
assert(appHtml.includes('id="storefrontOverviewValue"'), "the Store overview must show storefront value");
assert(appHtml.includes('id="storageOverviewValue"'), "the Store overview must show storage value");
assert(appHtml.includes('<div class="management-only">\n              <span>Storefront Value</span>'), "storefront value must remain management-only");
assert(appHtml.includes('<button class="primary-button" id="queueOrderProductionButton"'), "employees must be able to queue customer-order production");
assert(appHtml.includes('<option value="Mine">Assigned to Me</option>'), "employees need an assigned production view");
assert(appHtml.includes('<option value="Cancelled" data-management-only-option>'), "order cancellation must remain management-only");
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
assert(appScript.includes("if (!keepDraft) renderReviewEditor(activeEntry)"), "review refreshes must not overwrite a dirty active editor");
assert(appScript.includes("let storefrontBuyOrderDirty = false"), "storefront buy orders must track unsaved editor changes");
assert(appScript.includes("refreshed && !storefrontBuyOrderDirty"), "buy-order refreshes must preserve unsaved input");
assert(appScript.includes('calculateInventoryValuation("Storefront"'), "storefront value must be calculated from current counts");
assert(appScript.includes('calculateInventoryValuation("Storage"'), "storage value must be calculated from current counts");
assert(appScript.includes('function completeActiveOrder()'), "customer-order completion must respect linked production");
assert(appScript.includes('function productionBatchForOrder(orderId)'), "orders must link directly to their production batch");
assert(appScript.includes('function isInternalCraftOrder(order)'), "the client must keep internal crafts distinct from customer sales");
assert(appScript.includes('sourceType: orderProductionSourceType(activeOrder)'), "internal crafts must queue with their own production source type");
assert(appScript.includes('signal: AbortSignal.timeout(45000)'), "production queue requests must stop waiting after a bounded timeout");
assert(appScript.includes('elements.productionSourceStatus.textContent = `Unable to queue production:'), "production queue failures must remain visible inside the open source dialog");
assert(appScript.includes('if (queued) closeProductionSourceDialog()'), "the source dialog must only close after a successful queue request");
assert(appScript.includes('function switchWorkspace(event)'), "the ledger must support workspace switching without another login");
assert(appScript.includes('function linkWorkspaceJob(event)'), "the ledger must support credential-verified local job linking");
assert(appHtml.includes('data-section="business-settings"'), "administrators must have a business settings tab");
assert(appHtml.includes('id="businessSettingsForm"'), "business settings must expose a profile editor");
assert(appHtml.includes('id="settingsLogoPreview"'), "business settings must preview branding changes");
assert(appHtml.includes('id="settingsNavigationTabs"'), "business settings must expose per-business navigation controls");
assert(appHtml.includes('id="discordSettingsForm"'), "business settings must expose editable Discord channels");
assert(appHtml.includes('id="discordStorageLedgerChannelIdInput"'), "business settings must distinguish storage and ledger events");
assert(setupHtml.includes('id="discordStorageLedgerChannelIdInput"'), "first launch must collect the storage and ledger event channel");
assert(appScript.includes("function loadDiscordSettings"), "administrators must be able to load saved Discord routing");
assert(appScript.includes("function saveDiscordSettings"), "administrators must be able to update Discord routing");
assert(appScript.includes("NAVIGATION_TAB_DEFINITIONS"), "the client must define the configurable workspace tabs");
assert(appScript.includes("function applyNavigationVisibility()"), "saved navigation choices must update the visible tabs");
assert(appScript.includes("if (!isNavigationSectionEnabled(section)) return false"), "hidden tabs must also be rejected by the section access guard");
assert(styles.includes(".business-navigation-tabs"), "navigation controls must have a responsive ledger layout");
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
