const STORAGE_KEY = "frontier_still_water_work_orders_v1";
const TIME_CLOCK_KEY = "frontier_still_water_time_clock_v1";
const OPERATIONS_KEY = "frontier_still_water_manual_operations_v1";
const TARGETS_KEY = "frontier_still_water_storefront_targets_v1";
const SUPPLY_ACTIVE_STATUSES = new Set(["Active", "Ordered", "Partially Received"]);
const SUPPLY_DELIVERY_STATUSES = new Set(["Ordered", "Partially Received"]);
const BACKEND_REFRESH_INTERVAL_MS = Number(window.FRONTIER_REFRESH_INTERVAL_MS || 60000);
const FOCUS_REFRESH_STALE_MS = Number(window.FRONTIER_FOCUS_REFRESH_STALE_MS || 15000);
const statusesHiddenFromActive = new Set(["Completed", "Cancelled"]);
const AUDIT_ACTION_LABELS = Object.freeze({
  "account.admin_created": "Admin account created",
  "account.requested": "Access requested",
  "account.approved": "Employee approved",
  "account.reactivated": "Account reactivated",
  "account.disabled": "Account disabled",
  "account.rejected": "Access request rejected",
  "account.role_changed": "Staff role changed",
  "auth.login": "Signed in",
  "auth.logout": "Signed out",
  "clock.in": "Clocked in",
  "clock.out": "Clocked out",
  "operation.recorded": "Operation recorded",
  "target.updated": "Storefront target updated",
  "target.removed": "Storefront target removed",
  "supplier.saved": "Supplier record saved",
  "supplier.removed": "Supplier record removed"
});
const itemCatalog = window.FRONTIER_ITEMS || [];
const recipeCatalog = window.FRONTIER_RECIPES || {};
const recipeYieldCatalog = window.FRONTIER_RECIPE_YIELDS || {};
const pricingCatalog = window.FRONTIER_PRICING || { materials: {} };
const { buildSupplyQuoteTelegram } = window.FRONTIER_SUPPLY_TELEGRAM;
const ingredientCatalog = getRecipeIngredients();
const stockCatalog = [...itemCatalog, ...ingredientCatalog];

let orders = loadOrders();
let timeClock = { current: null, entries: [] };
let operations = loadOperations();
let stockTargets = loadStockTargets();
let supplyOrders = [];
let suppliers = [];
let currentUser = null;
let currentRole = "employee";
let employeeUsers = [];
let auditEvents = [];
let backendSnapshot = null;
let backendRefreshTimer = null;
let backendRefreshPromise = null;
let lastBackendRefreshAt = 0;
let supplyReceiptPending = false;
let activeOrder = newOrder();
let activeSupplyOrder = newSupplyOrder();
let activeSupplier = newSupplier();
let activeView = "quote";
let activeSection = "dashboard";

const elements = {
  currentUserName: document.querySelector("#currentUserName"),
  currentUserRole: document.querySelector("#currentUserRole"),
  logout: document.querySelector("#logoutButton"),
  customer: document.querySelector("#customerInput"),
  handler: document.querySelector("#handlerInput"),
  deposit: document.querySelector("#depositInput"),
  priority: document.querySelector("#prioritySelect"),
  deliveryDate: document.querySelector("#deliveryDateInput"),
  status: document.querySelector("#statusSelect"),
  itemSearch: document.querySelector("#itemSearchInput"),
  itemOptions: document.querySelector("#itemOptions"),
  stockOptions: document.querySelector("#stockOptions"),
  countStockOptions: document.querySelector("#countStockOptions"),
  supplyMaterialOptions: document.querySelector("#supplyMaterialOptions"),
  quantity: document.querySelector("#quantityInput"),
  price: document.querySelector("#priceInput"),
  lines: document.querySelector("#lineItemsBody"),
  label: document.querySelector("#labelInput"),
  notes: document.querySelector("#notesInput"),
  subtotal: document.querySelector("#subtotalValue"),
  depositValue: document.querySelector("#depositValue"),
  balance: document.querySelector("#balanceValue"),
  summary: document.querySelector("#summaryPreview"),
  ordersList: document.querySelector("#ordersList"),
  savedCount: document.querySelector("#savedCount"),
  filter: document.querySelector("#filterSelect"),
  orderMeta: document.querySelector("#orderMeta"),
  quoteView: document.querySelector("#quoteView"),
  productionView: document.querySelector("#productionView"),
  productionMeta: document.querySelector("#productionMeta"),
  productionBuildList: document.querySelector("#productionBuildList"),
  productionMaterialsList: document.querySelector("#productionMaterialsList"),
  missingRecipes: document.querySelector("#missingRecipes"),
  supplySection: document.querySelector("#supplySection"),
  supplyOrderMeta: document.querySelector("#supplyOrderMeta"),
  supplyStatus: document.querySelector("#supplyStatusSelect"),
  supplyProducer: document.querySelector("#supplyProducerInput"),
  supplyRequestedBy: document.querySelector("#supplyRequestedByInput"),
  supplyExpectedDate: document.querySelector("#supplyExpectedDateInput"),
  supplyMaterial: document.querySelector("#supplyMaterialInput"),
  supplyQuantity: document.querySelector("#supplyQuantityInput"),
  supplyUnitPrice: document.querySelector("#supplyUnitPriceInput"),
  supplyNotes: document.querySelector("#supplyNotesInput"),
  supplyLines: document.querySelector("#supplyLinesBody"),
  supplySubtotal: document.querySelector("#supplySubtotalValue"),
  supplyLineCount: document.querySelector("#supplyLineCountValue"),
  supplyUncovered: document.querySelector("#supplyUncoveredValue"),
  supplySummary: document.querySelector("#supplySummaryPreview"),
  supplyFilter: document.querySelector("#supplyFilterSelect"),
  supplySavedCount: document.querySelector("#supplySavedCount"),
  supplyDataStatus: document.querySelector("#supplyDataStatus"),
  supplyOrdersList: document.querySelector("#supplyOrdersList"),
  copySupplyTelegram: document.querySelector("#copySupplyTelegramButton"),
  receiveSupply: document.querySelector("#receiveSupplyButton"),
  producerOptions: document.querySelector("#producerOptions"),
  supplierPanel: document.querySelector("#supplierPanel"),
  supplierName: document.querySelector("#supplierNameInput"),
  supplierCategory: document.querySelector("#supplierCategoryInput"),
  supplierLocation: document.querySelector("#supplierLocationInput"),
  supplierBusinessTelegram: document.querySelector("#supplierBusinessTelegramInput"),
  supplierOwnerName: document.querySelector("#supplierOwnerNameInput"),
  supplierOwnerTelegram: document.querySelector("#supplierOwnerTelegramInput"),
  supplierProduct: document.querySelector("#supplierProductInput"),
  supplierProductPrice: document.querySelector("#supplierProductPriceInput"),
  supplierProductList: document.querySelector("#supplierProductList"),
  supplierProductCount: document.querySelector("#supplierProductCount"),
  supplierEmployeeName: document.querySelector("#supplierEmployeeNameInput"),
  supplierEmployeeTelegram: document.querySelector("#supplierEmployeeTelegramInput"),
  supplierEmployeeList: document.querySelector("#supplierEmployeeList"),
  supplierEmployeeCount: document.querySelector("#supplierEmployeeCount"),
  supplierSearch: document.querySelector("#supplierSearchInput"),
  supplierCardList: document.querySelector("#supplierCardList"),
  supplierSavedCount: document.querySelector("#supplierSavedCount"),
  supplierDataStatus: document.querySelector("#supplierDataStatus"),
  supplierEditMeta: document.querySelector("#supplierEditMeta"),
  newSupplier: document.querySelector("#newSupplierButton"),
  saveSupplier: document.querySelector("#saveSupplierButton"),
  deleteSupplier: document.querySelector("#deleteSupplierButton"),
  addSupplierProduct: document.querySelector("#addSupplierProductButton"),
  addSupplierEmployee: document.querySelector("#addSupplierEmployeeButton"),
  newDocument: document.querySelector("#newOrderButton"),
  saveDocument: document.querySelector("#saveOrderButton"),
  dashboardSection: document.querySelector("#dashboardSection"),
  restockSection: document.querySelector("#restockSection"),
  workbenchSection: document.querySelector("#workbenchSection"),
  operationsSection: document.querySelector("#operationsSection"),
  employeesSection: document.querySelector("#employeesSection"),
  pendingUserCount: document.querySelector("#pendingUserCount"),
  pendingUserList: document.querySelector("#pendingUserList"),
  employeeUserList: document.querySelector("#employeeUserList"),
  auditEmployeeFilter: document.querySelector("#auditEmployeeFilter"),
  auditCategoryFilter: document.querySelector("#auditCategoryFilter"),
  auditActionFilter: document.querySelector("#auditActionFilter"),
  auditSearch: document.querySelector("#auditSearchInput"),
  auditMeta: document.querySelector("#auditMetaText"),
  auditList: document.querySelector("#auditList"),
  refreshAudit: document.querySelector("#refreshAuditButton"),
  dataStatus: document.querySelector("#dataStatusText"),
  stockAlertList: document.querySelector("#stockAlertList"),
  missingStockCount: document.querySelector("#missingStockCount"),
  materialShortageCount: document.querySelector("#materialShortageCount"),
  expectedDeliveryTodayCount: document.querySelector("#expectedDeliveryTodayCount"),
  expectedDeliveryTodayList: document.querySelector("#expectedDeliveryTodayList"),
  dueTodayCount: document.querySelector("#dueTodayCount"),
  overdueCount: document.querySelector("#overdueCount"),
  expeditedCount: document.querySelector("#expeditedCount"),
  pausedCount: document.querySelector("#pausedCount"),
  inStoreCount: document.querySelector("#inStoreCount"),
  dueTodayList: document.querySelector("#dueTodayList"),
  overdueList: document.querySelector("#overdueList"),
  attentionList: document.querySelector("#attentionList"),
  inStoreList: document.querySelector("#inStoreList"),
  replenishmentMeta: document.querySelector("#replenishmentMeta"),
  replenishmentList: document.querySelector("#replenishmentList"),
  replenishmentMaterialsList: document.querySelector("#replenishmentMaterialsList"),
  clockEmployee: document.querySelector("#clockEmployeeInput"),
  clockToggle: document.querySelector("#clockToggleButton"),
  clockStatus: document.querySelector("#clockStatus"),
  timeClockList: document.querySelector("#timeClockList"),
  countLocation: document.querySelector("#countLocationInput"),
  countItem: document.querySelector("#countItemInput"),
  countQuantity: document.querySelector("#countQuantityInput"),
  countEmployee: document.querySelector("#countEmployeeInput"),
  movementType: document.querySelector("#movementTypeInput"),
  movementItem: document.querySelector("#movementItemInput"),
  movementQuantity: document.querySelector("#movementQuantityInput"),
  movementAmount: document.querySelector("#movementAmountInput"),
  movementEmployee: document.querySelector("#movementEmployeeInput"),
  movementNote: document.querySelector("#movementNoteInput"),
  ledgerType: document.querySelector("#ledgerTypeInput"),
  ledgerAmount: document.querySelector("#ledgerAmountInput"),
  ledgerEmployee: document.querySelector("#ledgerEmployeeInput"),
  ledgerNote: document.querySelector("#ledgerNoteInput"),
  payrollEmployee: document.querySelector("#payrollEmployeeInput"),
  payrollPeriodStart: document.querySelector("#payrollPeriodStartInput"),
  payrollPeriodEnd: document.querySelector("#payrollPeriodEndInput"),
  payrollAmount: document.querySelector("#payrollAmountInput"),
  payrollMethod: document.querySelector("#payrollMethodInput"),
  payrollReference: document.querySelector("#payrollReferenceInput"),
  payrollNote: document.querySelector("#payrollNoteInput"),
  payrollEnteredBy: document.querySelector("#payrollEnteredByInput"),
  targetItem: document.querySelector("#targetItemInput"),
  targetQuantity: document.querySelector("#targetQuantityInput"),
  saveTarget: document.querySelector("#saveTargetButton"),
  targetList: document.querySelector("#targetList"),
  saveCount: document.querySelector("#saveCountButton"),
  saveMovement: document.querySelector("#saveMovementButton"),
  saveLedger: document.querySelector("#saveLedgerButton"),
  savePayroll: document.querySelector("#savePayrollButton"),
  operationList: document.querySelector("#operationList"),
  operationCount: document.querySelector("#operationCountText")
};

seedDatalist();
wireEvents();
render();
loadSessionAndData();

function newOrder() {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    customer: "",
    handler: "",
    status: "Draft",
    priority: "Normal",
    deliveryDate: "",
    deposit: 0,
    lines: [],
    label: "The Frontier's Finest Firearms",
    notes: "",
    createdAt: now,
    updatedAt: now
  };
}

function newSupplyOrder() {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    producer: "",
    status: "Draft",
    expectedDate: "",
    requestedBy: currentUser?.fullName || "",
    notes: "",
    lines: [],
    createdAt: now,
    updatedAt: now
  };
}

function newSupplier() {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name: "",
    category: "",
    location: "",
    businessTelegram: "",
    ownerName: "",
    ownerTelegram: "",
    employees: [],
    products: [],
    createdAt: now,
    updatedAt: now,
    updatedBy: ""
  };
}

function loadOrders() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
}

function loadTimeClock(storageKey = TIME_CLOCK_KEY) {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) || "{}");
    return {
      current: stored.current || null,
      entries: Array.isArray(stored.entries) ? stored.entries : []
    };
  } catch {
    return { current: null, entries: [] };
  }
}

function loadOperations() {
  try {
    return JSON.parse(localStorage.getItem(OPERATIONS_KEY) || "[]");
  } catch {
    return [];
  }
}

function loadStockTargets() {
  try {
    return JSON.parse(localStorage.getItem(TARGETS_KEY) || "[]");
  } catch {
    return [];
  }
}

function persistOrders() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(orders));
}

function persistTimeClock() {
  localStorage.setItem(timeClockStorageKey(), JSON.stringify(timeClock));
}

function timeClockStorageKey() {
  return currentUser ? `${TIME_CLOCK_KEY}_${currentUser.id}` : TIME_CLOCK_KEY;
}

function persistOperations() {
  localStorage.setItem(OPERATIONS_KEY, JSON.stringify(operations));
}

function persistStockTargets() {
  localStorage.setItem(TARGETS_KEY, JSON.stringify(stockTargets));
}

function seedDatalist() {
  elements.itemOptions.innerHTML = itemCatalog
    .map(item => `<option value="${escapeHtml(item.label)}">${escapeHtml(item.name)} - $${formatNumber(item.price)}</option>`)
    .join("");
  elements.stockOptions.innerHTML = stockOptionMarkup(stockCatalog);
  seedSupplyMaterialOptions();
  seedCountDatalist();
}

function seedSupplyMaterialOptions() {
  const byName = new Map(ingredientCatalog.map(item => [normalize(item.name), item]));
  suppliers.flatMap(supplier => supplier.products || []).forEach(product => {
    const key = normalize(product.name);
    if (!byName.has(key)) byName.set(key, { ...product, category: "Supplier Product" });
  });
  elements.supplyMaterialOptions.innerHTML = stockOptionMarkup([...byName.values()]);
}

function seedCountDatalist() {
  const orderedCatalog = elements.countLocation.value === "Storage"
    ? [...ingredientCatalog, ...itemCatalog]
    : [...itemCatalog, ...ingredientCatalog];
  elements.countStockOptions.innerHTML = stockOptionMarkup(orderedCatalog);
}

function stockOptionMarkup(catalog) {
  return catalog
    .map(item => `<option value="${escapeHtml(item.label || item.name)}">${escapeHtml(item.name)}${item.category ? ` - ${escapeHtml(item.category)}` : ""}</option>`)
    .join("");
}

function wireEvents() {
  elements.newDocument.addEventListener("click", startNewDocument);
  elements.saveDocument.addEventListener("click", saveCurrentDocument);
  document.querySelector("#addItemButton").addEventListener("click", addItemLine);
  document.querySelector("#copySummaryButton").addEventListener("click", copySummary);
  document.querySelector("#copyProductionButton").addEventListener("click", copyProduction);
  elements.logout.addEventListener("click", logout);
  elements.pendingUserList.addEventListener("click", handleEmployeeAction);
  elements.employeeUserList.addEventListener("click", handleEmployeeAction);
  elements.auditEmployeeFilter.addEventListener("change", renderAudit);
  elements.auditCategoryFilter.addEventListener("change", renderAudit);
  elements.auditActionFilter.addEventListener("change", renderAudit);
  elements.auditSearch.addEventListener("input", renderAudit);
  elements.refreshAudit.addEventListener("click", loadAuditEvents);
  elements.clockToggle.addEventListener("click", toggleTimeClock);
  elements.countLocation.addEventListener("change", seedCountDatalist);
  elements.saveCount.addEventListener("click", saveManualCount);
  elements.saveMovement.addEventListener("click", saveManualMovement);
  elements.saveLedger.addEventListener("click", saveLedgerAdjustment);
  elements.savePayroll.addEventListener("click", savePayrollPayment);
  elements.saveTarget.addEventListener("click", saveStockTarget);
  document.querySelector("#pauseButton").addEventListener("click", () => setStatus("Paused"));
  document.querySelector("#expediteButton").addEventListener("click", () => {
    activeOrder.priority = "Expedite";
    setStatus("Expedited");
  });
  document.querySelector("#reserveButton").addEventListener("click", () => setStatus("Reserved"));
  document.querySelector("#completeButton").addEventListener("click", () => setStatus("Completed"));
  document.querySelector("#deleteOrderButton").addEventListener("click", removeActiveOrder);
  document.querySelector("#addSupplyLineButton").addEventListener("click", addSupplyLine);
  document.querySelector("#addMissingSupplyButton").addEventListener("click", addMissingSupplyLines);
  document.querySelector("#copySupplyOrderButton").addEventListener("click", copySupplyOrder);
  elements.copySupplyTelegram.addEventListener("click", copySupplyTelegram);
  document.querySelector("#orderSupplyButton").addEventListener("click", () => setSupplyStatus("Ordered"));
  elements.receiveSupply.addEventListener("click", receiveSupplyOrder);
  document.querySelector("#deleteSupplyOrderButton").addEventListener("click", removeActiveSupplyOrder);
  elements.newSupplier.addEventListener("click", startNewSupplier);
  elements.saveSupplier.addEventListener("click", saveSupplier);
  elements.deleteSupplier.addEventListener("click", removeActiveSupplier);
  elements.addSupplierProduct.addEventListener("click", addSupplierProduct);
  elements.addSupplierEmployee.addEventListener("click", addSupplierEmployee);
  elements.supplierProduct.addEventListener("input", updateSupplierProductDefaults);
  elements.supplierSearch.addEventListener("input", renderSupplierDirectory);
  [
    elements.supplierName,
    elements.supplierCategory,
    elements.supplierLocation,
    elements.supplierBusinessTelegram,
    elements.supplierOwnerName,
    elements.supplierOwnerTelegram
  ].forEach(field => field.addEventListener("input", updateSupplierFromInputs));

  document.querySelectorAll(".chip-button").forEach(button => {
    button.addEventListener("click", () => {
      activeOrder.lines.push({
        id: crypto.randomUUID(),
        name: button.dataset.custom,
        label: button.dataset.custom,
        tag: "custom_work",
        category: "Custom Work",
        quantity: 1,
        unitPrice: Number(button.dataset.price || 0),
        custom: true
      });
      touchActive();
      render();
    });
  });

  document.querySelectorAll("[data-view]").forEach(button => {
    button.addEventListener("click", () => {
      activeView = button.dataset.view;
      renderView();
    });
  });

  document.querySelectorAll("[data-section]").forEach(button => {
    button.addEventListener("click", () => {
      activeSection = button.dataset.section;
      renderSection();
      if (activeSection === "employees" && isManagement()) loadStaffData();
      if (activeSection === "supplies" && isManagement()) {
        loadSupplyOrders({ silent: true });
        loadSuppliers({ silent: true });
      }
    });
  });

  ["input", "change"].forEach(eventName => {
    elements.customer.addEventListener(eventName, updateActiveFromInputs);
    elements.handler.addEventListener(eventName, updateActiveFromInputs);
    elements.deposit.addEventListener(eventName, updateActiveFromInputs);
    elements.priority.addEventListener(eventName, updateActiveFromInputs);
    elements.deliveryDate.addEventListener(eventName, updateActiveFromInputs);
    elements.status.addEventListener(eventName, updateActiveFromInputs);
    elements.label.addEventListener(eventName, updateActiveFromInputs);
    elements.notes.addEventListener(eventName, updateActiveFromInputs);
  });

  elements.itemSearch.addEventListener("input", () => {
    const item = findCatalogItem(elements.itemSearch.value);
    elements.price.value = item ? item.price : "";
  });

  [elements.supplyProducer, elements.supplyExpectedDate, elements.supplyStatus, elements.supplyNotes]
    .forEach(field => ["input", "change"].forEach(eventName => field.addEventListener(eventName, updateSupplyFromInputs)));

  elements.supplyProducer.addEventListener("change", updateSupplyMaterialDefaults);

  elements.supplyMaterial.addEventListener("input", updateSupplyMaterialDefaults);

  elements.filter.addEventListener("change", renderOrdersList);
  elements.supplyFilter.addEventListener("change", renderSupplyOrdersList);
}

function startNewDocument() {
  if (activeSection === "supplies") {
    activeSupplyOrder = newSupplyOrder();
    renderSupplyWorkspace();
    elements.supplyProducer.focus();
    return;
  }
  activeOrder = newOrder();
  activeSection = "workbench";
  render();
}

function saveCurrentDocument() {
  if (activeSection === "supplies") return saveSupplyOrder();
  saveActiveOrder();
}

function updateActiveFromInputs() {
  activeOrder.customer = elements.customer.value.trim();
  activeOrder.handler = elements.handler.value.trim();
  activeOrder.deposit = Number(elements.deposit.value || 0);
  activeOrder.priority = elements.priority.value;
  activeOrder.deliveryDate = elements.deliveryDate.value;
  activeOrder.status = elements.status.value;
  activeOrder.label = elements.label.value;
  activeOrder.notes = elements.notes.value;
  touchActive();
  renderTotals();
  renderPreview();
  renderMeta();
}

function touchActive() {
  activeOrder.updatedAt = new Date().toISOString();
}

function addItemLine() {
  const searchValue = elements.itemSearch.value.trim();
  if (!searchValue) return;

  const item = findCatalogItem(searchValue) || {
    name: searchValue,
    label: searchValue,
    tag: "",
    category: "Manual",
    price: Number(elements.price.value || 0)
  };

  activeOrder.lines.push({
    id: crypto.randomUUID(),
    name: item.name,
    label: item.label,
    tag: item.tag,
    category: item.category,
    quantity: Math.max(1, Number(elements.quantity.value || 1)),
    unitPrice: Number(elements.price.value || item.price || 0),
    custom: false
  });

  elements.itemSearch.value = "";
  elements.quantity.value = "1";
  elements.price.value = "";
  touchActive();
  render();
}

function findCatalogItem(value) {
  const needle = normalize(value);
  if (!needle) return null;

  const exactMatch = itemCatalog.find(item => [item.name, item.label, item.tag]
    .map(normalize)
    .includes(needle));
  if (exactMatch) return exactMatch;

  return itemCatalog.find(item => {
    const fields = [item.name, item.label, item.tag, item.category].map(normalize);
    return fields.some(field => field.includes(needle));
  });
}

function saveActiveOrder() {
  updateActiveFromInputs();
  const existingIndex = orders.findIndex(order => order.id === activeOrder.id);
  if (existingIndex >= 0) {
    orders[existingIndex] = structuredClone(activeOrder);
  } else {
    orders.unshift(structuredClone(activeOrder));
  }
  persistOrders();
  renderOrdersList();
}

function setStatus(status) {
  activeOrder.status = status;
  if (status === "Expedited") activeOrder.priority = "Expedite";
  saveActiveOrder();
  render();
}

function removeActiveOrder() {
  orders = orders.filter(order => order.id !== activeOrder.id);
  persistOrders();
  activeOrder = newOrder();
  render();
}

function loadOrder(orderId) {
  const order = orders.find(saved => saved.id === orderId);
  if (!order) return;
  activeOrder = structuredClone(order);
  render();
}

function removeLine(lineId) {
  activeOrder.lines = activeOrder.lines.filter(line => line.id !== lineId);
  touchActive();
  render();
}

function updateSupplyFromInputs() {
  activeSupplyOrder.producer = elements.supplyProducer.value.trim();
  activeSupplyOrder.expectedDate = elements.supplyExpectedDate.value;
  activeSupplyOrder.status = elements.supplyStatus.value;
  activeSupplyOrder.requestedBy = currentUser?.fullName || activeSupplyOrder.requestedBy;
  activeSupplyOrder.notes = elements.supplyNotes.value;
  touchSupplyOrder();
  renderSupplySummary();
}

function touchSupplyOrder() {
  activeSupplyOrder.updatedAt = new Date().toISOString();
}

function findRecipeIngredient(value) {
  const needle = normalize(value);
  if (!needle) return null;
  return ingredientCatalog.find(item => normalize(item.name) === needle || normalize(item.label) === needle)
    || ingredientCatalog.find(item => normalize(item.name).includes(needle));
}

function updateSupplyMaterialDefaults() {
  const value = elements.supplyMaterial.value;
  const ingredient = ingredientCatalog.find(item => normalize(item.name) === normalize(value));
  const supplier = suppliers.find(candidate => normalize(candidate.name) === normalize(activeSupplyOrder.producer));
  const supplierProduct = supplier?.products.find(product => normalize(product.name) === normalize(value));
  const item = ingredient || supplierProduct;
  if (!item) return;
  if (ingredient) {
    const metrics = getSupplyLineMetrics(ingredient.name, activeSupplyOrder.id);
    elements.supplyQuantity.value = Math.max(1, metrics.missing);
  }
  elements.supplyUnitPrice.value = preferredSupplyUnitPrice(item.name);
}

function addSupplyLine() {
  const enteredName = elements.supplyMaterial.value.trim();
  if (!enteredName) {
    elements.supplyMaterial.focus();
    return;
  }
  const ingredient = findRecipeIngredient(enteredName) || {
    name: enteredName,
    label: enteredName,
    category: "Manual Material"
  };
  const quantity = Math.max(1, Number(elements.supplyQuantity.value || 1));
  const enteredPrice = elements.supplyUnitPrice.value;
  const unitPrice = Math.max(0, enteredPrice === "" ? preferredSupplyUnitPrice(ingredient.name) : Number(enteredPrice));
  const existing = activeSupplyOrder.lines.find(line => normalize(line.name) === normalize(ingredient.name));
  if (existing) {
    existing.quantity += quantity;
    existing.unitPrice = unitPrice;
  } else {
    activeSupplyOrder.lines.push({
      id: crypto.randomUUID(),
      name: ingredient.name,
      label: ingredient.label || ingredient.name,
      category: ingredient.category || "Recipe Ingredient",
      quantity,
      unitPrice
    });
  }
  elements.supplyMaterial.value = "";
  elements.supplyQuantity.value = "1";
  elements.supplyUnitPrice.value = "0";
  touchSupplyOrder();
  renderSupplyWorkspace();
}

function addMissingSupplyLines() {
  const missing = getMaterialPurchasePlan(activeSupplyOrder.id).filter(line => line.missing > 0);
  if (!missing.length) {
    elements.supplyDataStatus.textContent = "No uncovered material shortages to add";
    return;
  }
  missing.forEach(material => {
    const existing = activeSupplyOrder.lines.find(line => normalize(line.name) === normalize(material.ingredient));
    if (existing) {
      existing.quantity = Math.max(Number(existing.quantity || 0), material.missing);
      return;
    }
    activeSupplyOrder.lines.push({
      id: crypto.randomUUID(),
      name: material.ingredient,
      label: material.ingredient,
      category: "Recipe Ingredient",
      quantity: material.missing,
      unitPrice: preferredSupplyUnitPrice(material.ingredient)
    });
  });
  touchSupplyOrder();
  elements.supplyDataStatus.textContent = `${missing.length} uncovered material lines added`;
  renderSupplyWorkspace();
}

function removeSupplyLine(lineId) {
  activeSupplyOrder.lines = activeSupplyOrder.lines.filter(line => line.id !== lineId);
  touchSupplyOrder();
  renderSupplyWorkspace();
}

function loadSupplyOrder(orderId) {
  const order = supplyOrders.find(candidate => candidate.id === orderId);
  if (!order) return;
  activeSupplyOrder = structuredClone(order);
  renderSupplyWorkspace();
}

async function loadSupplyOrders({ silent = false } = {}) {
  if (!isManagement()) return;
  try {
    const response = await fetch("/api/supply-orders", { headers: { accept: "application/json" } });
    if (response.status === 401) {
      window.location.replace("/login.html");
      return;
    }
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || `API ${response.status}`);
    supplyOrders = Array.isArray(result.orders) ? result.orders : [];
    elements.supplyDataStatus.textContent = `${supplyOrders.length} shared producer orders loaded`;
    seedProducerOptions();
    renderSupplyOrdersList();
    renderDashboard();
  } catch (error) {
    if (!silent) elements.supplyDataStatus.textContent = `Unable to load producer orders: ${error.message}`;
  }
}

async function loadSuppliers({ silent = false } = {}) {
  if (!isManagement()) return;
  try {
    const response = await fetch("/api/suppliers", { headers: { accept: "application/json" } });
    if (response.status === 401) {
      window.location.replace("/login.html");
      return;
    }
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || `API ${response.status}`);
    suppliers = Array.isArray(result.suppliers) ? result.suppliers : [];
    const refreshed = suppliers.find(supplier => supplier.id === activeSupplier.id);
    if (refreshed) activeSupplier = structuredClone(refreshed);
    elements.supplierDataStatus.textContent = `${suppliers.length} shared ${suppliers.length === 1 ? "supplier" : "suppliers"} loaded`;
    seedProducerOptions();
    renderSupplierWorkspace();
  } catch (error) {
    if (!silent) elements.supplierDataStatus.textContent = `Unable to load suppliers: ${error.message}`;
  }
}

function startNewSupplier() {
  activeSupplier = newSupplier();
  renderSupplierWorkspace();
  elements.supplierName.focus();
}

function loadSupplier(supplierId) {
  const supplier = suppliers.find(candidate => candidate.id === supplierId);
  if (!supplier) return;
  activeSupplier = structuredClone(supplier);
  renderSupplierWorkspace();
  elements.supplierPanel.scrollIntoView({ behavior: "smooth", block: "start" });
}

function updateSupplierFromInputs() {
  activeSupplier.name = elements.supplierName.value.trim();
  activeSupplier.category = elements.supplierCategory.value.trim();
  activeSupplier.location = elements.supplierLocation.value.trim();
  activeSupplier.businessTelegram = elements.supplierBusinessTelegram.value.trim();
  activeSupplier.ownerName = elements.supplierOwnerName.value.trim();
  activeSupplier.ownerTelegram = elements.supplierOwnerTelegram.value.trim();
  activeSupplier.updatedAt = new Date().toISOString();
}

async function saveSupplier() {
  updateSupplierFromInputs();
  if (!activeSupplier.name) {
    elements.supplierDataStatus.textContent = "Enter a supplier name before saving";
    elements.supplierName.focus();
    return;
  }
  elements.saveSupplier.disabled = true;
  elements.supplierDataStatus.textContent = `Saving ${activeSupplier.name}`;
  try {
    const response = await fetch("/api/suppliers", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(activeSupplier)
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || `API ${response.status}`);
    activeSupplier = structuredClone(result.supplier);
    suppliers = Array.isArray(result.suppliers) ? result.suppliers : [];
    elements.supplierDataStatus.textContent = `${activeSupplier.name} saved`;
    seedProducerOptions();
    renderSupplierWorkspace();
  } catch (error) {
    elements.supplierDataStatus.textContent = `Supplier save failed: ${error.message}`;
  } finally {
    elements.saveSupplier.disabled = false;
  }
}

async function removeActiveSupplier() {
  const saved = suppliers.some(supplier => supplier.id === activeSupplier.id);
  if (!saved) {
    startNewSupplier();
    return;
  }
  if (!window.confirm(`Remove ${activeSupplier.name} from the supplier directory? Historical orders will be kept.`)) return;
  elements.deleteSupplier.disabled = true;
  try {
    const response = await fetch(`/api/suppliers/${encodeURIComponent(activeSupplier.id)}`, {
      method: "DELETE",
      headers: { accept: "application/json" }
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || `API ${response.status}`);
    suppliers = Array.isArray(result.suppliers) ? result.suppliers : [];
    activeSupplier = newSupplier();
    elements.supplierDataStatus.textContent = "Supplier removed; historical orders were kept";
    seedProducerOptions();
    renderSupplierWorkspace();
  } catch (error) {
    elements.supplierDataStatus.textContent = `Supplier removal failed: ${error.message}`;
  } finally {
    elements.deleteSupplier.disabled = false;
  }
}

function updateSupplierProductDefaults() {
  const ingredient = findRecipeIngredient(elements.supplierProduct.value);
  if (!ingredient) return;
  const existing = activeSupplier.products.find(product => normalize(product.name) === normalize(ingredient.name));
  elements.supplierProductPrice.value = existing ? existing.unitPrice : materialUnitPrice(ingredient.name);
}

function addSupplierProduct() {
  const enteredName = elements.supplierProduct.value.trim();
  if (!enteredName) {
    elements.supplierProduct.focus();
    return;
  }
  const ingredient = findRecipeIngredient(enteredName) || { name: enteredName, label: enteredName };
  const unitPrice = Math.max(0, Number(elements.supplierProductPrice.value || 0));
  const existing = activeSupplier.products.find(product => normalize(product.name) === normalize(ingredient.name));
  if (existing) {
    existing.unitPrice = unitPrice;
  } else {
    activeSupplier.products.push({
      id: crypto.randomUUID(),
      name: ingredient.name,
      label: ingredient.label || ingredient.name,
      unitPrice
    });
  }
  activeSupplier.updatedAt = new Date().toISOString();
  elements.supplierProduct.value = "";
  elements.supplierProductPrice.value = "0";
  renderSupplierProducts();
}

function addSupplierEmployee() {
  if (activeSupplier.employees.length >= 5) {
    elements.supplierDataStatus.textContent = "A supplier can have up to 5 employee contacts";
    return;
  }
  const name = elements.supplierEmployeeName.value.trim();
  const telegram = elements.supplierEmployeeTelegram.value.trim();
  if (!name) {
    elements.supplierDataStatus.textContent = "Enter the employee character name";
    elements.supplierEmployeeName.focus();
    return;
  }
  activeSupplier.employees.push({ id: crypto.randomUUID(), name, telegram });
  activeSupplier.updatedAt = new Date().toISOString();
  elements.supplierEmployeeName.value = "";
  elements.supplierEmployeeTelegram.value = "";
  renderSupplierEmployees();
}

function renderSupplierWorkspace() {
  if (!elements.supplierPanel) return;
  activeSupplier.products = Array.isArray(activeSupplier.products) ? activeSupplier.products : [];
  activeSupplier.employees = Array.isArray(activeSupplier.employees) ? activeSupplier.employees : [];
  elements.supplierName.value = activeSupplier.name || "";
  elements.supplierCategory.value = activeSupplier.category || "";
  elements.supplierLocation.value = activeSupplier.location || "";
  elements.supplierBusinessTelegram.value = activeSupplier.businessTelegram || "";
  elements.supplierOwnerName.value = activeSupplier.ownerName || "";
  elements.supplierOwnerTelegram.value = activeSupplier.ownerTelegram || "";
  const saved = suppliers.some(supplier => supplier.id === activeSupplier.id);
  elements.deleteSupplier.disabled = !saved;
  elements.supplierEditMeta.textContent = saved
    ? `Updated ${formatDate(activeSupplier.updatedAt)} by ${activeSupplier.updatedBy || "Unknown"}`
    : "New supplier record";
  renderSupplierProducts();
  renderSupplierEmployees();
  renderSupplierDirectory();
}

function renderSupplierProducts() {
  elements.supplierProductCount.textContent = `${activeSupplier.products.length} ${activeSupplier.products.length === 1 ? "product" : "products"}`;
  if (!activeSupplier.products.length) {
    elements.supplierProductList.innerHTML = `<div class="empty-card">No quoted products recorded</div>`;
    return;
  }
  elements.supplierProductList.innerHTML = activeSupplier.products
    .sort((a, b) => (a.label || a.name).localeCompare(b.label || b.name))
    .map(product => `
      <div class="supplier-product-row">
        <strong>${escapeHtml(product.label || product.name)}</strong>
        <input class="supplier-price-input" data-supplier-product-price="${product.id}" type="number" min="0" step="0.01" value="${Number(product.unitPrice || 0)}" aria-label="Unit price for ${escapeHtml(product.label || product.name)}">
        <button class="icon-button" data-remove-supplier-product="${product.id}" type="button" title="Remove product">x</button>
      </div>
    `).join("");
  elements.supplierProductList.querySelectorAll("[data-supplier-product-price]").forEach(input => {
    input.addEventListener("input", () => {
      const product = activeSupplier.products.find(candidate => candidate.id === input.dataset.supplierProductPrice);
      if (product) product.unitPrice = Math.max(0, Number(input.value || 0));
    });
  });
  elements.supplierProductList.querySelectorAll("[data-remove-supplier-product]").forEach(button => {
    button.addEventListener("click", () => {
      activeSupplier.products = activeSupplier.products.filter(product => product.id !== button.dataset.removeSupplierProduct);
      activeSupplier.updatedAt = new Date().toISOString();
      renderSupplierProducts();
    });
  });
}

function renderSupplierEmployees() {
  const employeeCount = activeSupplier.employees.length;
  elements.supplierEmployeeCount.textContent = `${employeeCount} of 5`;
  elements.addSupplierEmployee.disabled = employeeCount >= 5;
  if (!employeeCount) {
    elements.supplierEmployeeList.innerHTML = `<div class="empty-card">No employee contacts recorded</div>`;
    return;
  }
  elements.supplierEmployeeList.innerHTML = activeSupplier.employees.map(contact => `
    <div class="supplier-employee-row">
      <input data-supplier-employee-name="${contact.id}" type="text" value="${escapeHtml(contact.name)}" aria-label="Employee character name">
      <input data-supplier-employee-telegram="${contact.id}" type="text" value="${escapeHtml(contact.telegram)}" aria-label="Telegram for ${escapeHtml(contact.name || "employee")}">
      <button class="icon-button" data-remove-supplier-employee="${contact.id}" type="button" title="Remove contact">x</button>
    </div>
  `).join("");
  elements.supplierEmployeeList.querySelectorAll("[data-supplier-employee-name]").forEach(input => {
    input.addEventListener("input", () => {
      const contact = activeSupplier.employees.find(candidate => candidate.id === input.dataset.supplierEmployeeName);
      if (contact) contact.name = input.value;
    });
  });
  elements.supplierEmployeeList.querySelectorAll("[data-supplier-employee-telegram]").forEach(input => {
    input.addEventListener("input", () => {
      const contact = activeSupplier.employees.find(candidate => candidate.id === input.dataset.supplierEmployeeTelegram);
      if (contact) contact.telegram = input.value;
    });
  });
  elements.supplierEmployeeList.querySelectorAll("[data-remove-supplier-employee]").forEach(button => {
    button.addEventListener("click", () => {
      activeSupplier.employees = activeSupplier.employees.filter(contact => contact.id !== button.dataset.removeSupplierEmployee);
      activeSupplier.updatedAt = new Date().toISOString();
      renderSupplierEmployees();
    });
  });
}

function renderSupplierDirectory() {
  const search = normalize(elements.supplierSearch.value);
  const visible = suppliers.filter(supplier => !search || normalize([
    supplier.name,
    supplier.category,
    supplier.location,
    supplier.ownerName,
    supplier.businessTelegram,
    supplier.ownerTelegram,
    ...supplier.products.map(product => product.label || product.name),
    ...supplier.employees.flatMap(contact => [contact.name, contact.telegram])
  ].join(" ")).includes(search));
  elements.supplierSavedCount.textContent = `${suppliers.length} ${suppliers.length === 1 ? "supplier" : "suppliers"}`;
  if (!visible.length) {
    elements.supplierCardList.innerHTML = `<div class="empty-card">No suppliers match this view</div>`;
    return;
  }
  elements.supplierCardList.innerHTML = visible.map(supplier => {
    const offers = supplier.products.slice(0, 3)
      .map(product => `${product.label || product.name} $${formatNumber(product.unitPrice)}`)
      .join(" / ");
    return `
      <button class="supplier-card ${supplier.id === activeSupplier.id ? "selected" : ""}" type="button" data-supplier-id="${supplier.id}">
        <span class="supplier-card-heading">
          <strong>${escapeHtml(supplier.name)}</strong>
          <span>${supplier.products.length} ${supplier.products.length === 1 ? "price" : "prices"}</span>
        </span>
        <span>${escapeHtml(supplier.category || "Uncategorized")} / ${escapeHtml(supplier.location || "Location not set")}</span>
        <span>${escapeHtml(supplier.ownerName || "Owner not recorded")}${supplier.ownerTelegram ? ` / ${escapeHtml(supplier.ownerTelegram)}` : ""}</span>
        <span>${supplier.businessTelegram ? `Business ${escapeHtml(supplier.businessTelegram)}` : "Business telegram not recorded"} / ${supplier.employees.length} employee ${supplier.employees.length === 1 ? "contact" : "contacts"}</span>
        <small>${offers ? escapeHtml(offers) : "No product prices recorded"}</small>
      </button>
    `;
  }).join("");
  elements.supplierCardList.querySelectorAll("[data-supplier-id]").forEach(button => {
    button.addEventListener("click", () => loadSupplier(button.dataset.supplierId));
  });
}

async function saveSupplyOrder() {
  updateSupplyFromInputs();
  const wasDraft = activeSupplyOrder.status === "Draft";
  if (!activeSupplyOrder.producer) {
    elements.supplyDataStatus.textContent = "Choose a producer before saving";
    elements.supplyProducer.focus();
    return;
  }
  elements.saveDocument.disabled = true;
  elements.supplyDataStatus.textContent = "Saving shared producer order";
  try {
    const response = await fetch("/api/supply-orders", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(activeSupplyOrder)
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || `API ${response.status}`);
    activeSupplyOrder = structuredClone(result.order);
    supplyOrders = result.orders || [];
    if (wasDraft) elements.supplyFilter.value = "Active";
    elements.supplyDataStatus.textContent = `Saved as ${activeSupplyOrder.status} for ${activeSupplyOrder.producer}`;
    seedProducerOptions();
    renderSupplyWorkspace();
    renderDashboard();
  } catch (error) {
    elements.supplyDataStatus.textContent = `Save failed: ${error.message}`;
  } finally {
    elements.saveDocument.disabled = false;
  }
}

async function removeActiveSupplyOrder() {
  const saved = supplyOrders.some(order => order.id === activeSupplyOrder.id);
  if (!saved) {
    activeSupplyOrder = newSupplyOrder();
    renderSupplyWorkspace();
    return;
  }
  if (!window.confirm(`Remove the supply order for ${activeSupplyOrder.producer}?`)) return;
  try {
    const response = await fetch(`/api/supply-orders/${encodeURIComponent(activeSupplyOrder.id)}`, {
      method: "DELETE",
      headers: { accept: "application/json" }
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || `API ${response.status}`);
    supplyOrders = result.orders || [];
    activeSupplyOrder = newSupplyOrder();
    elements.supplyDataStatus.textContent = "Supply order removed";
    seedProducerOptions();
    renderSupplyWorkspace();
    renderDashboard();
  } catch (error) {
    elements.supplyDataStatus.textContent = `Remove failed: ${error.message}`;
  }
}

function setSupplyStatus(status) {
  activeSupplyOrder.status = status;
  elements.supplyStatus.value = status;
  saveSupplyOrder();
}

async function receiveSupplyOrder() {
  if (activeSupplyOrder.status !== "Ordered" && activeSupplyOrder.status !== "Partially Received") {
    elements.supplyDataStatus.textContent = "Mark the supply order as Ordered before receiving it";
    return;
  }
  const receipts = [...elements.supplyLines.querySelectorAll("[data-receive-supply-line]")]
    .map(input => ({ lineId: input.dataset.receiveSupplyLine, quantity: Number(input.value || 0) }))
    .filter(receipt => receipt.quantity > 0);
  if (!receipts.length) {
    elements.supplyDataStatus.textContent = "Enter at least one quantity in Receive Now";
    return;
  }

  const orderId = activeSupplyOrder.id;
  supplyReceiptPending = true;
  elements.receiveSupply.disabled = true;
  elements.supplyDataStatus.textContent = "Posting received items to Storage";
  try {
    const response = await fetch(`/api/supply-orders/${encodeURIComponent(orderId)}/receive`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ receipts })
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || `API ${response.status}`);
    activeSupplyOrder = structuredClone(result.order);
    supplyOrders = result.orders || [];
    renderSupplyWorkspace();
    renderDashboard();
    await loadBackendSnapshot({ silent: true });
    const receivedUnits = (result.receipts || []).reduce((sum, receipt) => sum + Number(receipt.quantity || 0), 0);
    elements.supplyDataStatus.textContent = `${formatNumber(receivedUnits)} units added to Storage / ${activeSupplyOrder.status}`;
  } catch (error) {
    await loadSupplyOrders({ silent: true });
    const latest = supplyOrders.find(order => order.id === orderId);
    if (latest) activeSupplyOrder = structuredClone(latest);
    await loadBackendSnapshot({ silent: true });
    renderSupplyWorkspace();
    elements.supplyDataStatus.textContent = `Receipt failed: ${error.message}`;
  } finally {
    supplyReceiptPending = false;
    renderSupplyWorkspace();
  }
}

async function copySupplyOrder() {
  updateSupplyFromInputs();
  const summary = buildSupplyOrderSummary(activeSupplyOrder);
  await navigator.clipboard.writeText(summary);
  elements.supplySummary.textContent = `${summary}\n\nCopied.`;
}

async function copySupplyTelegram() {
  updateSupplyFromInputs();
  const telegram = buildSupplyQuoteTelegram(activeSupplyOrder, {
    name: currentUser?.fullName || activeSupplyOrder.requestedBy,
    title: currentRole === "admin" ? "Owner/proprietor" : "Manager",
    business: "Frontier Firearms, Van Horn"
  });
  await navigator.clipboard.writeText(telegram);
  elements.supplySummary.textContent = `${telegram}\n\nCopied to clipboard.`;
  elements.supplyDataStatus.textContent = `Quotation telegram copied for ${activeSupplyOrder.producer}`;
}

function materialUnitPrice(name) {
  return Number(pricingCatalog.materials[name]?.midpoint || 0);
}

function preferredSupplyUnitPrice(name) {
  const supplier = suppliers.find(candidate => normalize(candidate.name) === normalize(activeSupplyOrder.producer));
  const product = supplier?.products.find(candidate => normalize(candidate.name) === normalize(name));
  return product ? Number(product.unitPrice || 0) : materialUnitPrice(name);
}

function render() {
  elements.customer.value = activeOrder.customer;
  elements.handler.value = activeOrder.handler;
  elements.deposit.value = activeOrder.deposit || 0;
  elements.priority.value = activeOrder.priority;
  elements.deliveryDate.value = activeOrder.deliveryDate || "";
  elements.status.value = activeOrder.status;
  elements.label.value = activeOrder.label;
  elements.notes.value = activeOrder.notes;
  renderLines();
  renderTotals();
  renderPreview();
  renderOrdersList();
  renderMeta();
  renderProduction();
  renderSupplyWorkspace();
  renderSupplierWorkspace();
  renderView();
  renderDashboard();
  renderTimeClock();
  renderOperations();
  renderEmployees();
  renderRole();
  renderSection();
}

function renderLines() {
  if (!activeOrder.lines.length) {
    elements.lines.innerHTML = `<tr><td colspan="5" class="empty-line">No lines yet</td></tr>`;
    return;
  }

  elements.lines.innerHTML = activeOrder.lines.map(line => {
    const total = line.quantity * line.unitPrice;
    return `
      <tr>
        <td>
          <strong>${escapeHtml(line.label || line.name)}</strong>
          <span>${escapeHtml(line.category || "Manual")}${line.tag ? ` / ${escapeHtml(line.tag)}` : ""}</span>
        </td>
        <td>${formatNumber(line.quantity)}</td>
        <td>$${formatNumber(line.unitPrice)}</td>
        <td>$${formatNumber(total)}</td>
        <td><button class="icon-button" type="button" data-remove-line="${line.id}" title="Remove line">x</button></td>
      </tr>
    `;
  }).join("");

  elements.lines.querySelectorAll("[data-remove-line]").forEach(button => {
    button.addEventListener("click", () => removeLine(button.dataset.removeLine));
  });
}

function renderSupplyWorkspace() {
  if (!elements.supplySection) return;
  activeSupplyOrder.requestedBy = activeSupplyOrder.requestedBy || currentUser?.fullName || "";
  elements.supplyProducer.value = activeSupplyOrder.producer;
  elements.supplyRequestedBy.value = activeSupplyOrder.requestedBy;
  elements.supplyExpectedDate.value = activeSupplyOrder.expectedDate || "";
  elements.supplyStatus.value = activeSupplyOrder.status;
  elements.supplyNotes.value = activeSupplyOrder.notes;
  elements.supplyOrderMeta.textContent = `${activeSupplyOrder.status} / ${activeSupplyOrder.producer || "Producer not selected"} / ${formatDate(activeSupplyOrder.updatedAt)}`;
  const hasRemaining = activeSupplyOrder.lines.some(line => Number(line.quantity || 0) > Number(line.receivedQuantity || 0));
  const isSaved = supplyOrders.some(order => order.id === activeSupplyOrder.id);
  elements.copySupplyTelegram.disabled = !isSaved || !activeSupplyOrder.lines.length;
  elements.receiveSupply.disabled = supplyReceiptPending || !hasRemaining || !new Set(["Ordered", "Partially Received"]).has(activeSupplyOrder.status);
  renderSupplyLines();
  renderSupplySummary();
  renderSupplyOrdersList();
  seedProducerOptions();
}

function renderSupplyLines() {
  if (!activeSupplyOrder.lines.length) {
    elements.supplyLines.innerHTML = `<tr><td colspan="12" class="empty-line">No parts or materials added</td></tr>`;
    return;
  }
  elements.supplyLines.innerHTML = activeSupplyOrder.lines.map(line => {
    const metrics = getSupplyLineMetrics(line.name, activeSupplyOrder.id);
    const total = Number(line.quantity || 0) * Number(line.unitPrice || 0);
    const received = Math.max(0, Number(line.receivedQuantity || 0));
    const remaining = Math.max(0, Number(line.quantity || 0) - received);
    const receivable = remaining > 0 && new Set(["Ordered", "Partially Received"]).has(activeSupplyOrder.status);
    return `
      <tr>
        <td><strong>${escapeHtml(line.label || line.name)}</strong><span>${escapeHtml(line.category || "Recipe Ingredient")}</span></td>
        <td>${formatNumber(metrics.demand)}</td>
        <td>${formatNumber(metrics.available)}</td>
        <td>${formatNumber(metrics.ordered)}</td>
        <td class="${metrics.missing > 0 ? "metric-short" : ""}">${formatNumber(metrics.missing)}</td>
        <td>${formatNumber(line.quantity)}</td>
        <td>${formatNumber(received)}</td>
        <td>${formatNumber(remaining)}</td>
        <td><input class="supply-receive-input" data-receive-supply-line="${line.id}" type="number" min="0" max="${remaining}" step="1" value="${receivable ? remaining : 0}" aria-label="Receive ${escapeHtml(line.label || line.name)} now" ${receivable ? "" : "disabled"}></td>
        <td>$${formatNumber(line.unitPrice)}</td>
        <td>$${formatNumber(total)}</td>
        <td><button class="icon-button" type="button" data-remove-supply-line="${line.id}" title="${received > 0 ? "Received lines cannot be removed" : "Remove line"}" ${received > 0 ? "disabled" : ""}>x</button></td>
      </tr>
    `;
  }).join("");
  elements.supplyLines.querySelectorAll("[data-remove-supply-line]").forEach(button => {
    button.addEventListener("click", () => removeSupplyLine(button.dataset.removeSupplyLine));
  });
}

function renderSupplySummary() {
  const subtotal = getSupplyOrderTotal(activeSupplyOrder);
  const activeQuantities = new Map();
  activeSupplyOrder.lines.forEach(line => {
    const key = normalize(line.name);
    const remaining = Math.max(0, Number(line.quantity || 0) - Number(line.receivedQuantity || 0));
    activeQuantities.set(key, (activeQuantities.get(key) || 0) + remaining);
  });
  const uncovered = getMaterialPurchasePlan(activeSupplyOrder.id)
    .reduce((sum, line) => sum + Math.max(0, line.missing - (activeQuantities.get(normalize(line.ingredient)) || 0)), 0);
  elements.supplySubtotal.textContent = `$${formatNumber(subtotal)}`;
  elements.supplyLineCount.textContent = activeSupplyOrder.lines.length;
  elements.supplyUncovered.textContent = formatNumber(uncovered);
  elements.supplySummary.textContent = buildSupplyOrderSummary(activeSupplyOrder);
}

function renderSupplyOrdersList() {
  const filter = elements.supplyFilter.value;
  const visible = supplyOrders
    .filter(order => filter === "All" || (filter === "Active" ? SUPPLY_ACTIVE_STATUSES.has(order.status) : order.status === filter))
    .sort((a, b) => a.producer.localeCompare(b.producer) || new Date(b.updatedAt) - new Date(a.updatedAt));
  const activeCount = supplyOrders.filter(order => SUPPLY_ACTIVE_STATUSES.has(order.status)).length;
  const producerCount = new Set(supplyOrders.map(order => normalize(order.producer))).size;
  elements.supplySavedCount.textContent = `${activeCount} active across ${producerCount} ${producerCount === 1 ? "producer" : "producers"}`;
  if (!visible.length) {
    elements.supplyOrdersList.innerHTML = `<div class="empty-card">No producer orders in this view</div>`;
    return;
  }

  const groups = new Map();
  visible.forEach(order => {
    const key = order.producer || "Unassigned producer";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(order);
  });
  elements.supplyOrdersList.innerHTML = [...groups.entries()].map(([producer, producerOrders]) => `
    <section class="producer-order-group">
      <div class="producer-order-heading">
        <h3>${escapeHtml(producer)}</h3>
        <span>${producerOrders.length} ${producerOrders.length === 1 ? "order" : "orders"}</span>
      </div>
      <div class="orders-list">
        ${producerOrders.map(order => `
          <button class="order-card ${order.id === activeSupplyOrder.id ? "selected" : ""}" type="button" data-supply-order-id="${order.id}">
            <span class="status-pill ${statusClass(order.status)}">${escapeHtml(order.status)}</span>
            <strong>${order.expectedDate ? formatDelivery(order.expectedDate) : "No expected date"}</strong>
            <span>${order.lines.length} lines / ${formatNumber(getSupplyReceivedUnits(order))} of ${formatNumber(getSupplyOrderedUnits(order))} received / $${formatNumber(getSupplyOrderTotal(order))}</span>
            <small>Updated ${formatDate(order.updatedAt)} by ${escapeHtml(order.updatedBy || order.requestedBy)}</small>
          </button>
        `).join("")}
      </div>
    </section>
  `).join("");
  elements.supplyOrdersList.querySelectorAll("[data-supply-order-id]").forEach(button => {
    button.addEventListener("click", () => loadSupplyOrder(button.dataset.supplyOrderId));
  });
}

function seedProducerOptions() {
  const producers = [...new Set([
    ...suppliers.map(supplier => supplier.name),
    ...supplyOrders.map(order => order.producer)
  ].filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
  elements.producerOptions.innerHTML = producers.map(producer => `<option value="${escapeHtml(producer)}"></option>`).join("");
  seedSupplyMaterialOptions();
}

function buildSupplyOrderSummary(order) {
  const lines = order.lines.length
    ? order.lines.map(line => {
      const metrics = getSupplyLineMetrics(line.name, order.id);
      const total = Number(line.quantity || 0) * Number(line.unitPrice || 0);
      const received = Number(line.receivedQuantity || 0);
      const remaining = Math.max(0, Number(line.quantity || 0) - received);
      return `${formatNumber(line.quantity)}x ${line.label || line.name} / ${formatNumber(received)} received / ${formatNumber(remaining)} remaining - $${formatNumber(line.unitPrice)} each = $${formatNumber(total)} / ${formatNumber(metrics.missing)} currently missing`;
    }).join("\n")
    : "No parts or materials added";
  return [
    "Frontier Firearms Supply Order",
    `Producer: ${order.producer || ""}`,
    `Requested by: ${order.requestedBy || currentUser?.fullName || ""}`,
    order.expectedDate ? `Expected: ${formatDelivery(order.expectedDate)}` : "Expected: Not set",
    `Status: ${order.status}`,
    "",
    lines,
    "",
    `Order total: $${formatNumber(getSupplyOrderTotal(order))}`,
    order.notes ? `\nNotes:\n${order.notes}` : ""
  ].filter(line => line !== "").join("\n");
}

function getSupplyOrderTotal(order) {
  return order.lines.reduce((sum, line) => sum + Number(line.quantity || 0) * Number(line.unitPrice || 0), 0);
}

function getSupplyOrderedUnits(order) {
  return order.lines.reduce((sum, line) => sum + Number(line.quantity || 0), 0);
}

function getSupplyReceivedUnits(order) {
  return order.lines.reduce((sum, line) => sum + Number(line.receivedQuantity || 0), 0);
}

function renderTotals() {
  const subtotal = getSubtotal(activeOrder);
  const deposit = Number(activeOrder.deposit || 0);
  elements.subtotal.textContent = `$${formatNumber(subtotal)}`;
  elements.depositValue.textContent = `$${formatNumber(deposit)}`;
  elements.balance.textContent = `$${formatNumber(Math.max(0, subtotal - deposit))}`;
}

function renderPreview() {
  elements.summary.textContent = buildSummary(activeOrder);
}

function renderView() {
  document.querySelectorAll("[data-view]").forEach(button => {
    button.classList.toggle("active", button.dataset.view === activeView);
  });
  elements.quoteView.classList.toggle("hidden", activeView !== "quote");
  elements.productionView.classList.toggle("hidden", activeView !== "production");
}

function renderSection() {
  document.querySelectorAll("[data-section]").forEach(button => {
    button.classList.toggle("active", button.dataset.section === activeSection);
  });
  elements.dashboardSection.classList.toggle("hidden", activeSection !== "dashboard");
  elements.restockSection.classList.toggle("hidden", activeSection !== "restock");
  elements.supplySection.classList.toggle("hidden", activeSection !== "supplies");
  elements.workbenchSection.classList.toggle("hidden", activeSection !== "workbench");
  elements.operationsSection.classList.toggle("hidden", activeSection !== "operations");
  elements.employeesSection.classList.toggle("hidden", activeSection !== "employees");
  const supplyMode = activeSection === "supplies";
  elements.newDocument.textContent = supplyMode ? "New Supply" : "New Sale";
  elements.saveDocument.textContent = supplyMode ? "Save Supply" : "Save Sale";
}

function renderDashboard() {
  const activeOrders = orders.filter(order => !statusesHiddenFromActive.has(order.status));
  const dueToday = activeOrders.filter(isDueToday);
  const overdue = activeOrders.filter(isOverdue);
  const inStore = activeOrders.filter(order => !order.deliveryDate);
  const expedited = activeOrders.filter(order => order.status === "Expedited" || order.priority === "Expedite");
  const paused = activeOrders.filter(order => order.status === "Paused");
  const attention = uniqueOrders([...expedited, ...paused]);
  const expectedDeliveries = supplyOrders
    .filter(order => order.expectedDate === todayKey())
    .filter(order => SUPPLY_DELIVERY_STATUSES.has(order.status))
    .filter(order => getSupplyReceivedUnits(order) < getSupplyOrderedUnits(order))
    .sort((a, b) => (a.producer || "").localeCompare(b.producer || "") || new Date(a.updatedAt) - new Date(b.updatedAt));

  elements.dueTodayCount.textContent = dueToday.length;
  elements.overdueCount.textContent = overdue.length;
  elements.expeditedCount.textContent = expedited.length;
  elements.pausedCount.textContent = paused.length;
  elements.inStoreCount.textContent = inStore.length;
  elements.expectedDeliveryTodayCount.textContent = expectedDeliveries.length;
  elements.dueTodayList.innerHTML = renderDashboardCards(dueToday, "No deliveries due today");
  elements.overdueList.innerHTML = renderDashboardCards(overdue, "No overdue orders");
  elements.attentionList.innerHTML = renderDashboardCards(attention, "No paused or expedited orders");
  elements.inStoreList.innerHTML = renderDashboardCards(inStore, "No active in-store orders");
  elements.expectedDeliveryTodayList.innerHTML = renderSupplyDeliveryCards(expectedDeliveries);
  renderReplenishment();

  [...elements.dueTodayList.querySelectorAll("[data-dashboard-order]"),
   ...elements.overdueList.querySelectorAll("[data-dashboard-order]"),
   ...elements.attentionList.querySelectorAll("[data-dashboard-order]"),
   ...elements.inStoreList.querySelectorAll("[data-dashboard-order]")]
    .forEach(button => button.addEventListener("click", () => {
      loadOrder(button.dataset.dashboardOrder);
      activeSection = "workbench";
      renderSection();
    }));

  elements.expectedDeliveryTodayList.querySelectorAll("[data-dashboard-supply-order]")
    .forEach(button => button.addEventListener("click", () => {
      loadSupplyOrder(button.dataset.dashboardSupplyOrder);
      activeSection = "supplies";
      renderSection();
      window.scrollTo({ top: 0, behavior: "smooth" });
    }));
}

function renderRole() {
  document.body.classList.toggle("employee-view", currentRole === "employee");
  document.body.classList.toggle("manager-view", currentRole === "manager");
  document.body.classList.toggle("admin-view", currentRole === "admin");
  document.body.classList.toggle("accounts-disabled", !currentUser?.accountManagement);
  elements.currentUserName.textContent = currentUser?.fullName || "Loading account";
  elements.currentUserRole.textContent = ({ admin: "Admin", manager: "Manager", employee: "Employee" })[currentRole] || "Employee";
  if ((!isManagement() || !currentUser?.accountManagement) && activeSection === "employees") {
    activeSection = "dashboard";
    renderSection();
  }
  if (!isManagement() && (activeSection === "operations" || activeSection === "supplies")) {
    activeSection = "dashboard";
    renderSection();
  }
}

function isManagement() {
  return currentRole === "admin" || currentRole === "manager";
}

function renderReplenishment() {
  const plan = getReplenishmentPlan();
  const materialShortages = plan.materials.filter(line => line.shortage > 0);
  elements.missingStockCount.textContent = plan.missing.length;
  elements.materialShortageCount.textContent = materialShortages.length;
  elements.replenishmentMeta.textContent = stockTargets.length
    ? `${plan.missing.length} storefront lines missing / ${materialShortages.length} material shortages${plan.missingRecipes.length ? ` / ${plan.missingRecipes.length} missing recipes` : ""}`
    : "Set admin stock targets to generate a standing order";

  elements.replenishmentList.innerHTML = plan.missing.length
    ? plan.missing.map(line => `
      <div class="replenishment-row">
        <strong>${escapeHtml(line.label)}</strong>
        <span>Have ${formatNumber(line.current)} / Target ${formatNumber(line.target)} / Make ${formatNumber(line.missing)}</span>
      </div>
    `).join("")
    : `<div class="empty-card">${stockTargets.length ? "Storefront targets are currently filled" : "No storefront targets set yet"}</div>`;

  const materialRows = materialShortages.map(line => `
      <div class="replenishment-row short">
        <strong>${escapeHtml(line.ingredient)}</strong>
        <span>Need ${formatNumber(line.needed)} / Storage ${formatNumber(line.available)} / Short ${formatNumber(line.shortage)}</span>
      </div>
    `).join("");
  const missingRecipeRows = plan.missingRecipes.length ? `
    <div class="replenishment-row short">
      <strong>Missing Recipes</strong>
      <span>${plan.missingRecipes.map(escapeHtml).join(", ")}</span>
    </div>
  ` : "";
  elements.replenishmentMaterialsList.innerHTML = materialRows || missingRecipeRows
    ? materialRows + missingRecipeRows
    : `<div class="empty-card">Storage covers all known recipe needs</div>`;

  elements.stockAlertList.innerHTML = plan.missing.length
    ? plan.missing.map(line => `
      <div class="replenishment-row short">
        <strong>${escapeHtml(line.label)}</strong>
        <span>${formatNumber(line.current)} in store / ${formatNumber(line.missing)} needed</span>
      </div>
    `).join("")
    : `<div class="empty-card">${stockTargets.length ? "All storefront targets are filled" : "No storefront targets set yet"}</div>`;
}

function renderTimeClock() {
  const current = timeClock.current;
  elements.clockEmployee.value = current?.employee || currentUser?.fullName || elements.clockEmployee.value;
  elements.clockEmployee.disabled = Boolean(currentUser);
  elements.clockToggle.textContent = current ? "Clock Out" : "Clock In";
  elements.clockStatus.textContent = current
    ? `${current.employee} clocked in at ${formatDateTime(current.clockIn)} / ${current.syncStatus || "Pending sheet sync"}`
    : "Clocked out";

  const recentEntries = timeClock.entries.slice(0, 5);
  elements.timeClockList.innerHTML = recentEntries.length
    ? recentEntries.map(entry => `
      <div class="time-entry">
        <strong>${escapeHtml(entry.employee)}</strong>
        <span>${formatDateTime(entry.clockIn)} - ${formatDateTime(entry.clockOut)}</span>
        <small>${formatDuration(entry.durationMinutes)} / ${escapeHtml(entry.syncStatus || "Pending sheet sync")}</small>
      </div>
    `).join("")
    : `<div class="empty-card">No completed shifts yet</div>`;
}

function renderDashboardCards(items, emptyText) {
  if (!items.length) return `<div class="empty-card">${emptyText}</div>`;
  return items.map(order => `
    <button class="dashboard-order" type="button" data-dashboard-order="${order.id}">
      <span class="status-pill ${order.status.toLowerCase()}">${escapeHtml(order.status)}</span>
      <strong>${escapeHtml(order.customer || "Unnamed customer")}</strong>
      <span>${formatDelivery(order.deliveryDate)} / ${order.lines.length} lines / $${formatNumber(getSubtotal(order))}</span>
    </button>
  `).join("");
}

function renderSupplyDeliveryCards(items) {
  if (!items.length) return `<div class="empty-card">No supply deliveries expected today</div>`;
  return items.map(order => {
    const ordered = getSupplyOrderedUnits(order);
    const received = getSupplyReceivedUnits(order);
    const remaining = Math.max(0, ordered - received);
    const remainingLines = order.lines.filter(line => Number(line.receivedQuantity || 0) < Number(line.quantity || 0)).length;
    return `
      <button class="dashboard-order" type="button" data-dashboard-supply-order="${order.id}">
        <span class="status-pill ${statusClass(order.status)}">${escapeHtml(order.status)}</span>
        <strong>${escapeHtml(order.producer || "Unassigned producer")}</strong>
        <span>${formatNumber(remaining)} units remaining / ${remainingLines} ${remainingLines === 1 ? "line" : "lines"} / $${formatNumber(getSupplyOrderTotal(order))}</span>
      </button>
    `;
  }).join("");
}

function renderProduction() {
  const production = getProductionPlan(activeOrder);
  elements.productionMeta.textContent = `${production.buildLines.length} craftable lines / ${production.materials.length} materials / est. $${formatNumber(production.materialCost)}`;

  if (!production.buildLines.length) {
    elements.productionBuildList.innerHTML = `<div class="empty-card">No craftable quote lines yet</div>`;
  } else {
    elements.productionBuildList.innerHTML = production.buildLines.map(line => `
      <div class="production-row">
        <strong>${escapeHtml(line.name)}</strong>
        <span>${formatNumber(line.quantity)} needed${line.yield > 1 ? ` / ${formatNumber(line.batches)} ${line.batches === 1 ? "batch" : "batches"} makes ${formatNumber(line.producedQuantity)}` : ""} / $${formatNumber(line.unitCost)} ea</span>
      </div>
    `).join("");
  }

  if (!production.materials.length) {
    elements.productionMaterialsList.innerHTML = `<div class="empty-card">No materials needed yet</div>`;
  } else {
    elements.productionMaterialsList.innerHTML = production.materials.map(material => `
      <div class="production-row">
        <strong>${escapeHtml(material.ingredient)}</strong>
        <span>${formatNumber(material.qty)} / $${formatNumber(material.cost)}</span>
      </div>
    `).join("");
  }

  elements.missingRecipes.innerHTML = production.missing.length
    ? `<strong>No recipe attached:</strong> ${production.missing.map(escapeHtml).join(", ")}`
    : "";
}

function renderOrdersList() {
  const filter = elements.filter.value;
  const visibleOrders = orders
    .filter(order => filter === "All" || (filter === "Active" ? !statusesHiddenFromActive.has(order.status) : order.status === filter))
    .sort((a, b) => sortOrder(a, b));

  const activeCount = orders.filter(order => !statusesHiddenFromActive.has(order.status)).length;
  elements.savedCount.textContent = `${activeCount} active`;

  if (!visibleOrders.length) {
    elements.ordersList.innerHTML = `<div class="empty-card">No saved work orders</div>`;
    return;
  }

  elements.ordersList.innerHTML = visibleOrders.map(order => `
    <button class="order-card ${order.id === activeOrder.id ? "selected" : ""}" type="button" data-order-id="${order.id}">
      <span class="status-pill ${order.status.toLowerCase()}">${escapeHtml(order.status)}</span>
      <strong>${escapeHtml(order.customer || "Unnamed customer")}</strong>
      <span>${order.lines.length} lines / $${formatNumber(getSubtotal(order))}</span>
      <span>${formatDelivery(order.deliveryDate)}</span>
      <small>${formatDate(order.updatedAt)}</small>
    </button>
  `).join("");

  elements.ordersList.querySelectorAll("[data-order-id]").forEach(button => {
    button.addEventListener("click", () => loadOrder(button.dataset.orderId));
  });
}

function renderMeta() {
  elements.orderMeta.textContent = `${activeOrder.status} / ${activeOrder.priority} / ${formatDate(activeOrder.updatedAt)}`;
}

async function copySummary() {
  updateActiveFromInputs();
  const summary = buildSummary(activeOrder);
  await navigator.clipboard.writeText(summary);
  elements.summary.textContent = `${summary}\n\nCopied.`;
}

async function copyProduction() {
  const text = buildProductionSummary(activeOrder);
  await navigator.clipboard.writeText(text);
  elements.productionMeta.textContent = "Production list copied";
}

function buildSummary(order) {
  const lines = order.lines.length
    ? order.lines.map(line => {
      const total = line.quantity * line.unitPrice;
      return `${formatNumber(line.quantity)}x ${line.label || line.name} - $${formatNumber(line.unitPrice)} each = $${formatNumber(total)}`;
    }).join("\n")
    : "No items added";

  const subtotal = getSubtotal(order);
  const deposit = Number(order.deposit || 0);
  const balance = Math.max(0, subtotal - deposit);
  const details = [order.label, order.notes].filter(Boolean).join("\n");

  return [
    "Frontier Firearms Quote",
    `Customer: ${order.customer || ""}`,
    order.handler ? `Handler: ${order.handler}` : "",
    order.deliveryDate ? `Delivery: ${formatDelivery(order.deliveryDate)}` : "Order Type: In-store",
    `Status: ${order.status}${order.priority === "Expedite" ? " / Expedite" : ""}`,
    "",
    lines,
    "",
    `Subtotal: $${formatNumber(subtotal)}`,
    `Deposit Paid: $${formatNumber(deposit)}`,
    `Balance Due: $${formatNumber(balance)}`,
    details ? `\nNotes:\n${details}` : ""
  ].filter(line => line !== "").join("\n");
}

function buildProductionSummary(order) {
  const production = getProductionPlan(order);
  const buildLines = production.buildLines.length
    ? production.buildLines.map(line => `${formatNumber(line.quantity)}x ${line.name}${line.yield > 1 ? ` / ${formatNumber(line.batches)} ${line.batches === 1 ? "batch" : "batches"} makes ${formatNumber(line.producedQuantity)}` : ""} / $${formatNumber(line.unitCost)} each`).join("\n")
    : "No craftable lines";
  const materials = production.materials.length
    ? production.materials.map(material => `${formatNumber(material.qty)}x ${material.ingredient} - $${formatNumber(material.cost)}`).join("\n")
    : "No materials needed";
  const missing = production.missing.length
    ? `\nNo recipe attached:\n${production.missing.join("\n")}`
    : "";

  return [
    "Frontier Firearms Production",
    `Customer: ${order.customer || ""}`,
    "",
    "Build:",
    buildLines,
    "",
    "Materials:",
    materials,
    `Estimated material cost: $${formatNumber(production.materialCost)}`,
    missing
  ].filter(line => line !== "").join("\n");
}

function toggleTimeClock() {
  const employee = currentUser?.fullName || elements.clockEmployee.value.trim();
  if (!timeClock.current && !employee) {
    elements.clockEmployee.focus();
    return;
  }

  if (timeClock.current) {
    const clockOut = new Date().toISOString();
    const durationMinutes = Math.max(0, Math.round((new Date(clockOut) - new Date(timeClock.current.clockIn)) / 60000));
    const completedEntry = {
      ...timeClock.current,
      clockOut,
      durationMinutes,
      syncStatus: "Pending sheet sync"
    };
    timeClock.entries.unshift(completedEntry);
    timeClock.current = null;
    persistTimeClock();
    syncTimeClockEntry(completedEntry.id);
  } else {
    timeClock.current = {
      id: crypto.randomUUID(),
      employee,
      clockIn: new Date().toISOString(),
      clockOut: "",
      durationMinutes: "",
      syncStatus: "Pending sheet sync"
    };
    persistTimeClock();
    syncTimeClockEntry(timeClock.current.id);
  }

  renderTimeClock();
}

function saveManualCount() {
  const item = resolveStockItem(elements.countItem.value);
  const quantity = Number(elements.countQuantity.value || 0);
  if (!item.label && !item.name) {
    elements.countItem.focus();
    return;
  }

  addOperation({
    kind: "Stock Count",
    location: elements.countLocation.value,
    itemName: item.name,
    itemLabel: item.label,
    itemTag: item.tag,
    quantity,
    employee: currentUser?.fullName || elements.countEmployee.value.trim(),
    amount: "",
    note: `Counted ${formatNumber(quantity)} at ${elements.countLocation.value}`
  });

  elements.countItem.value = "";
  elements.countQuantity.value = "0";
  renderReplenishment();
}

function saveManualMovement() {
  const item = resolveStockItem(elements.movementItem.value);
  const quantity = Math.max(1, Number(elements.movementQuantity.value || 1));
  if (!item.label && !item.name) {
    elements.movementItem.focus();
    return;
  }

  addOperation({
    kind: elements.movementType.value,
    location: "",
    itemName: item.name,
    itemLabel: item.label,
    itemTag: item.tag,
    quantity,
    employee: currentUser?.fullName || elements.movementEmployee.value.trim(),
    amount: Number(elements.movementAmount.value || 0),
    note: elements.movementNote.value.trim()
  });

  elements.movementItem.value = "";
  elements.movementQuantity.value = "1";
  elements.movementAmount.value = "0";
  elements.movementNote.value = "";
  renderReplenishment();
}

function saveLedgerAdjustment() {
  const amount = Number(elements.ledgerAmount.value || 0);
  addOperation({
    kind: elements.ledgerType.value,
    location: "Ledger",
    itemName: "",
    itemLabel: "",
    itemTag: "",
    quantity: "",
    employee: currentUser?.fullName || elements.ledgerEmployee.value.trim(),
    amount,
    note: elements.ledgerNote.value.trim()
  });

  elements.ledgerAmount.value = "0";
  elements.ledgerNote.value = "";
}

function savePayrollPayment() {
  const payee = elements.payrollEmployee.value.trim();
  const periodStart = elements.payrollPeriodStart.value;
  const periodEnd = elements.payrollPeriodEnd.value;
  const amount = Number(elements.payrollAmount.value || 0);
  if (!payee) {
    elements.payrollEmployee.focus();
    return;
  }
  if (!periodStart) {
    elements.payrollPeriodStart.focus();
    return;
  }
  if (!periodEnd || periodEnd < periodStart) {
    elements.payrollPeriodEnd.focus();
    return;
  }
  if (amount <= 0) {
    elements.payrollAmount.focus();
    return;
  }

  addOperation({
    kind: "Payroll Payment",
    location: "Payroll",
    itemName: "",
    itemLabel: payee,
    itemTag: "",
    quantity: "",
    amount,
    employee: currentUser?.fullName || elements.payrollEnteredBy.value.trim(),
    note: elements.payrollNote.value.trim(),
    payee,
    payPeriodStart: periodStart,
    payPeriodEnd: periodEnd,
    paymentMethod: elements.payrollMethod.value,
    reference: elements.payrollReference.value.trim()
  });

  elements.payrollAmount.value = "0";
  elements.payrollReference.value = "";
  elements.payrollNote.value = "";
}

function saveStockTarget() {
  const item = resolveItem(elements.targetItem.value);
  const target = Number(elements.targetQuantity.value || 0);
  if (!item.label && !item.name) {
    elements.targetItem.focus();
    return;
  }

  const nextTarget = {
    itemName: item.name,
    itemLabel: item.label,
    itemTag: item.tag,
    target,
    updatedAt: new Date().toISOString(),
    syncStatus: "Pending sheet sync"
  };
  const existingIndex = stockTargets.findIndex(saved => stockKey(saved) === stockKey(nextTarget));
  if (existingIndex >= 0 && target === 0) {
    removeStockTarget(stockKey(nextTarget));
    elements.targetItem.value = "";
    elements.targetQuantity.value = "0";
    elements.saveTarget.textContent = "Save Target";
    return;
  }
  if (existingIndex >= 0) {
    stockTargets[existingIndex] = nextTarget;
  } else {
    stockTargets.unshift(nextTarget);
  }

  persistStockTargets();
  elements.targetItem.value = "";
  elements.targetQuantity.value = "0";
  elements.saveTarget.textContent = "Save Target";
  renderOperations();
  renderReplenishment();
  syncStockTarget(stockKey(nextTarget));
}

function addOperation(entry) {
  const savedEntry = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    syncStatus: "Pending sheet sync",
    ...entry
  };
  operations.unshift(savedEntry);
  persistOperations();
  renderOperations();
  syncOperation(savedEntry.id);
}

function renderOperations() {
  const visibleOperations = currentRole === "admin"
    ? operations
    : currentRole === "manager"
      ? operations.filter(entry => entry.location !== "Payroll")
      : [];
  const pendingCount = visibleOperations.filter(entry => entry.syncStatus !== "Synced").length;
  elements.operationCount.textContent = `${pendingCount} entries waiting for sheet sync`;
  renderTargets();

  if (!visibleOperations.length) {
    elements.operationList.innerHTML = `<div class="empty-card">No manual activity recorded yet</div>`;
    return;
  }

  elements.operationList.innerHTML = visibleOperations.slice(0, 30).map(entry => {
    const title = entry.itemLabel || entry.itemName || entry.location || "Ledger";
    const quantity = entry.quantity !== "" ? `Qty ${formatNumber(entry.quantity)}` : "";
    const amount = entry.amount !== "" ? `$${formatNumber(entry.amount)}` : "";
    const detail = [entry.location, quantity, amount, entry.employee].filter(Boolean).join(" / ");
    return `
      <div class="operation-entry">
        <span class="status-pill">${escapeHtml(entry.syncStatus)}</span>
        <strong>${escapeHtml(entry.kind)}: ${escapeHtml(title)}</strong>
        <span>${escapeHtml(detail || "No detail")}</span>
        ${entry.note ? `<small>${escapeHtml(entry.note)}</small>` : ""}
        <small>${formatDateTime(entry.createdAt)}</small>
      </div>
    `;
  }).join("");
}

function renderTargets() {
  if (!stockTargets.length) {
    elements.targetList.innerHTML = `<div class="empty-card">No storefront targets set yet</div>`;
    return;
  }

  const counts = getLatestCounts("Storefront");
  elements.targetList.innerHTML = stockTargets.map(target => {
    const current = counts.get(stockKey(target)) || 0;
    const key = escapeHtml(stockKey(target));
    return `
      <div class="target-row">
        <div class="target-row-header">
          <strong>${escapeHtml(target.itemLabel || target.itemName)}</strong>
          <div class="target-actions">
            <button class="ghost-button target-action" type="button" data-target-edit="${key}" ${target.deleting ? "disabled" : ""}>Edit</button>
            <button class="danger-button target-action" type="button" data-target-remove="${key}" ${target.deleting ? "disabled" : ""}>Remove</button>
          </div>
        </div>
        <span>Target ${formatNumber(target.target)} / Counted ${formatNumber(current)} / ${escapeHtml(target.syncStatus || "Pending sheet sync")}</span>
      </div>
    `;
  }).join("");

  elements.targetList.querySelectorAll("[data-target-edit]").forEach(button => {
    button.addEventListener("click", () => editStockTarget(button.dataset.targetEdit));
  });
  elements.targetList.querySelectorAll("[data-target-remove]").forEach(button => {
    button.addEventListener("click", () => removeStockTarget(button.dataset.targetRemove));
  });
}

function editStockTarget(targetKey) {
  const target = stockTargets.find(item => stockKey(item) === targetKey);
  if (!target || target.deleting) return;
  elements.targetItem.value = target.itemLabel || target.itemName;
  elements.targetQuantity.value = target.target;
  elements.saveTarget.textContent = "Update Target";
  elements.targetQuantity.focus();
  elements.targetQuantity.select();
}

function removeStockTarget(targetKey) {
  const target = stockTargets.find(item => stockKey(item) === targetKey);
  if (!target || target.deleting) return;
  if (!window.confirm(`Remove the storefront target for ${target.itemLabel || target.itemName}?`)) return;

  target.target = 0;
  target.updatedAt = new Date().toISOString();
  target.deleting = true;
  target.syncStatus = "Removal pending";
  persistStockTargets();
  renderOperations();
  renderReplenishment();
  syncStockTarget(targetKey);
}

function resolveItem(value) {
  const trimmed = value.trim();
  if (!trimmed) return { name: "", label: "", tag: "" };
  const item = findCatalogItem(trimmed);
  return item || { name: trimmed, label: trimmed, tag: "" };
}

function resolveStockItem(value) {
  const trimmed = value.trim();
  if (!trimmed) return { name: "", label: "", tag: "" };
  const needle = normalize(trimmed);
  const item = stockCatalog.find(entry => {
    const haystack = normalize(`${entry.name} ${entry.label || ""} ${entry.tag || ""} ${entry.category || ""}`);
    return haystack.includes(needle);
  });
  return item || { name: trimmed, label: trimmed, tag: "", category: "Manual" };
}

async function loadSessionAndData() {
  try {
    const response = await fetch("/api/auth/session", { headers: { accept: "application/json" } });
    const result = await response.json();
    if (!response.ok || !result.user) throw new Error("Authentication required");
    currentUser = result.user;
    currentRole = currentUser.role;
    timeClock = loadTimeClock(timeClockStorageKey());
    migrateLegacyTimeClock();
    applyIdentityDefaults();
    render();
    await loadBackendSnapshot();
    startBackendRefreshLoop();
    if (isManagement()) {
      await Promise.all([loadSupplyOrders(), loadSuppliers()]);
      await loadStaffData();
    }
  } catch {
    window.location.replace("/login.html");
  }
}

function migrateLegacyTimeClock() {
  if (timeClock.current || timeClock.entries.length) return;
  const legacy = loadTimeClock(TIME_CLOCK_KEY);
  if (legacy.current && normalize(legacy.current.employee) === normalize(currentUser.fullName)) {
    timeClock = legacy;
    persistTimeClock();
  }
}

function applyIdentityDefaults() {
  const identityFields = [
    elements.clockEmployee,
    elements.countEmployee,
    elements.movementEmployee,
    elements.ledgerEmployee,
    elements.payrollEnteredBy
  ];
  identityFields.forEach(field => {
    if (!field) return;
    field.value = currentUser.fullName;
    field.disabled = true;
  });
  if (!elements.handler.value) elements.handler.value = currentUser.fullName;
  if (!activeSupplyOrder.requestedBy) activeSupplyOrder.requestedBy = currentUser.fullName;
}

async function logout() {
  elements.logout.disabled = true;
  try {
    await fetch("/api/auth/logout", { method: "POST", headers: { accept: "application/json" } });
  } finally {
    window.location.replace("/login.html");
  }
}

async function loadEmployeeUsers() {
  try {
    const response = await fetch("/api/admin/users", { headers: { accept: "application/json" } });
    if (response.status === 401) {
      window.location.replace("/login.html");
      return;
    }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Unable to load accounts");
    employeeUsers = result.users || [];
    renderEmployees();
  } catch (error) {
    elements.pendingUserList.innerHTML = `<div class="empty-card">${escapeHtml(error.message)}</div>`;
  }
}

async function loadAuditEvents() {
  if (!isManagement() || !currentUser?.accountManagement) return;
  elements.refreshAudit.disabled = true;
  try {
    const response = await fetch("/api/admin/audit?limit=1000", { headers: { accept: "application/json" } });
    if (response.status === 401) {
      window.location.replace("/login.html");
      return;
    }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Unable to load audit ledger");
    auditEvents = result.events || [];
    renderAuditFilters();
    renderAudit();
  } catch (error) {
    elements.auditMeta.textContent = error.message;
    elements.auditList.innerHTML = `<div class="empty-card">Audit ledger is unavailable</div>`;
  } finally {
    elements.refreshAudit.disabled = false;
  }
}

async function loadStaffData() {
  await Promise.all([loadEmployeeUsers(), loadAuditEvents()]);
  renderAuditFilters();
  renderAudit();
}

function renderEmployees() {
  if (!elements.pendingUserList || !isManagement()) return;
  const pending = employeeUsers.filter(user => user.status === "pending");
  const established = employeeUsers.filter(user => user.status !== "pending");
  elements.pendingUserCount.textContent = `${pending.length} pending`;
  elements.pendingUserList.innerHTML = pending.length
    ? pending.map(user => employeeCard(user, true)).join("")
    : `<div class="empty-card">No access requests waiting</div>`;
  elements.employeeUserList.innerHTML = established.length
    ? established.map(user => employeeCard(user, false)).join("")
    : `<div class="empty-card">No employee accounts yet</div>`;
}

function employeeCard(user, pending) {
  const isSelf = user.id === currentUser?.id;
  const canManageAccount = currentRole === "admin" || user.role === "employee";
  const actions = pending
    ? canManageAccount
      ? `<button class="primary-button" type="button" data-user-action="approve" data-user-id="${user.id}">Approve</button>
         <button class="danger-button" type="button" data-user-action="reject" data-user-id="${user.id}">Reject</button>`
      : ""
    : user.status === "disabled"
      ? canManageAccount
        ? `<button class="ghost-button" type="button" data-user-action="approve" data-user-id="${user.id}">Reactivate</button>`
        : ""
      : isSelf || !canManageAccount
        ? ""
        : `${currentRole === "admin" && user.role === "employee"
            ? `<button class="ghost-button" type="button" data-user-action="promote" data-user-id="${user.id}">Make Manager</button>`
            : currentRole === "admin" && user.role === "manager"
              ? `<button class="ghost-button" type="button" data-user-action="demote" data-user-id="${user.id}">Make Employee</button>`
              : ""}
           <button class="danger-button" type="button" data-user-action="disable" data-user-id="${user.id}">Disable</button>`;
  return `
    <div class="employee-row">
      <div class="employee-identity">
        <strong>${escapeHtml(user.fullName)}</strong>
        <span>${escapeHtml(({ admin: "Admin", manager: "Manager", employee: "Employee" })[user.role] || user.role)} / ${escapeHtml(user.status)}</span>
        <small>${pending ? `Requested ${formatDateTime(user.createdAt)}` : user.lastLoginAt ? `Last signed in ${formatDateTime(user.lastLoginAt)}` : "Has not signed in yet"}</small>
      </div>
      <div class="employee-actions">${actions}</div>
    </div>
  `;
}

async function handleEmployeeAction(event) {
  const button = event.target.closest("[data-user-action]");
  if (!button) return;
  const user = employeeUsers.find(candidate => candidate.id === button.dataset.userId);
  if (!user) return;
  const action = button.dataset.userAction;
  const confirmations = {
    disable: `Disable ${user.fullName}?`,
    reject: `Reject ${user.fullName}'s access request?`,
    promote: `Grant manager access to ${user.fullName}?`,
    demote: `Return ${user.fullName} to employee access?`
  };
  if (confirmations[action] && !window.confirm(confirmations[action])) return;

  button.disabled = true;
  try {
    const response = await fetch(`/api/admin/users/${encodeURIComponent(user.id)}/${action}`, {
      method: "POST",
      headers: { accept: "application/json" }
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Unable to update account");
    await loadStaffData();
  } catch (error) {
    window.alert(error.message);
    button.disabled = false;
  }
}

function renderAuditFilters() {
  const selectedEmployee = elements.auditEmployeeFilter.value;
  const selectedAction = elements.auditActionFilter.value;
  const names = [...new Set([
    ...employeeUsers.map(user => user.fullName),
    ...auditEvents.flatMap(event => [event.subjectName, event.actorName])
  ].filter(Boolean))].sort((a, b) => a.localeCompare(b));
  elements.auditEmployeeFilter.innerHTML = `<option value="">All employees</option>${names
    .map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`)
    .join("")}`;
  if (names.includes(selectedEmployee)) elements.auditEmployeeFilter.value = selectedEmployee;

  const actions = [...new Set(auditEvents
    .map(event => String(event.action || "").trim())
    .filter(Boolean))]
    .sort((a, b) => auditActionLabel(a).localeCompare(auditActionLabel(b)));
  elements.auditActionFilter.innerHTML = `<option value="">All event types</option>${actions
    .map(action => `<option value="${escapeHtml(action)}">${escapeHtml(auditActionLabel(action))}</option>`)
    .join("")}`;
  if (actions.includes(selectedAction)) elements.auditActionFilter.value = selectedAction;
}

function renderAudit() {
  if (!elements.auditList || !isManagement()) return;
  const employee = normalize(elements.auditEmployeeFilter.value);
  const category = elements.auditCategoryFilter.value;
  const action = elements.auditActionFilter.value;
  const search = normalize(elements.auditSearch.value);
  const filtered = auditEvents.filter(event => {
    if (employee && normalize(event.subjectName) !== employee && normalize(event.actorName) !== employee) return false;
    if (category && event.category !== category) return false;
    if (action && event.action !== action) return false;
    if (search && !normalize(`${event.action} ${event.actorName} ${event.subjectName} ${JSON.stringify(event.details || {})}`).includes(search)) return false;
    return true;
  });
  elements.auditMeta.textContent = `${filtered.length} of ${auditEvents.length} recorded events`;
  elements.auditList.innerHTML = filtered.length
    ? filtered.map(auditEventRow).join("")
    : `<div class="empty-card">No audit events match these filters</div>`;
}

function auditEventRow(event) {
  const label = auditActionLabel(event.action);
  const subject = event.subjectName || event.actorName || "Unknown employee";
  const actor = event.actorName && event.actorName !== subject ? ` / by ${event.actorName}` : "";
  const details = formatAuditDetails(event);
  return `
    <div class="audit-entry">
      <div class="audit-entry-header">
        <strong>${escapeHtml(label)}</strong>
        <time datetime="${escapeHtml(event.createdAt)}">${formatDateTime(event.createdAt)}</time>
      </div>
      <span>${escapeHtml(subject + actor)}</span>
      ${details ? `<small>${escapeHtml(details)}</small>` : ""}
    </div>
  `;
}

function auditActionLabel(action) {
  return AUDIT_ACTION_LABELS[action] || action || "Unknown event";
}

function formatAuditDetails(event) {
  const details = event.details || {};
  if (event.action === "clock.in") return `Started ${formatDateTime(details.clockIn)}`;
  if (event.action === "clock.out") return `${formatDuration(details.durationMinutes)} / ${formatDateTime(details.clockIn)} to ${formatDateTime(details.clockOut)}`;
  if (event.action === "operation.recorded") {
    return [details.kind, details.item, details.location, details.quantity !== "" ? `Qty ${details.quantity}` : "", details.amount !== "" ? `$${formatNumber(details.amount)}` : "", details.note]
      .filter(Boolean).join(" / ");
  }
  if (event.action === "target.updated" || event.action === "target.removed") {
    return [details.item, event.action === "target.updated" ? `Target ${details.target}` : "Removed"].filter(Boolean).join(" / ");
  }
  if (event.action === "account.role_changed") return `${details.previousRole} to ${details.role}`;
  if (details.previousStatus || details.status) return [details.previousStatus, details.status].filter(Boolean).join(" to ");
  return "";
}

async function syncOperation(entryId) {
  const entry = operations.find(item => item.id === entryId);
  if (!entry) return;
  const result = await syncToBackend("manual_operation", { entry });
  entry.syncStatus = result.ok ? "Synced" : "Pending sheet sync";
  persistOperations();
  renderOperations();
}

async function syncStockTarget(targetKey) {
  const target = stockTargets.find(item => stockKey(item) === targetKey);
  if (!target) return;
  const result = await syncToBackend("stock_target", { target });
  if (result.ok && target.deleting) {
    stockTargets = stockTargets.filter(item => stockKey(item) !== targetKey);
  } else {
    target.syncStatus = result.ok ? "Synced" : (target.deleting ? "Removal pending" : "Pending sheet sync");
  }
  persistStockTargets();
  renderOperations();
  renderReplenishment();
}

async function syncTimeClockEntry(entryId) {
  const entry = timeClock.entries.find(item => item.id === entryId)
    || (timeClock.current?.id === entryId ? timeClock.current : null);
  if (!entry) return;
  const result = await syncToBackend("time_clock", { entry });
  const latestEntry = timeClock.entries.find(item => item.id === entryId)
    || (timeClock.current?.id === entryId ? timeClock.current : null);
  if (latestEntry) latestEntry.syncStatus = result.ok ? "Synced" : "Pending sheet sync";
  persistTimeClock();
  renderTimeClock();
}

async function syncToBackend(action, payload) {
  try {
    const response = await fetch("/api/sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify({ action, ...payload })
    });
    if (response.status === 401) {
      window.location.replace("/login.html");
      return { ok: false };
    }
    if (!response.ok) return { ok: false };
    return await response.json();
  } catch {
    return { ok: false };
  }
}

function startBackendRefreshLoop() {
  if (backendRefreshTimer) return;
  backendRefreshTimer = window.setInterval(() => {
    if (document.visibilityState === "visible") loadBackendSnapshot({ silent: true });
  }, BACKEND_REFRESH_INTERVAL_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshBackendIfStale();
  });
  window.addEventListener("focus", refreshBackendIfStale);
}

function refreshBackendIfStale() {
  if (!currentUser || Date.now() - lastBackendRefreshAt < FOCUS_REFRESH_STALE_MS) return;
  loadBackendSnapshot({ silent: true });
}

async function loadBackendSnapshot(options = {}) {
  if (backendRefreshPromise) return backendRefreshPromise;
  backendRefreshPromise = performBackendRefresh(options);
  try {
    return await backendRefreshPromise;
  } finally {
    backendRefreshPromise = null;
  }
}

async function performBackendRefresh({ silent = false } = {}) {
  const previousSnapshot = backendSnapshot;
  try {
    const response = await fetch("/api/bootstrap", { headers: { Accept: "application/json" } });
    if (response.status === 401) {
      window.location.replace("/login.html");
      return;
    }
    if (!response.ok) throw new Error(`API ${response.status}`);
    const nextSnapshot = await response.json();
    const sheetReady = nextSnapshot.sheet?.ok && Array.isArray(nextSnapshot.sheet.sheets);
    if (!sheetReady && previousSnapshot?.sheet?.ok) {
      elements.dataStatus.textContent = `Sheet refresh delayed / last synced ${formatDateTime(lastBackendRefreshAt)}`;
      return;
    }
    backendSnapshot = nextSnapshot;
    lastBackendRefreshAt = Date.now();
    const sheetText = sheetReady
      ? ` / ${backendSnapshot.sheet.sheets.length} sheet tabs`
      : backendSnapshot.sheetConfigured
        ? " / sheet snapshot unavailable"
        : " / sheet not configured";
    elements.dataStatus.textContent = `Sheet synced ${formatDateTime(lastBackendRefreshAt)} / ${backendSnapshot.items.length} items${sheetText}`;
    if (sheetReady) {
      hydrateSheetInventory();
      renderDashboard();
      renderOperations();
      renderSupplyWorkspace();
      if (!silent) retryPendingSyncs();
    }
  } catch {
    if (previousSnapshot) {
      backendSnapshot = previousSnapshot;
      elements.dataStatus.textContent = `Sheet refresh delayed / last synced ${formatDateTime(lastBackendRefreshAt)}`;
    } else {
      backendSnapshot = null;
      elements.dataStatus.textContent = "Local mode: orders and manual entries are stored in this browser";
    }
  }
}

function hydrateSheetInventory() {
  const products = backendSnapshot?.sheet?.inventory?.products;
  if (!Array.isArray(products)) return;

  const mergedTargets = new Map();
  products
    .filter(product => Number(product.target || 0) > 0)
    .forEach(product => {
      const target = {
        itemName: product.itemName,
        itemLabel: product.itemLabel || product.itemName,
        target: Number(product.target || 0),
        updatedAt: backendSnapshot.sheet.generatedAt || backendSnapshot.generatedAt,
        syncStatus: "Synced"
      };
      mergedTargets.set(stockKey(target), target);
    });

  stockTargets
    .filter(target => target.syncStatus !== "Synced" || target.deleting)
    .forEach(target => mergedTargets.set(stockKey(target), target));

  stockTargets = [...mergedTargets.values()]
    .sort((a, b) => (a.itemLabel || a.itemName).localeCompare(b.itemLabel || b.itemName));
  persistStockTargets();
}

async function retryPendingSyncs() {
  const operationIds = operations
    .filter(entry => entry.syncStatus !== "Synced")
    .map(entry => entry.id);
  for (const entryId of operationIds) await syncOperation(entryId);

  const targetKeys = stockTargets
    .filter(target => target.syncStatus !== "Synced")
    .map(stockKey);
  for (const targetKey of targetKeys) await syncStockTarget(targetKey);

  const shiftIds = timeClock.entries
    .filter(entry => entry.syncStatus !== "Synced")
    .map(entry => entry.id);
  if (timeClock.current?.syncStatus !== "Synced") shiftIds.push(timeClock.current?.id);
  for (const entryId of shiftIds.filter(Boolean)) await syncTimeClockEntry(entryId);
}

function getReplenishmentPlan() {
  const storefrontCounts = getLatestCounts("Storefront");
  const storageCounts = getLatestCounts("Storage");
  const materialTotals = new Map();
  const missingRecipes = [];

  const missing = stockTargets
    .map(target => {
      const current = storefrontCounts.get(stockKey(target)) || 0;
      const missingQty = Math.max(0, Number(target.target || 0) - current);
      return {
        ...target,
        label: target.itemLabel || target.itemName,
        current,
        missing: missingQty
      };
    })
    .filter(line => line.missing > 0)
    .sort((a, b) => a.label.localeCompare(b.label));

  missing.forEach(line => {
    const recipe = recipeCatalog[line.itemName];
    if (!recipe) {
      missingRecipes.push(line.label);
      return;
    }

    const batches = recipeBatchCount(line.itemName, line.missing);
    recipe.forEach(([ingredient, qty]) => {
      materialTotals.set(ingredient, (materialTotals.get(ingredient) || 0) + Number(qty || 0) * batches);
    });
  });

  const materials = [...materialTotals.entries()]
    .map(([ingredient, needed]) => {
      const available = storageCounts.get(normalize(ingredient)) || 0;
      return {
        ingredient,
        needed,
        available,
        shortage: Math.max(0, needed - available)
      };
    })
    .sort((a, b) => b.shortage - a.shortage || a.ingredient.localeCompare(b.ingredient));

  return { missing, materials, missingRecipes };
}

function getMaterialPurchasePlan(excludeSupplyOrderId = "") {
  const demand = new Map();
  const addDemand = (ingredient, quantity) => {
    const key = normalize(ingredient);
    const current = demand.get(key) || { ingredient, demand: 0 };
    current.demand += Number(quantity || 0);
    demand.set(key, current);
  };

  getReplenishmentPlan().materials.forEach(line => addDemand(line.ingredient, line.needed));
  orders
    .filter(order => !statusesHiddenFromActive.has(order.status))
    .forEach(order => getProductionPlan(order).materials.forEach(material => addDemand(material.ingredient, material.qty)));

  const storageCounts = getLatestCounts("Storage");
  const committed = getCommittedSupplyQuantities(excludeSupplyOrderId);
  return [...demand.entries()].map(([key, line]) => {
    const available = storageCounts.get(key) || 0;
    const ordered = committed.get(key) || 0;
    const shortage = Math.max(0, line.demand - available);
    return {
      ingredient: line.ingredient,
      demand: line.demand,
      available,
      ordered,
      shortage,
      missing: Math.max(0, shortage - ordered)
    };
  }).sort((a, b) => b.missing - a.missing || a.ingredient.localeCompare(b.ingredient));
}

function getCommittedSupplyQuantities(excludeSupplyOrderId = "") {
  const committed = new Map();
  supplyOrders
    .filter(order => new Set(["Ordered", "Partially Received"]).has(order.status) && order.id !== excludeSupplyOrderId)
    .forEach(order => order.lines.forEach(line => {
      const key = normalize(line.name);
      const remaining = Math.max(0, Number(line.quantity || 0) - Number(line.receivedQuantity || 0));
      committed.set(key, (committed.get(key) || 0) + remaining);
    }));
  return committed;
}

function getSupplyLineMetrics(ingredient, excludeSupplyOrderId = "") {
  const key = normalize(ingredient);
  const planned = getMaterialPurchasePlan(excludeSupplyOrderId).find(line => normalize(line.ingredient) === key);
  if (planned) return planned;
  const available = getLatestCounts("Storage").get(key) || 0;
  const ordered = getCommittedSupplyQuantities(excludeSupplyOrderId).get(key) || 0;
  return { ingredient, demand: 0, available, ordered, shortage: 0, missing: 0 };
}

function getLatestCounts(location) {
  return window.FRONTIER_INVENTORY_COUNTS.selectLatestCounts({
    location,
    inventory: backendSnapshot?.sheet?.inventory || {},
    operations
  });
}

function stockKey(entry) {
  return normalize(entry.itemName || entry.itemLabel || entry.ingredient || entry.name);
}

function getProductionPlan(order) {
  const materialTotals = new Map();
  const buildMap = new Map();
  const missing = [];

  order.lines.forEach(line => {
    if (line.custom) return;
    const recipe = recipeCatalog[line.name];
    if (!recipe) {
      missing.push(line.label || line.name);
      return;
    }

    const quantity = Number(line.quantity || 0);
    buildMap.set(line.name, (buildMap.get(line.name) || 0) + quantity);
  });

  buildMap.forEach((quantity, name) => {
    const batches = recipeBatchCount(name, quantity);
    recipeCatalog[name].forEach(([ingredient, qty]) => {
      materialTotals.set(ingredient, (materialTotals.get(ingredient) || 0) + Number(qty || 0) * batches);
    });
  });

  return {
    buildLines: [...buildMap.entries()]
      .map(([name, quantity]) => {
        const yieldQuantity = recipeYield(name);
        const batches = recipeBatchCount(name, quantity);
        const batchCost = recipeCatalog[name].reduce((sum, [ingredient, qty]) => {
          const unitCost = Number(pricingCatalog.materials[ingredient]?.midpoint || 0);
          return sum + Number(qty || 0) * unitCost;
        }, 0);
        return {
          name,
          quantity,
          batches,
          yield: yieldQuantity,
          producedQuantity: batches * yieldQuantity,
          unitCost: batchCost / yieldQuantity
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name)),
    materials: [...materialTotals.entries()]
      .map(([ingredient, qty]) => {
        const unitCost = Number(pricingCatalog.materials[ingredient]?.midpoint || 0);
        return { ingredient, qty, unitCost, cost: qty * unitCost };
      })
      .sort((a, b) => a.ingredient.localeCompare(b.ingredient)),
    materialCost: [...materialTotals.entries()]
      .reduce((sum, [ingredient, qty]) => {
        const unitCost = Number(pricingCatalog.materials[ingredient]?.midpoint || 0);
        return sum + (qty * unitCost);
      }, 0),
    missing
  };
}

function recipeYield(name) {
  return Math.max(1, Number(recipeYieldCatalog[name] || 1));
}

function recipeBatchCount(name, quantity) {
  return Math.ceil(Math.max(0, Number(quantity || 0)) / recipeYield(name));
}

function getSubtotal(order) {
  return order.lines.reduce((sum, line) => sum + (Number(line.quantity || 0) * Number(line.unitPrice || 0)), 0);
}

function sortOrder(a, b) {
  const dateA = a.deliveryDate || "9999-12-31";
  const dateB = b.deliveryDate || "9999-12-31";
  if (dateA !== dateB) return dateA.localeCompare(dateB);
  if (a.priority !== b.priority) return a.priority === "Expedite" ? -1 : 1;
  return new Date(b.updatedAt) - new Date(a.updatedAt);
}

function uniqueOrders(items) {
  const seen = new Set();
  return items.filter(order => {
    if (seen.has(order.id)) return false;
    seen.add(order.id);
    return true;
  });
}

function todayKey() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isDueToday(order) {
  return order.deliveryDate === todayKey();
}

function isOverdue(order) {
  return Boolean(order.deliveryDate && order.deliveryDate < todayKey());
}

function formatDelivery(value) {
  if (!value) return "In-store order";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).format(new Date(`${value}T00:00:00`));
}

function formatDateTime(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(value));
}

function formatDuration(minutes) {
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (!hours) return `${remainder}m`;
  return `${hours}h ${String(remainder).padStart(2, "0")}m`;
}

function formatDate(value) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(value));
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function statusClass(value) {
  return normalize(value).replace(/\s+/g, "-");
}

function getRecipeIngredients() {
  const names = new Set();
  Object.values(recipeCatalog).forEach(recipe => {
    recipe.forEach(([ingredient]) => names.add(ingredient));
  });
  return [...names]
    .sort((a, b) => a.localeCompare(b))
    .map(name => ({
      name,
      label: name,
      tag: "",
      category: "Recipe Ingredient",
      price: 0
    }));
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
