const assert = require('node:assert/strict');
const { createCaptureRecord, serializeCaptureRecord } = require('./capture');
const { parseStillWaterEmbed } = require('./parser');

const cases = [
  {
    name: 'storage container withdrawal',
    input: {
      id: 'storage-pistol-chamber-withdrawal',
      title: 'Take from container Log',
      description: `Has Taken
Steam name : Son Telahari
PlayerName: William Winther
Server ID 6
Steam ID: steam:110000103fa2447
Has Taken 3 Pistol Chamber From Van Horn Gunsmith Inventory
Has Taken · 08/17/26 09:03:55 AM`
    },
    expected: {
      event_type: 'Stocking Movement',
      direction: 'Stock Out',
      discord_item_name: 'Pistol Chamber',
      discord_item_label: 'Pistol Chamber',
      item_name: 'Pistol Chamber',
      quantity: 3,
      actor: 'William Winther',
      container_name: 'Van Horn Gunsmith',
      catalog_matched: true,
      review_required: false
    }
  },
  {
    name: 'storage container deposit',
    input: {
      id: 'storage-pistol-chamber-deposit',
      title: 'Move to container Log',
      description: `Deposited
Steam name : Son Telahari
PlayerName: William Winther
Server ID 6
Steam ID: steam:110000103fa2447
Deposited 3 Pistol Chamber To Van Horn Gunsmith Inventory
Deposited · 08/17/26 09:04:36 AM`
    },
    expected: {
      event_type: 'Stocking Movement',
      direction: 'Stock In',
      discord_item_name: 'Pistol Chamber',
      discord_item_label: 'Pistol Chamber',
      item_name: 'Pistol Chamber',
      quantity: 3,
      actor: 'William Winther',
      container_name: 'Van Horn Gunsmith',
      catalog_matched: true,
      review_required: false
    }
  },
  {
    name: 'deposit',
    input: {
      id: 'deposit-example',
      title: 'Deposit',
      description: 'Item name: weapon_test_rifle\nItem label: Test Rifle\nDeposit Amount: 2\nSell Price: $100'
    },
    expected: { event_type: 'Stocking Movement', direction: 'Stock In', item_name: 'Test Rifle', quantity: 2, unit_price: 100 }
  },
  {
    name: 'real Still Water Gun Cleaning Kit deposit',
    input: {
      id: 'still-water-cleaning-kit-deposit',
      title: 'Deposit',
      description: `**Shop Info:**
Shop name: Frontier Firearms
 ID: 23
**Item Info:**
Item name: guncleaningkit
Item label: Gun Cleaning Kit
Deposit Amount: 40
Sell Price: $2.5`
    },
    expected: {
      event_type: 'Stocking Movement',
      direction: 'Stock In',
      discord_item_name: 'guncleaningkit',
      discord_item_label: 'Gun Cleaning Kit',
      item_name: 'Gun Cleaning Kit',
      quantity: 40,
      unit_price: 2.5,
      webhook_id: 'still-water-cleaning-kit-deposit'
    }
  },
  {
    name: 'real Still Water Navy Revolver deposit',
    input: {
      id: 'still-water-navy-deposit',
      title: '',
      description: `**Shop Info:**
Shop name: Frontier Firearms
 ID: 23
**Item Info:**
Item name: WEAPON_REVOLVER_NAVY
Item label: Revolver Navy
Deposit Amount: 1
Sell Price: $105
Weapon ID: 593`
    },
    expected: {
      event_type: 'Stocking Movement',
      direction: 'Stock In',
      discord_item_name: 'WEAPON_REVOLVER_NAVY',
      discord_item_label: 'Revolver Navy',
      item_name: 'Navy Revolver',
      quantity: 1,
      unit_price: 105,
      webhook_id: 'still-water-navy-deposit'
    }
  },
  {
    name: 'real Still Water BoltAction Rifle deposit',
    input: {
      id: 'still-water-boltaction-deposit',
      title: '',
      description: `**Shop Info:**
Shop name: Frontier Firearms
 ID: 23
**Item Info:**
Item name: WEAPON_RIFLE_BOLTACTION
Item label: BoltAction Rifle
Deposit Amount: 1
Sell Price: $80
Weapon ID: 597`
    },
    expected: {
      event_type: 'Stocking Movement',
      direction: 'Stock In',
      discord_item_name: 'WEAPON_RIFLE_BOLTACTION',
      discord_item_label: 'BoltAction Rifle',
      item_name: 'Boltaction Rifle',
      quantity: 1,
      unit_price: 80,
      webhook_id: 'still-water-boltaction-deposit'
    }
  },
  {
    name: 'real Still Water Pump Shotgun deposit',
    input: {
      id: 'still-water-pump-shotgun-deposit',
      title: '',
      description: `**Shop Info:**
Shop name: Frontier Firearms
 ID: 23
**Item Info:**
Item name: WEAPON_SHOTGUN_PUMP
Item label: Pump Shotgun
Deposit Amount: 1
Sell Price: $80
Weapon ID: 618`
    },
    expected: {
      event_type: 'Stocking Movement',
      direction: 'Stock In',
      discord_item_name: 'WEAPON_SHOTGUN_PUMP',
      discord_item_label: 'Pump Shotgun',
      item_name: 'Pump Shotgun',
      quantity: 1,
      unit_price: 80,
      webhook_id: 'still-water-pump-shotgun-deposit'
    }
  },
  {
    name: 'real Still Water Semi-Auto Shotgun deposit',
    input: {
      id: 'still-water-semiauto-shotgun-deposit',
      title: '',
      description: `**Shop Info:**
Shop name: Frontier Firearms
 ID: 23
**Item Info:**
Item name: WEAPON_SHOTGUN_SEMIAUTO
Item label: Semi-Auto Shotgun
Deposit Amount: 1
Sell Price: $105
Weapon ID: 632`
    },
    expected: {
      event_type: 'Stocking Movement',
      direction: 'Stock In',
      discord_item_name: 'WEAPON_SHOTGUN_SEMIAUTO',
      discord_item_label: 'Semi-Auto Shotgun',
      item_name: 'Semiauto Shotgun',
      quantity: 1,
      unit_price: 105,
      webhook_id: 'still-water-semiauto-shotgun-deposit'
    }
  },
  {
    name: 'real Still Water Repeating Shotgun deposit',
    input: {
      id: 'still-water-repeating-shotgun-deposit',
      title: '',
      description: `**Shop Info:**
Shop name: Frontier Firearms
 ID: 23
**Item Info:**
Item name: WEAPON_SHOTGUN_REPEATING
Item label: Repeating Shotgun
Deposit Amount: 1
Sell Price: $55
Weapon ID: 634`
    },
    expected: {
      event_type: 'Stocking Movement',
      direction: 'Stock In',
      discord_item_name: 'WEAPON_SHOTGUN_REPEATING',
      discord_item_label: 'Repeating Shotgun',
      item_name: 'Repeating Shotgun',
      quantity: 1,
      unit_price: 55,
      webhook_id: 'still-water-repeating-shotgun-deposit'
    }
  },
  {
    name: 'real Still Water Double Barrel Shotgun deposit',
    input: {
      id: 'still-water-double-barrel-shotgun-deposit',
      title: '',
      description: `**Shop Info:**
Shop name: Frontier Firearms
 ID: 23
**Item Info:**
Item name: WEAPON_SHOTGUN_DOUBLEBARREL
Item label: Double Barrel Shotgun
Deposit Amount: 1
Sell Price: $55
Weapon ID: 637`
    },
    expected: {
      event_type: 'Stocking Movement',
      direction: 'Stock In',
      discord_item_name: 'WEAPON_SHOTGUN_DOUBLEBARREL',
      discord_item_label: 'Double Barrel Shotgun',
      item_name: 'Doublebarrel Shotgun',
      quantity: 1,
      unit_price: 55,
      webhook_id: 'still-water-double-barrel-shotgun-deposit'
    }
  },
  {
    name: 'real Still Water Henry Repeater deposit',
    input: {
      id: 'still-water-henry-repeater-deposit',
      title: '',
      description: `**Shop Info:**
Shop name: Frontier Firearms
 ID: 23
**Item Info:**
Item name: WEAPON_REPEATER_HENRY
Item label: Henry Reapeater
Deposit Amount: 1
Sell Price: $55
Weapon ID: 639`
    },
    expected: {
      event_type: 'Stocking Movement',
      direction: 'Stock In',
      discord_item_name: 'WEAPON_REPEATER_HENRY',
      discord_item_label: 'Henry Reapeater',
      item_name: 'Henry Repeater',
      quantity: 1,
      unit_price: 55,
      webhook_id: 'still-water-henry-repeater-deposit'
    }
  },
  {
    name: 'real Still Water Winchester Repeater deposit',
    input: {
      id: 'still-water-winchester-repeater-deposit',
      title: '',
      description: `**Shop Info:**
Shop name: Frontier Firearms
 ID: 23
**Item Info:**
Item name: WEAPON_REPEATER_WINCHESTER
Item label: Winchester Repeater
Deposit Amount: 1
Sell Price: $55
Weapon ID: 641`
    },
    expected: {
      event_type: 'Stocking Movement',
      direction: 'Stock In',
      discord_item_name: 'WEAPON_REPEATER_WINCHESTER',
      discord_item_label: 'Winchester Repeater',
      item_name: 'Winchester Repeater',
      quantity: 1,
      unit_price: 55,
      webhook_id: 'still-water-winchester-repeater-deposit'
    }
  },
  {
    name: 'real Still Water Carbine Repeater deposit',
    input: {
      id: 'still-water-carbine-repeater-deposit',
      title: '',
      description: `**Shop Info:**
Shop name: Frontier Firearms
 ID: 23
**Item Info:**
Item name: WEAPON_REPEATER_CARBINE
Item label: Carabine Reapeater
Deposit Amount: 1
Sell Price: $45
Weapon ID: 643`
    },
    expected: {
      event_type: 'Stocking Movement',
      direction: 'Stock In',
      discord_item_name: 'WEAPON_REPEATER_CARBINE',
      discord_item_label: 'Carabine Reapeater',
      item_name: 'Carbine Repeater',
      quantity: 1,
      unit_price: 45,
      webhook_id: 'still-water-carbine-repeater-deposit'
    }
  },
  {
    name: 'real Still Water Evans Repeater deposit',
    input: {
      id: 'still-water-evans-repeater-deposit',
      title: '',
      description: `**Shop Info:**
Shop name: Frontier Firearms
 ID: 23
**Item Info:**
Item name: WEAPON_REPEATER_EVANS
Item label: Evans Repeater
Deposit Amount: 1
Sell Price: $55
Weapon ID: 645`
    },
    expected: {
      event_type: 'Stocking Movement',
      direction: 'Stock In',
      discord_item_name: 'WEAPON_REPEATER_EVANS',
      discord_item_label: 'Evans Repeater',
      item_name: 'Evans Repeater',
      quantity: 1,
      unit_price: 55,
      webhook_id: 'still-water-evans-repeater-deposit'
    }
  },
  {
    name: 'real Still Water Navy Crossover Revolver deposit',
    input: {
      id: 'still-water-navy-crossover-deposit',
      title: '',
      description: `**Shop Info:**
Shop name: Frontier Firearms
 ID: 23
**Item Info:**
Item name: WEAPON_REVOLVER_NAVY_CROSSOVER
Item label: Revolver Navy Crossover
Deposit Amount: 1
Sell Price: $105
Weapon ID: 647`
    },
    expected: {
      event_type: 'Stocking Movement',
      direction: 'Stock In',
      discord_item_name: 'WEAPON_REVOLVER_NAVY_CROSSOVER',
      discord_item_label: 'Revolver Navy Crossover',
      item_name: 'Navy Crossover Revolver',
      quantity: 1,
      unit_price: 105,
      webhook_id: 'still-water-navy-crossover-deposit'
    }
  },
  {
    name: 'customized Remington 1858 sale maps to Navy Crossover Revolver',
    input: {
      id: 'still-water-remington-1858-sale',
      title: 'Bought Item',
      description: `**Shop Info:**
Shop name: Frontier Firearms
ID: 23
Shop Ledger: $1870.0
**Item Info:**
Item label: Remington 1858
Amount Bought: 1
Sell Price: $105.0`
    },
    expected: {
      event_type: 'Sale',
      direction: 'Stock Out',
      discord_item_label: 'Remington 1858',
      item_name: 'Navy Crossover Revolver',
      quantity: 1,
      unit_price: 105,
      shop_ledger: 1870,
      webhook_id: 'still-water-remington-1858-sale'
    }
  },
  {
    name: 'real Still Water Schofield Revolver deposit',
    input: {
      id: 'still-water-schofield-deposit',
      title: '',
      description: `**Shop Info:**
Shop name: Frontier Firearms
 ID: 23
**Item Info:**
Item name: WEAPON_REVOLVER_SCHOFIELD
Item label: Revolver Schofield
Deposit Amount: 1
Sell Price: $55
Weapon ID: 649`
    },
    expected: {
      event_type: 'Stocking Movement',
      direction: 'Stock In',
      discord_item_name: 'WEAPON_REVOLVER_SCHOFIELD',
      discord_item_label: 'Revolver Schofield',
      item_name: 'Schofield Revolver',
      quantity: 1,
      unit_price: 55,
      webhook_id: 'still-water-schofield-deposit'
    }
  },
  {
    name: 'real Still Water Lemat Revolver deposit',
    input: {
      id: 'still-water-lemat-deposit',
      title: '',
      description: `**Shop Info:**
Shop name: Frontier Firearms
 ID: 23
**Item Info:**
Item name: WEAPON_REVOLVER_LEMAT
Item label: Revolver Lemat
Deposit Amount: 1
Sell Price: $55
Weapon ID: 650`
    },
    expected: {
      event_type: 'Stocking Movement',
      direction: 'Stock In',
      discord_item_name: 'WEAPON_REVOLVER_LEMAT',
      discord_item_label: 'Revolver Lemat',
      item_name: 'Lemat Revolver',
      quantity: 1,
      unit_price: 55,
      webhook_id: 'still-water-lemat-deposit'
    }
  },
  {
    name: 'real Still Water Rolling Block Rifle deposit',
    input: {
      id: 'still-water-rolling-block-deposit',
      title: '',
      description: `**Shop Info:**
Shop name: Frontier Firearms
 ID: 23
**Item Info:**
Item name: WEAPON_SNIPERRIFLE_ROLLINGBLOCK
Item label: Rolling Block Rifle
Deposit Amount: 1
Sell Price: $105
Weapon ID: 653`
    },
    expected: {
      event_type: 'Stocking Movement',
      direction: 'Stock In',
      discord_item_name: 'WEAPON_SNIPERRIFLE_ROLLINGBLOCK',
      discord_item_label: 'Rolling Block Rifle',
      item_name: 'Rollingblock Rifle',
      quantity: 1,
      unit_price: 105,
      webhook_id: 'still-water-rolling-block-deposit'
    }
  },
  {
    name: 'real Still Water Bow deposit',
    input: {
      id: 'still-water-bow-deposit',
      title: '',
      description: `**Shop Info:**
Shop name: Frontier Firearms
 ID: 23
**Item Info:**
Item name: WEAPON_BOW
Item label: Bow
Deposit Amount: 1
Sell Price: $25
Weapon ID: 667`
    },
    expected: {
      event_type: 'Stocking Movement',
      direction: 'Stock In',
      discord_item_name: 'WEAPON_BOW',
      discord_item_label: 'Bow',
      item_name: 'Bow',
      quantity: 1,
      unit_price: 25,
      webhook_id: 'still-water-bow-deposit'
    }
  },
  {
    name: 'real Still Water Reinforced Lasso deposit',
    input: {
      id: 'still-water-reinforced-lasso-deposit',
      title: '',
      description: `**Shop Info:**
Shop name: Frontier Firearms
 ID: 23
**Item Info:**
Item name: WEAPON_LASSO_REINFORCED
Item label: Reinforced Lasso
Deposit Amount: 1
Sell Price: $35
Weapon ID: 673`
    },
    expected: {
      event_type: 'Stocking Movement',
      direction: 'Stock In',
      discord_item_name: 'WEAPON_LASSO_REINFORCED',
      discord_item_label: 'Reinforced Lasso',
      item_name: 'Reinforced Lasso',
      quantity: 1,
      unit_price: 35,
      webhook_id: 'still-water-reinforced-lasso-deposit'
    }
  },
  {
    name: 'real Still Water Revolver Ammo Normal deposit',
    input: {
      id: 'still-water-revolver-ammo-normal-deposit',
      title: '',
      description: `**Shop Info:**
Shop name: Frontier Firearms
 ID: 23
**Item Info:**
Item name: ammorevolvernormal
Item label: Revolver Ammo Normal
Deposit Amount: 10
Sell Price: $2.0`
    },
    expected: {
      event_type: 'Stocking Movement',
      direction: 'Stock In',
      discord_item_name: 'ammorevolvernormal',
      discord_item_label: 'Revolver Ammo Normal',
      item_name: 'Revolver Ammo Normal',
      quantity: 10,
      unit_price: 2,
      webhook_id: 'still-water-revolver-ammo-normal-deposit'
    }
  },
  {
    name: 'real Still Water Rifle Ammo Express deposit',
    input: {
      id: 'still-water-rifle-ammo-express-deposit',
      title: '',
      description: `**Shop Info:**
Shop name: Frontier Firearms
 ID: 23
**Item Info:**
Item name: ammorifleexpress
Item label: Rifle Ammo Express
Deposit Amount: 10
Sell Price: $2.25`
    },
    expected: {
      event_type: 'Stocking Movement',
      direction: 'Stock In',
      discord_item_name: 'ammorifleexpress',
      discord_item_label: 'Rifle Ammo Express',
      item_name: 'Rifle Ammo Express',
      quantity: 10,
      unit_price: 2.25,
      webhook_id: 'still-water-rifle-ammo-express-deposit'
    }
  },
  {
    name: 'real Still Water Shotgun Ammo Normal deposit',
    input: {
      id: 'still-water-shotgun-ammo-normal-deposit',
      title: '',
      description: `**Shop Info:**
Shop name: Frontier Firearms
 ID: 23
**Item Info:**
Item name: ammoshotgunnormal
Item label: Shotgun Ammo Normal
Deposit Amount: 10
Sell Price: $2.0`
    },
    expected: {
      event_type: 'Stocking Movement',
      direction: 'Stock In',
      discord_item_name: 'ammoshotgunnormal',
      discord_item_label: 'Shotgun Ammo Normal',
      item_name: 'Shotgun Ammo Normal',
      quantity: 10,
      unit_price: 2,
      webhook_id: 'still-water-shotgun-ammo-normal-deposit'
    }
  },
  {
    name: 'real Still Water Repeater Ammo Express deposit',
    input: {
      id: 'still-water-repeater-ammo-express-deposit',
      title: '',
      description: `**Shop Info:**
Shop name: Frontier Firearms
 ID: 23
**Item Info:**
Item name: ammorepeaterexpress
Item label: Repeater Ammo Express
Deposit Amount: 10
Sell Price: $2.25`
    },
    expected: {
      event_type: 'Stocking Movement',
      direction: 'Stock In',
      discord_item_name: 'ammorepeaterexpress',
      discord_item_label: 'Repeater Ammo Express',
      item_name: 'Repeater Ammo Express',
      quantity: 10,
      unit_price: 2.25,
      webhook_id: 'still-water-repeater-ammo-express-deposit'
    }
  },
  {
    name: 'withdrawal',
    input: {
      id: 'withdraw-example',
      title: 'Withdraw Item',
      description: 'Item label: Test Rifle\nAmount Withdrawn: 1'
    },
    expected: { event_type: 'Stocking Movement', direction: 'Stock Out', item_name: 'Test Rifle', quantity: 1, unit_price: 0 }
  },
  {
    name: 'customer purchase',
    input: {
      id: 'sale-example',
      title: 'Bought Item',
      description: 'Shop Ledger: $6,025.50\nItem label: Test Rifle\nAmount Bought: 1\nSell Price: $100\nCurrent Item Total: 9'
    },
    expected: {
      event_type: 'Sale',
      direction: 'Stock Out',
      item_name: 'Test Rifle',
      quantity: 1,
      unit_price: 100,
      shop_ledger: 6025.5,
      current_item_total: 9
    }
  },
  {
    name: 'multi-item customer purchase total price',
    input: {
      id: 'multi-sale-example',
      title: 'Bought Item',
      description: 'Shop Ledger: $1,009.50\nItem label: Repeater Ammo Express\nAmount Bought: 10\nSell Price: $22.50\nCurrent Item Total: 5'
    },
    expected: {
      event_type: 'Sale',
      direction: 'Stock Out',
      item_name: 'Repeater Ammo Express',
      quantity: 10,
      unit_price: 2.25,
      shop_ledger: 1009.5,
      current_item_total: 5
    }
  },
  {
    name: 'buy order fill',
    input: {
      id: 'buy-order-example',
      title: 'Buy Order Filled',
      description: 'Item name: iron\nItem label: Iron\nBuy Order ID: BO-1\nAmount Filled: 8\nBuy Price: $4.50'
    },
    expected: { event_type: 'Purchase', direction: 'Purchase', item_name: 'Iron', quantity: 8, unit_price: 4.5, buy_order_id: 'BO-1' }
  },
  {
    name: 'sold to shop total price',
    input: {
      id: 'sold-example',
      title: 'Item Sold to Shop',
      description: 'Shop Ledger: $0\nItem name: iron\nItem label: Iron\nSold Amount: 10\nSell Price: $10'
    },
    expected: {
      event_type: 'Purchase',
      direction: 'Purchase',
      item_name: 'Iron',
      quantity: 10,
      unit_price: 1,
      shop_ledger: 0,
      current_item_total: null
    }
  },
  {
    name: 'ledger-only control',
    input: {
      id: 'ledger-control-example',
      title: 'Ledger Updated',
      description: 'Shop Info:\nShop name: Frontier Firearms\nShop Ledger: $2,768.00'
    },
    expected: {
      event_type: 'Stocking Movement',
      direction: 'Stock In',
      item_name: '',
      quantity: 0,
      shop_ledger: 2768,
      review_required: true,
      review_reason: 'missing_item,missing_quantity'
    }
  }
];

for (const testCase of cases) {
  const result = parseStillWaterEmbed(testCase.input);
  for (const [key, value] of Object.entries(testCase.expected)) {
    assert.deepEqual(result[key], value, `${testCase.name}: ${key}`);
  }
  assert.equal(result.webhook_id, testCase.input.id, `${testCase.name}: Discord message identity`);
}

const unknownItem = parseStillWaterEmbed({
  id: 'unknown-custom-label',
  title: 'Bought Item',
  description: 'Item label: Uncatalogued Custom Revolver\nAmount Bought: 1\nSell Price: $50'
});
assert.equal(unknownItem.review_required, true);
assert.equal(unknownItem.review_reason, 'unknown_item');
assert.equal(unknownItem.catalog_matched, false);

const knownMaterial = parseStillWaterEmbed({
  id: 'known-material',
  title: 'Item Sold to Shop',
  description: 'Item name: iron\nItem label: Iron\nSold Amount: 5\nSell Price: $5'
});
assert.equal(knownMaterial.review_required, false);
assert.equal(knownMaterial.item_name, 'Iron');

const capture = createCaptureRecord({
  id: 'message-1',
  channelId: 'channel-1',
  webhookId: 'webhook-1',
  createdAt: new Date('2026-07-12T10:30:00.000Z')
}, {
  title: 'Still Water Event',
  description: 'Raw storefront text'
});

assert.deepEqual(capture, {
  parser_profile: 'still-water',
  discord_message_id: 'message-1',
  discord_channel_id: 'channel-1',
  webhook_id: 'webhook-1',
  timestamp: '2026-07-12T10:30:00.000Z',
  title: 'Still Water Event',
  description: 'Raw storefront text'
});
assert.deepEqual(JSON.parse(serializeCaptureRecord(capture)), capture);

console.log(`Capture check passed and parser checks passed: ${cases.length} event formats, including 20 captured Still Water events.`);
