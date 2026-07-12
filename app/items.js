const FRONTIER_CATEGORIES = [
  "Rifles",
  "Bows",
  "Misc",
  "Shotguns",
  "Repeaters",
  "Revolvers"
];

const FRONTIER_ITEMS = [];

if (typeof window !== "undefined") {
  window.FRONTIER_CATEGORIES = FRONTIER_CATEGORIES;
  window.FRONTIER_ITEMS = FRONTIER_ITEMS;
}

if (typeof module !== "undefined") {
  module.exports = FRONTIER_ITEMS;
  module.exports.categories = FRONTIER_CATEGORIES;
}
