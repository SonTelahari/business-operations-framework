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

  function selectLatestCounts({ location, inventory = {}, operations = [] }) {
    const backendCounts = new Map();
    const sourceRows = location === "Storefront"
      ? inventory.products
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

    const manualCounts = new Map();
    operations.forEach((entry, index) => {
      if (entry?.kind !== "Stock Count" || entry.location !== location) return;
      const key = stockKey(entry);
      if (!key) return;

      const candidate = {
        quantity: numberOrZero(entry.quantity),
        countedAt: entry.createdAt || "",
        order: index
      };
      const current = manualCounts.get(key);
      const candidateTime = timestamp(candidate.countedAt);
      const currentTime = timestamp(current?.countedAt);
      if (!current || candidateTime > currentTime || (candidateTime === currentTime && candidate.order < current.order)) {
        manualCounts.set(key, candidate);
      }
    });

    manualCounts.forEach((manual, key) => {
      const backend = backendCounts.get(key);
      if (!backend) {
        backendCounts.set(key, manual);
        return;
      }

      const manualTime = timestamp(manual.countedAt);
      const backendTime = timestamp(backend.countedAt);
      if (backendTime === Number.NEGATIVE_INFINITY || manualTime >= backendTime) {
        backendCounts.set(key, manual);
      }
    });

    return new Map([...backendCounts].map(([key, value]) => [key, value.quantity]));
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

  return { normalizeKey, selectLatestCounts, selectCurrentLedger };
});
