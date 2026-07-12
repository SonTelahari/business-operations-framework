const assert = require('node:assert/strict');
const { createCaptureRecord } = require('./capture');
const { parseStillWaterEmbed } = require('./parser');

const cases = [
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
      webhook_id: '593'
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
      description: 'Item label: Test Rifle\nAmount Bought: 1\nSell Price: $100'
    },
    expected: { event_type: 'Sale', direction: 'Stock Out', item_name: 'Test Rifle', quantity: 1, unit_price: 100 }
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
      description: 'Item name: iron\nItem label: Iron\nSold Amount: 10\nSell Price: $10'
    },
    expected: { event_type: 'Purchase', direction: 'Purchase', item_name: 'Iron', quantity: 10, unit_price: 1 }
  }
];

for (const testCase of cases) {
  const result = parseStillWaterEmbed(testCase.input);
  for (const [key, value] of Object.entries(testCase.expected)) {
    assert.deepEqual(result[key], value, `${testCase.name}: ${key}`);
  }
}

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

console.log(`Capture check passed and parser checks passed: ${cases.length} event formats, including 1 captured Still Water event.`);
