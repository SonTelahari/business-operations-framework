const FRONTIER_CATEGORIES = [
  "Rifles",
  "Bows",
  "Misc",
  "Shotguns",
  "Repeaters",
  "Revolvers",
  "Pistols",
  "Ammunition"
];

const FRONTIER_ITEMS = [
  { name: "Springfield Rifle", label: "Springfield Rifle", tag: "", category: "Rifles", price: 0 },
  { name: "Varmint Rifle", label: "Varmint Rifle", tag: "", category: "Rifles", price: 0 },
  { name: "Boltaction Rifle", label: "BoltAction Rifle", tag: "WEAPON_RIFLE_BOLTACTION", category: "Rifles", price: 80 },
  { name: "Rollingblock Rifle", label: "Rollingblock Rifle", tag: "", category: "Rifles", price: 0 },
  { name: "Bow", label: "Bow", tag: "", category: "Bows", price: 0 },
  { name: "Lasso", label: "Lasso", tag: "", category: "Misc", price: 0 },
  { name: "Reinforced Lasso", label: "Reinforced Lasso", tag: "", category: "Misc", price: 0 },
  { name: "Doublebarrel Shotgun", label: "Doublebarrel Shotgun", tag: "", category: "Shotguns", price: 0 },
  { name: "Repeating Shotgun", label: "Repeating Shotgun", tag: "", category: "Shotguns", price: 0 },
  { name: "Exotic Double Barrel Shotgun", label: "Exotic Double Barrel Shotgun", tag: "", category: "Shotguns", price: 0 },
  { name: "Semiauto Shotgun", label: "Semiauto Shotgun", tag: "", category: "Shotguns", price: 0 },
  { name: "Pump Shotgun", label: "Pump Shotgun", tag: "", category: "Shotguns", price: 0 },
  { name: "Henry Repeater", label: "Henry Repeater", tag: "", category: "Repeaters", price: 0 },
  { name: "Winchester Repeater", label: "Winchester Repeater", tag: "", category: "Repeaters", price: 0 },
  { name: "Evans Repeater", label: "Evans Repeater", tag: "", category: "Repeaters", price: 0 },
  { name: "Carbine Repeater", label: "Carbine Repeater", tag: "", category: "Repeaters", price: 0 },
  { name: "Double Action Revolver", label: "Double Action Revolver", tag: "", category: "Revolvers", price: 0 },
  { name: "Lemat Revolver", label: "Lemat Revolver", tag: "", category: "Revolvers", price: 0 },
  { name: "Double Action Gambler Revolver", label: "Double Action Gambler Revolver", tag: "", category: "Revolvers", price: 0 },
  { name: "Cattleman Mexican Revolver", label: "Cattleman Mexican Revolver", tag: "", category: "Revolvers", price: 0 },
  { name: "Cattleman Revolver", label: "Cattleman Revolver", tag: "", category: "Revolvers", price: 0 },
  { name: "Navy Crossover Revolver", label: "Navy Crossover Revolver", tag: "", category: "Revolvers", price: 0 },
  { name: "Navy Revolver", label: "Revolver Navy", tag: "WEAPON_REVOLVER_NAVY", category: "Revolvers", price: 105 },
  { name: "Schofield Revolver", label: "Schofield Revolver", tag: "", category: "Revolvers", price: 0 },
  { name: "Volcanic Pistol", label: "Volcanic Pistol", tag: "", category: "Pistols", price: 0 },
  { name: "M1899 Pistol", label: "M1899 Pistol", tag: "", category: "Pistols", price: 0 },
  { name: "Revolver Ammo Express", label: "Revolver Ammo Express", tag: "", category: "Ammunition", price: 0 },
  { name: "Revolver Ammo Normal", label: "Revolver Ammo Normal", tag: "", category: "Ammunition", price: 0 },
  { name: "Revolver Ammo Splitpoint", label: "Revolver Ammo Splitpoint", tag: "", category: "Ammunition", price: 0 },
  { name: "Revolver Ammo Velocity", label: "Revolver Ammo Velocity", tag: "", category: "Ammunition", price: 0 },
  { name: "Varmint Tranquilizer Ammo", label: "Varmint Tranquilizer Ammo", tag: "", category: "Ammunition", price: 0 },
  { name: "Varmint Ammo", label: "Varmint Ammo", tag: "", category: "Ammunition", price: 0 },
  { name: "Repeater Ammo Velocity", label: "Repeater Ammo Velocity", tag: "", category: "Ammunition", price: 0 },
  { name: "Repeater Ammo Express", label: "Repeater Ammo Express", tag: "", category: "Ammunition", price: 0 },
  { name: "Repeater Ammo Splitpoint", label: "Repeater Ammo Splitpoint", tag: "", category: "Ammunition", price: 0 },
  { name: "Repeater Ammo Normal", label: "Repeater Ammo Normal", tag: "", category: "Ammunition", price: 0 },
  { name: "Arrow Small Game", label: "Arrow Small Game", tag: "", category: "Ammunition", price: 0 },
  { name: "Shotgun Ammo Normal", label: "Shotgun Ammo Normal", tag: "", category: "Ammunition", price: 0 },
  { name: "Shotgun Ammo Slug", label: "Shotgun Ammo Slug", tag: "", category: "Ammunition", price: 0 },
  { name: "Rifle Ammo Express", label: "Rifle Ammo Express", tag: "", category: "Ammunition", price: 0 },
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

if (typeof window !== "undefined") {
  window.FRONTIER_CATEGORIES = FRONTIER_CATEGORIES;
  window.FRONTIER_ITEMS = FRONTIER_ITEMS;
}

if (typeof module !== "undefined") {
  module.exports = FRONTIER_ITEMS;
  module.exports.categories = FRONTIER_CATEGORIES;
}
