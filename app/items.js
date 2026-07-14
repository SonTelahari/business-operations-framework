const FRONTIER_PRICING_CATALOG = typeof module !== "undefined" && module.exports
  ? require("./pricing")
  : (window.FRONTIER_PRICING || { products: {} });

const FRONTIER_CATEGORIES = [
  "Rifles",
  "Bows",
  "Misc",
  "Shotguns",
  "Repeaters",
  "Revolvers",
  "Pistols",
  "Tools",
  "Ammunition"
];

const FRONTIER_ITEMS = [
  { name: "Springfield Rifle", label: "Springfield Rifle", tag: "", category: "Rifles", price: 0 },
  { name: "Varmint Rifle", label: "Varmint Rifle", tag: "", category: "Rifles", price: 0 },
  { name: "Boltaction Rifle", label: "BoltAction Rifle", tag: "WEAPON_RIFLE_BOLTACTION", category: "Rifles", price: 80 },
  { name: "Rollingblock Rifle", label: "Rolling Block Rifle", tag: "WEAPON_SNIPERRIFLE_ROLLINGBLOCK", category: "Rifles", price: 105 },
  { name: "Bow", label: "Bow", tag: "WEAPON_BOW", category: "Bows", price: 25 },
  { name: "Lasso", label: "Lasso", tag: "", category: "Misc", price: 0 },
  { name: "Reinforced Lasso", label: "Reinforced Lasso", tag: "WEAPON_LASSO_REINFORCED", category: "Misc", price: 35 },
  { name: "Doublebarrel Shotgun", label: "Double Barrel Shotgun", tag: "WEAPON_SHOTGUN_DOUBLEBARREL", category: "Shotguns", price: 55 },
  { name: "Repeating Shotgun", label: "Repeating Shotgun", tag: "WEAPON_SHOTGUN_REPEATING", category: "Shotguns", price: 55 },
  { name: "Exotic Double Barrel Shotgun", label: "Exotic Double Barrel Shotgun", tag: "", category: "Shotguns", price: 0 },
  { name: "Semiauto Shotgun", label: "Semi-Auto Shotgun", tag: "WEAPON_SHOTGUN_SEMIAUTO", category: "Shotguns", price: 105 },
  { name: "Pump Shotgun", label: "Pump Shotgun", tag: "WEAPON_SHOTGUN_PUMP", category: "Shotguns", price: 80 },
  { name: "Henry Repeater", label: "Henry Reapeater", tag: "WEAPON_REPEATER_HENRY", category: "Repeaters", price: 55 },
  { name: "Winchester Repeater", label: "Winchester Repeater", tag: "WEAPON_REPEATER_WINCHESTER", category: "Repeaters", price: 55 },
  { name: "Evans Repeater", label: "Evans Repeater", tag: "WEAPON_REPEATER_EVANS", category: "Repeaters", price: 55 },
  { name: "Carbine Repeater", label: "Carabine Reapeater", tag: "WEAPON_REPEATER_CARBINE", category: "Repeaters", price: 45 },
  { name: "Double Action Revolver", label: "Double Action Revolver", tag: "", category: "Revolvers", price: 0 },
  { name: "Lemat Revolver", label: "Revolver Lemat", tag: "WEAPON_REVOLVER_LEMAT", category: "Revolvers", price: 55 },
  { name: "Double Action Gambler Revolver", label: "Double Action Gambler Revolver", tag: "", category: "Revolvers", price: 0 },
  { name: "Cattleman Mexican Revolver", label: "Cattleman Mexican Revolver", tag: "", category: "Revolvers", price: 0 },
  { name: "Cattleman Revolver", label: "Cattleman Revolver", tag: "", category: "Revolvers", price: 0 },
  { name: "Navy Crossover Revolver", label: "Revolver Navy Crossover", tag: "WEAPON_REVOLVER_NAVY_CROSSOVER", category: "Revolvers", price: 105 },
  { name: "Navy Revolver", label: "Revolver Navy", tag: "WEAPON_REVOLVER_NAVY", category: "Revolvers", price: 105 },
  { name: "Schofield Revolver", label: "Revolver Schofield", tag: "WEAPON_REVOLVER_SCHOFIELD", category: "Revolvers", price: 55 },
  { name: "Volcanic Pistol", label: "Volcanic Pistol", tag: "", category: "Pistols", price: 0 },
  { name: "M1899 Pistol", label: "M1899 Pistol", tag: "", category: "Pistols", price: 0 },
  { name: "Gun Cleaning Kit", label: "Gun Cleaning Kit", tag: "guncleaningkit", category: "Tools", price: 2.5 },
  { name: "Weapon Repair Kit", label: "Weapon Repair Kit", tag: "", category: "Tools", price: 0 },
  { name: "Revolver Ammo Express", label: "Revolver Ammo Express", tag: "", category: "Ammunition", price: 0 },
  { name: "Revolver Ammo Normal", label: "Revolver Ammo Normal", tag: "ammorevolvernormal", category: "Ammunition", price: 2 },
  { name: "Revolver Ammo Splitpoint", label: "Revolver Ammo Splitpoint", tag: "", category: "Ammunition", price: 0 },
  { name: "Revolver Ammo Velocity", label: "Revolver Ammo Velocity", tag: "", category: "Ammunition", price: 0 },
  { name: "Varmint Tranquilizer Ammo", label: "Varmint Tranquilizer Ammo", tag: "", category: "Ammunition", price: 0 },
  { name: "Varmint Ammo", label: "Varmint Ammo", tag: "", category: "Ammunition", price: 0 },
  { name: "Repeater Ammo Velocity", label: "Repeater Ammo Velocity", tag: "", category: "Ammunition", price: 0 },
  { name: "Repeater Ammo Express", label: "Repeater Ammo Express", tag: "ammorepeaterexpress", category: "Ammunition", price: 2.25 },
  { name: "Repeater Ammo Splitpoint", label: "Repeater Ammo Splitpoint", tag: "", category: "Ammunition", price: 0 },
  { name: "Repeater Ammo Normal", label: "Repeater Ammo Normal", tag: "", category: "Ammunition", price: 0 },
  { name: "Arrow Small Game", label: "Arrow Small Game", tag: "", category: "Ammunition", price: 0 },
  { name: "Shotgun Ammo Normal", label: "Shotgun Ammo Normal", tag: "ammoshotgunnormal", category: "Ammunition", price: 2 },
  { name: "Shotgun Ammo Slug", label: "Shotgun Ammo Slug", tag: "", category: "Ammunition", price: 0 },
  { name: "Rifle Ammo Express", label: "Rifle Ammo Express", tag: "ammorifleexpress", category: "Ammunition", price: 2.25 },
  { name: "Rifle Ammo Velocity", label: "Rifle Ammo Velocity", tag: "", category: "Ammunition", price: 0 },
  { name: "Rifle Ammo Splitpoint", label: "Rifle Ammo Splitpoint", tag: "", category: "Ammunition", price: 0 },
  { name: "Elephant Rifle Ammo", label: "Elephant Rifle Ammo", tag: "", category: "Ammunition", price: 0 },
  { name: "Rifle Ammo Normal", label: "Rifle Ammo Normal", tag: "", category: "Ammunition", price: 0 },
  { name: "Pistol Ammo Velocity", label: "Pistol Ammo Velocity", tag: "", category: "Ammunition", price: 0 },
  { name: "Pistol Ammo Splitpoint", label: "Pistol Ammo Splitpoint", tag: "", category: "Ammunition", price: 0 },
  { name: "Pistol Ammo Express", label: "Pistol Ammo Express", tag: "", category: "Ammunition", price: 0 },
  { name: "Pistol Ammo Normal", label: "Pistol Ammo Normal", tag: "", category: "Ammunition", price: 0 },
  { name: "Hatchet Ammo", label: "Hatchet Ammo", tag: "", category: "Ammunition", price: 0 },
  { name: "Hatchet Cleaver Ammo", label: "Hatchet Cleaver Ammo", tag: "", category: "Ammunition", price: 0 },
  { name: "Hatchet Hunter Ammo", label: "Hatchet Hunter Ammo", tag: "", category: "Ammunition", price: 0 }
];

FRONTIER_ITEMS.forEach(item => {
  const msrpEntry = FRONTIER_PRICING_CATALOG.products[item.name];
  if (!msrpEntry) return;
  item.price = msrpEntry.midpoint;
  item.msrpLow = msrpEntry.low;
  item.msrpHigh = msrpEntry.high;
});

if (typeof window !== "undefined") {
  window.FRONTIER_CATEGORIES = FRONTIER_CATEGORIES;
  window.FRONTIER_ITEMS = FRONTIER_ITEMS;
}

if (typeof module !== "undefined") {
  module.exports = FRONTIER_ITEMS;
  module.exports.categories = FRONTIER_CATEGORIES;
}
