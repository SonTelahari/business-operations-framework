function msrp(low, high, sourceSheet, sourceItem, match = "exact", confirmedByCapture = false) {
  return Object.freeze({
    low,
    high,
    midpoint: (low + high) / 2,
    sourceSheet,
    sourceItem,
    match,
    confirmedByCapture
  });
}

const normalAmmo = msrp(2, 2.25, "Gunsmith MSRPs", "Normal Ammo", "type");
const expressAmmo = msrp(2.25, 2.5, "Gunsmith MSRPs", "Express Ammo", "type");
const slugAmmo = msrp(2.25, 2.5, "Gunsmith MSRPs", "Slug Ammo", "type");
const velocityAmmo = msrp(2.25, 2.5, "Gunsmith MSRPs", "Velocity Ammo", "type");
const splitpointAmmo = msrp(2.25, 2.5, "Gunsmith MSRPs", "Splitpoint Ammo", "type");
const tranquilizerAmmo = msrp(2.25, 2.5, "Gunsmith MSRPs", "Tranq Ammo", "type");

const FRONTIER_PRICING = Object.freeze({
  source: Object.freeze({
    title: "Still Water MSRPs",
    spreadsheetId: "1OUepyU_8ohSrN_QcDtie9JihfBThXZGMCO7_BrxltBA",
    url: "https://docs.google.com/spreadsheets/d/1OUepyU_8ohSrN_QcDtie9JihfBThXZGMCO7_BrxltBA/edit",
    policy: "midpoint"
  }),
  products: Object.freeze({
    "Springfield Rifle": msrp(75, 85, "Gunsmith MSRPs", "Springfield Rifle"),
    "Varmint Rifle": msrp(25, 35, "Gunsmith MSRPs", "Varmint Rifle"),
    "Boltaction Rifle": msrp(75, 85, "Gunsmith MSRPs", "Bolt-action rifle", "alias", true),
    "Rollingblock Rifle": msrp(100, 110, "Master", "Rolling Block", "alias"),
    "Bow": msrp(25, 25, "Storefront Capture", "Bow", "captured", true),
    "Reinforced Lasso": msrp(35, 35, "Storefront Capture", "Reinforced Lasso", "captured", true),
    "Doublebarrel Shotgun": msrp(50, 60, "Gunsmith MSRPs", "Doubler Barrell Shotgun", "alias"),
    "Repeating Shotgun": msrp(50, 60, "Gunsmith MSRPs", "Repeating Shotgun"),
    "Exotic Double Barrel Shotgun": msrp(100, 110, "Gunsmith MSRPs", "Doubler Barrell Exotic Shotgun", "alias"),
    "Semiauto Shotgun": msrp(100, 110, "Gunsmith MSRPs", "Semi-Auto Shotgun", "alias"),
    "Pump Shotgun": msrp(75, 85, "Gunsmith MSRPs", "Pump Shotgun"),
    "Henry Repeater": msrp(50, 60, "Gunsmith MSRPs", "Henry Repeater"),
    "Winchester Repeater": msrp(50, 60, "Gunsmith MSRPs", "Whinchester Repeater", "alias"),
    "Evans Repeater": msrp(50, 60, "Gunsmith MSRPs", "Evans Repeater"),
    "Carbine Repeater": msrp(40, 50, "Gunsmith MSRPs", "Carbine Repeater"),
    "Double Action Revolver": msrp(50, 60, "Gunsmith MSRPs", "Revolver Double-Action", "alias"),
    "Lemat Revolver": msrp(50, 60, "Gunsmith MSRPs", "Revolver Lemat", "alias"),
    "Cattleman Mexican Revolver": msrp(50, 60, "Gunsmith MSRPs", "Cattleman Revolver Mexican", "alias"),
    "Cattleman Revolver": msrp(75, 85, "Gunsmith MSRPs", "Cattleman revolver", "alias"),
    "Navy Crossover Revolver": msrp(100, 110, "Gunsmith MSRPs", "Navy Crossover/1858", "alias"),
    "Navy Revolver": msrp(100, 110, "Gunsmith MSRPs", "Revolver Navy", "alias", true),
    "Schofield Revolver": msrp(50, 60, "Gunsmith MSRPs", "Revolver Schofield", "alias"),
    "Revolver Ammo Express": expressAmmo,
    "Revolver Ammo Normal": msrp(2, 2, "Storefront Capture", "Revolver Ammo Normal", "captured", true),
    "Revolver Ammo Splitpoint": splitpointAmmo,
    "Revolver Ammo Velocity": velocityAmmo,
    "Varmint Tranquilizer Ammo": tranquilizerAmmo,
    "Varmint Ammo": normalAmmo,
    "Repeater Ammo Velocity": velocityAmmo,
    "Repeater Ammo Express": msrp(2.25, 2.25, "Storefront Capture", "Repeater Ammo Express", "captured", true),
    "Repeater Ammo Splitpoint": splitpointAmmo,
    "Repeater Ammo Normal": normalAmmo,
    "Shotgun Ammo Normal": msrp(2, 2, "Storefront Capture", "Shotgun Ammo Normal", "captured", true),
    "Shotgun Ammo Slug": slugAmmo,
    "Rifle Ammo Express": msrp(2.25, 2.25, "Storefront Capture", "Rifle Ammo Express", "captured", true),
    "Rifle Ammo Velocity": velocityAmmo,
    "Rifle Ammo Splitpoint": splitpointAmmo,
    "Rifle Ammo Normal": normalAmmo,
    "Pistol Ammo Velocity": velocityAmmo,
    "Pistol Ammo Splitpoint": splitpointAmmo,
    "Pistol Ammo Express": expressAmmo,
    "Pistol Ammo Normal": normalAmmo
  }),
  materials: Object.freeze({
    "Iron": msrp(0.2, 0.25, "MIning/Oil", "Iron"),
    "Softwood": msrp(0.15, 0.2, "Carpenter MSRPs", "Soft Wood", "alias"),
    "Hard wood": msrp(0.3, 0.35, "Carpenter MSRPs", "Hard Wood", "alias"),
    "Flax": msrp(0.03, 0.05, "Ranch MSRPs", "Crops/Flowers", "alias"),
    "Bolts": msrp(0.04, 0.05, "Blacksmith MSRPs", "Bolts"),
    "Refined Oil": msrp(0.2, 0.25, "MIning/Oil", "Refined Oil"),
    "Glass Bottle": msrp(0.02, 0.03, "General Store MSRPs", "Glass Bottle"),
    "Fabric": msrp(0.25, 0.3, "Tailor MSRPs", "Fabric"),
    "Rifle Stock": msrp(7.5, 8.5, "Carpenter MSRPs", "Rifle Stock"),
    "Rifle Barrel": msrp(7.5, 8.5, "Blacksmith MSRPs", "Rifle Barrell", "alias"),
    "Rifle Receiver": msrp(7.5, 8.5, "Blacksmith MSRPs", "Rifle Receiver"),
    "Shotgun Stock": msrp(7.5, 8.5, "Carpenter MSRPs", "Shotgun Stock"),
    "Shotgun Barrel": msrp(7.5, 8.5, "Blacksmith MSRPs", "Shotgun Barrell", "alias"),
    "Repeater Stock": msrp(7.5, 8.5, "Carpenter MSRPs", "Repeater Stock"),
    "Repeater Barrel": msrp(7.5, 8.5, "Blacksmith MSRPs", "Repeater Barrell", "alias"),
    "Repeater Receiver": msrp(7.5, 8.5, "Blacksmith MSRPs", "Repeater Receiver"),
    "Revolver Handle": msrp(7.5, 8.5, "Carpenter MSRPs", "Revolver Handle"),
    "Revolver Barrel": msrp(7.5, 8.5, "Blacksmith MSRPs", "Revolver Barrell", "alias"),
    "Revolver Cylinder": msrp(7.5, 8.5, "Blacksmith MSRPs", "Revolver Cylindar", "alias"),
    "Pistol Handle": msrp(7.5, 8.5, "Blacksmith MSRPs", "Pistol Handle"),
    "Pistol Barrel": msrp(7.5, 8.5, "Master", "Pistol Barrell", "alias"),
    "Pistol Chamber": msrp(7.5, 8.5, "Blacksmith MSRPs", "Pistol Chamber"),
    "Shell Casing": msrp(0.1, 0.15, "Blacksmith MSRPs", "Shell Casing"),
    "Nitrite": msrp(0.1, 0.15, "MIning/Oil", "Nitrite")
  })
});

if (typeof window !== "undefined") {
  window.FRONTIER_PRICING = FRONTIER_PRICING;
}

if (typeof module !== "undefined") {
  module.exports = FRONTIER_PRICING;
}
