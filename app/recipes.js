const rifleRecipe = [
  ["Iron", 5],
  ["Softwood", 5],
  ["Rifle Stock", 1],
  ["Rifle Barrel", 1],
  ["Rifle Receiver", 1],
  ["Bolts", 2]
];

const pistolRecipe = [
  ["Iron", 2],
  ["Softwood", 2],
  ["Pistol Handle", 1],
  ["Pistol Barrel", 1],
  ["Pistol Chamber", 1],
  ["Bolts", 2]
];

const shotgunRecipe = [
  ["Iron", 5],
  ["Softwood", 5],
  ["Shotgun Stock", 1],
  ["Shotgun Barrel", 1],
  ["Bolts", 5]
];

const repeaterRecipe = [
  ["Iron", 5],
  ["Softwood", 5],
  ["Repeater Stock", 1],
  ["Repeater Barrel", 1],
  ["Repeater Receiver", 1],
  ["Bolts", 2]
];

const revolverRecipe = [
  ["Iron", 2],
  ["Softwood", 2],
  ["Revolver Handle", 1],
  ["Revolver Barrel", 1],
  ["Revolver Cylinder", 1],
  ["Bolts", 2]
];

const ammoRecipe = [
  ["Shell Casing", 10],
  ["Nitrite", 1]
];

const hatchetAmmoRecipe = [["Iron", 1]];

window.FRONTIER_RECIPES = {
  "Springfield Rifle": rifleRecipe,
  "Varmint Rifle": rifleRecipe,
  "Boltaction Rifle": rifleRecipe,
  "Rollingblock Rifle": rifleRecipe,
  "Bow": [["Hard wood", 10], ["Softwood", 4]],
  "Lasso": [["Flax", 30]],
  "Reinforced Lasso": [["Flax", 100]],
  "Doublebarrel Shotgun": shotgunRecipe,
  "Repeating Shotgun": shotgunRecipe,
  "Exotic Double Barrel Shotgun": shotgunRecipe,
  "Semiauto Shotgun": shotgunRecipe,
  "Pump Shotgun": shotgunRecipe,
  "Henry Repeater": repeaterRecipe,
  "Winchester Repeater": repeaterRecipe,
  "Evans Repeater": repeaterRecipe,
  "Carbine Repeater": repeaterRecipe,
  "Double Action Revolver": revolverRecipe,
  "Lemat Revolver": revolverRecipe,
  "Double Action Gambler Revolver": revolverRecipe,
  "Cattleman Mexican Revolver": revolverRecipe,
  "Cattleman Revolver": revolverRecipe,
  "Navy Crossover Revolver": revolverRecipe,
  "Navy Revolver": revolverRecipe,
  "Schofield Revolver": revolverRecipe,
  "Volcanic Pistol": pistolRecipe,
  "M1899 Pistol": pistolRecipe,
  "Revolver Ammo Express": ammoRecipe,
  "Revolver Ammo Normal": ammoRecipe,
  "Revolver Ammo Splitpoint": ammoRecipe,
  "Revolver Ammo Velocity": ammoRecipe,
  "Varmint Tranquilizer Ammo": ammoRecipe,
  "Varmint Ammo": ammoRecipe,
  "Repeater Ammo Velocity": ammoRecipe,
  "Repeater Ammo Express": ammoRecipe,
  "Repeater Ammo Splitpoint": ammoRecipe,
  "Repeater Ammo Normal": ammoRecipe,
  "Arrow Small Game": [["Iron", 1], ["Softwood", 2]],
  "Shotgun Ammo Normal": ammoRecipe,
  "Shotgun Ammo Slug": ammoRecipe,
  "Rifle Ammo Express": ammoRecipe,
  "Rifle Ammo Velocity": ammoRecipe,
  "Rifle Ammo Splitpoint": ammoRecipe,
  "Elephant Rifle Ammo": ammoRecipe,
  "Rifle Ammo Normal": ammoRecipe,
  "Pistol Ammo Velocity": ammoRecipe,
  "Pistol Ammo Splitpoint": ammoRecipe,
  "Pistol Ammo Express": ammoRecipe,
  "Pistol Ammo Normal": ammoRecipe,
  "Hatchet Ammo": hatchetAmmoRecipe,
  "Hatchet Cleaver Ammo": hatchetAmmoRecipe,
  "Hatchet Hunter Ammo": hatchetAmmoRecipe
};
