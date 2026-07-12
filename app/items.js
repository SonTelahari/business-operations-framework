const FRONTIER_CATEGORIES = [
  "Rifles",
  "Bows",
  "Misc",
  "Shotguns",
  "Repeaters",
  "Revolvers",
  "Pistols"
];

const FRONTIER_ITEMS = [
  { name: "Springfield Rifle", label: "Springfield Rifle", tag: "", category: "Rifles", price: 0 },
  { name: "Varmint Rifle", label: "Varmint Rifle", tag: "", category: "Rifles", price: 0 },
  { name: "Boltaction Rifle", label: "Boltaction Rifle", tag: "", category: "Rifles", price: 0 },
  { name: "Rollingblock Rifle", label: "Rollingblock Rifle", tag: "", category: "Rifles", price: 0 },
  { name: "Bow", label: "Bow", tag: "", category: "Bows", price: 0 },
  { name: "Lasso", label: "Lasso", tag: "", category: "Misc", price: 0 },
  { name: "Reinforced Lasso", label: "Reinforced Lasso", tag: "", category: "Misc", price: 0 },
  { name: "Volcanic Pistol", label: "Volcanic Pistol", tag: "", category: "Pistols", price: 0 },
  { name: "M1899 Pistol", label: "M1899 Pistol", tag: "", category: "Pistols", price: 0 }
];

if (typeof window !== "undefined") {
  window.FRONTIER_CATEGORIES = FRONTIER_CATEGORIES;
  window.FRONTIER_ITEMS = FRONTIER_ITEMS;
}

if (typeof module !== "undefined") {
  module.exports = FRONTIER_ITEMS;
  module.exports.categories = FRONTIER_CATEGORIES;
}
