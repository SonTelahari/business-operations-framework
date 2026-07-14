(function exposeSupplyTelegram(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.FRONTIER_SUPPLY_TELEGRAM = api;
})(typeof window !== "undefined" ? window : globalThis, function createSupplyTelegram() {
  const MIN_ITEM_WIDTH = 26;
  const MAX_ITEM_WIDTH = 34;
  const QUANTITY_WIDTH = 8;

  function buildSupplyQuoteTelegram(order, signer = {}) {
    const lines = Array.isArray(order?.lines) ? order.lines : [];
    const labels = lines.map(line => cleanCell(line.label || line.name || "Item"));
    const itemWidth = Math.min(
      MAX_ITEM_WIDTH,
      Math.max(MIN_ITEM_WIDTH, ...labels.map(label => label.length))
    );
    const divider = "-".repeat(itemWidth + QUANTITY_WIDTH + 6);
    const tableRows = lines.map((line, index) => {
      const label = labels[index];
      const quantity = formatTelegramQuantity(line.quantity);
      return `${label.padEnd(itemWidth)} | ${quantity.padStart(QUANTITY_WIDTH)} |`;
    });
    const signerName = cleanLine(signer.name || order?.requestedBy || "Frontier Firearms");
    const signerTitle = cleanLine(signer.title || "Representative");
    const business = cleanLine(signer.business || "Frontier Firearms, Van Horn");

    return [
      "Good day,",
      "",
      "We would like to get a quoted price for the following materials:",
      "",
      `${"Item".padEnd(itemWidth)} | ${"Number".padStart(QUANTITY_WIDTH)} |`,
      divider,
      ...tableRows,
      divider,
      "",
      "Please quote a price per unit as well as a sub total along with an estimated time of delivery.",
      "",
      "Respectfully,",
      signerName,
      signerTitle,
      business
    ].join("\n");
  }

  function formatTelegramQuantity(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "0";
    return Number.isInteger(number)
      ? String(number)
      : number.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  }

  function cleanCell(value) {
    return cleanLine(value).slice(0, MAX_ITEM_WIDTH);
  }

  function cleanLine(value) {
    return String(value || "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  }

  return { buildSupplyQuoteTelegram, formatTelegramQuantity };
});
