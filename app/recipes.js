const rifleRecipe = [
  ["Iron", 5],
  ["Wood", 5],
  ["Rifle Stock", 1],
  ["Rifle Barrel", 1],
  ["Rifle Receiver", 1],
  ["Bolts", 2]
];

const pistolRecipe = [
  ["Iron", 2],
  ["Wood", 2],
  ["Pistol Handle", 1],
  ["Pistol Barrel", 1],
  ["Pistol Chamber", 1],
  ["Bolts", 2]
];

const shotgunRecipe = [
  ["Iron", 5],
  ["Wood", 5],
  ["Shotgun Stock", 1],
  ["Shotgun Barrel", 1],
  ["Bolts", 5]
];

window.FRONTIER_RECIPES = {
  "Springfield Rifle": rifleRecipe,
  "Varmint Rifle": rifleRecipe,
  "Boltaction Rifle": rifleRecipe,
  "Rollingblock Rifle": rifleRecipe,
  "Bow": [["Hard wood", 10], ["Wood", 4]],
  "Lasso": [["Flax", 30]],
  "Reinforced Lasso": [["Flax", 100]],
  "Doublebarrel Shotgun": shotgunRecipe,
  "Repeating Shotgun": shotgunRecipe,
  "Exotic Double Barrel Shotgun": shotgunRecipe,
  "Semiauto Shotgun": shotgunRecipe,
  "Pump Shotgun": shotgunRecipe,
  "Volcanic Pistol": pistolRecipe,
  "M1899 Pistol": pistolRecipe
};
