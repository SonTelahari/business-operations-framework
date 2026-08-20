(function exposeProductionInventory(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.FRONTIER_PRODUCTION_INVENTORY = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createProductionInventory() {
  "use strict";

  function normalizeKey(value) {
    const key = String(value || "").trim().toLowerCase();
    return key === "wood" || key === "soft wood" || key === "softwood" ? "softwood" : key;
  }

  function canonicalName(value) {
    return normalizeKey(value) === "softwood" ? "Softwood" : String(value || "").trim();
  }

  function normalizeProductionSource(value, options = {}) {
    const itemKey = options.itemKey || normalizeKey;
    const key = itemKey(value);
    return key === "sales" || key.includes("store") ? "Storefront" : "Storage";
  }

  function craftsForLine(crafts, line) {
    if (typeof crafts === "function") return Math.max(0, Number(crafts(line) || 0));
    if (crafts instanceof Map) return Math.max(0, Number(crafts.get(line.id) || 0));
    return Math.max(0, Number(crafts?.[line.id] || 0));
  }

  function productionInventoryState(batch = {}, crafts = new Map(), options = {}) {
    const itemKey = options.itemKey || normalizeKey;
    const canonicalItemName = options.canonicalItemName || canonicalName;
    const normalizeSource = options.normalizeSource
      || (value => normalizeProductionSource(value, { itemKey }));
    const requirements = new Map();
    const intermediateOutputs = new Map();
    const outputs = new Map();

    (batch.lines || []).forEach(line => {
      const lineCrafts = craftsForLine(crafts, line);
      (line.recipe || []).forEach(component => {
        const itemName = canonicalItemName(component.ingredient);
        const sourceLocation = normalizeSource(component.sourceLocation);
        const normalizedItemKey = itemKey(itemName);
        const key = `${sourceLocation}:${normalizedItemKey}`;
        const current = requirements.get(key) || {
          itemName,
          ingredient: itemName,
          sourceLocation,
          itemKey: normalizedItemKey,
          quantity: 0,
          needed: 0
        };
        const amount = lineCrafts * Number(component.quantity || 0);
        current.quantity += amount;
        current.needed += amount;
        requirements.set(key, current);
      });

      const outputLocation = normalizeSource(line.outputLocation);
      const outputQuantity = lineCrafts * Number(line.recipeYield || 1);
      const normalizedItemKey = itemKey(line.itemName || line.itemLabel);
      const key = `${outputLocation}:${normalizedItemKey}`;
      if (line.isIntermediate) {
        const current = intermediateOutputs.get(key) || {
          itemName: line.itemName,
          itemLabel: line.itemLabel,
          outputLocation,
          usable: 0,
          surplus: 0
        };
        current.usable += Math.min(outputQuantity, Number(line.requestedQuantity || 0));
        current.surplus += Math.max(0, outputQuantity - Number(line.requestedQuantity || 0));
        intermediateOutputs.set(key, current);
        return;
      }

      const current = outputs.get(key) || {
        itemName: line.itemName,
        itemLabel: line.itemLabel,
        outputLocation,
        quantity: 0,
        rootOutput: true
      };
      current.quantity += outputQuantity;
      outputs.set(key, current);
    });

    const uses = new Map();
    requirements.forEach((requirement, key) => {
      const usable = Number(intermediateOutputs.get(key)?.usable || 0);
      const quantity = Math.max(0, requirement.quantity - usable);
      if (quantity > 0) uses.set(key, { ...requirement, quantity, needed: quantity });
    });
    intermediateOutputs.forEach((output, key) => {
      if (output.surplus <= 0) return;
      const current = outputs.get(key) || { ...output, quantity: 0, rootOutput: false };
      current.quantity += output.surplus;
      outputs.set(key, current);
    });

    return { uses, outputs };
  }

  function finishedStockReservations({
    batches = [],
    orders = [],
    excludeOrderId = "",
    itemKey = normalizeKey,
    normalizeSource,
    isOrderClosed = order => order?.status === "Completed" || order?.status === "Cancelled"
  } = {}) {
    const sourceFor = normalizeSource || (value => normalizeProductionSource(value, { itemKey }));
    const reserved = new Map();
    const ordersById = new Map(orders.map(order => [order.id, order]));
    const addReservation = (location, itemName, quantity) => {
      const amount = Math.max(0, Number(quantity || 0));
      const normalizedItemKey = itemKey(itemName);
      if (!normalizedItemKey || !amount) return;
      const key = `${sourceFor(location)}:${normalizedItemKey}`;
      reserved.set(key, Number(reserved.get(key) || 0) + amount);
    };

    batches.forEach(batch => {
      if (batch.sourceType !== "Customer Order" || batch.status === "Cancelled" || batch.sourceId === excludeOrderId) return;
      const order = ordersById.get(batch.sourceId);
      if (!order || isOrderClosed(order)) return;
      (batch.stockAllocations || []).forEach(allocation => {
        addReservation("Storage", allocation.itemName || allocation.itemLabel, allocation.storageQuantity);
        addReservation("Storefront", allocation.itemName || allocation.itemLabel, allocation.storefrontQuantity);
      });
      const pendingTargets = new Map((batch.pendingProgress?.targets || []).map(target => [
        target.lineId,
        Number(target.completedCrafts || 0)
      ]));
      (batch.lines || []).filter(line => !line.isIntermediate).forEach(line => {
        const completedCrafts = Math.max(
          Number(line.completedCrafts || 0),
          Number(pendingTargets.get(line.id) || 0)
        );
        const completedOutput = Math.min(
          Number(line.requestedQuantity || 0),
          completedCrafts * Number(line.recipeYield || 1)
        );
        addReservation(line.outputLocation, line.itemName || line.itemLabel, completedOutput);
      });
    });

    return reserved;
  }

  function reservationsByLocation(reservations, locations = ["Storage", "Storefront"]) {
    const grouped = Object.fromEntries(locations.map(location => [location, new Map()]));
    reservations.forEach((quantity, key) => {
      const separator = key.indexOf(":");
      if (separator < 0) return;
      const location = key.slice(0, separator);
      const itemKey = key.slice(separator + 1);
      if (!grouped[location]) return;
      grouped[location].set(itemKey, Number(quantity || 0));
    });
    return grouped;
  }

  function subtractInventoryReservations({
    counts = {},
    reservations = new Map(),
    locations = ["Storage", "Storefront"]
  } = {}) {
    const available = Object.fromEntries(locations.map(location => [
      location,
      new Map(counts[location] || [])
    ]));
    reservations.forEach((quantity, key) => {
      const separator = key.indexOf(":");
      if (separator < 0) return;
      const location = key.slice(0, separator);
      const itemKey = key.slice(separator + 1);
      const sourceCounts = available[location];
      if (!sourceCounts || !sourceCounts.has(itemKey)) return;
      const current = sourceCounts.get(itemKey);
      if (typeof current === "number") {
        sourceCounts.set(itemKey, Math.max(0, current - Number(quantity || 0)));
        return;
      }
      sourceCounts.set(itemKey, {
        ...current,
        quantity: Math.max(0, Number(current?.quantity || 0) - Number(quantity || 0))
      });
    });
    return available;
  }

  return {
    normalizeKey,
    canonicalName,
    normalizeProductionSource,
    productionInventoryState,
    finishedStockReservations,
    reservationsByLocation,
    subtractInventoryReservations
  };
});
