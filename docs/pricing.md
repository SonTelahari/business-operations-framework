# Still Water Pricing

Source: [Still Water MSRPs](https://docs.google.com/spreadsheets/d/1OUepyU_8ohSrN_QcDtie9JihfBThXZGMCO7_BrxltBA/edit)

## Policy

- The default sale price is the midpoint of the published low and high Gunsmith MSRP.
- Estimated production cost uses the midpoint price for every recipe ingredient.
- Captured storefront prices override uncertainty by confirming the corresponding midpoint.
- Products without a reliable source match remain at zero until a storefront capture or explicit MSRP confirms them.

The first captures confirm this policy: Bolt-action is `$75-$85` and stocked at `$80`; Navy is `$100-$110` and stocked at `$105`.

Base Bow is stocked at its captured `$25` price. The workbook's `$25-$35` `Improved Bow` range is not treated as the base Bow's range.

Captured storefront overrides also set Reinforced Lasso to `$35`, Revolver Ammo Normal to `$2.00`, Rifle Ammo Express to `$2.25`, Shotgun Ammo Normal to `$2.00`, and Repeater Ammo Express to `$2.25`.

## Material Aliases

- `Wood` uses the Carpenter `Soft Wood` range.
- `Hard wood` uses the Carpenter `Hard Wood` range.
- `Flax` uses the Ranch `Crops/Flowers` range.
- Gun-part spelling differences such as `Barrell` and `Cylindar` map to the recipe's normalized part name.

## Midpoint Costs

| Material | Unit Cost |
| --- | ---: |
| Iron | $0.225 |
| Wood | $0.175 |
| Hard wood | $0.325 |
| Flax | $0.04 |
| Bolts | $0.045 |
| Shell Casing | $0.125 |
| Nitrite | $0.125 |
| Each stock, barrel, receiver, handle, chamber, or cylinder | $8.00 |

## Awaiting Confirmation

- Lasso
- Double Action Gambler Revolver
- Volcanic Pistol
- M1899 Pistol
- Arrow Small Game
- Elephant Rifle Ammo
- Hatchet Ammo
- Hatchet Cleaver Ammo
- Hatchet Hunter Ammo
