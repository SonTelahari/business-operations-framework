const STORAGE_KEY = "frontier_still_water_work_orders_v1";
const TIME_CLOCK_KEY = "frontier_still_water_time_clock_v1";
const OPERATIONS_KEY = "frontier_still_water_manual_operations_v1";
const TARGETS_KEY = "frontier_still_water_storefront_targets_v1";
const BACKEND_REFRESH_INTERVAL_MS = Number(window.FRONTIER_REFRESH_INTERVAL_MS || 60000);
const FOCUS_REFRESH_STALE_MS = Number(window.FRONTIER_FOCUS_REFRESH_STALE_MS || 15000);
const statusesHiddenFromActive = new Set(["Completed", "Cancelled"]);
const itemCatalog = window.FRONTIER_ITEMS || [];
const recipeCatalog = window.FRONTIER_RECIPES || {};
const pricingCatalog = window.FRONTIER_PRICING || { materials: {} };
const ingredientCatalog = getRecipeIngredients();
const stockCatalog = [...itemCatalog, ...ingredientCatalog];

let orders = loadOrders();
let timeClock = { current: null, entries: [] };
let operations = loadOperations();
let stockTargets = loadStockTargets();
let currentUser = null;
let currentRole = "employee";
let employeeUsers = [];
let auditEvents = [];
let backendSnapshot = null;
let backendRefreshTimer = null;
let backendRefreshPromise = null;
let lastBackendRefreshAt = 0;
let activeOrder = newOrder();
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
  auditSearch: document.querySelector("#auditSearchInput"),
  auditMeta: document.querySelector("#auditMetaText"),
  auditList: document.querySelector("#auditList"),
  refreshAudit: document.querySelector("#refreshAuditButton"),
  dataStatus: document.querySelector("#dataStatusText"),
  stockAlertList: document.querySelector("#stockAlertList"),
  missingStockCount: document.querySelector("#missingStockCount"),
  materialShortageCount: document.querySelector("#materialShortageCount"),
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
  elements.stockOptions.innerHTML = stockCatalog
    .map(item => `<option value="${escapeHtml(item.label || item.name)}">${escapeHtml(item.name)}${item.category ? ` - ${escapeHtml(item.category)}` : ""}</option>`)
    .join("");
}

function wireEvents() {
  document.querySelector("#newOrderButton").addEventListener("click", () => {
    activeOrder = newOrder();
    activeSection = "workbench";
    render();
  });

  document.querySelector("#saveOrderButton").addEventListener("click", saveActiveOrder);
  document.querySelector("#addItemButton").addEventListener("click", addItemLine);
  document.querySelector("#copySummaryButton").addEventListener("click", copySummary);
  document.querySelector("#copyProductionButton").addEventListener("click", copyProduction);
  elements.logout.addEventListener("click", logout);
  elements.pendingUserList.addEventListener("click", handleEmployeeAction);
  elements.employeeUserList.addEventListener("click", handleEmployeeAction);
  elements.auditEmployeeFilter.addEventListener("change", renderAudit);
  elements.auditCategoryFilter.addEventListener("change", renderAudit);
  elements.auditSearch.addEventListener("input", renderAudit);
  elements.refreshAudit.addEventListener("click", loadAuditEvents);
  elements.clockToggle.addEventListener("click", toggleTimeClock);
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

  elements.filter.addEventListener("change", renderOrdersList);
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
  elements.workbenchSection.classList.toggle("hidden", activeSection !== "workbench");
  elements.operationsSection.classList.toggle("hidden", activeSection !== "operations");
  elements.employeesSection.classList.toggle("hidden", activeSection !== "employees");
}

function renderDashboard() {
  const activeOrders = orders.filter(order => !statusesHiddenFromActive.has(order.status));
  const dueToday = activeOrders.filter(isDueToday);
  const overdue = activeOrders.filter(isOverdue);
  const inStore = activeOrders.filter(order => !order.deliveryDate);
  const expedited = activeOrders.filter(order => order.status === "Expedited" || order.priority === "Expedite");
  const paused = activeOrders.filter(order => order.status === "Paused");
  const attention = uniqueOrders([...expedited, ...paused]);

  elements.dueTodayCount.textContent = dueToday.length;
  elements.overdueCount.textContent = overdue.length;
  elements.expeditedCount.textContent = expedited.length;
  elements.pausedCount.textContent = paused.length;
  elements.inStoreCount.textContent = inStore.length;
  elements.dueTodayList.innerHTML = renderDashboardCards(dueToday, "No deliveries due today");
  elements.overdueList.innerHTML = renderDashboardCards(overdue, "No overdue orders");
  elements.attentionList.innerHTML = renderDashboardCards(attention, "No paused or expedited orders");
  elements.inStoreList.innerHTML = renderDashboardCards(inStore, "No active in-store orders");
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
  if (!isManagement() && activeSection === "operations") {
    activeSection = "dashboard";
    renderSection();
  }
}

function isManagement() {
  return currentRole === "admin" || currentRole === "manager";
}

function renderReplenishment() {
  const plan = getReplenishmentPlan();
  elements.missingStockCount.textContent = plan.missing.length;
  elements.materialShortageCount.textContent = plan.materials.filter(line => line.shortage > 0).length;
  elements.replenishmentMeta.textContent = stockTargets.length
    ? `${plan.missing.length} storefront lines missing / ${plan.materials.length} material lines${plan.missingRecipes.length ? ` / ${plan.missingRecipes.length} missing recipes` : ""}`
    : "Set admin stock targets to generate a standing order";

  elements.replenishmentList.innerHTML = plan.missing.length
    ? plan.missing.map(line => `
      <div class="replenishment-row">
        <strong>${escapeHtml(line.label)}</strong>
        <span>Have ${formatNumber(line.current)} / Target ${formatNumber(line.target)} / Make ${formatNumber(line.missing)}</span>
      </div>
    `).join("")
    : `<div class="empty-card">${stockTargets.length ? "Storefront targets are currently filled" : "No storefront targets set yet"}</div>`;

  const materialRows = plan.materials.map(line => `
      <div class="replenishment-row ${line.shortage > 0 ? "short" : ""}">
        <strong>${escapeHtml(line.ingredient)}</strong>
        <span>Need ${formatNumber(line.needed)} / Storage ${formatNumber(line.available)}${line.shortage > 0 ? ` / Short ${formatNumber(line.shortage)}` : ""}</span>
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
    : `<div class="empty-card">No materials needed from current targets</div>`;

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

function renderProduction() {
  const production = getProductionPlan(activeOrder);
  elements.productionMeta.textContent = `${production.buildLines.length} craftable lines / ${production.materials.length} materials / est. $${formatNumber(production.materialCost)}`;

  if (!production.buildLines.length) {
    elements.productionBuildList.innerHTML = `<div class="empty-card">No craftable quote lines yet</div>`;
  } else {
    elements.productionBuildList.innerHTML = production.buildLines.map(line => `
      <div class="production-row">
        <strong>${escapeHtml(line.name)}</strong>
        <span>${formatNumber(line.quantity)} to make</span>
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
    ? production.buildLines.map(line => `${formatNumber(line.quantity)}x ${line.name}`).join("\n")
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
    if (isManagement()) await loadStaffData();
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
  const selected = elements.auditEmployeeFilter.value;
  const names = [...new Set([
    ...employeeUsers.map(user => user.fullName),
    ...auditEvents.flatMap(event => [event.subjectName, event.actorName])
  ].filter(Boolean))].sort((a, b) => a.localeCompare(b));
  elements.auditEmployeeFilter.innerHTML = `<option value="">All employees</option>${names
    .map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`)
    .join("")}`;
  if (names.includes(selected)) elements.auditEmployeeFilter.value = selected;
}

function renderAudit() {
  if (!elements.auditList || !isManagement()) return;
  const employee = normalize(elements.auditEmployeeFilter.value);
  const category = elements.auditCategoryFilter.value;
  const search = normalize(elements.auditSearch.value);
  const filtered = auditEvents.filter(event => {
    if (employee && normalize(event.subjectName) !== employee && normalize(event.actorName) !== employee) return false;
    if (category && event.category !== category) return false;
    if (search && !normalize(`${event.action} ${event.actorName} ${event.subjectName} ${JSON.stringify(event.details || {})}`).includes(search)) return false;
    return true;
  });
  elements.auditMeta.textContent = `${filtered.length} of ${auditEvents.length} recorded events`;
  elements.auditList.innerHTML = filtered.length
    ? filtered.map(auditEventRow).join("")
    : `<div class="empty-card">No audit events match these filters</div>`;
}

function auditEventRow(event) {
  const label = ({
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
    "target.removed": "Storefront target removed"
  })[event.action] || event.action;
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

    recipe.forEach(([ingredient, qty]) => {
      materialTotals.set(ingredient, (materialTotals.get(ingredient) || 0) + Number(qty || 0) * line.missing);
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

    recipe.forEach(([ingredient, qty]) => {
      materialTotals.set(ingredient, (materialTotals.get(ingredient) || 0) + Number(qty || 0) * quantity);
    });
  });

  return {
    buildLines: [...buildMap.entries()]
      .map(([name, quantity]) => ({ name, quantity }))
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
