const assert = require("node:assert/strict");
const { buildSupplyQuoteTelegram, formatTelegramQuantity } = require("./supply-telegram");

const telegram = buildSupplyQuoteTelegram({
  requestedBy: "Stored Requester",
  lines: [
    { label: "Repeater Barrel", quantity: 20 },
    { label: "Revolver Cylinder", quantity: 25 },
    { label: "Shell Casing", quantity: 2000 }
  ]
}, {
  name: "William Winther",
  title: "Owner/proprietor",
  business: "Frontier Firearms, Van Horn"
});

assert.equal(telegram, [
  "Good day,",
  "",
  "We would like to get a quoted price for the following materials:",
  "",
  "Item                       |   Number |",
  "----------------------------------------",
  "Repeater Barrel            |       20 |",
  "Revolver Cylinder          |       25 |",
  "Shell Casing               |     2000 |",
  "----------------------------------------",
  "",
  "Please quote a price per unit as well as a sub total along with an estimated time of delivery.",
  "",
  "Respectfully,",
  "William Winther",
  "Owner/proprietor",
  "Frontier Firearms, Van Horn"
].join("\n"));
assert.equal(formatTelegramQuantity(2000), "2000");
assert.equal(formatTelegramQuantity(12.5), "12.5");
assert.doesNotMatch(telegram, /2,000/);

console.log("Supply quotation telegram formatting passed.");
