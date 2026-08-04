(function exposeInventoryCounts(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.FRONTIER_INVENTORY_COUNTS = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createInventoryCounts() {
  function normalizeKey(value) {
    const key = String(value || "").trim().toLowerCase();
    return key === "wood" || key === "soft wood" || key === "softwood" ? "softwood" : key;
  }

  function stockKey(entry) {
    return normalizeKey(entry?.itemName || entry?.itemLabel || entry?.ingredient || entry?.name);
  }

  function timestamp(value) {
    const parsed = Date.parse(value || "");
    return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
  }

  function numberOrZero(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function resolveCatalogItem(catalog, value) {
    const needle = normalizeKey(value);
    if (!needle || !Array.isArray(catalog)) return null;
    const fieldsFor = item => [
      item?.name,
      item?.label,
      item?.tag,
      ...(Array.isArray(item?.aliases) ? item.aliases : [])
    ].filter(Boolean).map(normalizeKey);
    const exact = catalog.find(item => fieldsFor(item).includes(needle));
    if (exact) return exact;
    return catalog.find(item => [
      ...fieldsFor(item),
      normalizeKey(item?.category)
    ].some(field => field.includes(needle))) || null;
  }

  function selectLatestCounts({ location, inventory = {}, operations = [], snapshotGeneratedAt = "" }) {
    const backendCounts = new Map();
    const sourceRows = location === "Storefront"
      ? Array.isArray(inventory.storefront) ? inventory.storefront : inventory.products
      : Array.isArray(inventory.storage) ? inventory.storage : inventory.materials;

    if (Array.isArray(sourceRows)) {
      sourceRows.forEach(row => {
        const key = stockKey(row);
        if (!key) return;
        backendCounts.set(key, {
          quantity: numberOrZero(location === "Storefront" ? row.currentStock : row.storageCount),
          countedAt: row.countedAt || ""
        });
      });
    }

    const snapshotTime = timestamp(snapshotGeneratedAt);
    operations
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => !operationIsRepresented(entry, snapshotTime))
      .sort((a, b) => timestamp(a.entry?.createdAt) - timestamp(b.entry?.createdAt) || b.index - a.index)
      .forEach(({ entry }) => {
        const key = stockKey(entry);
        if (!key) return;

        const current = backendCounts.get(key) || { quantity: 0, countedAt: "" };
        const eventTime = timestamp(entry?.createdAt);
        const countedTime = timestamp(current.countedAt);

        if (entry?.kind === "Stock Count") {
          if (entry.location !== location || eventTime < countedTime) return;
          backendCounts.set(key, {
            quantity: numberOrZero(entry.quantity),
            countedAt: entry.createdAt || ""
          });
          return;
        }

        const movement = stockMovementDelta(entry, location);
        if (!movement || eventTime <= countedTime) return;
        backendCounts.set(key, {
          quantity: Math.max(0, numberOrZero(current.quantity) + movement),
          countedAt: current.countedAt || ""
        });
      });

    return new Map([...backendCounts].map(([key, value]) => [key, Math.max(0, numberOrZero(value.quantity))]));
  }

  function operationIsRepresented(entry, snapshotTime) {
    if (snapshotTime === Number.NEGATIVE_INFINITY || entry?.syncStatus !== "Synced") return false;
    return timestamp(entry.syncedAt || entry.createdAt) <= snapshotTime;
  }

  function stockMovementDelta(entry, location) {
    const quantity = Math.abs(numberOrZero(entry?.quantity));
    if (!quantity) return 0;

    const kind = String(entry?.kind || "");
    if (location === "Storefront") {
      if (kind === "Storefront Transfer") return quantity;
      if (kind === "Storage Transfer") return -quantity;
      return 0;
    }

    if (kind === "P2P Sale" || kind === "Production Use" || kind === "Correction Out" || kind === "Storefront Transfer") {
      return -quantity;
    }
    if (kind === "P2P Purchase" || kind === "Correction In" || kind === "Production Output" || kind === "Storage Transfer") {
      return quantity;
    }
    return 0;
  }

  function selectCurrentLedger({ ledger = null, operations = [], snapshotGeneratedAt = "" }) {
    const backendBalance = Number(ledger?.balance);
    const hasBackendBalance = Number.isFinite(backendBalance);
    const snapshotTime = timestamp(snapshotGeneratedAt);
    let available = hasBackendBalance;
    let balance = hasBackendBalance ? backendBalance : 0;
    const backendCountedBalance = ledger?.countedBalance;
    let countedBalance = backendCountedBalance === null || backendCountedBalance === undefined || backendCountedBalance === ""
      ? null
      : Number.isFinite(Number(backendCountedBalance)) ? Number(backendCountedBalance) : null;
    let countedAt = ledger?.countedAt || "";
    let netMovementSinceCount = numberOrZero(ledger?.netMovementSinceCount);
    let lastActivityAt = ledger?.lastActivityAt || countedAt;
    let source = ledger?.source || "";

    operations
      .filter(entry => {
        if (!entry?.createdAt) return entry?.syncStatus !== "Synced";
        const representedAt = entry.syncedAt || entry.createdAt;
        return entry.syncStatus !== "Synced" || timestamp(representedAt) > snapshotTime;
      })
      .sort((a, b) => timestamp(a.createdAt) - timestamp(b.createdAt))
      .forEach(entry => {
        const kind = String(entry.kind || "");
        const amount = Math.abs(numberOrZero(entry.amount));
        let movement = 0;

        if (kind === "Ledger Count") {
          available = true;
          balance = numberOrZero(entry.amount);
          countedBalance = balance;
          countedAt = entry.createdAt || countedAt;
          netMovementSinceCount = 0;
          lastActivityAt = entry.createdAt || lastActivityAt;
          source = "Latest local ledger count plus subsequent cash movements";
          return;
        }
        if (kind === "P2P Sale" || kind === "Cash In") movement = amount;
        if (kind === "P2P Purchase" || kind === "Cash Out" || kind === "Payroll Payout") movement = -amount;
        if (kind === "Correction") movement = numberOrZero(entry.amount);
        if (kind === "Payroll Payment" && String(entry.paymentMethod || "Ledger") === "Ledger") movement = -amount;
        if (!movement) return;

        available = true;
        balance += movement;
        netMovementSinceCount += movement;
        lastActivityAt = entry.createdAt || lastActivityAt;
        if (!source) source = "Locally recorded cash movements";
      });

    return {
      available,
      balance,
      countedBalance,
      countedAt,
      netMovementSinceCount,
      lastActivityAt,
      source
    };
  }

  return { normalizeKey, resolveCatalogItem, selectLatestCounts, selectCurrentLedger };
});
