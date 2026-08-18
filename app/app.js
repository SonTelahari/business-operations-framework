const STORAGE_KEY = "business_operations_work_orders_v1";
const TIME_CLOCK_KEY = "business_operations_time_clock_v1";
const OPERATIONS_KEY = "business_operations_manual_operations_v1";
const TARGETS_KEY = "business_operations_sales_targets_v1";
const STORAGE_TARGETS_KEY = "business_operations_storage_targets_v1";
const SUPPLY_ACTIVE_STATUSES = new Set(["Active", "Ordered", "Partially Received"]);
const SUPPLY_DELIVERY_STATUSES = new Set(["Ordered", "Partially Received"]);
const BUY_ORDER_OPEN_STATUSES = new Set(["Active", "Paused"]);
const PRODUCTION_ACTIVE_STATUSES = new Set(["Planned", "In Progress"]);
const ORDER_PRODUCTION_SOURCE_TYPES = new Set(["Customer Order", "Internal Craft"]);
const BACKEND_REFRESH_INTERVAL_MS = Number(window.BUSINESS_REFRESH_INTERVAL_MS || window.FRONTIER_REFRESH_INTERVAL_MS || 60000);
const FOCUS_REFRESH_STALE_MS = Number(window.BUSINESS_FOCUS_REFRESH_STALE_MS || window.FRONTIER_FOCUS_REFRESH_STALE_MS || 15000);
const statusesHiddenFromActive = new Set(["Completed", "Cancelled"]);
const ROLE_RANK = Object.freeze({ employee: 1, manager: 2, admin: 3 });
const SECTION_MIN_ROLE = Object.freeze({
  dashboard: "employee",
  workbench: "employee",
  production: "employee",
  store: "employee",
  catalog: "manager",
  restock: "manager",
  supplies: "manager",
  "buy-orders": "manager",
  operations: "manager",
  "daily-close": "manager",
  review: "manager",
  employees: "manager",
  finance: "admin",
  "business-settings": "admin"
});
const NAVIGATION_TAB_DEFINITIONS = Object.freeze([
  { section: "workbench", label: "Sales", role: "Employee" },
  { section: "production", label: "Production", role: "Employee" },
  { section: "store", label: "Store", role: "Employee" },
  { section: "catalog", label: "Catalog", role: "Manager" },
  { section: "restock", label: "Restock", role: "Manager" },
  { section: "supplies", label: "Supplies", role: "Manager" },
  { section: "buy-orders", label: "Buy Orders", role: "Manager" },
  { section: "operations", label: "Operations", role: "Manager" },
  { section: "daily-close", label: "Daily Close", role: "Manager" },
  { section: "review", label: "Review", role: "Manager" },
  { section: "employees", label: "Staff", role: "Manager" },
  { section: "finance", label: "Finance", role: "Admin" }
]);
const DEFAULT_NAVIGATION_SECTIONS = Object.freeze(Object.fromEntries(
  NAVIGATION_TAB_DEFINITIONS.map(tab => [tab.section, true])
));
let deliveryDateFormatter = new Intl.DateTimeFormat("en-US", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric"
});
let dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false
});
let businessDateKeyFormatter = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  timeZone: "UTC"
});
let numberFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
let currencyFormatter = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const AUDIT_ACTION_LABELS = Object.freeze({
  "account.admin_created": "Admin account created",
  "account.requested": "Access requested",
  "account.approved": "Employee approved",
  "account.reactivated": "Account reactivated",
  "account.disabled": "Account disabled",
  "account.rejected": "Access request rejected",
  "account.role_changed": "Staff role changed",
  "account.discord_linked": "Discord account linked",
  "account.job_linked": "Business job linked",
  "membership.requested": "Discord access requested",
  "membership.approve": "Discord membership approved",
  "membership.disable": "Discord membership disabled",
  "membership.reject": "Discord membership rejected",
  "membership.promote": "Discord membership promoted",
  "membership.demote": "Discord membership demoted",
  "auth.login": "Signed in",
  "auth.discord_login": "Signed in with Discord",
  "auth.workspace_switched": "Switched business",
  "auth.logout": "Signed out",
  "clock.in": "Clocked in",
  "clock.out": "Clocked out",
  "operation.recorded": "Operation recorded",
  "finance.funds_recorded": "Owner funds recorded",
  "target.updated": "Storefront target updated",
  "target.removed": "Storefront target removed",
  "storage_target.updated": "Storage target updated",
  "storage_target.removed": "Storage target removed",
  "catalog.item_created": "Catalog good added",
  "catalog.item_updated": "Catalog good updated",
  "catalog.recipe_saved": "Recipe saved",
  "catalog.recipe_removed": "Recipe removed",
  "business.profile_updated": "Business profile updated",
  "supplier.saved": "Supplier record saved",
  "supplier.removed": "Supplier record removed",
  "storefront_buy_order.saved": "Storefront buy order saved",
  "storefront_buy_order.fill_adjusted": "Buy order fill adjusted",
  "storefront_buy_order.removed": "Storefront buy order removed",
  "production_batch.created": "Production batch created",
  "production_batch.started": "Production batch started",
  "production_batch.progressed": "Production progress recorded",
  "production_batch.completed": "Production batch completed",
  "production_batch.cancelled": "Production batch cancelled",
  "sales_order.saved": "Sales order saved",
  "sales_order.production_queued": "Sales order queued for production",
  "sales_order.production_ready": "Sales order ready for delivery",
  "sales_order.internal_craft_completed": "Internal craft completed",
  "sales_order.production_cancelled": "Sales order production cancelled",
  "sales_order.removed": "Sales order removed",
  "sales_order.imported": "Browser sales orders imported",
  "daily_close.saved": "Daily close draft saved",
  "daily_close.finalized": "Daily close finalized",
  "daily_close.reopened": "Daily close reopened",
  "webhook_exception.resolved": "Webhook exception resolved",
  "webhook_exception.ignored": "Webhook exception ignored"
});
const itemCatalog = [];
const recipeCatalog = {};
const recipeYieldCatalog = {};
const pricingCatalog = { source: {}, products: {}, materials: {} };
const { buildSupplyQuoteTelegram } = window.FRONTIER_SUPPLY_TELEGRAM;
const ingredientCatalog = getRecipeIngredients();
const stockCatalog = [...itemCatalog, ...ingredientCatalog];
const productCatalogByKey = new Map();
let businessProfile = { name: "Business", ledgerName: "Business Ledger", location: "", referenceId: "", description: "", logoUrl: "", currency: "USD", locale: "en-US", timezone: "UTC" };
let businessTerminology = { salesLocation: "Storefront", storageLocation: "Storage", salesOrder: "Sales Order" };
let navigationSections = { ...DEFAULT_NAVIGATION_SECTIONS };
rebuildCatalogIndexes();

let legacyOrdersPendingMigration = loadOrders();
let orders = [];
let timeClock = { current: null, entries: [] };
let operations = loadOperations();
let stockTargets = loadStockTargets();
let storageTargets = loadStorageTargets();
let supplyOrders = [];
let storefrontBuyOrders = [];
let suppliers = [];
let reviewExceptions = [];
let webhookLog = [];
let productionBatches = [];
let dailyCloses = [];
let currentUser = null;
let currentWorkspace = null;
let workspaceProfile = { accountType: "local", currentBusinessId: "", jobs: [] };
let currentRole = "employee";
let employeeUsers = [];
let auditEvents = [];
let backendSnapshot = null;
let backendRefreshTimer = null;
let backendRefreshPromise = null;
let lastBackendRefreshAt = 0;
let supplyReceiptPending = false;
let productionActionPending = false;
let salesOrderSavePending = false;
let dailyCloseActionPending = false;
let activeOrderDirty = false;
let storefrontBuyOrderDirty = false;
let dailyCloseDirty = false;
let activeOrder = newOrder();
let activeSupplyOrder = newSupplyOrder();
let activeStorefrontBuyOrder = newStorefrontBuyOrder();
let activeDailyClose = newDailyClose();
let activeSupplier = newSupplier();
let activeReviewExceptionId = "";
let renderedReviewExceptionId = "";
let reviewEditorDirty = false;
let activeProductionBatchId = "";
let activeView = "quote";
let activeSection = "dashboard";
let financeSnapshot = null;
let financeLoading = false;
let activeProductCardKey = "";
let productInsightRequestId = 0;
let catalogItemSavePending = false;
let activeCatalogItemId = "";
let activeRecipeProductName = "";
let recipeSavePending = false;
let pendingProductionQueue = null;
let businessSettingsSavePending = false;
let businessSettingsDirty = false;
let discordSettingsSavePending = false;
let discordIntegration = null;
const productInsightCache = new Map();

const elements = {
  currentUserName: document.querySelector("#currentUserName"),
  currentUserRole: document.querySelector("#currentUserRole"),
  currentWorkspaceCode: document.querySelector("#currentWorkspaceCode"),
  workspaceSwitcher: document.querySelector("#workspaceSwitcherButton"),
  workspaceCount: document.querySelector("#workspaceCount"),
  workspaceDialog: document.querySelector("#workspaceDialog"),
  workspaceDialogForm: document.querySelector("#workspaceDialogForm"),
  workspaceJobList: document.querySelector("#workspaceJobList"),
  workspaceDialogStatus: document.querySelector("#workspaceDialogStatus"),
  closeWorkspaceDialog: document.querySelector("#closeWorkspaceDialogButton"),
  doneWorkspaceDialog: document.querySelector("#doneWorkspaceDialogButton"),
  localWorkspaceLinkSection: document.querySelector("#localWorkspaceLinkSection"),
  discordWorkspaceLinkSection: document.querySelector("#discordWorkspaceLinkSection"),
  linkJobWorkspace: document.querySelector("#linkJobWorkspaceInput"),
  linkJobName: document.querySelector("#linkJobNameInput"),
  linkJobPassword: document.querySelector("#linkJobPasswordInput"),
  linkJob: document.querySelector("#linkJobButton"),
  profileButton: document.querySelector("#profileButton"),
  logout: document.querySelector("#logoutButton"),
  orderType: document.querySelector("#orderTypeSelect"),
  activeOrderTitle: document.querySelector("#activeSalesOrderTitle"),
  customerField: document.querySelector("#customerField"),
  customer: document.querySelector("#customerInput"),
  handler: document.querySelector("#handlerInput"),
  depositField: document.querySelector("#depositField"),
  deposit: document.querySelector("#depositInput"),
  priority: document.querySelector("#prioritySelect"),
  deliveryDateFieldLabel: document.querySelector("#deliveryDateFieldLabel"),
  deliveryDate: document.querySelector("#deliveryDateInput"),
  status: document.querySelector("#statusSelect"),
  itemSearch: document.querySelector("#itemSearchInput"),
  itemOptions: document.querySelector("#itemOptions"),
  stockOptions: document.querySelector("#stockOptions"),
  countStockOptions: document.querySelector("#countStockOptions"),
  supplyMaterialOptions: document.querySelector("#supplyMaterialOptions"),
  quantity: document.querySelector("#quantityInput"),
  linePriceField: document.querySelector("#linePriceField"),
  price: document.querySelector("#priceInput"),
  quickCustomWork: document.querySelector("#quickCustomWork"),
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
  quoteTab: document.querySelector("#quoteTabButton"),
  copySummary: document.querySelector("#copySummaryButton"),
  completeOrder: document.querySelector("#completeButton"),
  quoteView: document.querySelector("#quoteView"),
  productionView: document.querySelector("#productionView"),
  productionMeta: document.querySelector("#productionMeta"),
  productionBuildList: document.querySelector("#productionBuildList"),
  productionMaterialsList: document.querySelector("#productionMaterialsList"),
  missingRecipes: document.querySelector("#missingRecipes"),
  queueOrderProduction: document.querySelector("#queueOrderProductionButton"),
  queueRestock: document.querySelector("#queueRestockButton"),
  productionSection: document.querySelector("#productionSection"),
  productionNavCount: document.querySelector("#productionNavCount"),
  productionDataStatus: document.querySelector("#productionDataStatus"),
  productionActiveCount: document.querySelector("#productionActiveCount"),
  productionDueCount: document.querySelector("#productionDueCount"),
  productionReadyCount: document.querySelector("#productionReadyCount"),
  productionShortCount: document.querySelector("#productionShortCount"),
  productionFilter: document.querySelector("#productionFilterInput"),
  productionBatchList: document.querySelector("#productionBatchList"),
  refreshProduction: document.querySelector("#refreshProductionButton"),
  productionDetailSource: document.querySelector("#productionDetailSource"),
  productionDetailTitle: document.querySelector("#productionDetailTitle"),
  productionDetailMeta: document.querySelector("#productionDetailMeta"),
  productionDetailStatus: document.querySelector("#productionDetailStatus"),
  productionDetailDue: document.querySelector("#productionDetailDue"),
  productionDetailAssigned: document.querySelector("#productionDetailAssigned"),
  productionDetailCreatedBy: document.querySelector("#productionDetailCreatedBy"),
  productionDetailUpdated: document.querySelector("#productionDetailUpdated"),
  productionProgressLines: document.querySelector("#productionProgressLines"),
  productionMaterialStatus: document.querySelector("#productionMaterialStatus"),
  productionActionStatus: document.querySelector("#productionActionStatus"),
  startProduction: document.querySelector("#startProductionButton"),
  recordProduction: document.querySelector("#recordProductionButton"),
  cancelProduction: document.querySelector("#cancelProductionButton"),
  supplySection: document.querySelector("#supplySection"),
  buyOrdersSection: document.querySelector("#buyOrdersSection"),
  buyOrderMeta: document.querySelector("#buyOrderMeta"),
  buyOrderStatus: document.querySelector("#buyOrderStatusInput"),
  buyOrderItem: document.querySelector("#buyOrderItemInput"),
  buyOrderItemOptions: document.querySelector("#buyOrderItemOptions"),
  buyOrderPostedAt: document.querySelector("#buyOrderPostedAtInput"),
  buyOrderQuantity: document.querySelector("#buyOrderQuantityInput"),
  buyOrderUnitPrice: document.querySelector("#buyOrderUnitPriceInput"),
  buyOrderNotes: document.querySelector("#buyOrderNotesInput"),
  buyOrderFilled: document.querySelector("#buyOrderFilledInput"),
  buyOrderActiveCount: document.querySelector("#buyOrderActiveCount"),
  buyOrderOutstandingCount: document.querySelector("#buyOrderOutstandingCount"),
  buyOrderCommittedValue: document.querySelector("#buyOrderCommittedValue"),
  buyOrderDataStatus: document.querySelector("#buyOrderDataStatus"),
  buyOrderSavedCount: document.querySelector("#buyOrderSavedCount"),
  buyOrderFilter: document.querySelector("#buyOrderFilterInput"),
  buyOrderList: document.querySelector("#buyOrderList"),
  newBuyOrder: document.querySelector("#newBuyOrderButton"),
  saveBuyOrder: document.querySelector("#saveBuyOrderButton"),
  deleteBuyOrder: document.querySelector("#deleteBuyOrderButton"),
  adjustBuyOrderFill: document.querySelector("#adjustBuyOrderFillButton"),
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
  storeSection: document.querySelector("#storeSection"),
  catalogSection: document.querySelector("#catalogSection"),
  restockSection: document.querySelector("#restockSection"),
  workbenchSection: document.querySelector("#workbenchSection"),
  operationsSection: document.querySelector("#operationsSection"),
  dailyCloseSection: document.querySelector("#dailyCloseSection"),
  reviewSection: document.querySelector("#reviewSection"),
  employeesSection: document.querySelector("#employeesSection"),
  businessSettingsSection: document.querySelector("#businessSettingsSection"),
  exceptionNavCount: document.querySelector("#exceptionNavCount"),
  dashboardReviewCount: document.querySelector("#dashboardReviewCount"),
  reviewDataStatus: document.querySelector("#reviewDataStatus"),
  reviewActionStatus: document.querySelector("#reviewActionStatus"),
  reviewOpenCount: document.querySelector("#reviewOpenCount"),
  reviewResolvedCount: document.querySelector("#reviewResolvedCount"),
  reviewIgnoredCount: document.querySelector("#reviewIgnoredCount"),
  reviewStatusFilter: document.querySelector("#reviewStatusFilter"),
  reviewSearch: document.querySelector("#reviewSearchInput"),
  reviewEventList: document.querySelector("#reviewEventList"),
  refreshReview: document.querySelector("#refreshReviewButton"),
  webhookLogStatus: document.querySelector("#webhookLogStatus"),
  webhookLogStatusFilter: document.querySelector("#webhookLogStatusFilter"),
  webhookLogSearch: document.querySelector("#webhookLogSearchInput"),
  webhookLogBody: document.querySelector("#webhookLogBody"),
  reviewEditorTitle: document.querySelector("#reviewEditorTitle"),
  reviewEditorStatus: document.querySelector("#reviewEditorStatus"),
  reviewReceivedAt: document.querySelector("#reviewReceivedAt"),
  reviewReason: document.querySelector("#reviewReason"),
  reviewActorName: document.querySelector("#reviewActorName"),
  reviewLedgerName: document.querySelector("#reviewLedgerName"),
  reviewDiscordName: document.querySelector("#reviewDiscordName"),
  reviewDiscordLabel: document.querySelector("#reviewDiscordLabel"),
  reviewAppInventoryTotal: document.querySelector("#reviewAppInventoryTotal"),
  reviewReportedItemTotal: document.querySelector("#reviewReportedItemTotal"),
  reviewStockVariance: document.querySelector("#reviewStockVariance"),
  reviewCashFields: document.querySelector("#reviewCashFields"),
  reviewCashTotal: document.querySelector("#reviewCashTotal"),
  reviewCashAllocated: document.querySelector("#reviewCashAllocated"),
  reviewCashRemaining: document.querySelector("#reviewCashRemaining"),
  reviewCashAmount: document.querySelector("#reviewCashAmountInput"),
  reviewCashDirection: document.querySelector("#reviewCashDirectionInput"),
  reviewCashCategory: document.querySelector("#reviewCashCategoryInput"),
  reviewCashReference: document.querySelector("#reviewCashReferenceInput"),
  reviewCashAllocationList: document.querySelector("#reviewCashAllocationList"),
  reviewItem: document.querySelector("#reviewItemInput"),
  reviewEventType: document.querySelector("#reviewEventTypeInput"),
  reviewDirection: document.querySelector("#reviewDirectionInput"),
  reviewQuantityLabelText: document.querySelector("#reviewQuantityLabelText"),
  reviewQuantity: document.querySelector("#reviewQuantityInput"),
  reviewUnitPriceLabelText: document.querySelector("#reviewUnitPriceLabelText"),
  reviewUnitPrice: document.querySelector("#reviewUnitPriceInput"),
  reviewNote: document.querySelector("#reviewNoteInput"),
  reviewRememberMapping: document.querySelector("#reviewRememberMappingInput"),
  reviewPackageConversion: document.querySelector("#reviewPackageConversionInput"),
  reviewPackageFields: document.querySelector("#reviewPackageFields"),
  reviewUnitsPerPackage: document.querySelector("#reviewUnitsPerPackageInput"),
  reviewPackagePreview: document.querySelector("#reviewPackagePreview"),
  reviewCreateProduct: document.querySelector("#reviewCreateProductInput"),
  reviewNewProductFields: document.querySelector("#reviewNewProductFields"),
  reviewItemType: document.querySelector("#reviewItemTypeInput"),
  reviewProductLabel: document.querySelector("#reviewProductLabelInput"),
  reviewProductTag: document.querySelector("#reviewProductTagInput"),
  reviewProductCategory: document.querySelector("#reviewProductCategoryInput"),
  reviewItemUnit: document.querySelector("#reviewItemUnitInput"),
  reviewItemUnitCost: document.querySelector("#reviewItemUnitCostInput"),
  reviewProductPrice: document.querySelector("#reviewProductPriceInput"),
  reviewProductTarget: document.querySelector("#reviewProductTargetInput"),
  resolveReview: document.querySelector("#resolveReviewButton"),
  ignoreReview: document.querySelector("#ignoreReviewButton"),
  reviewRawText: document.querySelector("#reviewRawText"),
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
  catalogCategoryOptions: document.querySelector("#catalogCategoryOptions"),
  storeOverviewSearch: document.querySelector("#storeOverviewSearchInput"),
  storeOverviewMeta: document.querySelector("#storeOverviewMeta"),
  storefrontOverviewUnits: document.querySelector("#storefrontOverviewUnits"),
  storageOverviewUnits: document.querySelector("#storageOverviewUnits"),
  storefrontOverviewValue: document.querySelector("#storefrontOverviewValue"),
  storefrontOverviewValueDetail: document.querySelector("#storefrontOverviewValueDetail"),
  storageOverviewValue: document.querySelector("#storageOverviewValue"),
  storageOverviewValueDetail: document.querySelector("#storageOverviewValueDetail"),
  ledgerOverviewBalance: document.querySelector("#ledgerOverviewBalance"),
  ledgerOverviewDetail: document.querySelector("#ledgerOverviewDetail"),
  storefrontOverviewCount: document.querySelector("#storefrontOverviewCount"),
  storageOverviewCount: document.querySelector("#storageOverviewCount"),
  storefrontOverviewBody: document.querySelector("#storefrontOverviewBody"),
  storageOverviewBody: document.querySelector("#storageOverviewBody"),
  productCardPanel: document.querySelector("#productCardPanel"),
  productCardCategory: document.querySelector("#productCardCategory"),
  productCardTitle: document.querySelector("#productCardTitle"),
  productCardMeta: document.querySelector("#productCardMeta"),
  productCardBody: document.querySelector("#productCardBody"),
  closeProductCard: document.querySelector("#closeProductCardButton"),
  openCatalogItemDialog: document.querySelector("#openCatalogItemDialogButton"),
  catalogItemDialog: document.querySelector("#catalogItemDialog"),
  catalogItemForm: document.querySelector("#catalogItemForm"),
  closeCatalogItemDialog: document.querySelector("#closeCatalogItemDialogButton"),
  cancelCatalogItem: document.querySelector("#cancelCatalogItemButton"),
  catalogItemType: document.querySelector("#catalogItemTypeInput"),
  catalogItemDialogTitle: document.querySelector("#catalogItemDialogTitle"),
  catalogItemDialogDescription: document.querySelector("#catalogItemDialogDescription"),
  catalogItemName: document.querySelector("#catalogItemNameInput"),
  catalogItemLabel: document.querySelector("#catalogItemLabelInput"),
  catalogItemTag: document.querySelector("#catalogItemTagInput"),
  catalogItemCategory: document.querySelector("#catalogItemCategoryInput"),
  catalogItemUnit: document.querySelector("#catalogItemUnitInput"),
  catalogItemUnitCost: document.querySelector("#catalogItemUnitCostInput"),
  catalogItemSalePrice: document.querySelector("#catalogItemSalePriceInput"),
  catalogItemTarget: document.querySelector("#catalogItemTargetInput"),
  catalogItemStorageTarget: document.querySelector("#catalogItemStorageTargetInput"),
  catalogItemActive: document.querySelector("#catalogItemActiveInput"),
  catalogItemStatus: document.querySelector("#catalogItemStatus"),
  saveCatalogItem: document.querySelector("#saveCatalogItemButton"),
  catalogDataStatus: document.querySelector("#catalogDataStatus"),
  catalogSearch: document.querySelector("#catalogSearchInput"),
  catalogGoodsBody: document.querySelector("#catalogGoodsBody"),
  newCatalogGood: document.querySelector("#newCatalogGoodButton"),
  recipeList: document.querySelector("#recipeList"),
  recipeEditorForm: document.querySelector("#recipeEditorForm"),
  recipeEditorTitle: document.querySelector("#recipeEditorTitle"),
  recipeEditorMeta: document.querySelector("#recipeEditorMeta"),
  recipeProduct: document.querySelector("#recipeProductInput"),
  recipeYield: document.querySelector("#recipeYieldInput"),
  recipeIngredientList: document.querySelector("#recipeIngredientList"),
  recipeEditorStatus: document.querySelector("#recipeEditorStatus"),
  newRecipe: document.querySelector("#newRecipeButton"),
  addRecipeIngredient: document.querySelector("#addRecipeIngredientButton"),
  deleteRecipe: document.querySelector("#deleteRecipeButton"),
  saveRecipe: document.querySelector("#saveRecipeButton"),
  productionSourceDialog: document.querySelector("#productionSourceDialog"),
  productionSourceForm: document.querySelector("#productionSourceForm"),
  productionSourceList: document.querySelector("#productionSourceList"),
  productionSourceStatus: document.querySelector("#productionSourceStatus"),
  closeProductionSource: document.querySelector("#closeProductionSourceButton"),
  cancelProductionSource: document.querySelector("#cancelProductionSourceButton"),
  confirmProductionSource: document.querySelector("#confirmProductionSourceButton"),
  businessSettingsForm: document.querySelector("#businessSettingsForm"),
  businessSettingsMeta: document.querySelector("#businessSettingsMeta"),
  businessSettingsStatus: document.querySelector("#businessSettingsStatus"),
  saveBusinessSettings: document.querySelector("#saveBusinessSettingsButton"),
  resetBusinessSettings: document.querySelector("#resetBusinessSettingsButton"),
  settingsBusinessName: document.querySelector("#settingsBusinessNameInput"),
  settingsLedgerName: document.querySelector("#settingsLedgerNameInput"),
  settingsLocation: document.querySelector("#settingsLocationInput"),
  settingsReferenceId: document.querySelector("#settingsReferenceIdInput"),
  settingsLogoUrl: document.querySelector("#settingsLogoUrlInput"),
  settingsDescription: document.querySelector("#settingsDescriptionInput"),
  settingsCurrency: document.querySelector("#settingsCurrencyInput"),
  settingsLocale: document.querySelector("#settingsLocaleInput"),
  settingsTimezone: document.querySelector("#settingsTimezoneInput"),
  settingsSalesLocation: document.querySelector("#settingsSalesLocationInput"),
  settingsStorageLocation: document.querySelector("#settingsStorageLocationInput"),
  settingsSalesOrder: document.querySelector("#settingsSalesOrderInput"),
  settingsNavigationTabs: document.querySelector("#settingsNavigationTabs"),
  settingsLogoPreview: document.querySelector("#settingsLogoPreview"),
  settingsMonogramPreview: document.querySelector("#settingsMonogramPreview"),
  settingsNamePreview: document.querySelector("#settingsNamePreview"),
  settingsLedgerPreview: document.querySelector("#settingsLedgerPreview"),
  settingsLocationPreview: document.querySelector("#settingsLocationPreview"),
  settingsDescriptionPreview: document.querySelector("#settingsDescriptionPreview"),
  discordSettingsPanel: document.querySelector("#discordSettingsPanel"),
  discordSettingsForm: document.querySelector("#discordSettingsForm"),
  discordSettingsStatus: document.querySelector("#discordSettingsStatus"),
  reloadDiscordSettings: document.querySelector("#reloadDiscordSettingsButton"),
  saveDiscordSettings: document.querySelector("#saveDiscordSettingsButton"),
  discordGuildId: document.querySelector("#discordGuildIdInput"),
  discordEventChannelId: document.querySelector("#discordEventChannelIdInput"),
  discordStorageLedgerChannelId: document.querySelector("#discordStorageLedgerChannelIdInput"),
  discordInventoryChannelId: document.querySelector("#discordInventoryChannelIdInput"),
  discordAlertChannelId: document.querySelector("#discordAlertChannelIdInput"),
  financeSection: document.querySelector("#financeSection"),
  financeDataStatus: document.querySelector("#financeDataStatus"),
  financeCoverageStatus: document.querySelector("#financeCoverageStatus"),
  financePeriod: document.querySelector("#financePeriodSelect"),
  financeFrom: document.querySelector("#financeFromInput"),
  financeTo: document.querySelector("#financeToInput"),
  refreshFinance: document.querySelector("#refreshFinanceButton"),
  reconcileFinance: document.querySelector("#reconcileFinanceButton"),
  financeRevenue: document.querySelector("#financeRevenueValue"),
  financeExpense: document.querySelector("#financeExpenseValue"),
  financeProfit: document.querySelector("#financeProfitValue"),
  financeLedger: document.querySelector("#financeLedgerValue"),
  financeSafekeeping: document.querySelector("#financeSafekeepingValue"),
  financeBusinessCash: document.querySelector("#financeBusinessCashValue"),
  financeCommitted: document.querySelector("#financeCommittedValue"),
  financeAvailable: document.querySelector("#financeAvailableValue"),
  financeOwnerCapital: document.querySelector("#financeOwnerCapitalValue"),
  financeOwnerCapitalDetail: document.querySelector("#financeOwnerCapitalDetail"),
  financeSupplyCommitment: document.querySelector("#financeSupplyCommitmentValue"),
  financeSupplyCommitmentDetail: document.querySelector("#financeSupplyCommitmentDetail"),
  financeBuyCommitment: document.querySelector("#financeBuyCommitmentValue"),
  financeBuyCommitmentDetail: document.querySelector("#financeBuyCommitmentDetail"),
  financeRestockCommitment: document.querySelector("#financeRestockCommitmentValue"),
  financeRestockCommitmentDetail: document.querySelector("#financeRestockCommitmentDetail"),
  financeSupplyCommitmentList: document.querySelector("#financeSupplyCommitmentList"),
  financeBuyCommitmentList: document.querySelector("#financeBuyCommitmentList"),
  financeRestockCommitmentList: document.querySelector("#financeRestockCommitmentList"),
  financeBreakdownFilter: document.querySelector("#financeBreakdownFilter"),
  financeBreakdownBody: document.querySelector("#financeBreakdownBody"),
  financeMonthlyBody: document.querySelector("#financeMonthlyBody"),
  financeFundsType: document.querySelector("#financeFundsTypeInput"),
  financeFundsAmount: document.querySelector("#financeFundsAmountInput"),
  financeFundsEmployee: document.querySelector("#financeFundsEmployeeInput"),
  financeFundsNote: document.querySelector("#financeFundsNoteInput"),
  saveFinanceFunds: document.querySelector("#saveFinanceFundsButton"),
  financeFundsStatus: document.querySelector("#financeFundsStatus"),
  stockAlertList: document.querySelector("#stockAlertList"),
  storageAlertList: document.querySelector("#storageAlertList"),
  storageAlertCount: document.querySelector("#storageAlertCount"),
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
  latestHandoffMeta: document.querySelector("#latestHandoffMeta"),
  latestHandoffSummary: document.querySelector("#latestHandoffSummary"),
  dailyCloseDataStatus: document.querySelector("#dailyCloseDataStatus"),
  dailyCloseStatus: document.querySelector("#dailyCloseStatus"),
  dailyCloseStorefrontUnits: document.querySelector("#dailyCloseStorefrontUnits"),
  dailyCloseStorageUnits: document.querySelector("#dailyCloseStorageUnits"),
  dailyCloseSystemLedger: document.querySelector("#dailyCloseSystemLedger"),
  dailyCloseOpenSales: document.querySelector("#dailyCloseOpenSales"),
  dailyCloseActiveProduction: document.querySelector("#dailyCloseActiveProduction"),
  dailyCloseIssueCount: document.querySelector("#dailyCloseIssueCount"),
  dailyCloseEditMeta: document.querySelector("#dailyCloseEditMeta"),
  dailyCloseBusinessDate: document.querySelector("#dailyCloseBusinessDateInput"),
  dailyCloseLedgerCount: document.querySelector("#dailyCloseLedgerCountInput"),
  dailyCloseLedgerDifference: document.querySelector("#dailyCloseLedgerDifference"),
  dailyCloseStorefrontConfirmed: document.querySelector("#dailyCloseStorefrontConfirmedInput"),
  dailyCloseStorageConfirmed: document.querySelector("#dailyCloseStorageConfirmedInput"),
  dailyCloseDiscrepancy: document.querySelector("#dailyCloseDiscrepancyInput"),
  dailyClosePriority: document.querySelector("#dailyClosePriorityInput"),
  dailyCloseHandoff: document.querySelector("#dailyCloseHandoffInput"),
  finalizeDailyClose: document.querySelector("#finalizeDailyCloseButton"),
  reopenDailyClose: document.querySelector("#reopenDailyCloseButton"),
  dailyCloseIssueList: document.querySelector("#dailyCloseIssueList"),
  dailyCloseHistoryCount: document.querySelector("#dailyCloseHistoryCount"),
  dailyCloseHistoryList: document.querySelector("#dailyCloseHistoryList"),
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
  targetLocation: document.querySelector("#targetLocationInput"),
  targetOptions: document.querySelector("#targetOptions"),
  targetQuantity: document.querySelector("#targetQuantityInput"),
  saveTarget: document.querySelector("#saveTargetButton"),
  targetList: document.querySelector("#targetList"),
  storageTargetList: document.querySelector("#storageTargetList"),
  saveCount: document.querySelector("#saveCountButton"),
  saveMovement: document.querySelector("#saveMovementButton"),
  saveLedger: document.querySelector("#saveLedgerButton"),
  savePayroll: document.querySelector("#savePayrollButton"),
  operationList: document.querySelector("#operationList"),
  operationCount: document.querySelector("#operationCountText")
};

document.body.append(elements.catalogItemDialog);
seedDatalist();
wireEvents();
setFinancePeriod("month", false);
render();
loadSessionAndData();

function newOrder() {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    orderType: "Customer Sale",
    customer: "",
    handler: currentUser?.fullName || "",
    status: "Draft",
    priority: "Normal",
    deliveryDate: "",
    deposit: 0,
    lines: [],
    label: "",
    notes: "",
    revision: 0,
    createdAt: now,
    updatedAt: now,
    createdBy: "",
    updatedBy: ""
  };
}

function isInternalCraftOrder(order) {
  return order?.orderType === "Internal Craft";
}

function orderProductionSourceType(order) {
  return isInternalCraftOrder(order) ? "Internal Craft" : "Customer Order";
}

function orderDisplayName(order) {
  if (isInternalCraftOrder(order)) return order.label || "Internal stock build";
  return order.customer || "Unnamed customer";
}

function newDailyClose() {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    businessDate: todayKey(),
    status: "Draft",
    storefrontConfirmed: false,
    storageConfirmed: false,
    countedLedgerBalance: null,
    discrepancyNotes: "",
    priorityNotes: "",
    handoffNotes: "",
    snapshot: emptyDailyCloseSnapshot(),
    revision: 0,
    createdAt: now,
    updatedAt: now,
    createdBy: currentUser?.fullName || "",
    updatedBy: "",
    finalizedAt: "",
    finalizedBy: ""
  };
}

function emptyDailyCloseSnapshot() {
  return {
    capturedAt: "",
    sheetGeneratedAt: "",
    storefrontUnits: null,
    storageUnits: null,
    ledgerBalance: null,
    openSalesOrders: 0,
    overdueSalesOrders: 0,
    activeProductionBatches: 0,
    expectedSupplyDeliveries: 0,
    openStorefrontBuyOrders: 0,
    openReviewExceptions: 0,
    issues: []
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

function newStorefrontBuyOrder() {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    itemName: "",
    itemLabel: "",
    quantity: 1,
    unitPrice: 0,
    postedAt: now,
    status: "Active",
    notes: "",
    filledQuantity: 0,
    fillEvents: [],
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

function loadStorageTargets() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_TARGETS_KEY) || "[]");
  } catch {
    return [];
  }
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

function persistStorageTargets() {
  localStorage.setItem(STORAGE_TARGETS_KEY, JSON.stringify(storageTargets));
}

function seedDatalist() {
  elements.itemOptions.innerHTML = itemCatalog
    .map(item => `<option value="${escapeHtml(item.label)}">${escapeHtml(item.name)} - ${formatCurrency(item.price)}</option>`)
    .join("");
  elements.stockOptions.innerHTML = stockOptionMarkup(stockCatalog);
  seedTargetDatalist();
  elements.buyOrderItemOptions.innerHTML = stockOptionMarkup([...ingredientCatalog, ...itemCatalog]);
  const catalogCategories = new Set([
    "Products",
    "Materials",
    "Resale",
    ...itemCatalog.map(item => item.category),
    ...ingredientCatalog.map(item => item.category)
  ].filter(Boolean));
  elements.catalogCategoryOptions.innerHTML = [...catalogCategories]
    .sort((a, b) => a.localeCompare(b))
    .map(category => `<option value="${escapeHtml(category)}"></option>`)
    .join("");
  seedSupplyMaterialOptions();
  seedCountDatalist();
}

function seedTargetDatalist() {
  const catalog = elements.targetLocation?.value === "Storage"
    ? [...ingredientCatalog, ...itemCatalog]
    : itemCatalog;
  if (elements.targetOptions) elements.targetOptions.innerHTML = stockOptionMarkup(catalog);
}

function rebuildCatalogIndexes() {
  productCatalogByKey.clear();
  itemCatalog.forEach(item => {
    [item.name, item.label, item.tag, ...(Array.isArray(item.aliases) ? item.aliases : [])].forEach(value => {
      const key = normalize(value);
      if (key && !productCatalogByKey.has(key)) productCatalogByKey.set(key, item);
    });
  });
  stockCatalog.splice(0, stockCatalog.length, ...itemCatalog, ...ingredientCatalog);
}

function hydrateSharedCatalog(snapshot) {
  const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
  itemCatalog.splice(0, itemCatalog.length, ...items.map(item => ({ ...item })));
  replaceObject(recipeCatalog, snapshot?.recipes);
  replaceObject(recipeYieldCatalog, snapshot?.recipeYields);
  replaceObject(pricingCatalog, snapshot?.pricing);
  const configuredMaterials = Array.isArray(snapshot?.materials)
    ? snapshot.materials.map(material => ({ ...material, label: material.label || material.name }))
    : [];
  const materialByName = new Map(configuredMaterials.map(material => [normalize(material.name), material]));
  getRecipeIngredients().forEach(material => {
    if (!materialByName.has(normalize(material.name))) materialByName.set(normalize(material.name), material);
  });
  ingredientCatalog.splice(0, ingredientCatalog.length, ...materialByName.values());
  rebuildCatalogIndexes();
  seedDatalist();
}

function replaceObject(target, source) {
  Object.keys(target).forEach(key => delete target[key]);
  if (!source || typeof source !== "object") return;
  Object.entries(source).forEach(([key, value]) => { target[key] = structuredClone(value); });
}

function applyBusinessConfiguration(snapshot) {
  businessProfile = { ...businessProfile, ...(snapshot?.business || {}) };
  businessTerminology = { ...businessTerminology, ...(snapshot?.terminology || {}) };
  navigationSections = {
    ...DEFAULT_NAVIGATION_SECTIONS,
    ...(snapshot?.navigation?.sections || {})
  };
  const name = businessProfile.name || "Business";
  const ledgerName = businessProfile.ledgerName || `${name} Ledger`;
  const locale = businessProfile.locale || "en-US";
  const timezone = businessProfile.timezone || "UTC";
  const currency = businessProfile.currency || "USD";
  deliveryDateFormatter = new Intl.DateTimeFormat(locale, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: timezone
  });
  dateTimeFormatter = new Intl.DateTimeFormat(locale, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: timezone
  });
  businessDateKeyFormatter = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: timezone
  });
  numberFormatter = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
  currencyFormatter = new Intl.NumberFormat(locale, { style: "currency", currency, maximumFractionDigits: 2 });
  document.title = `${name} - ${ledgerName}`;
  document.querySelector("#businessName").textContent = name;
  document.querySelector("#businessLedgerName").textContent = ledgerName;
  const salesOrderLabel = businessTerminology.salesOrder || "Sales Order";
  const salesDeskNavLabel = document.querySelector("#salesDeskNavLabel");
  const activeSalesOrderTitle = document.querySelector("#activeSalesOrderTitle");
  const savedSalesOrderTitle = document.querySelector("#savedSalesOrderTitle");
  if (salesDeskNavLabel) salesDeskNavLabel.textContent = "Sales";
  if (activeSalesOrderTitle) activeSalesOrderTitle.textContent = salesOrderLabel;
  if (savedSalesOrderTitle) savedSalesOrderTitle.textContent = pluralizeLabel(salesOrderLabel);
  const ownerCapitalLabel = document.querySelector("#financeOwnerCapitalLabel");
  if (ownerCapitalLabel) ownerCapitalLabel.textContent = `${currentUser?.fullName || "Owner"}'s capital currently in the business`;
  const logo = document.querySelector("#businessLogo");
  const monogram = document.querySelector("#businessMonogram");
  if (businessProfile.logoUrl) {
    logo.onerror = () => {
      logo.classList.add("hidden");
      monogram.classList.remove("hidden");
      monogram.textContent = businessInitials(name);
    };
    logo.src = businessProfile.logoUrl;
    logo.alt = `${name} logo`;
    logo.classList.remove("hidden");
    monogram.classList.add("hidden");
  } else {
    logo.onerror = null;
    logo.classList.add("hidden");
    monogram.classList.remove("hidden");
    monogram.textContent = businessInitials(name);
  }
  applyNavigationVisibility();
  if (!canAccessSection(activeSection)) activeSection = "dashboard";
  renderSection();
  if (isAdmin() && !businessSettingsDirty) populateBusinessSettings();
}

function pluralizeLabel(value) {
  const label = String(value || "Sales Order").trim();
  if (/s$/i.test(label)) return label;
  if (/y$/i.test(label) && !/[aeiou]y$/i.test(label)) return `${label.slice(0, -1)}ies`;
  return `${label}s`;
}

function businessInitials(value) {
  return String(value || "Business Ledger").split(/\s+/).filter(Boolean).slice(0, 2).map(word => word[0]).join("").toUpperCase();
}

function isNavigationSectionEnabled(section) {
  if (section === "dashboard" || section === "business-settings") return true;
  return navigationSections[section] !== false;
}

function applyNavigationVisibility() {
  document.querySelectorAll(".section-tabs [data-section]").forEach(control => {
    control.classList.toggle("navigation-disabled", !isNavigationSectionEnabled(control.dataset.section));
  });
}

function populateBusinessSettings() {
  if (!elements.businessSettingsForm) return;
  elements.settingsBusinessName.value = businessProfile.name || "";
  elements.settingsLedgerName.value = businessProfile.ledgerName || `${businessProfile.name || "Business"} Ledger`;
  elements.settingsLocation.value = businessProfile.location || "";
  elements.settingsReferenceId.value = businessProfile.referenceId || "";
  elements.settingsLogoUrl.value = businessProfile.logoUrl || "";
  elements.settingsDescription.value = businessProfile.description || "";
  elements.settingsCurrency.value = businessProfile.currency || "USD";
  elements.settingsLocale.value = businessProfile.locale || "en-US";
  elements.settingsTimezone.value = businessProfile.timezone || "UTC";
  elements.settingsSalesLocation.value = businessTerminology.salesLocation || "Storefront";
  elements.settingsStorageLocation.value = businessTerminology.storageLocation || "Storage";
  elements.settingsSalesOrder.value = businessTerminology.salesOrder || "Sales Order";
  renderBusinessNavigationSettings();
  const workspaceCode = currentWorkspace?.workspaceCode || currentWorkspace?.code || "";
  elements.businessSettingsMeta.textContent = workspaceCode
    ? `Workspace ${workspaceCode} / business identity and ledger presentation`
    : "Business identity and ledger presentation";
  renderBusinessSettingsPreview();
}

function renderBusinessNavigationSettings() {
  if (!elements.settingsNavigationTabs) return;
  elements.settingsNavigationTabs.innerHTML = NAVIGATION_TAB_DEFINITIONS.map(tab => `
    <label class="business-navigation-tab">
      <input type="checkbox" data-navigation-section="${escapeHtml(tab.section)}"${navigationSections[tab.section] !== false ? " checked" : ""}>
      <span>
        <strong>${escapeHtml(tab.label)}</strong>
        <small>${escapeHtml(tab.role)}</small>
      </span>
    </label>
  `).join("");
}

function renderBusinessSettingsPreview() {
  if (!elements.businessSettingsForm) return;
  const name = elements.settingsBusinessName.value.trim() || "Business";
  const ledgerName = elements.settingsLedgerName.value.trim() || `${name} Ledger`;
  const location = elements.settingsLocation.value.trim();
  const referenceId = elements.settingsReferenceId.value.trim();
  const description = elements.settingsDescription.value.trim();
  const logoUrl = elements.settingsLogoUrl.value.trim();
  elements.settingsNamePreview.textContent = name;
  elements.settingsLedgerPreview.textContent = ledgerName;
  elements.settingsLocationPreview.textContent = [location, referenceId].filter(Boolean).join(" / ");
  elements.settingsLocationPreview.classList.toggle("hidden", !location && !referenceId);
  elements.settingsDescriptionPreview.textContent = description;
  elements.settingsDescriptionPreview.classList.toggle("hidden", !description);
  elements.settingsMonogramPreview.textContent = businessInitials(name);
  if (/^https:\/\//i.test(logoUrl)) {
    elements.settingsLogoPreview.src = logoUrl;
    elements.settingsLogoPreview.alt = `${name} logo preview`;
    elements.settingsLogoPreview.classList.remove("hidden");
    elements.settingsMonogramPreview.classList.add("hidden");
  } else {
    elements.settingsLogoPreview.removeAttribute("src");
    elements.settingsLogoPreview.classList.add("hidden");
    elements.settingsMonogramPreview.classList.remove("hidden");
  }
}

async function saveBusinessSettings() {
  if (!isAdmin() || businessSettingsSavePending) return;
  businessSettingsSavePending = true;
  elements.saveBusinessSettings.disabled = true;
  elements.resetBusinessSettings.disabled = true;
  elements.businessSettingsStatus.textContent = "Saving business profile";
  try {
    const response = await fetch("/api/admin/business-profile", {
      method: "PUT",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        business: {
          name: elements.settingsBusinessName.value.trim(),
          ledgerName: elements.settingsLedgerName.value.trim(),
          location: elements.settingsLocation.value.trim(),
          referenceId: elements.settingsReferenceId.value.trim(),
          logoUrl: elements.settingsLogoUrl.value.trim(),
          description: elements.settingsDescription.value.trim(),
          currency: elements.settingsCurrency.value.trim().toUpperCase(),
          locale: elements.settingsLocale.value.trim(),
          timezone: elements.settingsTimezone.value.trim()
        },
        terminology: {
          salesLocation: elements.settingsSalesLocation.value.trim(),
          storageLocation: elements.settingsStorageLocation.value.trim(),
          salesOrder: elements.settingsSalesOrder.value.trim()
        },
        navigation: {
          sections: Object.fromEntries(NAVIGATION_TAB_DEFINITIONS.map(tab => [
            tab.section,
            Boolean(elements.settingsNavigationTabs.querySelector(`[data-navigation-section="${tab.section}"]`)?.checked)
          ]))
        }
      })
    });
    const result = await response.json().catch(() => ({}));
    if (response.status === 401) {
      window.location.replace("/login.html");
      return;
    }
    if (!response.ok) throw new Error(result.error || `API ${response.status}`);
    businessSettingsDirty = false;
    if (result.workspace) currentWorkspace = result.workspace;
    applyBusinessConfiguration({
      business: result.business,
      terminology: result.terminology,
      navigation: result.navigation
    });
    elements.businessSettingsStatus.textContent = `Saved ${formatDateTime(result.updatedAt || new Date().toISOString())}`;
  } catch (error) {
    elements.businessSettingsStatus.textContent = error.message;
  } finally {
    businessSettingsSavePending = false;
    elements.saveBusinessSettings.disabled = false;
    elements.resetBusinessSettings.disabled = false;
  }
}

function populateDiscordSettings(integration = discordIntegration) {
  if (!elements.discordSettingsForm) return;
  const saved = integration || {};
  elements.discordGuildId.value = saved.guildId || "";
  elements.discordEventChannelId.value = saved.eventChannelId || "";
  elements.discordStorageLedgerChannelId.value = saved.storageLedgerChannelId || "";
  elements.discordInventoryChannelId.value = saved.inventoryChannelId || "";
  elements.discordAlertChannelId.value = saved.alertChannelId || "";
}

async function loadDiscordSettings({ silent = false } = {}) {
  if (!isAdmin() || !elements.discordSettingsPanel) return;
  if (!silent) elements.discordSettingsStatus.textContent = "Loading Discord configuration";
  try {
    const response = await fetch("/api/integrations/discord/configuration", {
      headers: { accept: "application/json" }
    });
    const result = await response.json().catch(() => ({}));
    if (response.status === 401) {
      window.location.replace("/login.html");
      return;
    }
    if (response.status === 404) {
      elements.discordSettingsPanel.classList.add("hidden");
      return;
    }
    if (!response.ok) throw new Error(result.error || `API ${response.status}`);
    discordIntegration = result.integration || {};
    populateDiscordSettings();
    elements.discordSettingsPanel.classList.remove("hidden");
    elements.discordSettingsStatus.textContent = discordIntegration.eventChannelId
      ? "Discord channels loaded"
      : "Add the storefront event channel to enable Discord routing";
  } catch (error) {
    elements.discordSettingsStatus.textContent = error.message;
  }
}

async function saveDiscordSettings() {
  if (!isAdmin() || discordSettingsSavePending) return;
  discordSettingsSavePending = true;
  elements.saveDiscordSettings.disabled = true;
  elements.reloadDiscordSettings.disabled = true;
  elements.discordSettingsStatus.textContent = "Saving Discord channels";
  try {
    const response = await fetch("/api/integrations/discord/configuration", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        guildId: elements.discordGuildId.value.trim(),
        eventChannelId: elements.discordEventChannelId.value.trim(),
        storageLedgerChannelId: elements.discordStorageLedgerChannelId.value.trim(),
        inventoryChannelId: elements.discordInventoryChannelId.value.trim(),
        alertChannelId: elements.discordAlertChannelId.value.trim()
      })
    });
    const result = await response.json().catch(() => ({}));
    if (response.status === 401) {
      window.location.replace("/login.html");
      return;
    }
    if (!response.ok) throw new Error(result.error || `API ${response.status}`);
    discordIntegration = result.integration || {};
    populateDiscordSettings();
    elements.discordSettingsStatus.textContent = "Discord channels saved";
  } catch (error) {
    elements.discordSettingsStatus.textContent = error.message;
  } finally {
    discordSettingsSavePending = false;
    elements.saveDiscordSettings.disabled = false;
    elements.reloadDiscordSettings.disabled = false;
  }
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
  elements.finalizeDailyClose.addEventListener("click", finalizeActiveDailyClose);
  elements.reopenDailyClose.addEventListener("click", reopenActiveDailyClose);
  [
    elements.dailyCloseBusinessDate,
    elements.dailyCloseLedgerCount,
    elements.dailyCloseStorefrontConfirmed,
    elements.dailyCloseStorageConfirmed,
    elements.dailyCloseDiscrepancy,
    elements.dailyClosePriority,
    elements.dailyCloseHandoff
  ].forEach(field => ["input", "change"].forEach(eventName => field.addEventListener(eventName, () => {
    updateDailyCloseFromInputs();
    dailyCloseDirty = true;
    renderDailyCloseDifference();
  })));
  document.querySelector("#addItemButton").addEventListener("click", addItemLine);
  document.querySelector("#copySummaryButton").addEventListener("click", copySummary);
  document.querySelector("#copyProductionButton").addEventListener("click", copyProduction);
  elements.queueOrderProduction.addEventListener("click", queueActiveOrderProduction);
  elements.queueRestock.addEventListener("click", queueRestockProduction);
  elements.productionFilter.addEventListener("change", renderProductionQueue);
  elements.refreshProduction.addEventListener("click", () => loadProductionBatches());
  elements.startProduction.addEventListener("click", startSelectedProductionBatch);
  elements.recordProduction.addEventListener("click", recordSelectedProductionProgress);
  elements.cancelProduction.addEventListener("click", cancelSelectedProductionBatch);
  elements.logout.addEventListener("click", logout);
  elements.pendingUserList.addEventListener("click", handleEmployeeAction);
  elements.employeeUserList.addEventListener("click", handleEmployeeAction);
  elements.auditEmployeeFilter.addEventListener("change", renderAudit);
  elements.auditCategoryFilter.addEventListener("change", renderAudit);
  elements.auditActionFilter.addEventListener("change", renderAudit);
  elements.auditSearch.addEventListener("input", renderAudit);
  elements.refreshAudit.addEventListener("click", loadAuditEvents);
  elements.reviewStatusFilter.addEventListener("change", () => renderReviewWorkspace({ preserveEditor: true }));
  elements.reviewSearch.addEventListener("input", () => renderReviewWorkspace({ preserveEditor: true }));
  elements.refreshReview.addEventListener("click", () => loadBackendSnapshot({ silent: false, preserveReviewEditor: true }));
  elements.webhookLogStatusFilter.addEventListener("change", renderWebhookLog);
  elements.webhookLogSearch.addEventListener("input", renderWebhookLog);
  elements.reviewCreateProduct.addEventListener("change", renderReviewProductMode);
  elements.reviewPackageConversion.addEventListener("change", () => {
    if (elements.reviewPackageConversion.checked) elements.reviewRememberMapping.checked = true;
    renderReviewPackageMode();
  });
  elements.reviewUnitsPerPackage.addEventListener("input", renderReviewPackageMode);
  elements.reviewQuantity.addEventListener("input", renderReviewPackageMode);
  elements.reviewItem.addEventListener("input", renderReviewPackageMode);
  elements.reviewItemType.addEventListener("change", () => {
    elements.reviewProductCategory.value = elements.reviewItemType.value === "material"
      ? "Materials"
      : suggestProductCategory(elements.reviewProductLabel.value || elements.reviewItem.value);
    renderReviewProductMode();
  });
  [
    elements.reviewCashAmount,
    elements.reviewCashCategory,
    elements.reviewCashReference,
    elements.reviewItem,
    elements.reviewEventType,
    elements.reviewDirection,
    elements.reviewQuantity,
    elements.reviewUnitPrice,
    elements.reviewNote,
    elements.reviewRememberMapping,
    elements.reviewPackageConversion,
    elements.reviewUnitsPerPackage,
    elements.reviewCreateProduct,
    elements.reviewItemType,
    elements.reviewProductLabel,
    elements.reviewProductTag,
    elements.reviewProductCategory,
    elements.reviewItemUnit,
    elements.reviewItemUnitCost,
    elements.reviewProductPrice,
    elements.reviewProductTarget
  ].forEach(element => {
    element.addEventListener("input", markReviewEditorDirty);
    element.addEventListener("change", markReviewEditorDirty);
  });
  elements.resolveReview.addEventListener("click", resolveReviewException);
  elements.ignoreReview.addEventListener("click", ignoreReviewException);
  elements.clockToggle.addEventListener("click", toggleTimeClock);
  elements.countLocation.addEventListener("change", seedCountDatalist);
  elements.saveCount.addEventListener("click", saveManualCount);
  elements.saveMovement.addEventListener("click", saveManualMovement);
  elements.saveLedger.addEventListener("click", saveLedgerAdjustment);
  elements.savePayroll.addEventListener("click", savePayrollPayment);
  elements.saveTarget.addEventListener("click", saveStockTarget);
  elements.targetLocation.addEventListener("change", () => {
    elements.targetItem.value = "";
    elements.targetQuantity.value = "0";
    elements.saveTarget.textContent = "Save Target";
    seedTargetDatalist();
  });
  document.querySelector("#pauseButton").addEventListener("click", () => setStatus("Paused"));
  document.querySelector("#expediteButton").addEventListener("click", () => {
    activeOrder.priority = "Expedite";
    setStatus("Expedited");
  });
  document.querySelector("#reserveButton").addEventListener("click", () => setStatus("Reserved"));
  document.querySelector("#completeButton").addEventListener("click", completeActiveOrder);
  document.querySelector("#deleteOrderButton").addEventListener("click", removeActiveOrder);
  document.querySelector("#addSupplyLineButton").addEventListener("click", addSupplyLine);
  document.querySelector("#addMissingSupplyButton").addEventListener("click", addMissingSupplyLines);
  document.querySelector("#copySupplyOrderButton").addEventListener("click", copySupplyOrder);
  elements.copySupplyTelegram.addEventListener("click", copySupplyTelegram);
  document.querySelector("#orderSupplyButton").addEventListener("click", () => setSupplyStatus("Ordered"));
  elements.receiveSupply.addEventListener("click", receiveSupplyOrder);
  document.querySelector("#deleteSupplyOrderButton").addEventListener("click", removeActiveSupplyOrder);
  elements.newBuyOrder.addEventListener("click", startNewStorefrontBuyOrder);
  elements.saveBuyOrder.addEventListener("click", saveStorefrontBuyOrder);
  elements.deleteBuyOrder.addEventListener("click", removeActiveStorefrontBuyOrder);
  elements.adjustBuyOrderFill.addEventListener("click", adjustStorefrontBuyOrderFill);
  elements.newSupplier.addEventListener("click", startNewSupplier);
  elements.saveSupplier.addEventListener("click", saveSupplier);
  elements.deleteSupplier.addEventListener("click", removeActiveSupplier);
  elements.addSupplierProduct.addEventListener("click", addSupplierProduct);
  elements.addSupplierEmployee.addEventListener("click", addSupplierEmployee);
  elements.supplierProduct.addEventListener("input", updateSupplierProductDefaults);
  elements.supplierSearch.addEventListener("input", renderSupplierDirectory);
  elements.storeOverviewSearch.addEventListener("input", renderStoreOverview);
  elements.closeProductCard.addEventListener("click", closeProductCard);
  elements.openCatalogItemDialog.addEventListener("click", () => openCatalogItemDialog());
  elements.newCatalogGood.addEventListener("click", () => openCatalogItemDialog());
  elements.catalogSearch.addEventListener("input", renderCatalogLedger);
  elements.catalogGoodsBody.addEventListener("click", event => {
    const button = event.target.closest("[data-edit-catalog-good]");
    if (button) openCatalogItemDialog(button.dataset.editCatalogGood);
  });
  elements.recipeList.addEventListener("click", event => {
    const button = event.target.closest("[data-recipe-product]");
    if (button) editRecipe(button.dataset.recipeProduct);
  });
  elements.newRecipe.addEventListener("click", startNewRecipe);
  elements.addRecipeIngredient.addEventListener("click", () => addRecipeIngredientRow());
  elements.recipeIngredientList.addEventListener("click", event => {
    const button = event.target.closest("[data-remove-recipe-ingredient]");
    if (button) button.closest(".recipe-ingredient-row")?.remove();
  });
  elements.recipeEditorForm.addEventListener("submit", event => {
    event.preventDefault();
    saveRecipe();
  });
  elements.deleteRecipe.addEventListener("click", deleteActiveRecipe);
  elements.closeProductionSource.addEventListener("click", closeProductionSourceDialog);
  elements.cancelProductionSource.addEventListener("click", closeProductionSourceDialog);
  elements.workspaceSwitcher.addEventListener("click", openWorkspaceDialog);
  elements.closeWorkspaceDialog.addEventListener("click", closeWorkspaceDialog);
  elements.doneWorkspaceDialog.addEventListener("click", closeWorkspaceDialog);
  elements.workspaceDialogForm.addEventListener("submit", linkWorkspaceJob);
  elements.workspaceJobList.addEventListener("click", switchWorkspace);
  elements.linkJobWorkspace.addEventListener("input", () => {
    elements.linkJobWorkspace.value = formatWorkspaceCode(elements.linkJobWorkspace.value);
  });
  elements.productionSourceForm.addEventListener("submit", event => {
    event.preventDefault();
    confirmProductionSourceSelection();
  });
  elements.closeCatalogItemDialog.addEventListener("click", closeCatalogItemDialog);
  elements.cancelCatalogItem.addEventListener("click", closeCatalogItemDialog);
  elements.catalogItemType.addEventListener("change", renderCatalogItemType);
  elements.catalogItemName.addEventListener("input", () => {
    if (!elements.catalogItemLabel.dataset.edited) elements.catalogItemLabel.value = elements.catalogItemName.value;
  });
  elements.catalogItemLabel.addEventListener("input", () => {
    elements.catalogItemLabel.dataset.edited = elements.catalogItemLabel.value ? "true" : "";
  });
  elements.catalogItemForm.addEventListener("submit", event => {
    event.preventDefault();
    saveCatalogItem();
  });
  elements.businessSettingsForm.addEventListener("submit", event => {
    event.preventDefault();
    saveBusinessSettings();
  });
  elements.resetBusinessSettings.addEventListener("click", () => {
    businessSettingsDirty = false;
    populateBusinessSettings();
    elements.businessSettingsStatus.textContent = "Saved profile restored";
  });
  [
    elements.settingsBusinessName,
    elements.settingsLedgerName,
    elements.settingsLocation,
    elements.settingsReferenceId,
    elements.settingsLogoUrl,
    elements.settingsDescription,
    elements.settingsCurrency,
    elements.settingsLocale,
    elements.settingsTimezone,
    elements.settingsSalesLocation,
    elements.settingsStorageLocation,
    elements.settingsSalesOrder
  ].forEach(field => field.addEventListener("input", () => {
    businessSettingsDirty = true;
    elements.businessSettingsStatus.textContent = "Unsaved changes";
    renderBusinessSettingsPreview();
  }));
  elements.settingsNavigationTabs.addEventListener("change", event => {
    if (!event.target.matches("[data-navigation-section]")) return;
    businessSettingsDirty = true;
    elements.businessSettingsStatus.textContent = "Unsaved changes";
  });
  elements.discordSettingsForm.addEventListener("submit", event => {
    event.preventDefault();
    saveDiscordSettings();
  });
  elements.reloadDiscordSettings.addEventListener("click", () => loadDiscordSettings());
  elements.settingsLogoPreview.addEventListener("error", () => {
    elements.settingsLogoPreview.classList.add("hidden");
    elements.settingsMonogramPreview.classList.remove("hidden");
  });
  elements.financePeriod.addEventListener("change", () => setFinancePeriod(elements.financePeriod.value));
  elements.financeFrom.addEventListener("change", () => {
    elements.financePeriod.value = "custom";
    loadFinance();
  });
  elements.financeTo.addEventListener("change", () => {
    elements.financePeriod.value = "custom";
    loadFinance();
  });
  elements.refreshFinance.addEventListener("click", () => loadFinance());
  elements.reconcileFinance.addEventListener("click", () => {
    setFinancePeriod("all", false);
    loadFinance();
  });
  elements.financeBreakdownFilter.addEventListener("change", renderFinanceBreakdown);
  elements.saveFinanceFunds.addEventListener("click", recordFinanceFunds);
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
      if (!canAccessSection(button.dataset.section)) return;
      activeSection = button.dataset.section;
      renderSection();
      if (activeSection === "employees" && isManagement()) loadStaffData();
      if (activeSection === "supplies" && isManagement()) {
        loadSupplyOrders({ silent: true });
        loadSuppliers({ silent: true });
      }
      if (activeSection === "buy-orders" && isManagement()) loadStorefrontBuyOrders({ silent: true });
      if (activeSection === "review" && isManagement()) {
        loadBackendSnapshot({ silent: true, preserveReviewEditor: true });
      }
      if (activeSection === "catalog" && isManagement()) renderCatalogLedger();
      if (activeSection === "finance" && isAdmin()) loadFinance();
      if (activeSection === "business-settings" && isAdmin()) {
        if (!businessSettingsDirty) populateBusinessSettings();
        loadDiscordSettings({ silent: true });
      }
      if (activeSection === "production") loadProductionBatches({ silent: true });
      if (activeSection === "daily-close" && isManagement()) renderDailyCloseWorkspace();
    });
  });

  ["input", "change"].forEach(eventName => {
    elements.orderType.addEventListener(eventName, updateOrderTypeFromInput);
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
  [elements.buyOrderItem, elements.buyOrderPostedAt, elements.buyOrderQuantity, elements.buyOrderUnitPrice, elements.buyOrderStatus, elements.buyOrderNotes]
    .forEach(field => ["input", "change"].forEach(eventName => field.addEventListener(eventName, updateStorefrontBuyOrderFromInputs)));
  elements.buyOrderItem.addEventListener("input", updateStorefrontBuyOrderItemDefaults);

  elements.filter.addEventListener("change", renderOrdersList);
  elements.supplyFilter.addEventListener("change", renderSupplyOrdersList);
  elements.buyOrderFilter.addEventListener("change", renderStorefrontBuyOrders);
}

function startNewDocument() {
  if (activeSection === "daily-close") {
    const todayClose = dailyCloses.find(close => close.businessDate === todayKey());
    activeDailyClose = structuredClone(todayClose || newDailyClose());
    dailyCloseDirty = false;
    renderDailyCloseWorkspace();
    return;
  }
  if (activeSection === "supplies") {
    activeSupplyOrder = newSupplyOrder();
    renderSupplyWorkspace();
    elements.supplyProducer.focus();
    return;
  }
  if (activeSection === "buy-orders") {
    startNewStorefrontBuyOrder();
    return;
  }
  activeOrder = newOrder();
  activeOrderDirty = false;
  activeSection = "workbench";
  render();
}

function saveCurrentDocument() {
  if (activeSection === "daily-close") return saveDailyClose();
  if (activeSection === "supplies") return saveSupplyOrder();
  if (activeSection === "buy-orders") return saveStorefrontBuyOrder();
  return saveActiveOrder();
}

function updateActiveFromInputs() {
  activeOrder.orderType = elements.orderType.value === "Internal Craft" ? "Internal Craft" : "Customer Sale";
  activeOrder.customer = isInternalCraftOrder(activeOrder) ? "" : elements.customer.value.trim();
  activeOrder.handler = elements.handler.value.trim();
  activeOrder.deposit = isInternalCraftOrder(activeOrder) ? 0 : Number(elements.deposit.value || 0);
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

function updateOrderTypeFromInput() {
  const nextType = elements.orderType.value === "Internal Craft" ? "Internal Craft" : "Customer Sale";
  if (activeOrder.orderType === nextType) return;
  const wasInternal = isInternalCraftOrder(activeOrder);
  activeOrder.orderType = nextType;
  if (isInternalCraftOrder(activeOrder)) {
    activeOrder.customer = "";
    activeOrder.deposit = 0;
    activeOrder.lines = activeOrder.lines
      .filter(line => !line.custom)
      .map(line => ({ ...line, unitPrice: 0 }));
  } else if (wasInternal) {
    activeOrder.lines = activeOrder.lines.map(line => ({
      ...line,
      unitPrice: Number(findCatalogItem(line.name || line.label)?.price || 0)
    }));
  }
  touchActive();
  render();
}

function touchActive() {
  activeOrder.updatedAt = new Date().toISOString();
  activeOrderDirty = true;
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
    unitPrice: isInternalCraftOrder(activeOrder) ? 0 : Number(elements.price.value || item.price || 0),
    custom: false
  });

  elements.itemSearch.value = "";
  elements.quantity.value = "1";
  elements.price.value = "";
  touchActive();
  render();
}

function findCatalogItem(value) {
  return window.FRONTIER_INVENTORY_COUNTS.resolveCatalogItem(itemCatalog, value);
}

async function saveActiveOrder() {
  if (salesOrderSavePending) return false;
  updateActiveFromInputs();
  salesOrderSavePending = true;
  elements.saveDocument.disabled = true;
  elements.orderMeta.textContent = "Saving to the shared order register";
  try {
    const response = await fetch("/api/sales-orders", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(activeOrder)
    });
    const result = await response.json().catch(() => ({ ok: false, error: `API ${response.status}` }));
    if (!response.ok || !result.ok) {
      const error = new Error(result.error || `API ${response.status}`);
      error.code = result.code || "sales_order_save_failed";
      throw error;
    }
    orders = Array.isArray(result.orders) ? result.orders : [];
    activeOrder = structuredClone(result.order);
    activeOrderDirty = false;
    legacyOrdersPendingMigration = legacyOrdersPendingMigration.filter(order => order.id !== activeOrder.id);
    render();
    if (result.fulfillmentSynced) await loadBackendSnapshot({ silent: true });
    elements.orderMeta.textContent = `${activeOrder.status} / Shared revision ${activeOrder.revision} / Saved by ${activeOrder.updatedBy}`;
    return true;
  } catch (error) {
    elements.orderMeta.textContent = `Save failed: ${error.message}`;
    if (error.code === "sales_order_conflict") {
      await loadSharedSalesOrders({ preserveActive: true });
      const latest = orders.find(order => order.id === activeOrder.id);
      if (latest && window.confirm("Another employee changed this order. Reload their latest version? Your unsaved changes will be replaced.")) {
        activeOrder = structuredClone(latest);
        activeOrderDirty = false;
        render();
      }
    }
    return false;
  } finally {
    salesOrderSavePending = false;
    elements.saveDocument.disabled = false;
  }
}

async function setStatus(status) {
  activeOrder.status = status;
  if (status === "Expedited") activeOrder.priority = "Expedite";
  activeOrderDirty = true;
  await saveActiveOrder();
}

async function completeActiveOrder() {
  const batch = productionBatchForOrder(activeOrder.id);
  if (isInternalCraftOrder(activeOrder)) {
    if (batch) {
      activeProductionBatchId = batch.id;
      activeSection = "production";
      render();
      elements.productionActionStatus.textContent = batch.status === "Completed"
        ? "This internal stock build is complete"
        : "Finish this production batch to complete the internal craft";
    } else {
      elements.orderMeta.textContent = "Queue production to complete an internal craft";
    }
    return;
  }
  if (batch && PRODUCTION_ACTIVE_STATUSES.has(batch.status)) {
    activeProductionBatchId = batch.id;
    activeSection = "production";
    render();
    elements.productionActionStatus.textContent = "Finish this production batch before completing the customer order";
    return;
  }
  await setStatus("Completed");
}

async function removeActiveOrder() {
  const saved = orders.some(order => order.id === activeOrder.id);
  if (!saved) {
    activeOrder = newOrder();
    activeOrderDirty = false;
    render();
    return;
  }
  const recordLabel = isInternalCraftOrder(activeOrder)
    ? `the internal craft ${orderDisplayName(activeOrder)}`
    : `the sales order for ${orderDisplayName(activeOrder)}`;
  if (!window.confirm(`Remove ${recordLabel}?`)) return;
  try {
    const response = await fetch(`/api/sales-orders/${encodeURIComponent(activeOrder.id)}`, {
      method: "DELETE",
      headers: { accept: "application/json" }
    });
    const result = await response.json().catch(() => ({ ok: false, error: `API ${response.status}` }));
    if (!response.ok || !result.ok) throw new Error(result.error || `API ${response.status}`);
    orders = Array.isArray(result.orders) ? result.orders : [];
    activeOrder = newOrder();
    activeOrderDirty = false;
    render();
  } catch (error) {
    elements.orderMeta.textContent = `Remove failed: ${error.message}`;
  }
}

async function loadSharedSalesOrders({ preserveActive = false } = {}) {
  const response = await fetch("/api/sales-orders", { headers: { accept: "application/json" } });
  const result = await response.json().catch(() => ({ ok: false, error: `API ${response.status}` }));
  if (!response.ok || !result.ok) throw new Error(result.error || `API ${response.status}`);
  orders = Array.isArray(result.orders) ? result.orders : [];
  if (!preserveActive && !activeOrderDirty) {
    const refreshed = orders.find(order => order.id === activeOrder.id);
    if (refreshed) activeOrder = structuredClone(refreshed);
  }
  renderOrdersList();
  renderDashboard();
  return orders;
}

async function migrateLegacySalesOrders() {
  if (!legacyOrdersPendingMigration.length) return true;
  try {
    const response = await fetch("/api/sales-orders/import", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ orders: legacyOrdersPendingMigration })
    });
    const result = await response.json().catch(() => ({ ok: false, error: `API ${response.status}` }));
    if (!response.ok || !result.ok) throw new Error(result.error || `API ${response.status}`);
    orders = Array.isArray(result.orders) ? result.orders : [];
    legacyOrdersPendingMigration = [];
    localStorage.removeItem(STORAGE_KEY);
    return true;
  } catch (error) {
    orders = [...legacyOrdersPendingMigration];
    elements.dataStatus.textContent = `Shared order migration delayed: ${error.message}`;
    return false;
  }
}

function loadOrder(orderId) {
  const order = orders.find(savedOrder => savedOrder.id === orderId);
  if (!order) return;
  activeOrder = structuredClone(order);
  activeOrderDirty = false;
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

function startNewStorefrontBuyOrder() {
  activeStorefrontBuyOrder = newStorefrontBuyOrder();
  storefrontBuyOrderDirty = false;
  renderStorefrontBuyOrderWorkspace();
  elements.buyOrderItem.focus();
}

function updateStorefrontBuyOrderFromInputs() {
  const item = resolveStockItem(elements.buyOrderItem.value);
  activeStorefrontBuyOrder.itemName = item.name;
  activeStorefrontBuyOrder.itemLabel = item.label || item.name;
  activeStorefrontBuyOrder.quantity = Math.max(1, Number(elements.buyOrderQuantity.value || 1));
  activeStorefrontBuyOrder.unitPrice = Math.max(0, Number(elements.buyOrderUnitPrice.value || 0));
  activeStorefrontBuyOrder.postedAt = fromDateTimeLocalValue(elements.buyOrderPostedAt.value)
    || activeStorefrontBuyOrder.postedAt;
  activeStorefrontBuyOrder.status = elements.buyOrderStatus.value;
  activeStorefrontBuyOrder.notes = elements.buyOrderNotes.value.trim();
  storefrontBuyOrderDirty = true;
}

function updateStorefrontBuyOrderItemDefaults() {
  const item = resolveStockItem(elements.buyOrderItem.value);
  if (!item.name) return;
  const currentName = normalize(activeStorefrontBuyOrder.itemName);
  activeStorefrontBuyOrder.itemName = item.name;
  activeStorefrontBuyOrder.itemLabel = item.label || item.name;
  if (currentName !== normalize(item.name) && Number(elements.buyOrderUnitPrice.value || 0) === 0) {
    const price = preferredSupplyUnitPrice(item.name);
    elements.buyOrderUnitPrice.value = price || 0;
    activeStorefrontBuyOrder.unitPrice = price || 0;
  }
}

async function loadStorefrontBuyOrders({ silent = false } = {}) {
  if (!isManagement()) return;
  try {
    const response = await fetch("/api/storefront-buy-orders", { headers: { accept: "application/json" } });
    if (response.status === 401) {
      window.location.replace("/login.html");
      return;
    }
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || `API ${response.status}`);
    storefrontBuyOrders = Array.isArray(result.orders) ? result.orders : [];
    const refreshed = storefrontBuyOrders.find(order => order.id === activeStorefrontBuyOrder.id);
    if (refreshed && !storefrontBuyOrderDirty) activeStorefrontBuyOrder = structuredClone(refreshed);
    elements.buyOrderDataStatus.textContent = `${storefrontBuyOrders.length} shared buy ${storefrontBuyOrders.length === 1 ? "order" : "orders"} loaded`;
    renderStorefrontBuyOrderWorkspace();
  } catch (error) {
    if (!silent) elements.buyOrderDataStatus.textContent = `Unable to load buy orders: ${error.message}`;
  }
}

async function saveStorefrontBuyOrder() {
  updateStorefrontBuyOrderFromInputs();
  if (!activeStorefrontBuyOrder.itemName) {
    elements.buyOrderDataStatus.textContent = "Select a material or item";
    elements.buyOrderItem.focus();
    return;
  }
  elements.saveBuyOrder.disabled = true;
  elements.buyOrderDataStatus.textContent = "Saving storefront buy order";
  try {
    const response = await fetch("/api/storefront-buy-orders", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(activeStorefrontBuyOrder)
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || `API ${response.status}`);
    activeStorefrontBuyOrder = structuredClone(result.order);
    storefrontBuyOrderDirty = false;
    storefrontBuyOrders = result.orders || [];
    elements.buyOrderDataStatus.textContent = `${activeStorefrontBuyOrder.itemLabel} saved as ${activeStorefrontBuyOrder.status}`;
    renderStorefrontBuyOrderWorkspace();
  } catch (error) {
    elements.buyOrderDataStatus.textContent = `Save failed: ${error.message}`;
  } finally {
    elements.saveBuyOrder.disabled = false;
  }
}

async function adjustStorefrontBuyOrderFill() {
  const isSaved = storefrontBuyOrders.some(order => order.id === activeStorefrontBuyOrder.id);
  if (!isSaved) return;
  const filledQuantity = Number(elements.buyOrderFilled.value || 0);
  elements.adjustBuyOrderFill.disabled = true;
  try {
    const response = await fetch(`/api/storefront-buy-orders/${encodeURIComponent(activeStorefrontBuyOrder.id)}/fill`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ filledQuantity })
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || `API ${response.status}`);
    activeStorefrontBuyOrder = structuredClone(result.order);
    storefrontBuyOrderDirty = false;
    storefrontBuyOrders = result.orders || [];
    elements.buyOrderDataStatus.textContent = `Fill adjusted to ${formatNumber(activeStorefrontBuyOrder.filledQuantity)}`;
    renderStorefrontBuyOrderWorkspace();
  } catch (error) {
    elements.buyOrderDataStatus.textContent = `Adjustment failed: ${error.message}`;
  } finally {
    elements.adjustBuyOrderFill.disabled = false;
  }
}

async function removeActiveStorefrontBuyOrder() {
  const isSaved = storefrontBuyOrders.some(order => order.id === activeStorefrontBuyOrder.id);
  if (!isSaved) return startNewStorefrontBuyOrder();
  if (!window.confirm(`Remove the buy order for ${activeStorefrontBuyOrder.itemLabel}?`)) return;
  try {
    const response = await fetch(`/api/storefront-buy-orders/${encodeURIComponent(activeStorefrontBuyOrder.id)}`, {
      method: "DELETE",
      headers: { accept: "application/json" }
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || `API ${response.status}`);
    storefrontBuyOrders = result.orders || [];
    activeStorefrontBuyOrder = newStorefrontBuyOrder();
    storefrontBuyOrderDirty = false;
    elements.buyOrderDataStatus.textContent = "Buy order removed";
    renderStorefrontBuyOrderWorkspace();
  } catch (error) {
    elements.buyOrderDataStatus.textContent = `Remove failed: ${error.message}`;
  }
}

function loadStorefrontBuyOrder(orderId) {
  const order = storefrontBuyOrders.find(candidate => candidate.id === orderId);
  if (!order) return;
  activeStorefrontBuyOrder = structuredClone(order);
  storefrontBuyOrderDirty = false;
  renderStorefrontBuyOrderWorkspace();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderStorefrontBuyOrderWorkspace() {
  if (!elements.buyOrdersSection) return;
  const isSaved = storefrontBuyOrders.some(order => order.id === activeStorefrontBuyOrder.id);
  const filled = Math.max(0, Number(activeStorefrontBuyOrder.filledQuantity || 0));
  elements.buyOrderItem.value = activeStorefrontBuyOrder.itemLabel || activeStorefrontBuyOrder.itemName;
  elements.buyOrderPostedAt.value = toDateTimeLocalValue(activeStorefrontBuyOrder.postedAt);
  elements.buyOrderQuantity.value = activeStorefrontBuyOrder.quantity;
  elements.buyOrderUnitPrice.value = activeStorefrontBuyOrder.unitPrice;
  elements.buyOrderStatus.value = activeStorefrontBuyOrder.status;
  elements.buyOrderNotes.value = activeStorefrontBuyOrder.notes || "";
  elements.buyOrderFilled.value = filled;
  elements.buyOrderFilled.max = activeStorefrontBuyOrder.quantity;
  elements.buyOrderMeta.textContent = isSaved
    ? `${activeStorefrontBuyOrder.status} / posted ${formatDateTime(activeStorefrontBuyOrder.postedAt)}`
    : "New order";
  elements.deleteBuyOrder.disabled = !isSaved || filled > 0;
  elements.adjustBuyOrderFill.disabled = !isSaved;

  const openOrders = storefrontBuyOrders.filter(order => BUY_ORDER_OPEN_STATUSES.has(order.status));
  const outstanding = openOrders.reduce((sum, order) => sum + Math.max(0, Number(order.quantity || 0) - Number(order.filledQuantity || 0)), 0);
  const committed = openOrders.reduce((sum, order) => {
    const remaining = Math.max(0, Number(order.quantity || 0) - Number(order.filledQuantity || 0));
    return sum + remaining * Number(order.unitPrice || 0);
  }, 0);
  const nearFilled = openOrders.filter(order => Number(order.filledQuantity || 0) > 0
    && Number(order.filledQuantity || 0) / Number(order.quantity || 1) >= 0.8).length;
  const filledOrders = storefrontBuyOrders.filter(order => order.status === "Filled").length;
  elements.buyOrderActiveCount.textContent = formatNumber(openOrders.filter(order => order.status === "Active").length);
  elements.buyOrderOutstandingCount.textContent = formatNumber(outstanding);
  elements.buyOrderCommittedValue.textContent = formatCurrency(committed);
  elements.buyOrderSavedCount.textContent = `${storefrontBuyOrders.length} tracked / ${nearFilled} near filled / ${filledOrders} filled`;
  renderStorefrontBuyOrders();
}

function renderStorefrontBuyOrders() {
  const filter = elements.buyOrderFilter.value;
  const visible = storefrontBuyOrders.filter(order =>
    filter === "All" || (filter === "Open" ? BUY_ORDER_OPEN_STATUSES.has(order.status) : order.status === filter)
  );
  if (!visible.length) {
    elements.buyOrderList.innerHTML = `<div class="empty-card">No storefront buy orders in this view</div>`;
    return;
  }
  elements.buyOrderList.innerHTML = visible.map(order => {
    const quantity = Math.max(1, Number(order.quantity || 1));
    const filled = Math.max(0, Number(order.filledQuantity || 0));
    const remaining = Math.max(0, quantity - filled);
    const percent = Math.min(100, Math.round(filled / quantity * 100));
    const status = order.status === "Active" && percent >= 80 && percent < 100 ? "Near filled" : order.status;
    return `
      <button class="buy-order-card ${order.id === activeStorefrontBuyOrder.id ? "active" : ""}" data-buy-order-id="${escapeHtml(order.id)}" data-status="${escapeHtml(order.status)}" type="button">
        <span class="buy-order-card-header">
          <strong>${escapeHtml(order.itemLabel || order.itemName)}</strong>
          <span class="buy-order-status">${escapeHtml(status)}</span>
        </span>
        <span class="buy-order-progress" aria-label="${percent}% filled"><span style="width:${percent}%"></span></span>
        <span class="buy-order-card-numbers">
          <span>${formatNumber(filled)} / ${formatNumber(quantity)} received</span>
          <span>${formatNumber(remaining)} remaining</span>
        </span>
        <span class="buy-order-card-footer">
        <span>${formatCurrency(order.unitPrice)} each</span>
          <span>${formatDateTime(order.postedAt)}</span>
        </span>
      </button>
    `;
  }).join("");
  elements.buyOrderList.querySelectorAll("[data-buy-order-id]").forEach(button => {
    button.addEventListener("click", () => loadStorefrontBuyOrder(button.dataset.buyOrderId));
  });
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
    ? `Updated ${formatDateTime(activeSupplier.updatedAt)} by ${activeSupplier.updatedBy || "Unknown"}`
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
    .map(product => `${product.label || product.name} ${formatCurrency(product.unitPrice)}`)
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
    business: [businessProfile.name, businessProfile.location].filter(Boolean).join(", ")
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
  renderOrderMode();
  elements.orderType.value = isInternalCraftOrder(activeOrder) ? "Internal Craft" : "Customer Sale";
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
  renderStorefrontBuyOrderWorkspace();
  renderSupplierWorkspace();
  renderProductionQueue();
  renderDailyCloseWorkspace();
  renderView();
  renderDashboard();
  renderLatestHandoff();
  renderStoreOverview();
  renderFinance();
  renderTimeClock();
  renderOperations();
  renderReviewWorkspace();
  renderEmployees();
  renderRole();
  renderSection();
}

function renderOrderMode() {
  const internal = isInternalCraftOrder(activeOrder);
  elements.activeOrderTitle.textContent = internal ? "Internal Craft" : businessTerminology.salesOrder;
  elements.customerField.classList.toggle("hidden", internal);
  elements.depositField.classList.toggle("hidden", internal);
  elements.linePriceField.classList.toggle("hidden", internal);
  elements.quickCustomWork.classList.toggle("hidden", internal);
  elements.customer.disabled = internal;
  elements.deposit.disabled = internal;
  elements.price.disabled = internal;
  elements.deliveryDateFieldLabel.textContent = internal ? "Target Date" : "Delivery Date";
  elements.quoteTab.textContent = internal ? "Plan" : "Quote";
  elements.copySummary.textContent = internal ? "Copy Craft Plan" : "Copy Summary";
  elements.completeOrder.disabled = internal;
  elements.completeOrder.title = internal ? "Internal crafts complete from the production queue" : "Complete order";
  const completedOption = elements.status.querySelector('option[value="Completed"]');
  if (completedOption) completedOption.disabled = internal;
}

function renderLines() {
  if (!activeOrder.lines.length) {
    elements.lines.innerHTML = `<tr><td colspan="5" class="empty-line">No lines yet</td></tr>`;
    return;
  }

  elements.lines.innerHTML = activeOrder.lines.map(line => {
    const unitPrice = isInternalCraftOrder(activeOrder) ? 0 : Number(line.unitPrice || 0);
    const total = line.quantity * unitPrice;
    return `
      <tr>
        <td>
          <strong>${escapeHtml(line.label || line.name)}</strong>
          <span>${escapeHtml(line.category || "Manual")}${line.tag ? ` / ${escapeHtml(line.tag)}` : ""}</span>
        </td>
        <td>${formatNumber(line.quantity)}</td>
        <td>${formatCurrency(unitPrice)}</td>
        <td>${formatCurrency(total)}</td>
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
  elements.supplyOrderMeta.textContent = `${activeSupplyOrder.status} / ${activeSupplyOrder.producer || "Producer not selected"} / ${formatDateTime(activeSupplyOrder.updatedAt)}`;
  const hasRemaining = activeSupplyOrder.lines.some(line => Number(line.quantity || 0) > Number(line.receivedQuantity || 0));
  const isSaved = supplyOrders.some(order => order.id === activeSupplyOrder.id);
  elements.copySupplyTelegram.disabled = !isSaved || !activeSupplyOrder.lines.length;
  elements.receiveSupply.disabled = supplyReceiptPending || !hasRemaining || !SUPPLY_DELIVERY_STATUSES.has(activeSupplyOrder.status);
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
    const receivable = remaining > 0 && SUPPLY_DELIVERY_STATUSES.has(activeSupplyOrder.status);
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
        <td>${formatCurrency(line.unitPrice)}</td>
        <td>${formatCurrency(total)}</td>
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
  elements.supplySubtotal.textContent = formatCurrency(subtotal);
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
          <span>${order.lines.length} lines / ${formatNumber(getSupplyReceivedUnits(order))} of ${formatNumber(getSupplyOrderedUnits(order))} received / ${formatCurrency(getSupplyOrderTotal(order))}</span>
            <small>Updated ${formatDateTime(order.updatedAt)} by ${escapeHtml(order.updatedBy || order.requestedBy)}</small>
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
      return `${formatNumber(line.quantity)}x ${line.label || line.name} / ${formatNumber(received)} received / ${formatNumber(remaining)} remaining - ${formatCurrency(line.unitPrice)} each = ${formatCurrency(total)} / ${formatNumber(metrics.missing)} currently missing`;
    }).join("\n")
    : "No parts or materials added";
  return [
    `${businessProfile.name || "Business"} Supply Order`,
    `Producer: ${order.producer || ""}`,
    `Requested by: ${order.requestedBy || currentUser?.fullName || ""}`,
    order.expectedDate ? `Expected: ${formatDelivery(order.expectedDate)}` : "Expected: Not set",
    `Status: ${order.status}`,
    "",
    lines,
    "",
    `Order total: ${formatCurrency(getSupplyOrderTotal(order))}`,
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
  const internal = isInternalCraftOrder(activeOrder);
  const subtotal = internal ? 0 : getSubtotal(activeOrder);
  const deposit = internal ? 0 : Number(activeOrder.deposit || 0);
  elements.subtotal.textContent = formatCurrency(subtotal);
  elements.depositValue.textContent = formatCurrency(deposit);
  elements.balance.textContent = formatCurrency(Math.max(0, subtotal - deposit));
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
  if (!canAccessSection(activeSection)) activeSection = "dashboard";
  document.querySelectorAll("[data-section]").forEach(button => {
    button.classList.toggle("active", button.dataset.section === activeSection);
  });
  elements.dashboardSection.classList.toggle("hidden", activeSection !== "dashboard");
  elements.storeSection.classList.toggle("hidden", activeSection !== "store");
  elements.catalogSection.classList.toggle("hidden", activeSection !== "catalog");
  elements.financeSection.classList.toggle("hidden", activeSection !== "finance");
  elements.restockSection.classList.toggle("hidden", activeSection !== "restock");
  elements.buyOrdersSection.classList.toggle("hidden", activeSection !== "buy-orders");
  elements.supplySection.classList.toggle("hidden", activeSection !== "supplies");
  elements.workbenchSection.classList.toggle("hidden", activeSection !== "workbench");
  elements.productionSection.classList.toggle("hidden", activeSection !== "production");
  elements.operationsSection.classList.toggle("hidden", activeSection !== "operations");
  elements.dailyCloseSection.classList.toggle("hidden", activeSection !== "daily-close");
  elements.reviewSection.classList.toggle("hidden", activeSection !== "review");
  elements.employeesSection.classList.toggle("hidden", activeSection !== "employees");
  elements.businessSettingsSection.classList.toggle("hidden", activeSection !== "business-settings");
  const supplyMode = activeSection === "supplies";
  const buyOrderMode = activeSection === "buy-orders";
  const closeMode = activeSection === "daily-close";
  const documentMode = activeSection === "workbench" || supplyMode || buyOrderMode || closeMode;
  elements.newDocument.classList.toggle("hidden", !documentMode);
  elements.saveDocument.classList.toggle("hidden", !documentMode);
  elements.newDocument.textContent = supplyMode ? "New Supply" : buyOrderMode ? "New Buy Order" : closeMode ? "Today's Close" : "New Sale";
  elements.saveDocument.textContent = supplyMode ? "Save Supply" : buyOrderMode ? "Save Buy Order" : closeMode ? "Save Draft" : "Save Sale";
}

function renderDashboard() {
  const activeOrders = orders.filter(order => !statusesHiddenFromActive.has(order.status));
  const today = todayKey();
  const dueToday = activeOrders.filter(order => order.deliveryDate === today);
  const overdue = activeOrders.filter(order => Boolean(order.deliveryDate && order.deliveryDate < today));
  const inStore = activeOrders.filter(order => !order.deliveryDate);
  const expedited = activeOrders.filter(order => order.status === "Expedited" || order.priority === "Expedite");
  const paused = activeOrders.filter(order => order.status === "Paused");
  const attention = uniqueOrders([...expedited, ...paused]);
  const expectedDeliveries = supplyOrders
    .filter(order => order.expectedDate === today)
    .filter(order => SUPPLY_DELIVERY_STATUSES.has(order.status))
    .filter(order => getSupplyReceivedUnits(order) < getSupplyOrderedUnits(order))
    .sort((a, b) => (a.producer || "").localeCompare(b.producer || "") || new Date(a.updatedAt) - new Date(b.updatedAt));

  elements.dueTodayCount.textContent = dueToday.length;
  elements.overdueCount.textContent = overdue.length;
  elements.expeditedCount.textContent = expedited.length;
  elements.pausedCount.textContent = paused.length;
  elements.inStoreCount.textContent = inStore.length;
  elements.expectedDeliveryTodayCount.textContent = expectedDeliveries.length;
  renderReviewIndicators();
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

function openCatalogItemDialog(itemId = "") {
  if (!isManagement()) return;
  const existing = itemId ? catalogGoods().find(item => item.id === itemId || normalize(item.name) === normalize(itemId)) : null;
  activeCatalogItemId = existing?.id || "";
  elements.catalogItemForm.reset();
  elements.catalogItemType.value = existing?.itemType || "product";
  elements.catalogItemName.value = existing?.name || "";
  elements.catalogItemName.disabled = Boolean(existing);
  elements.catalogItemLabel.value = existing?.label || "";
  elements.catalogItemTag.value = existing?.tag || existing?.itemTag || "";
  elements.catalogItemCategory.value = existing?.category || "";
  elements.catalogItemUnit.value = existing?.unit || existing?.unitName || "unit";
  elements.catalogItemUnitCost.value = Number(existing?.unitCost ?? existing?.price ?? 0);
  elements.catalogItemSalePrice.value = Number(existing?.salePrice ?? existing?.price ?? 0);
  elements.catalogItemTarget.value = Number(existing?.stockTarget ?? existing?.target ?? 0);
  elements.catalogItemStorageTarget.value = Number(existing?.storageTarget ?? 0);
  elements.catalogItemActive.value = existing?.active === false ? "false" : "true";
  elements.catalogItemLabel.dataset.edited = "";
  elements.catalogItemStatus.textContent = "";
  elements.catalogItemDialogTitle.textContent = existing ? "Edit Good" : "Add Good";
  elements.catalogItemDialogDescription.textContent = existing
    ? "Update its role, display details, prices, and availability"
    : "Create a sellable product, a recipe material, or one good that serves both roles";
  elements.saveCatalogItem.textContent = existing ? "Save Changes" : "Add Good";
  renderCatalogItemType();
  elements.catalogItemDialog.showModal();
  elements.catalogItemName.focus();
}

function closeCatalogItemDialog() {
  if (elements.catalogItemDialog.open) elements.catalogItemDialog.close();
}

function renderCatalogItemType() {
  const type = elements.catalogItemType.value;
  const sellable = type === "product" || type === "both";
  document.querySelectorAll(".catalog-product-field").forEach(field => field.classList.toggle("hidden", !sellable));
  const defaultCategories = new Set(["", "Products", "Materials", "Products and Materials"]);
  if (defaultCategories.has(elements.catalogItemCategory.value.trim())) {
    elements.catalogItemCategory.value = type === "material"
      ? "Materials"
      : type === "both" ? "Products and Materials" : "Products";
  }
}

async function saveCatalogItem() {
  if (catalogItemSavePending || !isManagement()) return;
  if (backendSnapshot?.dataBackend !== "postgresql") {
    elements.catalogItemStatus.textContent = "Catalog additions require the hosted database version";
    return;
  }
  const item = catalogItemDraft({
    type: elements.catalogItemType.value,
    name: elements.catalogItemName.value,
    label: elements.catalogItemLabel.value,
    tag: elements.catalogItemTag.value,
    category: elements.catalogItemCategory.value,
    unit: elements.catalogItemUnit.value,
    unitCost: elements.catalogItemUnitCost.value,
    salePrice: elements.catalogItemSalePrice.value,
    target: elements.catalogItemTarget.value,
    storageTarget: elements.catalogItemStorageTarget.value,
    active: elements.catalogItemActive.value === "true"
  });
  const validation = validateCatalogItemDraft(item);
  if (validation) {
    elements.catalogItemStatus.textContent = validation;
    return;
  }
  if (!activeCatalogItemId && (findExactStockItem(item.name) || findExactStockItem(item.label) || (item.tag && findExactStockItem(item.tag)))) {
    elements.catalogItemStatus.textContent = "That name, label, or game item tag already belongs to a catalog good";
    return;
  }

  catalogItemSavePending = true;
  elements.saveCatalogItem.disabled = true;
  elements.catalogItemStatus.textContent = activeCatalogItemId ? "Saving changes..." : "Adding good...";
  const action = activeCatalogItemId ? "catalog_item_update" : "catalog_item";
  const result = await syncToBackend(action, { item: { ...item, id: activeCatalogItemId } });
  if (!result.ok) {
    elements.catalogItemStatus.textContent = result.error || "The catalog good could not be saved";
    elements.saveCatalogItem.disabled = false;
    catalogItemSavePending = false;
    return;
  }
  elements.catalogItemStatus.textContent = activeCatalogItemId ? "Good updated" : "Good added";
  await loadBackendSnapshot({ silent: true });
  closeCatalogItemDialog();
  elements.storeOverviewSearch.value = result.item?.label || item.label;
  renderStoreOverview();
  renderCatalogLedger();
  elements.saveCatalogItem.disabled = false;
  catalogItemSavePending = false;
}

function catalogItemDraft(input) {
  const type = input.type === "material" ? "material" : input.type === "both" ? "both" : "product";
  const sellable = type === "product" || type === "both";
  return {
    type,
    name: String(input.name || "").trim(),
    label: String(input.label || input.name || "").trim(),
    tag: String(input.tag || "").trim(),
    category: String(input.category || (type === "material" ? "Materials" : type === "both" ? "Products and Materials" : "Products")).trim(),
    unit: String(input.unit || "unit").trim() || "unit",
    unitCost: input.unitCost === "" ? 0 : formNumber(input.unitCost),
    salePrice: sellable ? input.salePrice === "" ? 0 : formNumber(input.salePrice) : 0,
    target: sellable ? input.target === "" ? 0 : formNumber(input.target) : 0,
    storageTarget: input.storageTarget === "" ? 0 : formNumber(input.storageTarget),
    active: input.active !== false
  };
}

function validateCatalogItemDraft(item) {
  if (!item.name || !item.label) return "Enter a catalog name and display label";
  if (!item.category) return "Enter a category";
  if (![item.unitCost, item.salePrice, item.target, item.storageTarget].every(value => Number.isFinite(value) && value >= 0)) {
    return "Costs, prices, and targets must be zero or greater";
  }
  return "";
}

function formNumber(value) {
  const text = String(value ?? "").trim().replace(/\s+/g, "");
  if (!text) return 0;
  const normalized = text.includes(",") && !text.includes(".")
    ? text.replace(",", ".")
    : text.replace(/,/g, "");
  return Number(normalized);
}

function catalogGoods() {
  const shared = Array.isArray(backendSnapshot?.sheet?.catalog) ? backendSnapshot.sheet.catalog : [];
  if (shared.length) return shared.map(item => ({ ...item }));
  const goods = new Map();
  const addGoods = (items, fallbackType) => items.forEach(item => {
    const key = normalize(item.name || item.label);
    if (!key) return;
    const existing = goods.get(key) || {};
    const incomingType = item.itemType || fallbackType;
    const itemType = existing.itemType && existing.itemType !== incomingType
      ? "both"
      : incomingType || existing.itemType;
    goods.set(key, { ...existing, ...item, itemType });
  });
  addGoods(itemCatalog, "product");
  addGoods(ingredientCatalog, "material");
  return [...goods.values()];
}

function renderCatalogLedger() {
  const query = normalize(elements.catalogSearch.value);
  const goods = catalogGoods().sort((a, b) => String(a.label || a.name).localeCompare(String(b.label || b.name)));
  const visible = goods.filter(item => !query || [item.name, item.label, item.itemType, item.category, item.itemTag]
    .some(value => normalize(value).includes(query)));
  elements.catalogGoodsBody.innerHTML = visible.length ? visible.map(item => `
    <tr class="${item.active === false ? "catalog-inactive" : ""}">
      <td><strong>${escapeHtml(item.label || item.name)}</strong><small>${escapeHtml(item.name)}${item.itemTag ? ` / ${escapeHtml(item.itemTag)}` : ""}</small></td>
      <td>${escapeHtml(catalogRoleLabel(item.itemType))}</td>
      <td>${escapeHtml(item.category || "Uncategorized")}</td>
      <td>${formatCurrency(item.unitCost || 0)}</td>
      <td>${item.itemType === "material" ? "-" : formatCurrency(item.salePrice ?? item.price ?? 0)}</td>
      <td><button class="ghost-button" type="button" data-edit-catalog-good="${escapeHtml(item.id || item.name)}">Edit</button></td>
    </tr>
  `).join("") : '<tr><td colspan="6" class="empty-line">No goods match this search</td></tr>';
  elements.catalogDataStatus.textContent = backendSnapshot?.dataBackend === "postgresql"
    ? `${goods.length} goods / ${Object.keys(recipeCatalog).length} recipes in the shared catalog`
    : "Catalog editing requires the hosted database version";
  elements.recipeList.innerHTML = Object.keys(recipeCatalog).length
    ? Object.keys(recipeCatalog).sort((a, b) => a.localeCompare(b)).map(productName => `
        <button class="recipe-list-row ${normalize(activeRecipeProductName) === normalize(productName) ? "active" : ""}" type="button" data-recipe-product="${escapeHtml(productName)}">
          <strong>${escapeHtml(productLabel(productName))}</strong>
          <span>${formatNumber(recipeYieldCatalog[productName] || 1)} per production cycle / ${recipeCatalog[productName].length} ingredients</span>
        </button>
      `).join("")
    : '<div class="empty-card">No recipes have been entered</div>';
  renderRecipeProductOptions(elements.recipeProduct.value || activeRecipeProductName);
  if (!elements.recipeIngredientList.children.length) startNewRecipe();
}

function catalogRoleLabel(value) {
  return value === "both" ? "Product and material" : value === "product" ? "Product" : "Material";
}

function productLabel(productName) {
  const item = itemCatalog.find(candidate => normalize(candidate.name) === normalize(productName));
  return item?.label || productName;
}

function renderRecipeProductOptions(selected = "") {
  const products = itemCatalog.filter(item => item.active !== false).sort((a, b) => (a.label || a.name).localeCompare(b.label || b.name));
  elements.recipeProduct.innerHTML = '<option value="">Choose product</option>' + products.map(item => `
    <option value="${escapeHtml(item.name)}" ${normalize(item.name) === normalize(selected) ? "selected" : ""}>${escapeHtml(item.label || item.name)}</option>
  `).join("");
}

function startNewRecipe() {
  activeRecipeProductName = "";
  elements.recipeEditorForm.reset();
  elements.recipeProduct.disabled = false;
  elements.recipeYield.value = 1;
  elements.recipeIngredientList.innerHTML = "";
  renderRecipeProductOptions("");
  addRecipeIngredientRow();
  elements.recipeEditorTitle.textContent = "New Recipe";
  elements.recipeEditorMeta.textContent = "Select an output and add its ingredients";
  elements.recipeEditorStatus.textContent = "";
  elements.deleteRecipe.classList.add("hidden");
  renderCatalogLedgerListOnly();
}

function editRecipe(productName) {
  const key = Object.keys(recipeCatalog).find(name => normalize(name) === normalize(productName));
  if (!key) return;
  activeRecipeProductName = key;
  elements.recipeProduct.disabled = true;
  renderRecipeProductOptions(key);
  elements.recipeYield.value = Number(recipeYieldCatalog[key] || 1);
  elements.recipeIngredientList.innerHTML = "";
  recipeCatalog[key].forEach(([ingredient, quantity, sourceLocation]) => addRecipeIngredientRow({
    name: ingredient,
    quantity,
    sourceLocation
  }));
  elements.recipeEditorTitle.textContent = `Edit ${productLabel(key)}`;
  elements.recipeEditorMeta.textContent = `${recipeCatalog[key].length} ingredients / default sources saved with the recipe`;
  elements.recipeEditorStatus.textContent = "";
  elements.deleteRecipe.classList.remove("hidden");
  renderCatalogLedgerListOnly();
}

function renderCatalogLedgerListOnly() {
  elements.recipeList.querySelectorAll("[data-recipe-product]").forEach(button => {
    button.classList.toggle("active", normalize(button.dataset.recipeProduct) === normalize(activeRecipeProductName));
  });
}

function addRecipeIngredientRow(ingredient = {}) {
  const goods = catalogGoods().filter(item => item.active !== false).sort((a, b) => (a.label || a.name).localeCompare(b.label || b.name));
  const row = document.createElement("div");
  row.className = "recipe-ingredient-row";
  row.innerHTML = `
    <label>
      Good
      <select data-recipe-ingredient required>
        <option value="">Choose good</option>
        ${goods.map(item => `<option value="${escapeHtml(item.name)}" ${normalize(item.name) === normalize(ingredient.name) ? "selected" : ""}>${escapeHtml(item.label || item.name)} / ${escapeHtml(catalogRoleLabel(item.itemType))}</option>`).join("")}
      </select>
    </label>
    <label>
      Quantity
      <input data-recipe-quantity type="number" min="0.001" step="0.001" value="${escapeHtml(ingredient.quantity || 1)}" required>
    </label>
    <label>
      Take From
      <select data-recipe-source>
        <option value="Storage" ${normalizeProductionSourceClient(ingredient.sourceLocation) === "Storage" ? "selected" : ""}>Storage</option>
        <option value="Storefront" ${normalizeProductionSourceClient(ingredient.sourceLocation) === "Storefront" ? "selected" : ""}>Storefront</option>
      </select>
    </label>
    <button class="icon-button" type="button" data-remove-recipe-ingredient title="Remove ingredient" aria-label="Remove ingredient">&times;</button>
  `;
  elements.recipeIngredientList.append(row);
}

async function saveRecipe() {
  if (recipeSavePending || !isManagement()) return;
  if (backendSnapshot?.dataBackend !== "postgresql") {
    elements.recipeEditorStatus.textContent = "Recipe editing requires the hosted database version";
    return;
  }
  const ingredients = [...elements.recipeIngredientList.querySelectorAll(".recipe-ingredient-row")].map(row => ({
    name: row.querySelector("[data-recipe-ingredient]").value,
    quantity: Number(row.querySelector("[data-recipe-quantity]").value),
    sourceLocation: row.querySelector("[data-recipe-source]").value
  }));
  const recipe = {
    productName: elements.recipeProduct.value,
    yield: Number(elements.recipeYield.value),
    ingredients
  };
  if (!recipe.productName || !Number.isFinite(recipe.yield) || recipe.yield <= 0 || !ingredients.length
    || ingredients.some(ingredient => !ingredient.name || !Number.isFinite(ingredient.quantity) || ingredient.quantity <= 0)) {
    elements.recipeEditorStatus.textContent = "Choose a product and complete every ingredient line";
    return;
  }
  if (new Set(ingredients.map(ingredient => normalize(ingredient.name))).size !== ingredients.length) {
    elements.recipeEditorStatus.textContent = "Each good can only appear once in a recipe";
    return;
  }
  recipeSavePending = true;
  elements.saveRecipe.disabled = true;
  elements.recipeEditorStatus.textContent = "Saving recipe...";
  const result = await syncToBackend("recipe_upsert", { recipe });
  if (!result.ok) {
    elements.recipeEditorStatus.textContent = result.error || "Recipe could not be saved";
  } else {
    activeRecipeProductName = recipe.productName;
    await loadBackendSnapshot({ silent: true });
    editRecipe(recipe.productName);
    elements.recipeEditorStatus.textContent = "Recipe saved";
  }
  recipeSavePending = false;
  elements.saveRecipe.disabled = false;
}

async function deleteActiveRecipe() {
  if (!activeRecipeProductName || recipeSavePending || !isManagement()) return;
  if (!window.confirm(`Remove the recipe for ${productLabel(activeRecipeProductName)}? Existing production batches will keep their saved copy.`)) return;
  recipeSavePending = true;
  elements.deleteRecipe.disabled = true;
  const result = await syncToBackend("recipe_delete", { recipe: { productName: activeRecipeProductName } });
  if (!result.ok) {
    elements.recipeEditorStatus.textContent = result.error || "Recipe could not be removed";
  } else {
    await loadBackendSnapshot({ silent: true });
    startNewRecipe();
  }
  recipeSavePending = false;
  elements.deleteRecipe.disabled = false;
}

function normalizeProductionSourceClient(value) {
  const key = normalize(value);
  return key === "sales" || key.includes("store") ? "Storefront" : "Storage";
}

function renderStoreOverview() {
  const storefrontCounts = getLatestCounts("Storefront");
  const storageCounts = getLatestCounts("Storage");
  const query = normalize(elements.storeOverviewSearch.value);
  const targetByKey = new Map(stockTargets
    .filter(target => !target.deleting)
    .map(target => [inventoryOverviewKey(target), Number(target.target || 0)]));
  const storageTargetByKey = new Map(storageTargets
    .filter(target => !target.deleting)
    .map(target => [inventoryOverviewKey(target), Number(target.target || 0)]));
  const storefrontRows = buildInventoryOverviewRows([...itemCatalog, ...ingredientCatalog], storefrontCounts, "Storefront")
    .map(row => ({ ...row, target: targetByKey.get(row.key) || 0 }));
  const storageRows = buildInventoryOverviewRows([...ingredientCatalog, ...itemCatalog], storageCounts, "Storage")
    .map(row => ({ ...row, target: storageTargetByKey.get(row.key) || 0 }));
  const visibleStorefront = filterInventoryOverviewRows(storefrontRows, query);
  const visibleStorage = filterInventoryOverviewRows(storageRows, query);

  elements.storefrontOverviewUnits.textContent = formatNumber(sumInventoryCounts(storefrontCounts));
  elements.storageOverviewUnits.textContent = formatNumber(sumInventoryCounts(storageCounts));
  const storefrontValuation = calculateInventoryValuation("Storefront", storefrontCounts);
  const storageValuation = calculateInventoryValuation("Storage", storageCounts);
  elements.storefrontOverviewValue.textContent = formatCurrency(storefrontValuation.total);
  elements.storageOverviewValue.textContent = formatCurrency(storageValuation.total);
  elements.storefrontOverviewValueDetail.textContent = valuationDetail(storefrontValuation, "At recorded sell prices");
  elements.storageOverviewValueDetail.textContent = valuationDetail(storageValuation, "At recorded costs", true);
  elements.storefrontOverviewCount.textContent = inventoryLineCountText(visibleStorefront.length, storefrontRows.length, query);
  elements.storageOverviewCount.textContent = inventoryLineCountText(visibleStorage.length, storageRows.length, query);
  elements.storefrontOverviewBody.innerHTML = renderInventoryOverviewRows(visibleStorefront, true);
  elements.storageOverviewBody.innerHTML = renderInventoryOverviewRows(visibleStorage, true);
  wireProductCardRows();
  if (activeProductCardKey) renderProductCard();

  const sheetGeneratedAt = backendSnapshot?.sheet?.generatedAt;
  elements.storeOverviewMeta.textContent = sheetGeneratedAt
    ? `Shared counts as of ${formatDateTime(sheetGeneratedAt)}`
    : "Shared database snapshot unavailable / local counts shown";

  const ledger = window.FRONTIER_INVENTORY_COUNTS.selectCurrentLedger({
    ledger: backendSnapshot?.sheet?.inventory?.ledger,
    operations,
    snapshotGeneratedAt: sheetGeneratedAt
  });
  if (!ledger.available) {
    elements.ledgerOverviewBalance.textContent = "Unavailable";
    const sheetError = backendSnapshot?.sheet?.error;
    const inventory = backendSnapshot?.sheet?.inventory;
    elements.ledgerOverviewDetail.textContent = sheetError
    ? `Shared data sync failed: ${sheetError}`
      : inventory && !Object.prototype.hasOwnProperty.call(inventory, "ledger")
      ? "The shared data backend does not expose ledger data"
        : "Awaiting a shared ledger count";
    return;
  }

  elements.ledgerOverviewBalance.textContent = formatCurrency(ledger.balance);
  const movement = Number(ledger.netMovementSinceCount || 0);
  const movementText = `${movement >= 0 ? "+" : "-"}${formatCurrency(Math.abs(movement))}`;
  elements.ledgerOverviewDetail.textContent = ledger.countedAt
    ? `Counted ${formatDateTime(ledger.countedAt)} / ${movementText} since count`
    : `Recorded cash movement ${movementText}`;
}

function wireProductCardRows() {
  document.querySelectorAll("[data-product-key]").forEach(row => {
    const open = () => openProductCard(row.dataset.productKey);
    row.addEventListener("click", open);
    row.addEventListener("keydown", event => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      open();
    });
  });
}

function openProductCard(productKey) {
  const item = catalogProductFor(productKey);
  if (!item) return;
  activeProductCardKey = normalize(item.name);
  elements.productCardPanel.classList.remove("hidden");
  renderProductCard();
  document.querySelectorAll("[data-product-key]").forEach(row => {
    row.classList.toggle("selected", row.dataset.productKey === activeProductCardKey);
  });
  loadProductInsight(item);
  if (window.matchMedia("(max-width: 980px)").matches) {
    elements.productCardPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function closeProductCard() {
  activeProductCardKey = "";
  productInsightRequestId += 1;
  elements.productCardPanel.classList.add("hidden");
  document.querySelectorAll("[data-product-key].selected").forEach(row => row.classList.remove("selected"));
}

function renderProductCard() {
  const item = catalogProductFor(activeProductCardKey);
  if (!item) {
    elements.productCardPanel.classList.add("hidden");
    return;
  }

  const recipe = Array.isArray(recipeCatalog[item.name]) ? recipeCatalog[item.name] : [];
  const hasRecipe = recipe.length > 0;
  const yieldQuantity = recipeYield(item.name);
  const storefront = Number(getLatestCounts("Storefront").get(inventoryOverviewKey(item)) || 0);
  const storageCounts = getLatestCounts("Storage");
  const storage = Number(storageCounts.get(inventoryOverviewKey(item)) || 0);
  const target = stockTargets.find(entry => !entry.deleting && inventoryOverviewKey(entry) === inventoryOverviewKey(item));
  const storageTarget = storageTargets.find(entry => !entry.deleting && inventoryOverviewKey(entry) === inventoryOverviewKey(item));
  const retailPrice = Number(item.price || 0);
  const productPricing = pricingCatalog.products?.[item.name];
  const ingredients = recipe.map(([ingredient, quantity, source]) => {
    const pricing = pricingCatalog.materials?.[ingredient];
    const unitCost = Number(pricing?.midpoint || 0);
    const sourceLocation = normalizeProductionSourceClient(source);
    return {
      ingredient,
      quantity: Number(quantity || 0),
      sourceLocation,
      unitCost,
      costKnown: Boolean(pricing),
      available: Number(getLatestCounts(sourceLocation).get(inventoryOverviewKey({ ingredient })) || 0)
    };
  });
  const costKnown = ingredients.length > 0 && ingredients.every(ingredient => ingredient.costKnown);
  const batchCost = ingredients.reduce((sum, ingredient) => sum + ingredient.quantity * ingredient.unitCost, 0);
  const unitCost = yieldQuantity ? batchCost / yieldQuantity : batchCost;
  const unitProfit = retailPrice > 0 && costKnown ? retailPrice - unitCost : null;
  const margin = unitProfit !== null && retailPrice > 0 ? (unitProfit / retailPrice) * 100 : null;

  elements.productCardCategory.textContent = item.category || "Product Record";
  elements.productCardTitle.textContent = item.label || item.name;
  elements.productCardMeta.textContent = item.tag
    ? `${item.name} / ${item.tag}`
    : item.name;
  const insight = productInsightCache.get(activeProductCardKey);
  const managementPricing = isManagement() ? `
    <div><dt>MSRP range</dt><dd>${productPricing ? `${formatCurrency(productPricing.low)}-${formatCurrency(productPricing.high)}` : "Unavailable"}</dd></div>
    <div><dt>MSRP material cost</dt><dd>${costKnown ? `${formatCurrency(unitCost)} / unit` : "Unavailable"}</dd></div>
        <div><dt>Est. gross / unit</dt><dd class="${unitProfit !== null && unitProfit < 0 ? "negative" : ""}">${unitProfit === null ? "Unavailable" : formatCurrency(unitProfit)}</dd></div>
    <div><dt>Est. gross margin</dt><dd>${margin === null ? "Unavailable" : `${formatNumber(margin)}%`}</dd></div>
  ` : "";
  const salesSection = isManagement() ? renderProductSalesInsight(insight) : "";
  const recipeRows = ingredients.length
    ? ingredients.map(ingredient => `
      <div class="product-recipe-row ${ingredient.available < ingredient.quantity ? "short" : ""}">
        <div><strong>${escapeHtml(ingredient.ingredient)}</strong><span>${formatNumber(ingredient.available)} in ${escapeHtml(ingredient.sourceLocation.toLowerCase())}</span></div>
        <span>${formatNumber(ingredient.quantity)} needed</span>
        ${isManagement() ? `<span>${ingredient.costKnown ? formatCurrency(ingredient.quantity * ingredient.unitCost) : "Unpriced"}</span>` : ""}
      </div>
    `).join("")
    : `<div class="empty-card">No recipe recorded</div>`;
  const image = item.image ? `
    <img class="product-card-image" src="${escapeHtml(item.image)}" alt="${escapeHtml(item.label || item.name)}">
  ` : "";
  const wiki = item.wikiUrl ? `
    <a class="product-card-link" href="${escapeHtml(item.wikiUrl)}" target="_blank" rel="noreferrer">Open reference</a>
  ` : "";

  elements.productCardBody.innerHTML = `
    ${image}
    <dl class="product-card-stock">
      <div><dt>Storefront</dt><dd>${formatNumber(storefront)}</dd></div>
      <div><dt>Storage</dt><dd>${formatNumber(storage)}</dd></div>
      <div><dt>Store Target</dt><dd>${target ? formatNumber(target.target) : "-"}</dd></div>
      <div><dt>Storage Target</dt><dd>${storageTarget ? formatNumber(storageTarget.target) : "-"}</dd></div>
    </dl>
    <section class="product-card-section">
      <h3>${isManagement() ? "Price and Cost" : "Price"}</h3>
      <dl class="product-card-facts">
        <div><dt>Store price</dt><dd>${retailPrice > 0 ? formatCurrency(retailPrice) : "Not priced"}</dd></div>
        <div><dt>Recipe yield</dt><dd>${hasRecipe ? formatNumber(yieldQuantity) : "-"}</dd></div>
        ${managementPricing}
      </dl>
    </section>
    <section class="product-card-section">
      <div class="product-card-section-heading"><h3>Recipe</h3>${isManagement() ? `<span>${costKnown ? `${formatCurrency(batchCost)} / batch` : "Cost incomplete"}</span>` : ""}</div>
      <div class="product-recipe-list">${recipeRows}</div>
    </section>
    ${salesSection}
    ${wiki}
  `;
}

function renderProductSalesInsight(insight) {
  if (!insight || insight.status === "loading") {
    return `<section class="product-card-section"><h3>Recorded Sales</h3><p class="product-card-status">Loading sales history</p></section>`;
  }
  if (insight.status === "error") {
    return `<section class="product-card-section"><h3>Recorded Sales</h3><p class="product-card-status">${escapeHtml(insight.error || "Sales history unavailable")}</p></section>`;
  }
  const sales = insight.data?.sales || {};
  const channels = Array.isArray(sales.channels) ? sales.channels : [];
  return `
    <section class="product-card-section">
      <div class="product-card-section-heading"><h3>Recorded Sales</h3><span>All history</span></div>
      <dl class="product-card-facts product-sales-facts">
      <div><dt>Revenue</dt><dd>${formatCurrency(sales.revenue || 0)}</dd></div>
        <div><dt>Transactions</dt><dd>${formatNumber(sales.transactions || 0)}</dd></div>
      <div><dt>Average ticket</dt><dd>${formatCurrency(sales.averageTransaction || 0)}</dd></div>
      </dl>
      ${channels.length ? `<div class="product-sales-channels">${channels.map(channel => `
        <div><span>${escapeHtml(channel.category)}</span><strong>${formatCurrency(channel.revenue)} / ${formatNumber(channel.transactions)}</strong></div>
      `).join("")}</div>` : `<p class="product-card-status">No recorded sales yet</p>`}
    </section>
  `;
}

async function loadProductInsight(item) {
  if (!isManagement()) return;
  const key = normalize(item.name);
  const cached = productInsightCache.get(key);
  if (cached?.status === "ready" && Date.now() - cached.fetchedAt < 60000) return;
  const requestId = ++productInsightRequestId;
  productInsightCache.set(key, { status: "loading" });
  if (activeProductCardKey === key) renderProductCard();
  try {
    const response = await fetch(`/api/product-insights/${encodeURIComponent(item.name)}`, {
      headers: { accept: "application/json" }
    });
    const result = await response.json().catch(() => ({ ok: false, error: `API ${response.status}` }));
    if (!response.ok || !result.ok) throw new Error(result.error || `API ${response.status}`);
    productInsightCache.set(key, { status: "ready", data: result, fetchedAt: Date.now() });
  } catch (error) {
    productInsightCache.set(key, { status: "error", error: error.message, fetchedAt: Date.now() });
  }
  if (requestId === productInsightRequestId && activeProductCardKey === key) renderProductCard();
}

function setFinancePeriod(preset, refresh = true) {
  const now = new Date();
  let from = elements.financeFrom.value;
  let to = elements.financeTo.value;
  if (preset === "month") {
    from = localDateKey(new Date(now.getFullYear(), now.getMonth(), 1));
    to = localDateKey(new Date(now.getFullYear(), now.getMonth() + 1, 0));
  } else if (preset === "last-month") {
    from = localDateKey(new Date(now.getFullYear(), now.getMonth() - 1, 1));
    to = localDateKey(new Date(now.getFullYear(), now.getMonth(), 0));
  } else if (preset === "year") {
    from = `${now.getFullYear()}-01-01`;
    to = `${now.getFullYear()}-12-31`;
  } else if (preset === "all") {
    from = "";
    to = "";
  }
  elements.financePeriod.value = preset;
  elements.financeFrom.value = from;
  elements.financeTo.value = to;
  if (refresh && currentUser && activeSection === "finance" && isAdmin()) loadFinance();
}

async function loadFinance({ silent = false } = {}) {
  if (!isAdmin() || financeLoading) return false;
  const from = elements.financeFrom.value;
  const to = elements.financeTo.value;
  if (from && to && from > to) {
    elements.financeDataStatus.textContent = "The start date must be before the end date";
    return false;
  }

  financeLoading = true;
  elements.refreshFinance.disabled = true;
  elements.reconcileFinance.disabled = true;
  if (!silent || !financeSnapshot) elements.financeDataStatus.textContent = "Balancing the shared accounts";
  try {
    const parameters = new URLSearchParams();
    if (from) parameters.set("from", from);
    if (to) parameters.set("to", to);
    const response = await fetch(`/api/finance${parameters.size ? `?${parameters}` : ""}`, {
      headers: { accept: "application/json" }
    });
    if (response.status === 401) {
      window.location.replace("/login.html");
      return false;
    }
    const result = await response.json().catch(() => ({ ok: false, error: `API ${response.status}` }));
    if (!response.ok || !result.ok) throw new Error(result.error || `API ${response.status}`);
    financeSnapshot = result;
    renderFinance();
    const period = result.period?.from || result.period?.to
      ? `${result.period.from ? formatDelivery(result.period.from) : "Beginning"} to ${result.period.to ? formatDelivery(result.period.to) : "Today"}`
      : "All recorded activity";
    elements.financeDataStatus.textContent = `${period} / refreshed ${formatDateTime(result.generatedAt)}`;
    return true;
  } catch (error) {
    elements.financeDataStatus.textContent = `Finance unavailable: ${error.message}`;
    return false;
  } finally {
    financeLoading = false;
    elements.refreshFinance.disabled = false;
    elements.reconcileFinance.disabled = false;
  }
}

function renderFinance() {
  if (!financeSnapshot || !elements.financeSection) return;
  const totals = financeSnapshot.totals || {};
  const balances = financeSnapshot.balances || {};
  const cash = financeSnapshot.cash || {};
  const commitments = financeSnapshot.commitments || {};
  const coverage = financeSnapshot.coverage || {};

  elements.financeRevenue.textContent = formatFinanceCurrency(totals.revenue);
  elements.financeExpense.textContent = formatFinanceCurrency(totals.expenses);
  elements.financeProfit.textContent = formatFinanceCurrency(totals.profit);
  elements.financeProfit.closest(".finance-profit-cell")?.classList.toggle("loss", Number(totals.profit || 0) < 0);
  elements.financeLedger.textContent = formatFinanceAvailableCurrency(cash.ledgerBalance);
  elements.financeSafekeeping.textContent = formatFinanceCurrency(cash.safekeepingHeld);
  elements.financeBusinessCash.textContent = formatFinanceAvailableCurrency(cash.businessCash);
  elements.financeCommitted.textContent = formatFinanceCurrency(cash.committed);
  elements.financeAvailable.textContent = formatFinanceAvailableCurrency(cash.availableAfterCommitments);
  elements.financeAvailable.closest(".finance-available-cell")?.classList.toggle("short", Number(cash.availableAfterCommitments) < 0);
  elements.financeOwnerCapital.textContent = formatFinanceCurrency(balances.ownerCapital);
  elements.financeOwnerCapitalDetail.textContent = `${formatFinanceCurrency(balances.ownerCapitalDeposits)} deposited / ${formatFinanceCurrency(balances.ownerWithdrawals)} withdrawn`;
  elements.financeCoverageStatus.textContent = [
    `${formatNumber(coverage.storefrontSales || 0)} storefront sales`,
    `${formatNumber(coverage.storefrontPurchases || 0)} storefront purchases`,
    `${formatNumber(coverage.buyOrdersReviewed || 0)} buy orders reviewed`,
    `${formatNumber(coverage.manualEntries || 0)} manual entries`,
    `${formatNumber(coverage.supplierReceipts || 0)} supplier receipts`,
    `${formatNumber(coverage.payrollPayments || 0)} payroll payments`,
    `${formatNumber(coverage.ownerFundEntries || 0)} owner-fund entries`
  ].join(" / ");

  elements.financeSupplyCommitment.textContent = formatFinanceCurrency(commitments.supplyOrders);
  elements.financeSupplyCommitmentDetail.textContent = `${(commitments.supplyLines || []).length} remaining ${(commitments.supplyLines || []).length === 1 ? "line" : "lines"}`;
  elements.financeBuyCommitment.textContent = formatFinanceCurrency(commitments.storefrontBuyOrders);
  elements.financeBuyCommitmentDetail.textContent = `${(commitments.buyOrderLines || []).length} open ${(commitments.buyOrderLines || []).length === 1 ? "order" : "orders"}`;
  elements.financeRestockCommitment.textContent = formatFinanceCurrency(commitments.missingStock);
  const restockCount = (commitments.restockLines || []).length;
  const unpriced = Number(commitments.unpricedLines || 0);
  const missingRecipes = (commitments.missingProducts || []).filter(product => !product.recipeAvailable);
  elements.financeRestockCommitmentDetail.textContent = `${restockCount} material ${restockCount === 1 ? "shortage" : "shortages"}${unpriced ? ` / ${unpriced} awaiting a price` : ""}${missingRecipes.length ? ` / ${missingRecipes.length} without a recipe` : ""}`;
  elements.financeSupplyCommitmentList.innerHTML = renderFinanceCommitmentLines(commitments.supplyLines, "supplier");
  elements.financeBuyCommitmentList.innerHTML = renderFinanceCommitmentLines(commitments.buyOrderLines, "buy-order");
  const restockLines = commitments.restockLines || [];
  elements.financeRestockCommitmentList.innerHTML = [
    restockLines.length || !missingRecipes.length ? renderFinanceCommitmentLines(restockLines, "restock") : "",
    ...missingRecipes.map(product => `
      <div class="finance-detail-row">
        <span>${escapeHtml(product.label)}</span>
        <small>${formatNumber(product.quantity)} needed / recipe required for costing</small>
        <strong>Unpriced</strong>
      </div>
    `)
  ].join("");
  renderFinanceBreakdown();
  renderFinanceMonthly();
}

function renderFinanceCommitmentLines(lines = [], type) {
  if (!lines.length) return `<div class="empty-card">Nothing committed here</div>`;
  return lines.map(line => {
    const context = type === "supplier"
      ? `${line.producer || "Supplier"} / ${formatNumber(line.quantity)} at ${formatFinanceCurrency(line.unitPrice)}`
      : type === "buy-order"
        ? `${formatNumber(line.quantity)} remaining at ${formatFinanceCurrency(line.unitPrice)}`
        : `${formatNumber(line.quantity)} needed${Number(line.unitPrice || 0) ? ` at ${formatFinanceCurrency(line.unitPrice)}` : " / price needed"}`;
    return `
      <div class="finance-detail-row">
        <span>${escapeHtml(line.label || "Unlabelled line")}</span>
        <small>${escapeHtml(context)}</small>
        <strong>${formatFinanceCurrency(line.amount)}</strong>
      </div>
    `;
  }).join("");
}

function renderFinanceBreakdown() {
  if (!elements.financeBreakdownBody) return;
  const filter = elements.financeBreakdownFilter.value || "All";
  const rows = (financeSnapshot?.breakdown || []).filter(row => filter === "All" || row.type === filter);
  if (!rows.length) {
    elements.financeBreakdownBody.innerHTML = `<tr><td colspan="5" class="empty-line">No matching entries in this period</td></tr>`;
    return;
  }
  elements.financeBreakdownBody.innerHTML = rows.map(row => `
    <tr>
      <td><span class="status-pill ${normalize(row.type)}">${escapeHtml(row.type)}</span></td>
      <td><strong>${escapeHtml(row.category)}</strong><span>${escapeHtml(row.source || "Shared ledger")}</span></td>
      <td>${escapeHtml(row.label || row.category)}</td>
      <td>${formatNumber(row.count)}</td>
      <td>${formatFinanceCurrency(row.amount)}</td>
    </tr>
  `).join("");
}

function renderFinanceMonthly() {
  const rows = [...(financeSnapshot?.monthly || [])].sort((a, b) => b.month.localeCompare(a.month));
  if (!rows.length) {
    elements.financeMonthlyBody.innerHTML = `<tr><td colspan="4" class="empty-line">No monthly results in this period</td></tr>`;
    return;
  }
  elements.financeMonthlyBody.innerHTML = rows.map(row => `
    <tr>
      <td><strong>${escapeHtml(formatFinanceMonth(row.month))}</strong></td>
      <td>${formatFinanceCurrency(row.revenue)}</td>
      <td>${formatFinanceCurrency(row.expenses)}</td>
      <td class="${Number(row.profit || 0) < 0 ? "metric-short" : ""}">${formatFinanceCurrency(row.profit)}</td>
    </tr>
  `).join("");
}

async function recordFinanceFunds() {
  if (currentRole !== "admin" || financeLoading) return;
  const amount = Number(elements.financeFundsAmount.value || 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    elements.financeFundsStatus.textContent = "Enter an amount greater than zero";
    elements.financeFundsAmount.focus();
    return;
  }
  elements.saveFinanceFunds.disabled = true;
  elements.financeFundsStatus.textContent = "Writing the entry to the shared ledger";
  const result = await addOperation({
    kind: elements.financeFundsType.value,
    location: "Ledger",
    itemName: "",
    itemLabel: "",
    itemTag: "",
    quantity: "",
    employee: currentUser.fullName,
    amount,
    note: elements.financeFundsNote.value.trim()
  });
  if (!result?.ok) {
    elements.financeFundsStatus.textContent = `Saved locally; data sync pending${result?.error ? `: ${result.error}` : ""}`;
    elements.saveFinanceFunds.disabled = false;
    return;
  }
  elements.financeFundsAmount.value = "0";
  elements.financeFundsNote.value = "";
  elements.financeFundsStatus.textContent = "Recorded in the shared ledger";
  await loadBackendSnapshot({ silent: true });
  await loadFinance();
  elements.saveFinanceFunds.disabled = false;
}

function formatFinanceMonth(value) {
  const date = new Date(`${value}-01T00:00:00`);
  return Number.isNaN(date.getTime())
    ? String(value || "")
    : new Intl.DateTimeFormat(businessProfile.locale || "en-US", {
      month: "long",
      year: "numeric",
      timeZone: businessProfile.timezone || "UTC"
    }).format(date);
}

function formatFinanceAvailableCurrency(value) {
  return Number.isFinite(value) ? formatFinanceCurrency(value) : "Unavailable";
}

function formatFinanceCurrency(value) {
  return formatCurrency(value);
}

function updateDailyCloseFromInputs() {
  activeDailyClose.businessDate = elements.dailyCloseBusinessDate.value;
  activeDailyClose.countedLedgerBalance = elements.dailyCloseLedgerCount.value === ""
    ? null
    : Number(elements.dailyCloseLedgerCount.value);
  activeDailyClose.storefrontConfirmed = elements.dailyCloseStorefrontConfirmed.checked;
  activeDailyClose.storageConfirmed = elements.dailyCloseStorageConfirmed.checked;
  activeDailyClose.discrepancyNotes = elements.dailyCloseDiscrepancy.value;
  activeDailyClose.priorityNotes = elements.dailyClosePriority.value;
  activeDailyClose.handoffNotes = elements.dailyCloseHandoff.value;
}

async function saveDailyClose({ silent = false } = {}) {
  if (!isManagement() || dailyCloseActionPending) return false;
  updateDailyCloseFromInputs();
  dailyCloseActionPending = true;
  elements.saveDocument.disabled = true;
  if (!silent) elements.dailyCloseDataStatus.textContent = "Refreshing the shared snapshot and saving draft";
  try {
    const response = await fetch("/api/daily-closes", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(activeDailyClose)
    });
    const result = await response.json().catch(() => ({ ok: false, error: `API ${response.status}` }));
    if (!response.ok || !result.ok) {
      const error = new Error(result.error || `API ${response.status}`);
      error.code = result.code || "daily_close_save_failed";
      throw error;
    }
    applyDailyCloseResult(result);
    dailyCloseDirty = false;
    elements.dailyCloseDataStatus.textContent = `Draft saved ${formatDateTime(activeDailyClose.updatedAt)} by ${activeDailyClose.updatedBy}`;
    return true;
  } catch (error) {
    elements.dailyCloseDataStatus.textContent = `Save failed: ${error.message}`;
    if (error.code === "daily_close_conflict" || error.code === "daily_close_date_exists") {
      await refreshDailyCloses({ preserveActive: true }).catch(() => {});
    }
    return false;
  } finally {
    dailyCloseActionPending = false;
    elements.saveDocument.disabled = false;
    renderDailyCloseWorkspace();
  }
}

async function finalizeActiveDailyClose() {
  if (!isManagement() || dailyCloseActionPending || activeDailyClose.status === "Finalized") return;
  if (!await saveDailyClose({ silent: true })) return;
  if (!window.confirm(`Finalize the daily close for ${formatDelivery(activeDailyClose.businessDate)}? It will be locked after signing.`)) return;
  dailyCloseActionPending = true;
  try {
    const response = await fetch(`/api/daily-closes/${encodeURIComponent(activeDailyClose.id)}/finalize`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ revision: activeDailyClose.revision })
    });
    const result = await response.json().catch(() => ({ ok: false, error: `API ${response.status}` }));
    if (!response.ok || !result.ok) throw new Error(result.error || `API ${response.status}`);
    applyDailyCloseResult(result);
    dailyCloseDirty = false;
    elements.dailyCloseDataStatus.textContent = `Finalized ${formatDateTime(activeDailyClose.finalizedAt)} by ${activeDailyClose.finalizedBy}`;
  } catch (error) {
    elements.dailyCloseDataStatus.textContent = `Finalize failed: ${error.message}`;
  } finally {
    dailyCloseActionPending = false;
    renderDailyCloseWorkspace();
    renderLatestHandoff();
  }
}

async function reopenActiveDailyClose() {
  if (currentRole !== "admin" || dailyCloseActionPending || activeDailyClose.status !== "Finalized") return;
  if (!window.confirm(`Reopen the signed close for ${formatDelivery(activeDailyClose.businessDate)}?`)) return;
  dailyCloseActionPending = true;
  try {
    const response = await fetch(`/api/daily-closes/${encodeURIComponent(activeDailyClose.id)}/reopen`, {
      method: "POST",
      headers: { accept: "application/json" }
    });
    const result = await response.json().catch(() => ({ ok: false, error: `API ${response.status}` }));
    if (!response.ok || !result.ok) throw new Error(result.error || `API ${response.status}`);
    applyDailyCloseResult(result);
    dailyCloseDirty = false;
    elements.dailyCloseDataStatus.textContent = `Reopened ${formatDateTime(activeDailyClose.updatedAt)} by ${activeDailyClose.updatedBy}`;
  } catch (error) {
    elements.dailyCloseDataStatus.textContent = `Reopen failed: ${error.message}`;
  } finally {
    dailyCloseActionPending = false;
    renderDailyCloseWorkspace();
    renderLatestHandoff();
  }
}

function applyDailyCloseResult(result) {
  dailyCloses = Array.isArray(result.closes) ? result.closes : dailyCloses;
  if (result.close) activeDailyClose = structuredClone(result.close);
  renderDailyCloseWorkspace();
  renderLatestHandoff();
}

async function refreshDailyCloses({ preserveActive = false } = {}) {
  const response = await fetch("/api/daily-closes", { headers: { accept: "application/json" } });
  const result = await response.json().catch(() => ({ ok: false, error: `API ${response.status}` }));
  if (!response.ok || !result.ok) throw new Error(result.error || `API ${response.status}`);
  dailyCloses = Array.isArray(result.closes) ? result.closes : [];
  if (!preserveActive && !dailyCloseDirty) {
    const refreshed = dailyCloses.find(close => close.id === activeDailyClose.id)
      || dailyCloses.find(close => close.businessDate === todayKey());
    if (refreshed) activeDailyClose = structuredClone(refreshed);
  }
  renderDailyCloseWorkspace();
  renderLatestHandoff();
}

function loadDailyClose(closeId) {
  const close = dailyCloses.find(candidate => candidate.id === closeId);
  if (!close) return;
  activeDailyClose = structuredClone(close);
  dailyCloseDirty = false;
  renderDailyCloseWorkspace();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderDailyCloseWorkspace() {
  if (!elements.dailyCloseSection) return;
  const snapshot = activeDailyClose.revision > 0 ? activeDailyClose.snapshot : buildDailyClosePreview();
  const finalized = activeDailyClose.status === "Finalized";
  elements.dailyCloseBusinessDate.value = activeDailyClose.businessDate || todayKey();
  elements.dailyCloseLedgerCount.value = activeDailyClose.countedLedgerBalance === null ? "" : activeDailyClose.countedLedgerBalance;
  elements.dailyCloseStorefrontConfirmed.checked = Boolean(activeDailyClose.storefrontConfirmed);
  elements.dailyCloseStorageConfirmed.checked = Boolean(activeDailyClose.storageConfirmed);
  elements.dailyCloseDiscrepancy.value = activeDailyClose.discrepancyNotes || "";
  elements.dailyClosePriority.value = activeDailyClose.priorityNotes || "";
  elements.dailyCloseHandoff.value = activeDailyClose.handoffNotes || "";
  elements.dailyCloseStatus.textContent = activeDailyClose.status;
  elements.dailyCloseStatus.className = `status-pill ${statusClass(activeDailyClose.status)}`;
  elements.dailyCloseStorefrontUnits.textContent = formatAvailableNumber(snapshot.storefrontUnits);
  elements.dailyCloseStorageUnits.textContent = formatAvailableNumber(snapshot.storageUnits);
  elements.dailyCloseSystemLedger.textContent = formatAvailableCurrency(snapshot.ledgerBalance);
  elements.dailyCloseOpenSales.textContent = formatNumber(snapshot.openSalesOrders);
  elements.dailyCloseActiveProduction.textContent = formatNumber(snapshot.activeProductionBatches);
  elements.dailyCloseIssueCount.textContent = formatNumber(snapshot.issues?.length || 0);
  elements.dailyCloseEditMeta.textContent = finalized
    ? `Signed ${formatDateTime(activeDailyClose.finalizedAt)} by ${activeDailyClose.finalizedBy}`
    : activeDailyClose.revision > 0
      ? `Shared revision ${activeDailyClose.revision} / saved by ${activeDailyClose.updatedBy}`
      : "Unsaved draft / live preview";
  elements.dailyCloseDataStatus.textContent = finalized
    ? `Finalized for ${formatDelivery(activeDailyClose.businessDate)} / snapshot ${formatDateTime(snapshot.capturedAt)}`
    : elements.dailyCloseDataStatus.textContent || "Draft is ready";

  [
    elements.dailyCloseBusinessDate,
    elements.dailyCloseLedgerCount,
    elements.dailyCloseStorefrontConfirmed,
    elements.dailyCloseStorageConfirmed,
    elements.dailyCloseDiscrepancy,
    elements.dailyClosePriority,
    elements.dailyCloseHandoff
  ].forEach(field => { field.disabled = finalized || dailyCloseActionPending; });
  elements.finalizeDailyClose.disabled = finalized || dailyCloseActionPending;
  elements.reopenDailyClose.disabled = !finalized || dailyCloseActionPending;
  elements.saveDocument.disabled = finalized || dailyCloseActionPending;
  renderDailyCloseDifference(snapshot);
  renderDailyCloseIssues(snapshot);
  renderDailyCloseHistory();
}

function renderDailyCloseDifference(snapshot = activeDailyClose.revision > 0 ? activeDailyClose.snapshot : buildDailyClosePreview()) {
  const counted = activeDailyClose.countedLedgerBalance;
  const system = snapshot?.ledgerBalance;
  if (!Number.isFinite(counted) || !Number.isFinite(system)) {
    elements.dailyCloseLedgerDifference.textContent = "Unavailable";
    elements.dailyCloseLedgerDifference.classList.remove("short");
    return;
  }
  const difference = counted - system;
  elements.dailyCloseLedgerDifference.textContent = `${difference >= 0 ? "+" : "-"}${formatCurrency(Math.abs(difference))}`;
  elements.dailyCloseLedgerDifference.classList.toggle("short", Math.abs(difference) >= 0.005);
}

function renderDailyCloseIssues(snapshot) {
  const issues = Array.isArray(snapshot?.issues) ? snapshot.issues : [];
  elements.dailyCloseIssueList.innerHTML = issues.length
    ? issues.map(issue => `
      <div class="daily-close-issue">
        <span>${escapeHtml(issue.type || "Open Item")}</span>
        <strong>${escapeHtml(issue.label)}</strong>
        <small>${escapeHtml(issue.detail || "")}</small>
      </div>
    `).join("")
    : `<div class="empty-card">No open issues in this snapshot</div>`;
}

function renderDailyCloseHistory() {
  elements.dailyCloseHistoryCount.textContent = `${dailyCloses.length} shared ${dailyCloses.length === 1 ? "record" : "records"}`;
  elements.dailyCloseHistoryList.innerHTML = dailyCloses.length
    ? dailyCloses.map(close => `
      <button class="daily-close-history-entry ${close.id === activeDailyClose.id ? "selected" : ""}" type="button" data-daily-close-id="${escapeHtml(close.id)}">
        <span class="status-pill ${statusClass(close.status)}">${escapeHtml(close.status)}</span>
        <strong>${escapeHtml(formatDelivery(close.businessDate))}</strong>
        <small>${escapeHtml(close.finalizedBy ? `Signed by ${close.finalizedBy}` : `Updated by ${close.updatedBy || close.createdBy}`)}</small>
        <span>${formatNumber(close.snapshot?.issues?.length || 0)} open items / ${formatAvailableCurrency(close.snapshot?.ledgerBalance)}</span>
      </button>
    `).join("")
    : `<div class="empty-card">No daily closes recorded yet</div>`;
  elements.dailyCloseHistoryList.querySelectorAll("[data-daily-close-id]")
    .forEach(button => button.addEventListener("click", () => loadDailyClose(button.dataset.dailyCloseId)));
}

function renderLatestHandoff() {
  if (!elements.latestHandoffSummary) return;
  const latest = dailyCloses.find(close => close.status === "Finalized");
  if (!latest) {
    elements.latestHandoffMeta.textContent = "No finalized daily close yet";
    elements.latestHandoffSummary.innerHTML = `<div class="empty-card">The latest signed handoff will appear here</div>`;
    return;
  }
  const snapshot = latest.snapshot || emptyDailyCloseSnapshot();
  elements.latestHandoffMeta.textContent = `${formatDelivery(latest.businessDate)} / signed ${formatDateTime(latest.finalizedAt)} by ${latest.finalizedBy}`;
  elements.latestHandoffSummary.innerHTML = `
    <div class="handoff-metrics">
      <span><strong>${formatNumber(snapshot.openSalesOrders)}</strong> open sales</span>
      <span><strong>${formatNumber(snapshot.activeProductionBatches)}</strong> active batches</span>
      <span><strong>${formatNumber(snapshot.issues?.length || 0)}</strong> open items</span>
    </div>
    ${latest.priorityNotes ? `<div><strong>Priorities</strong><p>${escapeHtml(latest.priorityNotes)}</p></div>` : ""}
    ${latest.handoffNotes ? `<div><strong>Handoff</strong><p>${escapeHtml(latest.handoffNotes)}</p></div>` : ""}
  `;
}

function buildDailyClosePreview() {
  const storefrontCounts = getLatestCounts("Storefront");
  const storageCounts = getLatestCounts("Storage");
  const ledger = window.FRONTIER_INVENTORY_COUNTS.selectCurrentLedger({
    ledger: backendSnapshot?.sheet?.inventory?.ledger,
    operations,
    snapshotGeneratedAt: backendSnapshot?.sheet?.generatedAt
  });
  const activeSales = orders.filter(order => !statusesHiddenFromActive.has(order.status));
  const activeProduction = productionBatches.filter(batch => PRODUCTION_ACTIVE_STATUSES.has(batch.status));
  const openBuyOrders = storefrontBuyOrders.filter(order => BUY_ORDER_OPEN_STATUSES.has(order.status));
  const issues = [
    ...activeSales.filter(order => order.deliveryDate && order.deliveryDate < todayKey()).map(order => ({
      type: isInternalCraftOrder(order) ? "Overdue Internal Craft" : "Overdue Sale",
      label: orderDisplayName(order),
      detail: `Due ${order.deliveryDate}`
    })),
    ...activeProduction.map(batch => ({
      type: "Production",
      label: batch.reference || batch.sourceType,
      detail: batch.status
    })),
    ...openBuyOrders.map(order => ({
      type: "Storefront Buy Order",
      label: order.itemLabel || order.itemName,
      detail: `${formatNumber(order.filledQuantity)} of ${formatNumber(order.quantity)} filled`
    }))
  ];
  return {
    capturedAt: new Date().toISOString(),
    sheetGeneratedAt: backendSnapshot?.sheet?.generatedAt || "",
    storefrontUnits: [...storefrontCounts.values()].reduce((sum, value) => sum + Number(value || 0), 0),
    storageUnits: [...storageCounts.values()].reduce((sum, value) => sum + Number(value || 0), 0),
    ledgerBalance: ledger.available ? ledger.balance : null,
    openSalesOrders: activeSales.length,
    overdueSalesOrders: activeSales.filter(order => order.deliveryDate && order.deliveryDate < todayKey()).length,
    activeProductionBatches: activeProduction.length,
    expectedSupplyDeliveries: supplyOrders.filter(order => SUPPLY_DELIVERY_STATUSES.has(order.status) && order.expectedDate && order.expectedDate <= todayKey()).length,
    openStorefrontBuyOrders: openBuyOrders.length,
    openReviewExceptions: reviewExceptions.filter(exception => exception.status === "Open").length,
    issues
  };
}

function formatAvailableNumber(value) {
  return Number.isFinite(value) ? formatNumber(value) : "Unavailable";
}

function formatAvailableCurrency(value) {
  return Number.isFinite(value) ? formatCurrency(value) : "Unavailable";
}

function buildInventoryOverviewRows(catalog, counts, location) {
  const rows = [];
  const rowsByKey = new Map();
  const displayNames = inventoryOverviewDisplayNames(location);

  catalog.forEach(item => {
    const key = inventoryOverviewKey(item);
    if (!key || rowsByKey.has(key)) return;
    const isMaterial = item.category === "Recipe Ingredient";
    const row = {
      key,
      label: item.label || item.name,
      name: item.name,
      category: isMaterial ? "Material" : (item.category || "Counted Item"),
      quantity: Number(counts.get(key) || 0),
      productKey: isMaterial ? "" : (catalogProductFor(item.name)?.name || "")
    };
    rowsByKey.set(key, row);
    rows.push(row);
  });

  counts.forEach((quantity, key) => {
    if (rowsByKey.has(key)) return;
    const row = {
      key,
      label: displayNames.get(key) || titleCase(key),
      name: displayNames.get(key) || titleCase(key),
      category: "Counted Item",
      quantity: Number(quantity || 0)
    };
    rowsByKey.set(key, row);
    rows.push(row);
  });

  return rows;
}

function inventoryOverviewDisplayNames(location) {
  const names = new Map();
  const inventory = backendSnapshot?.sheet?.inventory || {};
  const rows = location === "Storefront"
    ? Array.isArray(inventory.storefront) ? inventory.storefront : inventory.products
    : Array.isArray(inventory.storage) ? inventory.storage : inventory.materials;

  if (Array.isArray(rows)) {
    rows.forEach(row => {
      const key = inventoryOverviewKey(row);
      const label = row.itemLabel || row.itemName || row.ingredient || row.name;
      if (key && label) names.set(key, String(label));
    });
  }
  operations
    .filter(entry => entry.kind === "Stock Count" && entry.location === location)
    .forEach(entry => {
      const key = inventoryOverviewKey(entry);
      const label = entry.itemLabel || entry.itemName;
      if (key && label) names.set(key, String(label));
    });
  return names;
}

function filterInventoryOverviewRows(rows, query) {
  if (!query) return rows;
  return rows.filter(row => normalize(`${row.label} ${row.name} ${row.category}`).includes(query));
}

function renderInventoryOverviewRows(rows, showTarget) {
  const columns = showTarget ? 4 : 3;
  if (!rows.length) return `<tr><td colspan="${columns}" class="empty-line">No matching inventory lines</td></tr>`;
  return rows.map(row => `
    <tr class="${row.productKey ? `inventory-product-row${normalize(row.productKey) === activeProductCardKey ? " selected" : ""}` : ""}"
        ${row.productKey ? `data-product-key="${escapeHtml(normalize(row.productKey))}" tabindex="0" title="Open product record"` : ""}>
      <td>
        <strong>${escapeHtml(row.label)}</strong>
        ${row.name && normalize(row.name) !== normalize(row.label) ? `<span>${escapeHtml(row.name)}</span>` : ""}
      </td>
      <td>${escapeHtml(row.category)}</td>
      <td class="${row.quantity ? "" : "inventory-zero"}">${formatNumber(row.quantity)}</td>
      ${showTarget ? `<td class="${row.target ? "" : "inventory-zero"}">${row.target ? formatNumber(row.target) : "-"}</td>` : ""}
    </tr>
  `).join("");
}

function catalogProductFor(value) {
  return productCatalogByKey.get(normalize(value)) || null;
}

function inventoryOverviewKey(entry) {
  return window.FRONTIER_INVENTORY_COUNTS.normalizeKey(
    entry?.itemName || entry?.itemLabel || entry?.ingredient || entry?.name
  );
}

function sumInventoryCounts(counts) {
  return [...counts.values()].reduce((total, quantity) => total + Number(quantity || 0), 0);
}

function calculateInventoryValuation(location, counts) {
  const inventory = backendSnapshot?.sheet?.inventory || {};
  const rows = location === "Storefront"
    ? (Array.isArray(inventory.storefront) ? inventory.storefront : inventory.products || [])
    : (Array.isArray(inventory.storage) ? inventory.storage : inventory.materials || []);
  const rowsByKey = new Map(rows.map(row => [inventoryOverviewKey(row), row]));
  let total = 0;
  let valuedUnits = 0;
  let unvaluedUnits = 0;
  let unvaluedLines = 0;
  let fallbackLines = 0;

  counts.forEach((rawQuantity, key) => {
    const quantity = Math.max(0, Number(rawQuantity || 0));
    if (!quantity) return;
    const row = rowsByKey.get(key) || {};
    const product = productCatalogByKey.get(key);
    const material = ingredientCatalog.find(item => inventoryOverviewKey(item) === key);
    const productPricing = findPricingByKey(pricingCatalog.products, key);
    const materialPricing = findPricingByKey(pricingCatalog.materials, key);
    const salePrice = firstPositiveNumber(row.salePrice, product?.price, productPricing?.midpoint);
    const unitCost = firstPositiveNumber(row.unitCost, material?.unitCost, material?.price, materialPricing?.midpoint);
    const unitValue = location === "Storefront" ? salePrice : (unitCost || salePrice);
    if (!unitValue) {
      unvaluedUnits += quantity;
      unvaluedLines += 1;
      return;
    }
    if (location === "Storage" && !unitCost && salePrice) fallbackLines += 1;
    valuedUnits += quantity;
    total += quantity * unitValue;
  });

  return { total, valuedUnits, unvaluedUnits, unvaluedLines, fallbackLines };
}

function findPricingByKey(collection, key) {
  return Object.entries(collection || {}).find(([name]) => normalize(name) === key)?.[1] || null;
}

function firstPositiveNumber(...values) {
  return values.map(Number).find(value => Number.isFinite(value) && value > 0) || 0;
}

function valuationDetail(valuation, baseText, storage = false) {
  if (!valuation.valuedUnits && !valuation.unvaluedUnits) return "No counted units";
  if (valuation.unvaluedLines) {
    return `${baseText} / ${formatNumber(valuation.unvaluedUnits)} units on ${valuation.unvaluedLines} ${valuation.unvaluedLines === 1 ? "line" : "lines"} unvalued`;
  }
  if (storage && valuation.fallbackLines) {
    return `${baseText} / ${valuation.fallbackLines} ${valuation.fallbackLines === 1 ? "line" : "lines"} at sell price`;
  }
  return `${baseText} / all counted units valued`;
}

function inventoryLineCountText(visible, total, query) {
  return `${query ? `${visible} of ${total}` : visible} ${visible === 1 ? "line" : "lines"}`;
}

function titleCase(value) {
  return String(value || "").replace(/\b\w/g, character => character.toUpperCase());
}

function renderRole() {
  document.body.classList.toggle("employee-view", currentRole === "employee");
  document.body.classList.toggle("manager-view", currentRole === "manager");
  document.body.classList.toggle("admin-view", currentRole === "admin");
  document.body.classList.toggle("accounts-disabled", !currentUser?.accountManagement);
  elements.currentUserName.textContent = currentUser?.fullName || "Loading account";
  elements.currentUserRole.textContent = ({ admin: "Admin", manager: "Manager", employee: "Employee" })[currentRole] || "Employee";
  elements.profileButton?.classList.toggle("hidden", currentUser?.accountType !== "discord");
  renderWorkspaceSwitcher();
  if (elements.currentWorkspaceCode) {
    elements.currentWorkspaceCode.textContent = currentWorkspace?.code ? `Workspace ${currentWorkspace.code}` : "";
    elements.currentWorkspaceCode.classList.toggle("hidden", !currentWorkspace?.code);
    elements.currentWorkspaceCode.title = currentWorkspace?.id ? `Internal workspace ID: ${currentWorkspace.id}` : "";
  }
  document.querySelectorAll("[data-admin-only-option]").forEach(option => {
    option.hidden = !isAdmin();
    option.disabled = !isAdmin();
  });
  document.querySelectorAll("[data-management-only-option]").forEach(option => {
    option.hidden = !isManagement();
    option.disabled = !isManagement();
  });
  if (!isAdmin() && elements.ledgerType?.selectedOptions[0]?.dataset.adminOnlyOption !== undefined) {
    elements.ledgerType.value = "Ledger Count";
  }
  if (!canAccessSection(activeSection)) {
    activeSection = "dashboard";
    renderSection();
  }
}

function canAccessSection(section) {
  const requiredRole = SECTION_MIN_ROLE[section] || "admin";
  if ((ROLE_RANK[currentRole] || 0) < ROLE_RANK[requiredRole]) return false;
  if (!isNavigationSectionEnabled(section)) return false;
  return section !== "employees" || Boolean(currentUser?.accountManagement);
}

function isManagement() {
  return currentRole === "admin" || currentRole === "manager";
}

function isAdmin() {
  return currentRole === "admin";
}

function renderReviewIndicators() {
  const openCount = reviewExceptions.filter(entry => entry.status === "Open").length;
  const resolvedCount = reviewExceptions.filter(entry => entry.status === "Resolved").length;
  const ignoredCount = reviewExceptions.filter(entry => entry.status === "Ignored").length;
  elements.dashboardReviewCount.textContent = formatNumber(openCount);
  elements.reviewOpenCount.textContent = formatNumber(openCount);
  elements.reviewResolvedCount.textContent = formatNumber(resolvedCount);
  elements.reviewIgnoredCount.textContent = formatNumber(ignoredCount);
  elements.exceptionNavCount.textContent = formatNumber(openCount);
  elements.exceptionNavCount.classList.toggle("hidden", openCount === 0);
}

function renderReviewWorkspace({ preserveEditor = false } = {}) {
  if (!elements.reviewSection) return;
  renderReviewIndicators();
  renderWebhookLog();
  const openCount = reviewExceptions.filter(entry => entry.status === "Open").length;
  const generatedAt = backendSnapshot?.sheet?.generatedAt;
  elements.reviewDataStatus.textContent = generatedAt
    ? `${openCount} open / ${webhookLog.length} recent webhooks / data synced ${formatDateTime(generatedAt)}`
    : `${openCount} open / shared data unavailable`;

  const filter = elements.reviewStatusFilter.value || "Open";
  const query = normalize(elements.reviewSearch.value);
  const visible = reviewExceptions.filter(entry => {
    if (filter !== "All" && entry.status !== filter) return false;
    if (!query) return true;
    return normalize([
      entry.webhookId,
      entry.reason,
      entry.discordTitle,
      entry.discordItemName,
      entry.discordItemLabel,
      entry.resolvedItem,
      entry.resolvedBy,
      entry.note
    ].join(" ")).includes(query);
  });

  if (!activeReviewExceptionId || !reviewExceptions.some(entry => entry.webhookId === activeReviewExceptionId)) {
    activeReviewExceptionId = visible[0]?.webhookId
      || reviewExceptions.find(entry => entry.status === "Open")?.webhookId
      || reviewExceptions[0]?.webhookId
      || "";
  }

  elements.reviewEventList.innerHTML = visible.length
    ? visible.map(entry => `
      <button class="review-event-card ${entry.webhookId === activeReviewExceptionId ? "active" : ""}" data-review-id="${escapeHtml(entry.webhookId)}" data-status="${escapeHtml(entry.status)}" type="button">
        <span class="review-event-card-header">
          <strong>${escapeHtml(entry.discordItemLabel || entry.discordItemName || "Unidentified event")}</strong>
          <span class="review-event-card-status">${escapeHtml(entry.status)}</span>
        </span>
        <span>${escapeHtml(reviewReasonText(entry.reason))}</span>
        <small class="review-event-card-meta"><span>${escapeHtml(entry.eventType || "Event")}</span><span>${escapeHtml(formatDateTime(entry.receivedAt))}</span></small>
      </button>
    `).join("")
    : `<div class="empty-card">No webhook events in this view</div>`;
  elements.reviewEventList.querySelectorAll("[data-review-id]").forEach(button => {
    button.addEventListener("click", () => {
      activeReviewExceptionId = button.dataset.reviewId;
      reviewEditorDirty = false;
      renderReviewWorkspace();
    });
  });

  const activeEntry = reviewExceptions.find(entry => entry.webhookId === activeReviewExceptionId);
  const keepDraft = preserveEditor
    && reviewEditorDirty
    && activeEntry?.status === "Open"
    && renderedReviewExceptionId === activeReviewExceptionId;
  if (!keepDraft) renderReviewEditor(activeEntry);
}

function markReviewEditorDirty() {
  if (activeReviewExceptionId && renderedReviewExceptionId === activeReviewExceptionId) {
    reviewEditorDirty = true;
  }
}

function renderWebhookLog() {
  if (!elements.webhookLogBody) return;
  const status = elements.webhookLogStatusFilter.value || "all";
  const query = normalize(elements.webhookLogSearch.value);
  const visible = webhookLog.filter(entry => {
    if (status !== "all" && entry.status !== status) return false;
    if (!query) return true;
    return normalize([
      entry.webhookId,
      entry.status,
      entry.channelType,
      entry.discordChannelId,
      entry.eventType,
      entry.direction,
      entry.itemName,
      entry.discordItemName,
      entry.discordItemLabel,
      entry.actorName,
      entry.reviewReason,
      entry.rawText
    ].join(" ")).includes(query);
  });
  elements.webhookLogStatus.textContent = `${visible.length} of ${webhookLog.length} retained events shown`;
  elements.webhookLogBody.innerHTML = visible.length
    ? visible.map(entry => {
        const channelLabel = entry.channelType === "storage-ledger" ? "Storage / Ledger" : "Storefront";
        const itemLabel = entry.itemName || entry.discordItemLabel || entry.discordItemName || "Unidentified";
        return `
          <tr>
            <td>${escapeHtml(formatDateTime(entry.receivedAt || entry.occurredAt))}</td>
            <td><span class="webhook-log-result ${escapeHtml(entry.status)}">${escapeHtml(entry.status || "unknown")}</span></td>
            <td>${escapeHtml(channelLabel)}<span>${escapeHtml(entry.discordChannelId || "No channel ID")}</span></td>
            <td>${escapeHtml(entry.eventType || "Event")}<span>${escapeHtml(entry.direction || "No direction")}</span></td>
            <td>${escapeHtml(itemLabel)}${entry.discordItemLabel && entry.discordItemLabel !== itemLabel ? `<span>${escapeHtml(entry.discordItemLabel)}</span>` : ""}</td>
            <td>${escapeHtml(formatNumber(entry.quantity || 0))}</td>
            <td>${escapeHtml(entry.actorName || "Not supplied")}</td>
            <td>
              <code>${escapeHtml(entry.webhookId || "Unknown")}</code>
              <details class="webhook-log-raw">
                <summary>Raw text</summary>
                <pre>${escapeHtml(entry.rawText || "No raw webhook text retained")}</pre>
              </details>
            </td>
          </tr>`;
      }).join("")
    : `<tr><td class="empty-line" colspan="8">No retained webhooks match this view</td></tr>`;
}

function renderReviewEditor(entry) {
  renderedReviewExceptionId = entry?.webhookId || "";
  reviewEditorDirty = false;
  elements.reviewActionStatus.textContent = "";
  if (!entry) {
    elements.reviewEditorTitle.textContent = "No event selected";
    elements.reviewEditorStatus.textContent = "-";
    elements.reviewReceivedAt.textContent = "-";
    elements.reviewReason.textContent = "-";
    elements.reviewActorName.textContent = "-";
    elements.reviewLedgerName.textContent = "-";
    elements.reviewDiscordName.textContent = "-";
    elements.reviewDiscordLabel.textContent = "-";
    elements.reviewAppInventoryTotal.textContent = "-";
    elements.reviewReportedItemTotal.textContent = "-";
    elements.reviewStockVariance.textContent = "-";
    elements.reviewCashAmount.value = 0;
    elements.reviewCashTotal.textContent = formatFinanceCurrency(0);
    elements.reviewCashAllocated.textContent = formatFinanceCurrency(0);
    elements.reviewCashRemaining.textContent = formatFinanceCurrency(0);
    elements.reviewCashDirection.value = "Cash In";
    elements.reviewCashCategory.value = "";
    elements.reviewCashReference.value = "";
    elements.reviewCashAllocationList.innerHTML = "";
    elements.reviewItem.value = "";
    elements.reviewQuantity.value = 0;
    elements.reviewUnitPrice.value = 0;
    elements.reviewPackageConversion.checked = false;
    elements.reviewUnitsPerPackage.value = 1;
    elements.reviewCreateProduct.checked = false;
    elements.reviewItemType.value = "product";
    elements.reviewProductLabel.value = "";
    elements.reviewProductTag.value = "";
    elements.reviewProductCategory.value = "Resale";
    elements.reviewItemUnit.value = "unit";
    elements.reviewItemUnitCost.value = 0;
    elements.reviewProductPrice.value = 0;
    elements.reviewProductTarget.value = 0;
    elements.reviewRawText.textContent = "No event selected";
    renderReviewProductMode();
    renderReviewPackageMode();
    renderReviewCashMode();
    setReviewEditorDisabled(true);
    return;
  }

  const suggestedItem = findExactStockItem(entry.resolvedItem)
    || findExactStockItem(entry.discordItemLabel)
    || findExactStockItem(entry.discordItemName);
  elements.reviewEditorTitle.textContent = entry.discordTitle || entry.eventType || "Webhook Event";
  elements.reviewEditorStatus.textContent = entry.status;
  elements.reviewReceivedAt.textContent = formatDateTime(entry.receivedAt);
  elements.reviewReason.textContent = reviewReasonText(entry.reason);
  elements.reviewActorName.textContent = entry.actorName || "Not supplied";
  elements.reviewLedgerName.textContent = entry.ledgerName || "Business Ledger";
  elements.reviewDiscordName.textContent = entry.discordItemName || "Not supplied";
  elements.reviewDiscordLabel.textContent = entry.discordItemLabel || "Not supplied";
  elements.reviewAppInventoryTotal.textContent = reviewCountText(entry.appInventoryTotal);
  elements.reviewReportedItemTotal.textContent = reviewCountText(entry.currentItemTotal);
  elements.reviewStockVariance.textContent = entry.stockVariance === null || entry.stockVariance === undefined
    ? "Not applicable"
    : `${Number(entry.stockVariance) > 0 ? "+" : ""}${formatNumber(entry.stockVariance)}`;
  elements.reviewItem.value = entry.resolvedItem || suggestedItem?.label || entry.discordItemLabel || entry.discordItemName || "";
  elements.reviewEventType.value = ["Sale", "Purchase", "Stocking Movement"].includes(entry.eventType)
    ? entry.eventType
    : "Stocking Movement";
  elements.reviewDirection.value = ["Stock In", "Stock Out", "Purchase"].includes(entry.direction)
    ? entry.direction
    : "Stock In";
  elements.reviewQuantity.value = Number(entry.quantity || 0);
  elements.reviewUnitPrice.value = Number(entry.unitPrice || 0);
  elements.reviewNote.value = entry.note || "";
  elements.reviewRememberMapping.checked = !entry.transactionWritten
    && Boolean(entry.discordItemName || entry.discordItemLabel);
  elements.reviewPackageConversion.checked = !entry.transactionWritten && /\bcrate\b/i.test(
    `${entry.discordItemName || ""} ${entry.discordItemLabel || ""}`
  );
  elements.reviewUnitsPerPackage.value = 1;
  elements.reviewCreateProduct.checked = false;
  elements.reviewItemType.value = "product";
  elements.reviewProductLabel.value = entry.discordItemLabel || entry.discordItemName || "";
  elements.reviewProductTag.value = entry.discordItemName || "";
  elements.reviewProductCategory.value = suggestProductCategory(
    entry.discordItemLabel || entry.discordItemName
  );
  elements.reviewItemUnit.value = "unit";
  elements.reviewItemUnitCost.value = 0;
  elements.reviewProductPrice.value = Number(entry.unitPrice || 0);
  elements.reviewProductTarget.value = 0;
  elements.reviewRawText.textContent = entry.rawText || "No webhook text was supplied";
  renderReviewProductMode(entry);
  renderReviewPackageMode(entry);
  renderReviewCashMode(entry);
  setReviewEditorDisabled(entry.status !== "Open");
  if (entry.status === "Open" && entry.transactionWritten && !isCashReview(entry)) setRecordedReviewMode();
}

function setReviewEditorDisabled(disabled) {
  [
    elements.reviewCashAmount,
    elements.reviewCashCategory,
    elements.reviewCashReference,
    elements.reviewItem,
    elements.reviewEventType,
    elements.reviewDirection,
    elements.reviewQuantity,
    elements.reviewUnitPrice,
    elements.reviewNote,
    elements.reviewRememberMapping,
    elements.reviewPackageConversion,
    elements.reviewUnitsPerPackage,
    elements.reviewCreateProduct,
    elements.reviewItemType,
    elements.reviewProductLabel,
    elements.reviewProductTag,
    elements.reviewProductCategory,
    elements.reviewItemUnit,
    elements.reviewItemUnitCost,
    elements.reviewProductPrice,
    elements.reviewProductTarget,
    elements.resolveReview,
    elements.ignoreReview
  ].forEach(element => { element.disabled = disabled; });
}

function isCashReview(entry) {
  return Boolean(entry?.cashMovement || entry?.eventType === "Cash Movement"
    || String(entry?.reason || "").split(",").includes("cash_classification_required"));
}

function renderReviewCashMode(entry = reviewExceptions.find(candidate => candidate.webhookId === activeReviewExceptionId)) {
  const cash = isCashReview(entry);
  elements.reviewCashFields.classList.toggle("hidden", !cash);
  document.querySelectorAll(".review-cash-summary").forEach(field => field.classList.toggle("hidden", !cash));
  document.querySelectorAll(".review-stock-summary").forEach(field => field.classList.toggle("hidden", cash));
  document.querySelectorAll(".review-stock-field").forEach(field => field.classList.toggle("hidden", cash));
  document.querySelector(".review-mapping-option")?.classList.toggle("hidden", cash);
  document.querySelector(".review-package-conversion")?.classList.toggle("hidden", cash);
  document.querySelector(".review-new-product-option")?.classList.toggle("hidden", cash);
  elements.ignoreReview.classList.toggle("hidden", cash);
  if (!cash) return;

  const direction = entry.direction === "Cash Out" ? "Cash Out" : "Cash In";
  const total = Number(entry.cashAmount || entry.quantity || 0);
  const allocated = Number(entry.cashAllocated || 0);
  const remaining = Math.max(0, Number(entry.cashRemaining ?? total - allocated));
  elements.reviewCashTotal.textContent = formatFinanceCurrency(total);
  elements.reviewCashAllocated.textContent = formatFinanceCurrency(allocated);
  elements.reviewCashRemaining.textContent = formatFinanceCurrency(remaining);
  elements.reviewCashRemaining.classList.toggle("complete", remaining <= 0.005);
  elements.reviewCashAmount.value = remaining;
  elements.reviewCashAmount.max = remaining;
  elements.reviewCashDirection.value = direction;
  elements.reviewCashReference.value = "";
  elements.reviewCashCategory.innerHTML = cashReviewOptions(direction)
    .map(option => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`)
    .join("");
  const allocations = Array.isArray(entry.cashAllocations) ? entry.cashAllocations : [];
  elements.reviewCashAllocationList.innerHTML = allocations.length
    ? `<h4>Saved allocations</h4>${allocations.map(allocation => `
      <div class="review-cash-allocation-row">
        <span><strong>${escapeHtml(allocation.category)}</strong>${allocation.reference ? `<small>${escapeHtml(allocation.reference)}</small>` : ""}</span>
        <strong>${formatFinanceCurrency(allocation.amount)}</strong>
      </div>
    `).join("")}`
    : `<p class="empty-line">No cash has been allocated yet</p>`;
  elements.reviewNewProductFields.classList.add("hidden");
  elements.reviewPackageFields.classList.add("hidden");
  elements.resolveReview.textContent = remaining < total ? "Apply Next Allocation" : "Apply Cash Allocation";
}

function cashReviewOptions(direction) {
  const incoming = [
    { value: "", label: "Choose incoming operation" },
    { value: "Business Income", label: "Business Income (P&L)" },
    { value: "P2P Sale", label: "P2P Sale (P&L)" },
    { value: "Owner Capital Deposit", label: "Owner Capital Deposit" },
    { value: "Safekeeping Deposit", label: "Safekeeping Deposit" },
    { value: "Cash Transfer In", label: "Cash Transfer In (not P&L)" }
  ];
  const outgoing = [
    { value: "", label: "Choose outgoing operation" },
    { value: "Business Expense", label: "Business Expense (P&L)" },
    { value: "P2P Purchase", label: "P2P Purchase (P&L)" },
    { value: "Supplier Purchase", label: "Supplier Purchase (P&L)" },
    { value: "Payroll Payment", label: "Payroll Payment (P&L)" },
    { value: "Owner Withdrawal", label: "Owner Withdrawal" },
    { value: "Safekeeping Withdrawal", label: "Safekeeping Withdrawal" },
    { value: "Cash Transfer Out", label: "Cash Transfer Out (not P&L)" }
  ];
  return direction === "Cash Out" ? outgoing : incoming;
}

function renderReviewProductMode(entry = reviewExceptions.find(candidate => candidate.webhookId === activeReviewExceptionId)) {
  const creating = elements.reviewCreateProduct.checked;
  const type = elements.reviewItemType.value;
  const product = type === "product" || type === "both";
  elements.reviewNewProductFields.classList.toggle("hidden", !creating);
  document.querySelectorAll(".review-product-only-field").forEach(field => field.classList.toggle("hidden", !product));
  if (creating) {
    const defaults = new Set(["", "Products", "Materials", "Products and Materials"]);
    if (defaults.has(elements.reviewProductCategory.value.trim())) {
      elements.reviewProductCategory.value = type === "material"
        ? "Materials"
        : type === "both" ? "Products and Materials" : "Products";
    }
  }
  elements.resolveReview.textContent = entry?.transactionWritten
    ? "Acknowledge Review"
    : creating ? "Add Good and Apply" : "Resolve and Apply";
  elements.ignoreReview.textContent = entry?.transactionWritten ? "Dismiss Review" : "Ignore Event";
}

function renderReviewPackageMode(entry = reviewExceptions.find(candidate => candidate.webhookId === activeReviewExceptionId)) {
  const packaged = elements.reviewPackageConversion.checked;
  const packageQuantity = Math.max(0, Number(elements.reviewQuantity.value || 0));
  const unitsPerPackage = Math.max(1, Number(elements.reviewUnitsPerPackage.value || 1));
  const totalUnits = packageQuantity * unitsPerPackage;
  const selected = findExactStockItem(elements.reviewItem.value);
  const itemName = selected?.label || elements.reviewItem.value.trim() || "selected good";
  elements.reviewPackageFields.classList.toggle("hidden", !packaged);
  elements.reviewQuantityLabelText.textContent = packaged ? "Crates or packages reported" : "Quantity";
  elements.reviewUnitPriceLabelText.textContent = packaged ? "Price per crate or package" : "Unit Price";
  elements.reviewPackagePreview.textContent = `${formatNumber(packageQuantity)} package${packageQuantity === 1 ? "" : "s"} x ${formatNumber(unitsPerPackage)} = ${formatNumber(totalUnits)} ${itemName} units`;
  if (!packaged) elements.reviewUnitsPerPackage.value = 1;
  if (entry?.transactionWritten) elements.reviewPackageFields.classList.add("hidden");
}

function setRecordedReviewMode() {
  [
    elements.reviewItem,
    elements.reviewEventType,
    elements.reviewDirection,
    elements.reviewQuantity,
    elements.reviewUnitPrice,
    elements.reviewRememberMapping,
    elements.reviewPackageConversion,
    elements.reviewUnitsPerPackage,
    elements.reviewCreateProduct,
    elements.reviewItemType,
    elements.reviewProductLabel,
    elements.reviewProductTag,
    elements.reviewProductCategory,
    elements.reviewItemUnit,
    elements.reviewItemUnitCost,
    elements.reviewProductPrice,
    elements.reviewProductTarget
  ].forEach(element => { element.disabled = true; });
}

function suggestProductCategory(value) {
  const key = normalize(value);
  if (key.includes("shotgun")) return "Shotguns";
  if (key.includes("repeater")) return "Repeaters";
  if (key.includes("revolver")) return "Revolvers";
  if (key.includes("pistol")) return "Pistols";
  if (key.includes("rifle")) return "Rifles";
  if (key.includes("bow")) return "Bows";
  if (key.includes("ammo") || key.includes("cartridge")) return "Ammunition";
  if (key.includes("kit") || key.includes("tool")) return "Tools";
  return "Resale";
}

function findExactStockItem(value) {
  const wanted = normalize(value);
  if (!wanted) return null;
  return stockCatalog.find(item => [item.name, item.label, item.tag, ...(item.aliases || [])]
    .map(normalize)
    .includes(wanted)) || null;
}

function reviewReasonText(value) {
  const labels = {
    unknown_item: "Unknown item label",
    missing_item: "Item missing",
    missing_quantity: "Quantity missing",
    stock_count_mismatch: "Storefront count discrepancy",
    cash_classification_required: "Cash operation needs classification"
  };
  return String(value || "Review required")
    .split(",")
    .filter(Boolean)
    .map(reason => labels[reason] || reason.replace(/_/g, " "))
    .join(" / ");
}

function reviewCountText(value) {
  return value === null || value === undefined || value === "" ? "Not supplied" : formatNumber(value);
}

async function resolveReviewException() {
  const entry = reviewExceptions.find(candidate => candidate.webhookId === activeReviewExceptionId);
  if (!entry || entry.status !== "Open") return;
  if (isCashReview(entry)) {
    await resolveCashReviewException(entry);
    return;
  }
  const transactionAlreadyWritten = Boolean(entry.transactionWritten);
  const creating = !transactionAlreadyWritten && elements.reviewCreateProduct.checked;
  const item = findExactStockItem(elements.reviewItem.value);
  const quantity = formNumber(elements.reviewQuantity.value);
  const packaged = elements.reviewPackageConversion.checked;
  const quantityMultiplier = packaged ? formNumber(elements.reviewUnitsPerPackage.value) : 1;
  if (!creating && !item) {
    setReviewActionStatus("Select an exact catalog item or recipe material");
    elements.reviewItem.focus();
    return;
  }
  if (creating && backendSnapshot?.dataBackend !== "postgresql" && Number(backendSnapshot?.sheet?.schemaVersion || 0) < 8) {
    setReviewActionStatus("Update the legacy data service before adding new wares");
    return;
  }
  if (creating && item) {
    setReviewActionStatus("This ware already exists; uncheck the new ware option to apply it");
    elements.reviewItem.focus();
    return;
  }
  const newItem = creating ? {
    enabled: true,
    ...catalogItemDraft({
      type: elements.reviewItemType.value,
      name: elements.reviewItem.value,
      label: elements.reviewProductLabel.value,
      tag: elements.reviewProductTag.value,
      category: elements.reviewProductCategory.value,
      unit: elements.reviewItemUnit.value,
      unitCost: elements.reviewItemUnitCost.value,
      salePrice: elements.reviewProductPrice.value,
      target: elements.reviewProductTarget.value
    })
  } : null;
  const newItemValidation = creating ? validateCatalogItemDraft(newItem) : "";
  if (newItemValidation) {
    setReviewActionStatus(newItemValidation);
    return;
  }
  if (!Number.isFinite(quantity) || quantity <= 0) {
    setReviewActionStatus("Enter a positive quantity");
    elements.reviewQuantity.focus();
    return;
  }
  if (!Number.isFinite(quantityMultiplier) || quantityMultiplier < 1 || quantityMultiplier > 1000000) {
    setReviewActionStatus("Enter between 1 and 1,000,000 units per crate");
    elements.reviewUnitsPerPackage.focus();
    return;
  }
  if (packaged && !elements.reviewRememberMapping.checked) {
    setReviewActionStatus("Keep Remember checked to save the crate conversion rule");
    elements.reviewRememberMapping.focus();
    return;
  }

  elements.resolveReview.disabled = true;
  elements.ignoreReview.disabled = true;
  setReviewActionStatus(creating ? "Adding catalog good and applying movement..." : "Applying movement...");
  const result = await syncToBackend("resolve_exception", {
    exception: {
      webhookId: entry.webhookId,
      discordItemLabel: entry.discordItemLabel,
      itemName: creating ? newItem.name : item.name,
      eventType: elements.reviewEventType.value,
      direction: elements.reviewDirection.value,
      quantity,
      quantityMultiplier,
      unitPrice: formNumber(elements.reviewUnitPrice.value),
      rememberMapping: !transactionAlreadyWritten && elements.reviewRememberMapping.checked,
      note: elements.reviewNote.value.trim(),
      newItem
    }
  });
  if (!result.ok) {
    setReviewActionStatus(`Resolution failed: ${result.error || "data sync failed"}`);
    setReviewEditorDisabled(false);
    return;
  }
  reviewEditorDirty = false;
  activeReviewExceptionId = "";
  await loadBackendSnapshot({ silent: true });
}

async function resolveCashReviewException(entry) {
  const cashCategory = elements.reviewCashCategory.value;
  const allocationAmount = formNumber(elements.reviewCashAmount.value);
  const remainingBefore = Number(entry.cashRemaining ?? entry.cashAmount ?? entry.quantity ?? 0);
  if (!cashCategory) {
    setReviewActionStatus("Choose what operation this cash movement belongs to");
    elements.reviewCashCategory.focus();
    return;
  }
  if (!Number.isFinite(allocationAmount) || allocationAmount <= 0) {
    setReviewActionStatus("Enter an allocation greater than zero");
    elements.reviewCashAmount.focus();
    return;
  }
  if (allocationAmount - remainingBefore > 0.005) {
    setReviewActionStatus(`Only ${formatFinanceCurrency(remainingBefore)} remains to be allocated`);
    elements.reviewCashAmount.focus();
    return;
  }

  elements.resolveReview.disabled = true;
  elements.ignoreReview.disabled = true;
  setReviewActionStatus("Classifying cash and updating the ledger...");
  const result = await syncToBackend("resolve_exception", {
    exception: {
      webhookId: entry.webhookId,
      eventType: "Cash Movement",
      direction: elements.reviewCashDirection.value,
      cashAmount: allocationAmount,
      cashCategory,
      allocationId: crypto.randomUUID(),
      cashReference: elements.reviewCashReference.value.trim(),
      note: elements.reviewNote.value.trim()
    }
  });
  if (!result.ok) {
    setReviewActionStatus(`Resolution failed: ${result.error || "data sync failed"}`);
    setReviewEditorDisabled(false);
    return;
  }
  const complete = result.status === "Resolved" || Number(result.cashRemaining || 0) <= 0.005;
  reviewEditorDirty = false;
  if (complete) activeReviewExceptionId = "";
  await loadBackendSnapshot({ silent: true });
  if (!complete) {
    setReviewActionStatus(
      `${formatFinanceCurrency(result.allocationAmount || allocationAmount)} allocated; ${formatFinanceCurrency(result.cashRemaining)} remains`
    );
  }
}

function setReviewActionStatus(message) {
  elements.reviewActionStatus.textContent = message;
  elements.reviewDataStatus.textContent = message;
}

async function ignoreReviewException() {
  const entry = reviewExceptions.find(candidate => candidate.webhookId === activeReviewExceptionId);
  if (!entry || entry.status !== "Open") return;
  if (!window.confirm(`Ignore webhook ${entry.webhookId}?`)) return;
  elements.resolveReview.disabled = true;
  elements.ignoreReview.disabled = true;
  const result = await syncToBackend("ignore_exception", {
    exception: {
      webhookId: entry.webhookId,
      discordItemLabel: entry.discordItemLabel,
      note: elements.reviewNote.value.trim()
    }
  });
  if (!result.ok) {
    elements.reviewDataStatus.textContent = `Ignore failed: ${result.error || "data sync failed"}`;
    setReviewEditorDisabled(false);
    return;
  }
  reviewEditorDirty = false;
  activeReviewExceptionId = "";
  await loadBackendSnapshot({ silent: true });
}

function renderReplenishment() {
  const plan = getReplenishmentPlan();
  const storagePlan = getStorageAlertPlan();
  const materialShortages = plan.materials.filter(line => line.shortage > 0);
  const unqueuedCraftable = plan.missing.reduce((sum, line) => {
    if (!recipeCatalog[line.itemName]) return sum;
    return sum + Math.max(0, Number(line.missing || 0) - queuedProductionQuantity(line.itemName));
  }, 0);
  elements.missingStockCount.textContent = plan.missing.length;
  elements.materialShortageCount.textContent = materialShortages.length;
  elements.storageAlertCount.textContent = storagePlan.length;
  elements.replenishmentMeta.textContent = stockTargets.length
    ? `${plan.missing.length} storefront lines missing / ${materialShortages.length} material shortages${plan.missingRecipes.length ? ` / ${plan.missingRecipes.length} missing recipes` : ""}`
    : "Set admin stock targets to generate a standing order";

  elements.replenishmentList.innerHTML = plan.missing.length
    ? plan.missing.map(line => {
      const queued = queuedProductionQuantity(line.itemName);
      return `
      <div class="replenishment-row">
        <strong>${escapeHtml(line.label)}</strong>
        <span>Have ${formatNumber(line.current)} / Target ${formatNumber(line.target)} / Make ${formatNumber(line.missing)}${queued ? ` / ${formatNumber(queued)} queued` : ""}</span>
      </div>
    `;
    }).join("")
    : `<div class="empty-card">${stockTargets.length ? "Storefront targets are currently filled" : "No storefront targets set yet"}</div>`;

  const materialRows = materialShortages.map(line => `
      <div class="replenishment-row short">
        <strong>${escapeHtml(line.ingredient)}</strong>
        <span>Need ${formatNumber(line.needed)} / ${escapeHtml(line.sourceLocation)} ${formatNumber(line.available)} / Short ${formatNumber(line.shortage)}</span>
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
    : `<div class="empty-card">Selected stock locations cover all known recipe needs</div>`;

  elements.stockAlertList.innerHTML = plan.missing.length
    ? plan.missing.map(line => `
      <div class="replenishment-row short">
        <strong>${escapeHtml(line.label)}</strong>
        <span>${formatNumber(line.current)} in store / ${formatNumber(line.missing)} needed</span>
      </div>
    `).join("")
    : `<div class="empty-card">${stockTargets.length ? "All storefront targets are filled" : "No storefront targets set yet"}</div>`;
  elements.storageAlertList.innerHTML = storagePlan.length
    ? storagePlan.map(line => `
      <div class="replenishment-row short">
        <strong>${escapeHtml(line.label)}</strong>
        <span>${formatNumber(line.current)} in storage / ${formatNumber(line.missing)} needed</span>
      </div>
    `).join("")
    : `<div class="empty-card">${storageTargets.length ? "All storage targets are filled" : "No storage targets set yet"}</div>`;
  elements.queueRestock.disabled = productionActionPending || !isManagement() || unqueuedCraftable <= 0;
  elements.queueRestock.textContent = unqueuedCraftable > 0
    ? `Queue ${formatNumber(unqueuedCraftable)} Units`
    : "Restock Covered";
}

function renderTimeClock() {
  const current = timeClock.current;
  elements.clockEmployee.value = current?.employee || currentUser?.fullName || elements.clockEmployee.value;
  elements.clockEmployee.disabled = Boolean(currentUser);
  elements.clockToggle.textContent = current ? "Clock Out" : "Clock In";
  elements.clockStatus.textContent = current
    ? `${current.employee} clocked in at ${formatDateTime(current.clockIn)} / ${current.syncStatus || "Pending data sync"}`
    : "Clocked out";

  const recentEntries = timeClock.entries.slice(0, 5);
  elements.timeClockList.innerHTML = recentEntries.length
    ? recentEntries.map(entry => `
      <div class="time-entry">
        <strong>${escapeHtml(entry.employee)}</strong>
        <span>${formatDateTime(entry.clockIn)} - ${formatDateTime(entry.clockOut)}</span>
        <small>${formatDuration(entry.durationMinutes)} / ${escapeHtml(entry.syncStatus || "Pending data sync")}</small>
      </div>
    `).join("")
    : `<div class="empty-card">No completed shifts yet</div>`;
}

function renderDashboardCards(items, emptyText) {
  if (!items.length) return `<div class="empty-card">${emptyText}</div>`;
  return items.map(order => `
    <button class="dashboard-order" type="button" data-dashboard-order="${order.id}">
      <span class="status-pill ${order.status.toLowerCase()}">${escapeHtml(order.status)}</span>
      <strong>${escapeHtml(orderDisplayName(order))}</strong>
      <span>${formatDelivery(order.deliveryDate)} / ${order.lines.length} lines / ${formatCurrency(isInternalCraftOrder(order) ? 0 : getSubtotal(order))}</span>
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
      <span>${formatNumber(remaining)} units remaining / ${remainingLines} ${remainingLines === 1 ? "line" : "lines"} / ${formatCurrency(getSupplyOrderTotal(order))}</span>
      </button>
    `;
  }).join("");
}

function renderProduction() {
  const production = getProductionPlan(activeOrder);
  const internal = isInternalCraftOrder(activeOrder);
  const existingUnits = production.stockAllocations.reduce((sum, allocation) =>
    sum + Number(allocation.storageQuantity || 0) + Number(allocation.storefrontQuantity || 0), 0);
  elements.productionMeta.textContent = internal
    ? `${production.buildLines.length} stock-building lines / ${production.materials.length} materials / output goes to storage${isManagement() ? ` / est. ${formatCurrency(production.materialCost)}` : ""}`
    : `${formatNumber(existingUnits)} existing units reserved / ${production.buildLines.length} production lines / ${production.materials.length} materials${isManagement() ? ` / est. ${formatCurrency(production.materialCost)}` : ""}`;

  if (!production.fulfillmentLines.length) {
    elements.productionBuildList.innerHTML = `<div class="empty-card">No order lines to fulfill yet</div>`;
  } else {
    elements.productionBuildList.innerHTML = production.fulfillmentLines.map(line => `
      <div class="production-row">
        <strong>${escapeHtml(line.label || line.name)}</strong>
        <span>${internal
          ? `${formatNumber(line.productionQuantity)} to produce for storage`
          : `${formatNumber(line.orderedQuantity)} ordered / ${formatNumber(line.existingQuantity)} existing / ${formatNumber(line.productionQuantity)} to produce${line.storageQuantity ? ` / ${formatNumber(line.storageQuantity)} storage` : ""}${line.storefrontQuantity ? ` / ${formatNumber(line.storefrontQuantity)} storefront` : ""}`}</span>
      </div>
    `).join("");
  }

  if (!production.materials.length) {
    elements.productionMaterialsList.innerHTML = `<div class="empty-card">No materials needed yet</div>`;
  } else {
    elements.productionMaterialsList.innerHTML = production.materials.map(material => `
      <div class="production-row">
        <strong>${escapeHtml(material.ingredient)}</strong>
      <span>${formatNumber(material.qty)}${isManagement() ? ` / ${formatCurrency(material.cost)}` : ""}</span>
      </div>
    `).join("");
  }

  elements.missingRecipes.innerHTML = production.missing.length
    ? `<strong>No recipe attached:</strong> ${production.missing.map(escapeHtml).join(", ")}`
    : "";
  const linkedBatch = productionBatchForOrder(activeOrder.id);
  elements.queueOrderProduction.disabled = productionActionPending
    || (!linkedBatch && !production.buildLines.length && !production.stockAllocations.length);
  elements.queueOrderProduction.textContent = linkedBatch ? "Open Production" : "Queue Production";
}

function renderOrdersList() {
  const filter = elements.filter.value;
  const visibleOrders = orders
    .filter(order => filter === "All" || (filter === "Active" ? !statusesHiddenFromActive.has(order.status) : order.status === filter))
    .sort((a, b) => sortOrder(a, b));

  const activeCount = orders.filter(order => !statusesHiddenFromActive.has(order.status)).length;
  elements.savedCount.textContent = `${activeCount} active / ${orders.length} shared`;

  if (!visibleOrders.length) {
    elements.ordersList.innerHTML = `<div class="empty-card">No saved work orders</div>`;
    return;
  }

  elements.ordersList.innerHTML = visibleOrders.map(order => `
    <button class="order-card ${order.id === activeOrder.id ? "selected" : ""}" type="button" data-order-id="${order.id}">
      <span class="status-pill ${order.status.toLowerCase()}">${escapeHtml(order.status)}</span>
      <strong>${escapeHtml(orderDisplayName(order))}</strong>
      <span>${escapeHtml(isInternalCraftOrder(order) ? "Internal Craft" : "Customer Sale")} / ${order.lines.length} lines / ${formatCurrency(isInternalCraftOrder(order) ? 0 : getSubtotal(order))}</span>
      <span>${formatDelivery(order.deliveryDate)}</span>
      <small>${formatDateTime(order.updatedAt)}</small>
    </button>
  `).join("");

  elements.ordersList.querySelectorAll("[data-order-id]").forEach(button => {
    button.addEventListener("click", () => loadOrder(button.dataset.orderId));
  });
}

function renderMeta() {
  const sharedState = activeOrder.revision > 0
    ? `Shared revision ${activeOrder.revision}${activeOrder.updatedBy ? ` by ${activeOrder.updatedBy}` : ""}`
    : "Not yet saved";
  elements.orderMeta.textContent = `${activeOrder.status} / ${activeOrder.priority} / ${sharedState} / ${formatDateTime(activeOrder.updatedAt)}`;
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
  const internal = isInternalCraftOrder(order);
  const lines = order.lines.length
    ? order.lines.map(line => {
      if (internal) return `${formatNumber(line.quantity)}x ${line.label || line.name}`;
      const total = line.quantity * line.unitPrice;
      return `${formatNumber(line.quantity)}x ${line.label || line.name} - ${formatCurrency(line.unitPrice)} each = ${formatCurrency(total)}`;
    }).join("\n")
    : "No items added";

  const subtotal = internal ? 0 : getSubtotal(order);
  const deposit = internal ? 0 : Number(order.deposit || 0);
  const balance = Math.max(0, subtotal - deposit);
  const details = [order.label, order.notes].filter(Boolean).join("\n");

  return [
    `${businessProfile.name || "Business"} ${internal ? "Internal Craft" : "Quote"}`,
    internal ? "Purpose: Build stock for storage" : `Customer: ${order.customer || ""}`,
    order.handler ? `Handler: ${order.handler}` : "",
    order.deliveryDate
      ? `${internal ? "Target" : "Delivery"}: ${formatDelivery(order.deliveryDate)}`
      : internal ? "Target: Not set" : "Order Type: In-store",
    `Status: ${order.status}${order.priority === "Expedite" ? " / Expedite" : ""}`,
    "",
    lines,
    "",
    internal ? "Financial effect: None" : `Subtotal: ${formatCurrency(subtotal)}`,
    internal ? "" : `Deposit Paid: ${formatCurrency(deposit)}`,
    internal ? "" : `Balance Due: ${formatCurrency(balance)}`,
    details ? `\nNotes:\n${details}` : ""
  ].filter(line => line !== "").join("\n");
}

function buildProductionSummary(order) {
  const production = getProductionPlan(order);
  const buildLines = production.fulfillmentLines.length
    ? production.fulfillmentLines.map(line =>
      isInternalCraftOrder(order)
        ? `${formatNumber(line.productionQuantity)}x ${line.label || line.name} to produce for storage`
        : `${formatNumber(line.orderedQuantity)}x ${line.label || line.name} / ${formatNumber(line.existingQuantity)} existing / ${formatNumber(line.productionQuantity)} to produce`
    ).join("\n")
    : "No order lines";
  const materials = production.materials.length
    ? production.materials.map(material => `${formatNumber(material.qty)}x ${material.ingredient}${isManagement() ? ` - ${formatCurrency(material.cost)}` : ""}`).join("\n")
    : "No materials needed";
  const missing = production.missing.length
    ? `\nNo recipe attached:\n${production.missing.join("\n")}`
    : "";

  return [
    `${businessProfile.name || "Business"} Production`,
    isInternalCraftOrder(order) ? "Destination: Storage" : `Customer: ${order.customer || ""}`,
    "",
    "Build:",
    buildLines,
    "",
    "Materials:",
    materials,
    isManagement() ? `Estimated material cost: ${formatCurrency(production.materialCost)}` : "",
    missing
  ].filter(line => line !== "").join("\n");
}

async function queueActiveOrderProduction() {
  if (productionActionPending) return;
  const linkedBatch = productionBatchForOrder(activeOrder.id);
  if (linkedBatch) {
    activeProductionBatchId = linkedBatch.id;
    activeSection = "production";
    render();
    return;
  }
  updateActiveFromInputs();
  const saved = orders.some(order => order.id === activeOrder.id);
  if (!saved || activeOrderDirty) {
    elements.productionMeta.textContent = `Saving the ${isInternalCraftOrder(activeOrder) ? "internal craft" : "customer order"} before production is queued`;
    if (!await saveActiveOrder()) return;
  }
  const plan = getProductionPlan(activeOrder);
  if (!plan.buildLines.length && !plan.stockAllocations.length) {
    elements.productionMeta.textContent = plan.missing.length
      ? `${isInternalCraftOrder(activeOrder) ? "No recipe is available" : "No recipe or existing stock is available"} for ${plan.missing.join(", ")}`
      : "Add at least one stocked or producible item before queuing fulfillment";
    return;
  }
  openProductionSourceDialog({
    id: crypto.randomUUID(),
    sourceType: orderProductionSourceType(activeOrder),
    sourceId: activeOrder.id,
    reference: isInternalCraftOrder(activeOrder)
      ? activeOrder.label || "Internal stock build"
      : activeOrder.customer || "In-store order",
    dueDate: activeOrder.deliveryDate,
    priority: activeOrder.priority,
    assignedTo: activeOrder.handler,
    notes: activeOrder.notes,
    lines: plan.buildLines.map(line => ({ itemName: line.name, requestedQuantity: line.quantity })),
    stockAllocations: plan.stockAllocations,
    fulfillmentLines: plan.fulfillmentLines
  }, isInternalCraftOrder(activeOrder)
    ? "Internal stock build added to the shared queue"
    : "Customer order fulfillment added to the shared queue");
}

async function queueRestockProduction() {
  if (!isManagement() || productionActionPending) return;
  const plan = getReplenishmentPlan();
  const lines = plan.missing.map(line => ({
    itemName: line.itemName,
    requestedQuantity: Math.max(0, Number(line.missing || 0) - queuedProductionQuantity(line.itemName))
  })).filter(line => line.requestedQuantity > 0 && recipeCatalog[line.itemName]);
  if (!lines.length) {
    elements.replenishmentMeta.textContent = "All producible storefront shortages are already covered by active batches";
    return;
  }
  openProductionSourceDialog({
    id: crypto.randomUUID(),
    sourceType: "Storefront Restock",
    sourceId: "",
    reference: `Storefront restock ${formatDelivery(todayKey())}`,
    dueDate: todayKey(),
    priority: "Normal",
    assignedTo: "",
    notes: "Generated from current storefront targets",
    lines
  }, "Missing storefront stock added to the production queue");
}

function openProductionSourceDialog(payload, successMessage) {
  pendingProductionQueue = {
    payload,
    successMessage,
    fulfillmentLines: Array.isArray(payload.fulfillmentLines) ? structuredClone(payload.fulfillmentLines) : []
  };
  delete payload.fulfillmentLines;
  elements.productionSourceStatus.textContent = "";
  renderProductionSourceDialog();
  elements.productionSourceDialog.showModal();
}

function renderProductionSourceDialog() {
  if (!pendingProductionQueue) return;
  const { payload, fulfillmentLines } = pendingProductionQueue;
  const requirements = new Map();
  payload.lines.forEach(line => {
    const recipe = recipeCatalog[line.itemName] || [];
    const crafts = Math.ceil(Number(line.requestedQuantity || 0) / Math.max(1, Number(recipeYieldCatalog[line.itemName] || 1)));
    recipe.forEach(([ingredient, quantity, defaultSource]) => {
      const key = normalize(ingredient);
      const current = requirements.get(key) || {
        ingredient,
        needed: 0,
        sourceLocation: normalizeProductionSourceClient(defaultSource)
      };
      current.needed += crafts * Number(quantity || 0);
      requirements.set(key, current);
    });
  });
  const storage = getLatestCounts("Storage");
  const storefront = getLatestCounts("Storefront");
  const allocationRows = payload.sourceType === "Customer Order" && fulfillmentLines.length ? `
    <section class="production-source-section">
      <div class="production-source-heading">
        <strong>Existing Finished Stock</strong>
        <span>${formatNumber(fulfillmentLines.reduce((sum, line) => sum + Number(line.existingQuantity || 0), 0))} units reserved</span>
      </div>
      ${fulfillmentLines.map(line => `
        <div class="production-allocation-row" data-stock-allocation-row="${escapeHtml(normalize(line.name))}">
          <div>
            <strong>${escapeHtml(line.label || line.name)}</strong>
            <span>${formatNumber(line.orderedQuantity)} ordered / ${formatNumber(line.productionQuantity)} to produce</span>
          </div>
          <div class="production-allocation-controls">
            <label>
              Storage / ${formatNumber(line.storageAvailable)}
              <input data-stock-allocation-location="storage" type="number" min="0" max="${Number(line.storageAvailable || 0)}" step="1" value="${Number(line.storageQuantity || 0)}">
            </label>
            <label>
              Storefront / ${formatNumber(line.storefrontAvailable)}
              <input data-stock-allocation-location="storefront" type="number" min="0" max="${Number(line.storefrontAvailable || 0)}" step="1" value="${Number(line.storefrontQuantity || 0)}">
            </label>
          </div>
        </div>
      `).join("")}
    </section>
  ` : "";
  const materialRows = requirements.size ? `
    <section class="production-source-section">
      <div class="production-source-heading">
        <strong>Production Materials</strong>
        <span>${requirements.size} ${requirements.size === 1 ? "material" : "materials"}</span>
      </div>
      ${[...requirements.entries()].map(([key, requirement]) => `
        <div class="production-source-row" data-production-source-row="${escapeHtml(key)}">
          <div>
            <strong>${escapeHtml(requirement.ingredient)}</strong>
            <span>${formatNumber(requirement.needed)} needed</span>
          </div>
          <label>
            Take From
            <select data-production-source-select>
              <option value="Storage" ${requirement.sourceLocation === "Storage" ? "selected" : ""}>Storage / ${formatNumber(storage.get(key) || 0)} available</option>
              <option value="Storefront" ${requirement.sourceLocation === "Storefront" ? "selected" : ""}>Storefront / ${formatNumber(storefront.get(key) || 0)} available</option>
            </select>
          </label>
        </div>
      `).join("")}
    </section>
  ` : payload.lines.length
    ? ""
    : `<div class="empty-card">Existing stock covers the complete customer order</div>`;
  elements.productionSourceList.innerHTML = `${allocationRows}${materialRows}`;
  elements.productionSourceList.querySelectorAll("[data-stock-allocation-location]").forEach(input => {
    input.addEventListener("change", updatePendingProductionAllocation);
  });
  const missing = fulfillmentLines.filter(line => line.productionQuantity > 0 && !recipeCatalog[line.name]);
  elements.confirmProductionSource.disabled = missing.length > 0;
  elements.productionSourceStatus.textContent = missing.length
    ? `No recipe is attached to ${missing.map(line => line.label || line.name).join(", ")}`
    : "";
}

function updatePendingProductionAllocation() {
  if (!pendingProductionQueue) return;
  const rows = new Map([...elements.productionSourceList.querySelectorAll("[data-stock-allocation-row]")]
    .map(row => [row.dataset.stockAllocationRow, row]));
  pendingProductionQueue.fulfillmentLines = pendingProductionQueue.fulfillmentLines.map(line => {
    const row = rows.get(normalize(line.name));
    if (!row) return line;
    const storageInput = row.querySelector('[data-stock-allocation-location="storage"]');
    const storefrontInput = row.querySelector('[data-stock-allocation-location="storefront"]');
    const orderedQuantity = Number(line.orderedQuantity || 0);
    const storageQuantity = Math.min(
      orderedQuantity,
      Number(line.storageAvailable || 0),
      Math.max(0, Math.floor(Number(storageInput?.value || 0)))
    );
    const storefrontQuantity = Math.min(
      Math.max(0, orderedQuantity - storageQuantity),
      Number(line.storefrontAvailable || 0),
      Math.max(0, Math.floor(Number(storefrontInput?.value || 0)))
    );
    return {
      ...line,
      storageQuantity,
      storefrontQuantity,
      existingQuantity: storageQuantity + storefrontQuantity,
      productionQuantity: Math.max(0, orderedQuantity - storageQuantity - storefrontQuantity)
    };
  });
  pendingProductionQueue.payload.stockAllocations = pendingProductionQueue.fulfillmentLines
    .filter(line => line.existingQuantity > 0)
    .map(line => ({
      itemName: line.name,
      itemLabel: line.label || line.name,
      storageQuantity: line.storageQuantity,
      storefrontQuantity: line.storefrontQuantity
    }));
  pendingProductionQueue.payload.lines = pendingProductionQueue.fulfillmentLines
    .filter(line => line.productionQuantity > 0 && recipeCatalog[line.name])
    .map(line => ({ itemName: line.name, requestedQuantity: line.productionQuantity }));
  renderProductionSourceDialog();
}

function closeProductionSourceDialog() {
  pendingProductionQueue = null;
  if (elements.productionSourceDialog.open) elements.productionSourceDialog.close();
}

async function confirmProductionSourceSelection() {
  if (!pendingProductionQueue || productionActionPending) return;
  const ingredientSources = {};
  elements.productionSourceList.querySelectorAll("[data-production-source-row]").forEach(row => {
    ingredientSources[row.dataset.productionSourceRow] = row.querySelector("[data-production-source-select]").value;
  });
  const { payload, successMessage } = pendingProductionQueue;
  payload.lines = payload.lines.map(line => ({ ...line, ingredientSources }));
  elements.productionSourceStatus.textContent = payload.sourceType === "Internal Craft"
    ? "Queuing internal stock build..."
    : "Queuing fulfillment...";
  elements.confirmProductionSource.disabled = true;
  const queued = await createProductionBatch(payload, successMessage);
  if (queued) closeProductionSourceDialog();
}

async function createProductionBatch(payload, successMessage) {
  productionActionPending = true;
  elements.queueOrderProduction.disabled = true;
  elements.queueRestock.disabled = true;
  try {
    const response = await fetch("/api/production-batches", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(45000)
    });
    const result = await response.json().catch(() => ({ ok: false, error: `API ${response.status}` }));
    if (!response.ok || !result.ok) throw new Error(result.error || `API ${response.status}`);
    productionBatches = Array.isArray(result.batches) ? result.batches : [];
    applySalesOrdersFromResult(result);
    activeProductionBatchId = result.batch.id;
    if (result.batch.status === "Completed" && !result.batch.lines.length) elements.productionFilter.value = "All";
    activeSection = "production";
    elements.productionActionStatus.textContent = successMessage;
    render();
    return true;
  } catch (error) {
    const message = error.name === "TimeoutError" || error.name === "AbortError"
      ? "The server did not respond within 45 seconds. Check the connection and try again."
      : error.message;
    if (pendingProductionQueue && elements.productionSourceDialog.open) {
      elements.productionSourceStatus.textContent = `Unable to queue production: ${message}`;
    } else {
      const status = activeSection === "restock" ? elements.replenishmentMeta : elements.productionMeta;
      status.textContent = `Unable to queue production: ${message}`;
    }
    return false;
  } finally {
    productionActionPending = false;
    if (pendingProductionQueue && elements.productionSourceDialog.open) {
      elements.confirmProductionSource.disabled = false;
    }
    renderProduction();
    renderReplenishment();
  }
}

async function loadProductionBatches({ silent = false } = {}) {
  try {
    const response = await fetch("/api/production-batches", { headers: { accept: "application/json" } });
    if (response.status === 401) {
      window.location.replace("/login.html");
      return;
    }
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || `API ${response.status}`);
    productionBatches = Array.isArray(result.batches) ? result.batches : [];
    if (!activeProductionBatchId || !productionBatches.some(batch => batch.id === activeProductionBatchId)) {
      activeProductionBatchId = productionBatches.find(batch => PRODUCTION_ACTIVE_STATUSES.has(batch.status))?.id
        || productionBatches[0]?.id
        || "";
    }
    elements.productionDataStatus.textContent = `${productionBatches.length} shared ${productionBatches.length === 1 ? "batch" : "batches"} loaded`;
    renderProductionQueue();
    renderReplenishment();
  } catch (error) {
    if (!silent) elements.productionDataStatus.textContent = `Unable to load production: ${error.message}`;
  }
}

function renderProductionQueue() {
  if (!elements.productionSection) return;
  const active = productionBatches.filter(batch => PRODUCTION_ACTIVE_STATUSES.has(batch.status));
  const readinessPlans = getProductionReadinessPlans();
  const readiness = active.map(batch => ({ batch, plan: readinessPlans.get(batch.id) || getProductionBatchMaterialPlan(batch) }));
  const dueToday = active.filter(batch => batch.dueDate === todayKey());
  const ready = readiness.filter(entry => entry.plan.shortageCount === 0);
  const shortCount = readiness.reduce((sum, entry) => sum + Number(entry.plan.shortageCount || 0), 0);
  elements.productionActiveCount.textContent = formatNumber(active.length);
  elements.productionDueCount.textContent = formatNumber(dueToday.length);
  elements.productionReadyCount.textContent = formatNumber(ready.length);
  elements.productionShortCount.textContent = formatNumber(shortCount);
  elements.productionNavCount.textContent = formatNumber(active.length);
  elements.productionNavCount.classList.toggle("hidden", active.length === 0);

  const filter = elements.productionFilter.value || "Active";
  const visible = productionBatches.filter(batch => filter === "All"
    || (filter === "Mine" && normalize(batch.assignedTo) === normalize(currentUser?.fullName))
    || (filter === "Active" ? PRODUCTION_ACTIVE_STATUSES.has(batch.status) : batch.status === filter));
  if (!visible.some(batch => batch.id === activeProductionBatchId)) {
    activeProductionBatchId = visible[0]?.id || "";
  }
  elements.productionBatchList.innerHTML = visible.length
    ? visible.map(batch => {
      const planned = batch.lines.reduce((sum, line) => sum + Number(line.plannedCrafts || 0), 0);
      const completed = batch.lines.reduce((sum, line) => sum + Number(line.completedCrafts || 0), 0);
      const reservedStock = (batch.stockAllocations || []).reduce((sum, allocation) =>
        sum + Number(allocation.storageQuantity || 0) + Number(allocation.storefrontQuantity || 0), 0);
      const materialPlan = readinessPlans.get(batch.id) || getProductionBatchMaterialPlan(batch);
      return `
        <button class="production-batch-row ${batch.id === activeProductionBatchId ? "active" : ""}" type="button" data-production-batch="${escapeHtml(batch.id)}">
          <span class="status-pill ${statusClass(batch.status)}">${escapeHtml(batch.status)}</span>
          <strong>${escapeHtml(batch.reference || batch.sourceType)}</strong>
          <span>${escapeHtml(batch.sourceType)} / ${formatNumber(reservedStock)} existing units / ${formatNumber(completed)} of ${formatNumber(planned)} production cycles</span>
          <small>${batch.assignedTo ? `Assigned to ${escapeHtml(batch.assignedTo)} / ` : "Unassigned / "}${batch.dueDate ? formatDelivery(batch.dueDate) : "No due date"}${materialPlan.shortageCount ? ` / ${formatNumber(materialPlan.shortageCount)} material shorts` : " / Materials ready"}</small>
        </button>
      `;
    }).join("")
    : `<div class="empty-card">No production batches in this view</div>`;
  elements.productionBatchList.querySelectorAll("[data-production-batch]").forEach(button => {
    button.addEventListener("click", () => {
      activeProductionBatchId = button.dataset.productionBatch;
      renderProductionQueue();
    });
  });
  renderProductionDetail(visible.find(batch => batch.id === activeProductionBatchId));
}

function renderProductionDetail(batch) {
  if (!batch) {
    elements.productionDetailSource.textContent = "Select a batch";
    elements.productionDetailTitle.textContent = "No production batch selected";
    elements.productionDetailMeta.textContent = "Choose a batch from the register";
    elements.productionDetailStatus.textContent = "Waiting";
    elements.productionDetailStatus.className = "status-pill";
    elements.productionDetailDue.textContent = "-";
    elements.productionDetailAssigned.textContent = "-";
    elements.productionDetailCreatedBy.textContent = "-";
    elements.productionDetailUpdated.textContent = "-";
    elements.productionProgressLines.innerHTML = `<div class="empty-card">No production lines selected</div>`;
    elements.productionMaterialStatus.innerHTML = `<div class="empty-card">No material plan selected</div>`;
    elements.productionActionStatus.textContent = "Select a batch to begin";
    elements.startProduction.disabled = true;
    elements.recordProduction.disabled = true;
    elements.cancelProduction.disabled = true;
    return;
  }

  const closed = batch.status === "Completed" || batch.status === "Cancelled";
  const pendingTargets = new Map((batch.pendingProgress?.targets || []).map(target => [target.lineId, target.completedCrafts]));
  elements.productionDetailSource.textContent = batch.sourceType;
  elements.productionDetailTitle.textContent = batch.reference || "Production batch";
  const reservedStock = (batch.stockAllocations || []).reduce((sum, allocation) =>
    sum + Number(allocation.storageQuantity || 0) + Number(allocation.storefrontQuantity || 0), 0);
  elements.productionDetailMeta.textContent = `${batch.lines.length} production ${batch.lines.length === 1 ? "line" : "lines"} / ${formatNumber(reservedStock)} existing units / ${batch.priority}${batch.notes ? ` / ${batch.notes}` : ""}`;
  elements.productionDetailStatus.textContent = batch.status;
  elements.productionDetailStatus.className = `status-pill ${statusClass(batch.status)}`;
  elements.productionDetailDue.textContent = batch.dueDate ? formatDelivery(batch.dueDate) : "No due date";
  elements.productionDetailAssigned.textContent = batch.assignedTo || "Unassigned";
  elements.productionDetailCreatedBy.textContent = batch.createdBy || "Unknown";
  elements.productionDetailUpdated.textContent = formatDateTime(batch.updatedAt);
  const allocationMarkup = (batch.stockAllocations || []).map(allocation => `
    <div class="production-progress-row production-stock-allocation">
      <div>
        <strong>${escapeHtml(allocation.itemLabel || allocation.itemName)}</strong>
        <span>${formatNumber(Number(allocation.storageQuantity || 0) + Number(allocation.storefrontQuantity || 0))} existing units reserved${allocation.storageQuantity ? ` / ${formatNumber(allocation.storageQuantity)} storage` : ""}${allocation.storefrontQuantity ? ` / ${formatNumber(allocation.storefrontQuantity)} storefront` : ""}</span>
      </div>
      <span class="status-pill ready">Reserved</span>
    </div>
  `).join("");
  const productionMarkup = batch.lines.map(line => {
    const completedCrafts = Number(line.completedCrafts || 0);
    const plannedCrafts = Number(line.plannedCrafts || 0);
    const inputValue = pendingTargets.get(line.id) ?? completedCrafts;
    return `
      <div class="production-progress-row">
        <div>
          <strong>${escapeHtml(line.itemLabel || line.itemName)}</strong>
          <span>${formatNumber(line.requestedQuantity)} requested / ${formatNumber(plannedCrafts * line.recipeYield)} planned output</span>
        </div>
        <div class="production-cycle-control">
          <span>${formatNumber(completedCrafts)} / ${formatNumber(plannedCrafts)}</span>
          <input data-production-progress-line="${escapeHtml(line.id)}" type="number" min="${completedCrafts}" max="${plannedCrafts}" step="1" value="${inputValue}" aria-label="Completed production cycles for ${escapeHtml(line.itemLabel || line.itemName)}" ${closed ? "disabled" : ""}>
        </div>
      </div>
    `;
  }).join("");
  elements.productionProgressLines.innerHTML = allocationMarkup || productionMarkup
    ? `${allocationMarkup}${productionMarkup}`
    : `<div class="empty-card">No fulfillment lines selected</div>`;

  const materialPlan = getProductionBatchMaterialPlan(batch);
  elements.productionMaterialStatus.innerHTML = materialPlan.materials.length
    ? materialPlan.materials.map(material => `
      <div class="production-material-row ${material.shortage > 0 ? "short" : "ready"}">
        <strong>${escapeHtml(material.ingredient)}</strong>
        <span>${escapeHtml(material.sourceLocation)} / ${formatNumber(material.available)} available / ${formatNumber(material.needed)} needed</span>
        <small>${material.shortage > 0 ? `${formatNumber(material.shortage)} short` : "Ready"}</small>
      </div>
    `).join("")
    : `<div class="empty-card">No remaining materials needed</div>`;
  elements.productionActionStatus.textContent = batch.pendingProgress
      ? "Data update paused. Record Progress will retry the saved movements safely."
    : materialPlan.shortageCount
      ? `${materialPlan.shortageCount} materials are short`
      : closed ? batch.status : "Materials available for the remaining plan";
  elements.startProduction.disabled = productionActionPending || closed || batch.status !== "Planned";
  elements.recordProduction.disabled = productionActionPending || closed;
  elements.cancelProduction.disabled = productionActionPending || closed || !isManagement();
}

function getProductionBatchMaterialPlan(batch) {
  const reservedPlan = getProductionReadinessPlans().get(batch.id);
  if (reservedPlan) return reservedPlan;
  const materials = getProductionBatchMaterialNeeds(batch).map(material => {
    const available = Number(getLatestCounts(material.sourceLocation).get(material.itemKey) || 0);
    return { ...material, available, shortage: Math.max(0, material.needed - available) };
  });
  return { materials, shortageCount: materials.filter(material => material.shortage > 0).length };
}

function getProductionBatchMaterialNeeds(batch) {
  const totals = new Map();
  batch.lines.forEach(line => {
    const remainingCrafts = Math.max(0, Number(line.plannedCrafts || 0) - Number(line.completedCrafts || 0));
    line.recipe.forEach(component => {
      const sourceLocation = normalizeProductionSourceClient(component.sourceLocation);
      const itemKey = normalize(component.ingredient);
      const key = `${sourceLocation}:${itemKey}`;
      const current = totals.get(key) || { ingredient: component.ingredient, sourceLocation, itemKey, needed: 0 };
      current.needed += remainingCrafts * Number(component.quantity || 0);
      totals.set(key, current);
    });
  });
  return [...totals.entries()].map(([key, material]) => ({ key, ...material }));
}

function getProductionReadinessPlans() {
  const remaining = {
    Storage: new Map(getLatestCounts("Storage")),
    Storefront: new Map(getLatestCounts("Storefront"))
  };
  const plans = new Map();
  productionBatches.filter(batch => PRODUCTION_ACTIVE_STATUSES.has(batch.status)).forEach(batch => {
    const materials = getProductionBatchMaterialNeeds(batch).map(material => {
      const sourceCounts = remaining[material.sourceLocation];
      const available = Number(sourceCounts.get(material.itemKey) || 0);
      const shortage = Math.max(0, material.needed - available);
      sourceCounts.set(material.itemKey, Math.max(0, available - material.needed));
      return { ...material, available, shortage };
    }).sort((a, b) => b.shortage - a.shortage || a.ingredient.localeCompare(b.ingredient));
    plans.set(batch.id, {
      materials,
      shortageCount: materials.filter(material => material.shortage > 0).length
    });
  });
  return plans;
}

function queuedProductionQuantity(itemName) {
  const wanted = normalize(itemName);
  return productionBatches.filter(batch => PRODUCTION_ACTIVE_STATUSES.has(batch.status))
    .flatMap(batch => batch.lines)
    .filter(line => normalize(line.itemName) === wanted)
    .reduce((sum, line) => sum + Math.max(0,
      (Number(line.plannedCrafts || 0) - Number(line.completedCrafts || 0)) * Number(line.recipeYield || 1)
    ), 0);
}

async function startSelectedProductionBatch() {
  const batch = productionBatches.find(candidate => candidate.id === activeProductionBatchId);
  if (!batch || productionActionPending) return;
  await runProductionAction(batch, "start", {}, "Batch started");
}

async function recordSelectedProductionProgress() {
  const batch = productionBatches.find(candidate => candidate.id === activeProductionBatchId);
  if (!batch || productionActionPending) return;
  const completions = [...elements.productionProgressLines.querySelectorAll("[data-production-progress-line]")]
    .map(input => ({ lineId: input.dataset.productionProgressLine, completedCrafts: Number(input.value) }))
    .filter(completion => {
      const line = batch.lines.find(candidate => candidate.id === completion.lineId);
      return line && completion.completedCrafts > Number(line.completedCrafts || 0);
    });
  if (!completions.length && !batch.pendingProgress) {
    elements.productionActionStatus.textContent = "Increase at least one completed craft-cycle total";
    return;
  }
  await runProductionAction(batch, "progress", { completions }, "Production progress recorded");
  await loadBackendSnapshot({ silent: true });
}

async function cancelSelectedProductionBatch() {
  const batch = productionBatches.find(candidate => candidate.id === activeProductionBatchId);
  if (!batch || !isManagement() || productionActionPending) return;
  if (!window.confirm(`Cancel production batch ${batch.reference || batch.id}?`)) return;
  await runProductionAction(batch, "cancel", {}, "Production batch cancelled / available under Cancelled");
}

async function runProductionAction(batch, action, payload, successMessage) {
  productionActionPending = true;
  let finalMessage = "";
  renderProductionDetail(batch);
  elements.productionActionStatus.textContent = action === "progress" ? "Writing production movements to the shared ledger" : "Updating production batch";
  try {
    const response = await fetch(`/api/production-batches/${encodeURIComponent(batch.id)}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(payload)
    });
    const result = await response.json().catch(() => ({ ok: false, error: `API ${response.status}` }));
    if (!response.ok || !result.ok) throw new Error(result.error || `API ${response.status}`);
    productionBatches = Array.isArray(result.batches) ? result.batches : [];
    applySalesOrdersFromResult(result);
    activeProductionBatchId = result.batch.id;
    finalMessage = action === "progress" && result.batch.sourceType === "Storefront Restock"
      ? "Materials recorded / awaiting storefront deposit"
      : successMessage;
  } catch (error) {
    finalMessage = `Update failed: ${error.message}`;
    await loadProductionBatches({ silent: true });
  } finally {
    productionActionPending = false;
    renderProductionQueue();
    renderReplenishment();
    if (finalMessage) {
      if (activeProductionBatchId === batch.id) {
        elements.productionActionStatus.textContent = finalMessage;
      } else {
        elements.productionDataStatus.textContent = finalMessage;
      }
    }
  }
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
      syncStatus: "Pending data sync"
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
      syncStatus: "Pending data sync"
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
  const kind = elements.ledgerType.value;
  const enteredAmount = Number(elements.ledgerAmount.value || 0);
  const amount = kind === "Correction" ? enteredAmount : Math.abs(enteredAmount);
  if (!Number.isFinite(amount) || (kind !== "Ledger Count" && amount === 0)) {
    elements.ledgerAmount.focus();
    return;
  }
  addOperation({
    kind,
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
  const location = elements.targetLocation.value === "Storage" ? "Storage" : "Storefront";
  const targets = location === "Storage" ? storageTargets : stockTargets;
  const item = location === "Storage"
    ? resolveStockItem(elements.targetItem.value)
    : resolveItem(elements.targetItem.value);
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
    location,
    updatedAt: new Date().toISOString(),
    syncStatus: "Pending data sync"
  };
  const existingIndex = targets.findIndex(saved => stockKey(saved) === stockKey(nextTarget));
  if (existingIndex >= 0 && target === 0) {
    removeInventoryTarget(location, stockKey(nextTarget));
    elements.targetItem.value = "";
    elements.targetQuantity.value = "0";
    elements.saveTarget.textContent = "Save Target";
    return;
  }
  if (existingIndex < 0 && target === 0) return;
  if (existingIndex >= 0) {
    targets[existingIndex] = nextTarget;
  } else {
    targets.unshift(nextTarget);
  }

  persistInventoryTargets(location);
  elements.targetItem.value = "";
  elements.targetQuantity.value = "0";
  elements.saveTarget.textContent = "Save Target";
  renderOperations();
  renderReplenishment();
  renderStoreOverview();
  syncInventoryTarget(location, stockKey(nextTarget));
}

function addOperation(entry) {
  const savedEntry = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    syncStatus: "Pending data sync",
    ...entry
  };
  operations.unshift(savedEntry);
  persistOperations();
  renderOperations();
  renderStoreOverview();
  return syncOperation(savedEntry.id);
}

function renderOperations() {
  const visibleOperations = currentRole === "admin"
    ? operations
    : currentRole === "manager"
      ? operations.filter(entry => entry.location !== "Payroll")
      : [];
  const pendingCount = visibleOperations.filter(entry => entry.syncStatus !== "Synced").length;
  elements.operationCount.textContent = `${pendingCount} entries waiting for data sync`;
  renderTargets();

  if (!visibleOperations.length) {
    elements.operationList.innerHTML = `<div class="empty-card">No manual activity recorded yet</div>`;
    return;
  }

  elements.operationList.innerHTML = visibleOperations.slice(0, 30).map(entry => {
    const title = entry.itemLabel || entry.itemName || entry.location || "Ledger";
    const quantity = entry.quantity !== "" ? `Qty ${formatNumber(entry.quantity)}` : "";
    const amount = entry.amount !== "" ? formatCurrency(entry.amount) : "";
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
  renderTargetCollection("Storefront", stockTargets, elements.targetList);
  renderTargetCollection("Storage", storageTargets, elements.storageTargetList);
}

function productionBatchForOrder(orderId) {
  if (!orderId) return null;
  return productionBatches.find(batch => ORDER_PRODUCTION_SOURCE_TYPES.has(batch.sourceType)
    && batch.sourceId === orderId
    && batch.status !== "Cancelled") || null;
}

function getFinishedStockReservations(excludeOrderId = "") {
  const reservations = { Storage: new Map(), Storefront: new Map() };
  const ordersById = new Map(orders.map(order => [order.id, order]));
  productionBatches.forEach(batch => {
    if (batch.sourceType !== "Customer Order" || batch.status === "Cancelled" || batch.sourceId === excludeOrderId) return;
    const order = ordersById.get(batch.sourceId);
    if (!order || statusesHiddenFromActive.has(order.status)) return;
    (batch.stockAllocations || []).forEach(allocation => {
      const key = normalize(allocation.itemName || allocation.itemLabel);
      [["Storage", allocation.storageQuantity], ["Storefront", allocation.storefrontQuantity]].forEach(([location, quantity]) => {
        reservations[location].set(key, Number(reservations[location].get(key) || 0) + Number(quantity || 0));
      });
    });
  });
  return reservations;
}

function applySalesOrdersFromResult(result) {
  if (!Array.isArray(result?.orders)) return;
  orders = result.orders;
  if (!activeOrderDirty) {
    const refreshed = orders.find(order => order.id === activeOrder.id);
    if (refreshed) activeOrder = structuredClone(refreshed);
  }
}

function renderTargetCollection(location, targets, listElement) {
  if (!targets.length) {
    listElement.innerHTML = `<div class="empty-card">No ${location.toLowerCase()} targets set yet</div>`;
    return;
  }
  const counts = getLatestCounts(location);
  listElement.innerHTML = targets.map(target => {
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
      <span>Target ${formatNumber(target.target)} / Counted ${formatNumber(current)} / ${escapeHtml(target.syncStatus || "Pending data sync")}</span>
      </div>
    `;
  }).join("");

  listElement.querySelectorAll("[data-target-edit]").forEach(button => {
    button.addEventListener("click", () => editInventoryTarget(location, button.dataset.targetEdit));
  });
  listElement.querySelectorAll("[data-target-remove]").forEach(button => {
    button.addEventListener("click", () => removeInventoryTarget(location, button.dataset.targetRemove));
  });
}

function editInventoryTarget(location, targetKey) {
  const targets = location === "Storage" ? storageTargets : stockTargets;
  const target = targets.find(item => stockKey(item) === targetKey);
  if (!target || target.deleting) return;
  elements.targetLocation.value = location;
  seedTargetDatalist();
  elements.targetItem.value = target.itemLabel || target.itemName;
  elements.targetQuantity.value = target.target;
  elements.saveTarget.textContent = "Update Target";
  elements.targetQuantity.focus();
  elements.targetQuantity.select();
}

function removeInventoryTarget(location, targetKey) {
  const targets = location === "Storage" ? storageTargets : stockTargets;
  const target = targets.find(item => stockKey(item) === targetKey);
  if (!target || target.deleting) return;
  if (!window.confirm(`Remove the ${location.toLowerCase()} target for ${target.itemLabel || target.itemName}?`)) return;

  target.target = 0;
  target.location = location;
  target.updatedAt = new Date().toISOString();
  target.deleting = true;
  target.syncStatus = "Removal pending";
  persistInventoryTargets(location);
  renderOperations();
  renderReplenishment();
  renderStoreOverview();
  syncInventoryTarget(location, targetKey);
}

function persistInventoryTargets(location) {
  if (location === "Storage") persistStorageTargets();
  else persistStockTargets();
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
  const item = window.FRONTIER_INVENTORY_COUNTS.resolveCatalogItem(stockCatalog, trimmed);
  return item || { name: trimmed, label: trimmed, tag: "", category: "Manual" };
}

async function loadSessionAndData() {
  try {
    const response = await fetch("/api/auth/session", { headers: { accept: "application/json" } });
    const result = await response.json();
    if (!response.ok || !result.user) throw new Error("Authentication required");
    currentUser = result.user;
    currentWorkspace = result.workspace || null;
    workspaceProfile = result.jobProfile || {
      accountType: currentUser.accountType || "local",
      currentBusinessId: currentWorkspace?.id || "",
      jobs: currentWorkspace ? [{
        businessId: currentWorkspace.id,
        workspaceCode: currentWorkspace.code,
        businessName: currentWorkspace.name,
        fullName: currentUser.fullName,
        role: currentUser.role,
        status: "active",
        current: true
      }] : []
    };
    currentRole = currentUser.role;
    timeClock = loadTimeClock(timeClockStorageKey());
    migrateLegacyTimeClock();
    applyIdentityDefaults();
    render();
    await migrateLegacySalesOrders();
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
    elements.payrollEnteredBy,
    elements.financeFundsEmployee
  ];
  identityFields.forEach(field => {
    if (!field) return;
    field.value = currentUser.fullName;
    field.disabled = true;
  });
  if (!activeOrder.handler) activeOrder.handler = currentUser.fullName;
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

function renderWorkspaceSwitcher() {
  if (!elements.workspaceSwitcher) return;
  const jobs = Array.isArray(workspaceProfile?.jobs) ? workspaceProfile.jobs : [];
  const activeCount = jobs.filter(job => job.status === "active").length;
  elements.workspaceSwitcher.classList.toggle("hidden", !currentWorkspace);
  elements.workspaceCount.textContent = String(Math.max(1, activeCount));
  elements.workspaceSwitcher.title = activeCount > 1
    ? `Switch between ${activeCount} active businesses`
    : "Link or open another business";
}

function openWorkspaceDialog() {
  renderWorkspaceJobs();
  setWorkspaceDialogStatus("");
  elements.workspaceDialog.showModal();
}

function closeWorkspaceDialog() {
  if (elements.workspaceDialog.open) elements.workspaceDialog.close();
}

function renderWorkspaceJobs() {
  const jobs = [...(workspaceProfile?.jobs || [])].sort((left, right) =>
    Number(Boolean(right.current)) - Number(Boolean(left.current))
    || workspaceJobStatusRank(left.status) - workspaceJobStatusRank(right.status)
    || String(left.businessName || "").localeCompare(String(right.businessName || ""))
  );
  elements.workspaceJobList.innerHTML = jobs.length ? jobs.map(job => {
    const active = job.status === "active";
    const current = Boolean(job.current) || job.businessId === currentWorkspace?.id;
    return `
      <div class="workspace-job-row ${current ? "current" : ""}">
        <div>
          <strong>${escapeHtml(job.businessName || "Business")}</strong>
          <span>${escapeHtml(job.fullName || currentUser?.fullName || "")} / ${escapeHtml(workspaceRoleLabel(job.role))}</span>
          <small>${escapeHtml(job.workspaceCode || "")} / ${escapeHtml(workspaceJobStatusLabel(job.status))}</small>
        </div>
        ${current
          ? '<span class="workspace-current-mark">Current</span>'
          : active
            ? `<button class="ghost-button" type="button" data-workspace-business-id="${escapeHtml(job.businessId)}" data-workspace-membership-id="${escapeHtml(job.membershipId || job.id || "")}">Open</button>`
            : `<span class="workspace-job-state">${escapeHtml(workspaceJobStatusLabel(job.status))}</span>`}
      </div>
    `;
  }).join("") : '<div class="empty-card">No business jobs are connected yet</div>';

  const discord = workspaceProfile?.accountType === "discord";
  elements.localWorkspaceLinkSection.classList.toggle("hidden", discord);
  elements.discordWorkspaceLinkSection.classList.toggle("hidden", !discord);
}

async function switchWorkspace(event) {
  const button = event.target.closest("[data-workspace-business-id]");
  if (!button) return;
  elements.workspaceJobList.querySelectorAll("button").forEach(control => { control.disabled = true; });
  setWorkspaceDialogStatus("Opening business...");
  const result = await workspaceRequest("/api/workspaces/select", {
    businessId: button.dataset.workspaceBusinessId,
    membershipId: button.dataset.workspaceMembershipId
  });
  if (!result.ok) {
    renderWorkspaceJobs();
    setWorkspaceDialogStatus(result.error || "Business could not be opened", "error");
    return;
  }
  if (result.workspace?.code) localStorage.setItem("business_ledger_workspace_code", result.workspace.code);
  window.location.replace("/");
}

async function linkWorkspaceJob(event) {
  event.preventDefault();
  if (workspaceProfile?.accountType === "discord") return;
  const workspaceCode = formatWorkspaceCode(elements.linkJobWorkspace.value);
  const fullName = elements.linkJobName.value.trim();
  const password = elements.linkJobPassword.value;
  if (!workspaceCode || !fullName || !password) {
    setWorkspaceDialogStatus("Enter the workspace code, character name, and password", "error");
    return;
  }
  setWorkspaceLinkBusy(true);
  setWorkspaceDialogStatus("Verifying approved job...");
  const result = await workspaceRequest("/api/workspaces/link", { workspaceCode, fullName, password });
  setWorkspaceLinkBusy(false);
  if (!result.ok) {
    setWorkspaceDialogStatus(result.error || "Job could not be linked", "error");
    return;
  }
  workspaceProfile = result.profile || workspaceProfile;
  elements.linkJobWorkspace.value = "";
  elements.linkJobName.value = "";
  elements.linkJobPassword.value = "";
  renderWorkspaceSwitcher();
  renderWorkspaceJobs();
  setWorkspaceDialogStatus(`${result.job?.businessName || "Business"} linked to your profile`, "success");
}

async function workspaceRequest(url, body) {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const result = await response.json();
    return { ...result, ok: response.ok && result.ok !== false };
  } catch {
    return { ok: false, error: "The workspace service could not be reached" };
  }
}

function setWorkspaceLinkBusy(busy) {
  [elements.linkJobWorkspace, elements.linkJobName, elements.linkJobPassword, elements.linkJob]
    .forEach(control => { control.disabled = busy; });
}

function setWorkspaceDialogStatus(message, tone = "") {
  elements.workspaceDialogStatus.textContent = message;
  elements.workspaceDialogStatus.className = `form-status${tone ? ` ${tone}` : ""}`;
}

function formatWorkspaceCode(value) {
  const compact = String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
  return compact.length > 5 ? `${compact.slice(0, 5)}-${compact.slice(5)}` : compact;
}

function workspaceRoleLabel(role) {
  return ({ admin: "Admin", manager: "Manager", employee: "Employee" })[role] || "Employee";
}

function workspaceJobStatusLabel(status) {
  return ({ active: "Active", pending: "Awaiting approval", disabled: "Disabled", rejected: "Rejected" })[status] || status || "Unavailable";
}

function workspaceJobStatusRank(status) {
  return ({ active: 0, pending: 1, disabled: 2, rejected: 3 })[status] ?? 4;
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
        <span>${escapeHtml(({ admin: "Admin", manager: "Manager", employee: "Employee" })[user.role] || user.role)} / ${escapeHtml(user.status)}${user.accountType === "discord" ? " / Discord" : ""}</span>
        ${user.discordUsername ? `<small>@${escapeHtml(user.discordUsername)}${user.settingName ? ` / ${escapeHtml(user.settingName)}` : ""}</small>` : ""}
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
  return [details.kind, details.item, details.location, details.quantity !== "" ? `Qty ${details.quantity}` : "", details.amount !== "" ? formatCurrency(details.amount) : "", details.note]
      .filter(Boolean).join(" / ");
  }
  if (["target.updated", "target.removed", "storage_target.updated", "storage_target.removed"].includes(event.action)) {
    const updated = event.action.endsWith(".updated");
    return [details.item, updated ? `Target ${details.target}` : "Removed"].filter(Boolean).join(" / ");
  }
  if (String(event.action || "").startsWith("storefront_buy_order.")) {
  return [details.status, details.quantity !== undefined ? `Ordered ${details.quantity}` : "", details.filledQuantity !== undefined ? `Filled ${details.filledQuantity}` : "", details.unitPrice !== undefined ? `${formatCurrency(details.unitPrice)} each` : ""]
      .filter(Boolean).join(" / ");
  }
  if (event.action === "account.role_changed") return `${details.previousRole} to ${details.role}`;
  if (details.previousStatus || details.status) return [details.previousStatus, details.status].filter(Boolean).join(" to ");
  return "";
}

async function syncOperation(entryId) {
  const entry = operations.find(item => item.id === entryId);
  if (!entry) return;
  const result = await syncToBackend("manual_operation", { entry });
  entry.syncStatus = result.ok ? "Synced" : "Pending data sync";
  entry.syncedAt = result.ok ? new Date().toISOString() : "";
  persistOperations();
  renderOperations();
  renderStoreOverview();
  return result;
}

async function syncStockTarget(targetKey) {
  return syncInventoryTarget("Storefront", targetKey);
}

async function syncInventoryTarget(location, targetKey) {
  const targets = location === "Storage" ? storageTargets : stockTargets;
  const target = targets.find(item => stockKey(item) === targetKey);
  if (!target) return;
  const result = await syncToBackend(location === "Storage" ? "storage_target" : "stock_target", { target });
  if (result.ok && target.deleting) {
    if (location === "Storage") storageTargets = storageTargets.filter(item => stockKey(item) !== targetKey);
    else stockTargets = stockTargets.filter(item => stockKey(item) !== targetKey);
  } else {
    target.syncStatus = result.ok ? "Synced" : (target.deleting ? "Removal pending" : "Pending data sync");
  }
  persistInventoryTargets(location);
  renderOperations();
  renderReplenishment();
  renderStoreOverview();
}

async function syncTimeClockEntry(entryId) {
  const entry = timeClock.entries.find(item => item.id === entryId)
    || (timeClock.current?.id === entryId ? timeClock.current : null);
  if (!entry) return;
  const result = await syncToBackend("time_clock", { entry });
  const latestEntry = timeClock.entries.find(item => item.id === entryId)
    || (timeClock.current?.id === entryId ? timeClock.current : null);
  if (latestEntry) latestEntry.syncStatus = result.ok ? "Synced" : "Pending data sync";
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
    const result = await response.json().catch(() => ({ ok: false, error: `API ${response.status}` }));
    if (response.status === 401) {
      window.location.replace("/login.html");
      return { ok: false, error: "Authentication required" };
    }
    if (!response.ok) return { ok: false, error: result.error || `API ${response.status}` };
    return result;
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function startBackendRefreshLoop() {
  if (backendRefreshTimer) return;
  backendRefreshTimer = window.setInterval(() => {
    if (document.visibilityState === "visible") {
      loadBackendSnapshot({ silent: true, preserveReviewEditor: true });
    }
  }, BACKEND_REFRESH_INTERVAL_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshBackendIfStale();
  });
  window.addEventListener("focus", refreshBackendIfStale);
}

function refreshBackendIfStale() {
  if (!currentUser || Date.now() - lastBackendRefreshAt < FOCUS_REFRESH_STALE_MS) return;
  loadBackendSnapshot({ silent: true, preserveReviewEditor: true });
  if (isManagement()) {
    loadSupplyOrders({ silent: true });
  }
  if (activeSection === "finance" && isAdmin()) loadFinance({ silent: true });
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

async function performBackendRefresh({ silent = false, preserveReviewEditor = false } = {}) {
  const previousSnapshot = backendSnapshot;
  try {
    if (legacyOrdersPendingMigration.length) await migrateLegacySalesOrders();
    const response = await fetch("/api/bootstrap", { headers: { Accept: "application/json" } });
    if (response.status === 401) {
      window.location.replace("/login.html");
      return;
    }
    if (!response.ok) throw new Error(`API ${response.status}`);
    const nextSnapshot = await response.json();
    const dataReady = Boolean(nextSnapshot.sheet?.ok);
    hydrateSharedSalesOrders(nextSnapshot);
    hydrateDailyCloses(nextSnapshot);
    productionBatches = Array.isArray(nextSnapshot.productionBatches) ? nextSnapshot.productionBatches : productionBatches;
    if (!activeProductionBatchId || !productionBatches.some(batch => batch.id === activeProductionBatchId)) {
      activeProductionBatchId = productionBatches.find(batch => PRODUCTION_ACTIVE_STATUSES.has(batch.status))?.id
        || productionBatches[0]?.id
        || "";
    }
    renderProductionQueue();
    if (!dataReady && previousSnapshot?.sheet?.ok) {
      elements.dataStatus.textContent = `Data refresh delayed / last synced ${formatDateTime(lastBackendRefreshAt)}`;
      return;
    }
    backendSnapshot = nextSnapshot;
    applyBusinessConfiguration(nextSnapshot);
    hydrateSharedCatalog(nextSnapshot);
    if (isManagement()) renderCatalogLedger();
    if (isManagement()) {
      reviewExceptions = Array.isArray(nextSnapshot.sheet?.reviewExceptions)
        ? nextSnapshot.sheet.reviewExceptions
        : [];
      webhookLog = Array.isArray(nextSnapshot.sheet?.webhookLog)
        ? nextSnapshot.sheet.webhookLog
        : [];
    }
    if (isManagement() && Array.isArray(nextSnapshot.storefrontBuyOrders)) {
      storefrontBuyOrders = nextSnapshot.storefrontBuyOrders;
      const refreshedBuyOrder = storefrontBuyOrders.find(order => order.id === activeStorefrontBuyOrder.id);
      if (refreshedBuyOrder && !storefrontBuyOrderDirty) {
        activeStorefrontBuyOrder = structuredClone(refreshedBuyOrder);
      }
      elements.buyOrderDataStatus.textContent = `${storefrontBuyOrders.length} shared buy ${storefrontBuyOrders.length === 1 ? "order" : "orders"} loaded`;
    }
    lastBackendRefreshAt = Date.now();
    const backendText = backendSnapshot.dataBackend === "postgresql"
      ? " / PostgreSQL"
      : dataReady && Array.isArray(backendSnapshot.sheet?.sheets)
        ? ` / ${backendSnapshot.sheet.sheets.length} legacy tabs`
        : " / shared data unavailable";
    elements.dataStatus.textContent = `Data synced ${formatDateTime(lastBackendRefreshAt)} / ${backendSnapshot.items.length} items${backendText}`;
    if (dataReady) {
      hydrateSheetInventory();
      renderDashboard();
      renderStoreOverview();
      renderOperations();
      renderSupplyWorkspace();
      renderStorefrontBuyOrderWorkspace();
      renderReviewWorkspace({ preserveEditor: preserveReviewEditor });
      if (activeSection === "finance" && isAdmin()) loadFinance({ silent: true });
      if (!silent) retryPendingSyncs();
    } else {
      renderStoreOverview();
    }
  } catch {
    if (previousSnapshot) {
      backendSnapshot = previousSnapshot;
      elements.dataStatus.textContent = `Data refresh delayed / last synced ${formatDateTime(lastBackendRefreshAt)}`;
    } else {
      backendSnapshot = null;
      elements.dataStatus.textContent = "Shared data unavailable / unsynced entries remain in this browser until the connection returns";
    }
  }
}

function hydrateSharedSalesOrders(snapshot) {
  if (!Array.isArray(snapshot?.salesOrders)) return;
  const sharedOrders = snapshot.salesOrders;
  if (legacyOrdersPendingMigration.length) {
    const merged = new Map(sharedOrders.map(order => [order.id, order]));
    legacyOrdersPendingMigration.forEach(order => {
      if (!merged.has(order.id)) merged.set(order.id, order);
    });
    orders = [...merged.values()];
  } else {
    orders = sharedOrders;
  }

  if (!activeOrderDirty) {
    const refreshed = orders.find(order => order.id === activeOrder.id);
    if (refreshed) activeOrder = structuredClone(refreshed);
    else if (activeOrder.revision > 0) activeOrder = newOrder();
  }
  renderOrdersList();
  renderDashboard();
}

function hydrateDailyCloses(snapshot) {
  if (!Array.isArray(snapshot?.dailyCloses)) return;
  dailyCloses = snapshot.dailyCloses;
  if (!dailyCloseDirty) {
    const refreshed = dailyCloses.find(close => close.id === activeDailyClose.id)
      || dailyCloses.find(close => close.businessDate === todayKey());
    if (refreshed) activeDailyClose = structuredClone(refreshed);
  }
  renderDailyCloseWorkspace();
  renderLatestHandoff();
}

function hydrateSheetInventory() {
  const products = backendSnapshot?.sheet?.inventory?.products;
  const storage = backendSnapshot?.sheet?.inventory?.storage;
  const generatedAt = backendSnapshot?.sheet?.generatedAt || backendSnapshot?.generatedAt;
  if (Array.isArray(products)) {
    stockTargets = mergeSharedTargets(products, stockTargets, "target", "Storefront", generatedAt);
  }
  if (Array.isArray(storage)) {
    storageTargets = mergeSharedTargets(storage, storageTargets, "storageTarget", "Storage", generatedAt);
  }
  persistStockTargets();
  persistStorageTargets();
}

function mergeSharedTargets(rows, localTargets, field, location, generatedAt) {
  const mergedTargets = new Map();
  rows
    .filter(row => Number(row[field] || 0) > 0)
    .forEach(row => {
      const target = {
        itemName: row.itemName || row.ingredient || row.name,
        itemLabel: row.itemLabel || row.ingredient || row.name || row.itemName,
        itemTag: row.itemTag || "",
        target: Number(row[field] || 0),
        location,
        updatedAt: generatedAt,
        syncStatus: "Synced"
      };
      mergedTargets.set(stockKey(target), target);
    });
  localTargets
    .filter(target => target.syncStatus !== "Synced" || target.deleting)
    .forEach(target => mergedTargets.set(stockKey(target), target));
  return [...mergedTargets.values()]
    .sort((a, b) => (a.itemLabel || a.itemName).localeCompare(b.itemLabel || b.itemName));
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

  const storageTargetKeys = storageTargets
    .filter(target => target.syncStatus !== "Synced")
    .map(stockKey);
  for (const targetKey of storageTargetKeys) await syncInventoryTarget("Storage", targetKey);

  const shiftIds = timeClock.entries
    .filter(entry => entry.syncStatus !== "Synced")
    .map(entry => entry.id);
  if (timeClock.current?.syncStatus !== "Synced") shiftIds.push(timeClock.current?.id);
  for (const entryId of shiftIds.filter(Boolean)) await syncTimeClockEntry(entryId);
}

function getReplenishmentPlan() {
  const storefrontCounts = getLatestCounts("Storefront");
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
    recipe.forEach(([ingredient, qty, source]) => {
      const sourceLocation = normalizeProductionSourceClient(source);
      const key = `${sourceLocation}:${normalize(ingredient)}`;
      const current = materialTotals.get(key) || { ingredient, sourceLocation, needed: 0 };
      current.needed += Number(qty || 0) * batches;
      materialTotals.set(key, current);
    });
  });

  const materials = [...materialTotals.values()]
    .map(material => {
      const available = getLatestCounts(material.sourceLocation).get(normalize(material.ingredient)) || 0;
      return {
        ...material,
        available,
        shortage: Math.max(0, material.needed - available)
      };
    })
    .sort((a, b) => b.shortage - a.shortage || a.ingredient.localeCompare(b.ingredient));

  return { missing, materials, missingRecipes };
}

function getStorageAlertPlan() {
  const storageCounts = getLatestCounts("Storage");
  return storageTargets
    .filter(target => !target.deleting && Number(target.target || 0) > 0)
    .map(target => {
      const current = Number(storageCounts.get(stockKey(target)) || 0);
      const targetQuantity = Number(target.target || 0);
      return {
        ...target,
        label: target.itemLabel || target.itemName,
        current,
        missing: Math.max(0, targetQuantity - current)
      };
    })
    .filter(line => line.missing > 0)
    .sort((a, b) => Number(a.current > 0) - Number(b.current > 0) || b.missing - a.missing || a.label.localeCompare(b.label));
}

function getMaterialPurchasePlan(excludeSupplyOrderId = "") {
  const demand = new Map();
  const addDemand = (ingredient, quantity) => {
    const key = normalize(ingredient);
    const current = demand.get(key) || { ingredient, demand: 0 };
    current.demand += Number(quantity || 0);
    demand.set(key, current);
  };

  getReplenishmentPlan().materials
    .filter(line => line.sourceLocation === "Storage")
    .forEach(line => addDemand(line.ingredient, line.needed));
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
    .filter(order => SUPPLY_DELIVERY_STATUSES.has(order.status) && order.id !== excludeSupplyOrderId)
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
    operations,
    snapshotGeneratedAt: backendSnapshot?.sheet?.generatedAt || ""
  });
}

function stockKey(entry) {
  return normalize(entry.itemName || entry.itemLabel || entry.ingredient || entry.name);
}

function getProductionPlan(order, allocationOverrides = null) {
  const internal = isInternalCraftOrder(order);
  const materialTotals = new Map();
  const buildMap = new Map();
  const missing = [];
  const orderLines = new Map();

  order.lines.forEach(line => {
    if (line.custom) return;
    const key = normalize(line.name || line.label || line.tag);
    if (!key) return;
    const quantity = Number(line.quantity || 0);
    const current = orderLines.get(key) || {
      key,
      name: line.name || line.label,
      label: line.label || line.name,
      orderedQuantity: 0
    };
    current.orderedQuantity += quantity;
    orderLines.set(key, current);
  });

  const linkedBatch = productionBatchForOrder(order.id);
  const linkedAllocations = new Map((linkedBatch?.stockAllocations || []).map(allocation => [
    normalize(allocation.itemName || allocation.itemLabel),
    allocation
  ]));
  const linkedProduction = new Map((linkedBatch?.lines || []).map(line => [
    normalize(line.itemName || line.itemLabel),
    Number(line.requestedQuantity || 0)
  ]));
  const reservations = getFinishedStockReservations(order.id);
  const storageCounts = getLatestCounts("Storage");
  const storefrontCounts = getLatestCounts("Storefront");
  const fulfillmentLines = [...orderLines.values()].map(line => {
    const storageAvailable = Math.max(0,
      Number(storageCounts.get(line.key) || 0) - Number(reservations.Storage.get(line.key) || 0)
    );
    const storefrontAvailable = Math.max(0,
      Number(storefrontCounts.get(line.key) || 0) - Number(reservations.Storefront.get(line.key) || 0)
    );
    const override = allocationOverrides instanceof Map
      ? allocationOverrides.get(line.key)
      : allocationOverrides?.[line.key];
    const saved = linkedAllocations.get(line.key);
    let storageQuantity;
    let storefrontQuantity;
    if (internal) {
      storageQuantity = 0;
      storefrontQuantity = 0;
    } else if (saved) {
      storageQuantity = Math.max(0, Number(saved.storageQuantity || 0));
      storefrontQuantity = Math.max(0, Number(saved.storefrontQuantity || 0));
    } else if (override) {
      const selected = override;
      storageQuantity = Math.min(line.orderedQuantity, storageAvailable, Math.max(0, Number(selected.storageQuantity || 0)));
      storefrontQuantity = Math.min(
        Math.max(0, line.orderedQuantity - storageQuantity),
        storefrontAvailable,
        Math.max(0, Number(selected.storefrontQuantity || 0))
      );
    } else if (linkedBatch) {
      storageQuantity = 0;
      storefrontQuantity = 0;
    } else {
      storageQuantity = Math.min(line.orderedQuantity, storageAvailable);
      storefrontQuantity = Math.min(
        Math.max(0, line.orderedQuantity - storageQuantity),
        storefrontAvailable
      );
    }
    const existingQuantity = storageQuantity + storefrontQuantity;
    const productionQuantity = linkedBatch
      ? Number(linkedProduction.get(line.key) || 0)
      : internal ? line.orderedQuantity : Math.max(0, line.orderedQuantity - existingQuantity);
    if (productionQuantity > 0) {
      if (recipeCatalog[line.name]) buildMap.set(line.name, productionQuantity);
      else missing.push(line.label || line.name);
    }
    return {
      ...line,
      storageAvailable,
      storefrontAvailable,
      storageQuantity,
      storefrontQuantity,
      existingQuantity,
      productionQuantity
    };
  }).sort((a, b) => a.label.localeCompare(b.label));

  buildMap.forEach((quantity, name) => {
    const batches = recipeBatchCount(name, quantity);
    recipeCatalog[name].forEach(([ingredient, qty]) => {
      materialTotals.set(ingredient, (materialTotals.get(ingredient) || 0) + Number(qty || 0) * batches);
    });
  });

  return {
    fulfillmentLines,
    stockAllocations: fulfillmentLines.filter(line => line.existingQuantity > 0).map(line => ({
      itemName: line.name,
      itemLabel: line.label || line.name,
      storageQuantity: line.storageQuantity,
      storefrontQuantity: line.storefrontQuantity
    })),
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
  return localDateKey(new Date());
}

function localDateKey(date) {
  const parts = Object.fromEntries(businessDateKeyFormatter.formatToParts(date).map(part => [part.type, part.value]));
  const year = parts.year;
  const month = parts.month;
  const day = parts.day;
  return `${year}-${month}-${day}`;
}

function formatDelivery(value) {
  if (!value) return "In-store order";
  return deliveryDateFormatter.format(new Date(`${value}T12:00:00Z`));
}

function formatDateTime(value) {
  if (!value) return "";
  return dateTimeFormatter.format(new Date(value));
}

function toDateTimeLocalValue(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function fromDateTimeLocalValue(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function formatDuration(minutes) {
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (!hours) return `${remainder}m`;
  return `${hours}h ${String(remainder).padStart(2, "0")}m`;
}

function formatNumber(value) {
  return numberFormatter.format(Number(value || 0));
}

function formatCurrency(value) {
  return currencyFormatter.format(Number(value || 0));
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
