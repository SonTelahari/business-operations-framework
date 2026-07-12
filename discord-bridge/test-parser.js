const assert = require('node:assert/strict');
const { parseFrontierEmbed } = require('./parser');

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
  const result = parseFrontierEmbed(testCase.input);
  for (const [key, value] of Object.entries(testCase.expected)) {
    assert.deepEqual(result[key], value, `${testCase.name}: ${key}`);
  }
}

console.log(`Parser checks passed: ${cases.length} generic Still Water event formats.`);
