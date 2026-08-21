const assert = require("node:assert/strict");
const { newDb } = require("pg-mem");
const fs = require("node:fs");
const path = require("node:path");
const { Database } = require("./database");
const { StandaloneStore, reduceInventory, reduceLedger } = require("./standalone-store");

const storeSource = fs.readFileSync(path.join(__dirname, "standalone-store.js"), "utf8");
assert(storeSource.includes("$5::numeric IS NULL"), "PostgreSQL must know the nullable inventory count parameter type");
assert(storeSource.includes("$2::numeric IS NULL"), "PostgreSQL must know the nullable ledger count parameter type");

async function run() {
  const memory = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const adapter = memory.adapters.createPg();
  const database = new Database({ pool: new adapter.Pool() });
  const businessId = "materialized-test";
  const store = new StandaloneStore(database, { businessId });

  try {
    await database.initialize();

    // History can predate migration rollout or the first time a hosted workspace is opened.
    await database.query(`
      INSERT INTO inventory_events (
        business_id, event_id, occurred_at, source, event_kind, location_type,
        item_name, normalized_item_name, absolute_quantity
      ) VALUES
        ($1, 'opening-count', '2026-08-01T10:00:00.000Z', 'Legacy', 'Stock Count', 'storage', 'Iron', 'iron', 10),
        ($1, 'opening-use', '2026-08-01T10:20:00.000Z', 'Legacy', 'Production Use', 'storage', 'Iron', 'iron', NULL)
    `, [businessId]);
    await database.query(`
      UPDATE inventory_events SET quantity_delta = -3
      WHERE business_id = $1 AND event_id = 'opening-use'
    `, [businessId]);
    await database.query(`
      INSERT INTO ledger_events (
        business_id, event_id, occurred_at, source, event_kind, absolute_balance
      ) VALUES ($1, 'opening-ledger', '2026-08-01T10:00:00.000Z', 'Legacy', 'Ledger Count', 100)
    `, [businessId]);
    await database.query(`
      INSERT INTO ledger_events (
        business_id, event_id, occurred_at, source, event_kind, amount_delta
      ) VALUES ($1, 'opening-expense', '2026-08-01T10:20:00.000Z', 'Legacy', 'Cash Out', -20)
    `, [businessId]);

    const initialized = await store.ensureMaterializedBalances();
    assert.equal(initialized.rebuilt, true);
    assert.deepEqual(await inventoryBalance(database, businessId), {
      quantity: 7,
      countedQuantity: 10,
      netMovement: -3
    });
    assert.deepEqual(await ledgerBalance(database, businessId), {
      balance: 80,
      countedBalance: 100,
      netMovement: -20
    });

    // A late movement before the count must not change the current quantity.
    await manual(store, {
      id: "late-before-count",
      kind: "Correction In",
      location: "Storage",
      itemName: "Iron",
      quantity: 5,
      createdAt: "2026-08-01T09:00:00.000Z"
    });
    assert.equal((await inventoryBalance(database, businessId)).quantity, 7);

    // A late absolute count between existing events resets the earlier history.
    await manual(store, {
      id: "late-middle-count",
      kind: "Stock Count",
      location: "Storage",
      itemName: "Iron",
      quantity: 20,
      createdAt: "2026-08-01T10:15:00.000Z"
    });
    assert.deepEqual(await inventoryBalance(database, businessId), {
      quantity: 17,
      countedQuantity: 20,
      netMovement: -3
    });

    await Promise.all([
      manual(store, {
        id: "concurrent-in-one", kind: "Correction In", location: "Storage",
        itemName: "Iron", quantity: 2, createdAt: "2026-08-01T10:30:00.000Z"
      }),
      manual(store, {
        id: "concurrent-in-two", kind: "Correction In", location: "Storage",
        itemName: "Iron", quantity: 4, createdAt: "2026-08-01T10:31:00.000Z"
      })
    ]);
    assert.equal((await inventoryBalance(database, businessId)).quantity, 23);
    assert.equal((await manual(store, {
      id: "concurrent-in-two", kind: "Correction In", location: "Storage",
      itemName: "Iron", quantity: 99, createdAt: "2026-08-01T10:32:00.000Z"
    })).duplicate, true);
    assert.equal((await inventoryBalance(database, businessId)).quantity, 23);

    // Ledger events follow the same chronological reset rules.
    await manual(store, {
      id: "late-ledger-income",
      kind: "Cash In",
      amount: 50,
      createdAt: "2026-08-01T09:00:00.000Z"
    });
    assert.equal((await ledgerBalance(database, businessId)).balance, 80);
    await manual(store, {
      id: "late-ledger-count",
      kind: "Ledger Count",
      amount: 120,
      createdAt: "2026-08-01T10:15:00.000Z"
    });
    assert.deepEqual(await ledgerBalance(database, businessId), {
      balance: 100,
      countedBalance: 120,
      netMovement: -20
    });
    await manual(store, {
      id: "new-ledger-income",
      kind: "Cash In",
      amount: 5,
      createdAt: "2026-08-01T10:40:00.000Z"
    });
    assert.equal((await store.finance()).ledger.balance, 105);

    await assertMaterializedParity(database, businessId);

    // Recovery rebuilds compact state from immutable events without changing history.
    await database.query("DELETE FROM inventory_balances WHERE business_id = $1", [businessId]);
    await database.query("DELETE FROM ledger_balances WHERE business_id = $1", [businessId]);
    const rebuilt = await store.rebuildMaterializedBalances();
    assert.equal(rebuilt.rebuilt, true);
    assert.equal(rebuilt.inventoryBalances, 1);
    await assertMaterializedParity(database, businessId);

    console.log("Materialized inventory and ledger balance parity checks passed.");
  } finally {
    await database.close();
  }
}

async function manual(store, entry) {
  return store.handleGuiPayload({ action: "manual_operation", entry });
}

async function inventoryBalance(database, businessId) {
  const result = await database.query(`
    SELECT quantity, counted_at, net_movement_since_count
    FROM inventory_balances
    WHERE business_id = $1 AND location_type = 'storage' AND normalized_item_name = 'iron'
  `, [businessId]);
  const row = result.rows[0];
  return {
    quantity: Number(row.quantity),
    countedQuantity: row.counted_at ? Number(row.quantity) - Number(row.net_movement_since_count) : null,
    netMovement: Number(row.net_movement_since_count)
  };
}

async function ledgerBalance(database, businessId) {
  const result = await database.query(`
    SELECT balance, counted_balance, net_movement_since_count
    FROM ledger_balances WHERE business_id = $1
  `, [businessId]);
  const row = result.rows[0];
  return {
    balance: Number(row.balance),
    countedBalance: row.counted_balance === null ? null : Number(row.counted_balance),
    netMovement: Number(row.net_movement_since_count)
  };
}

async function assertMaterializedParity(database, businessId) {
  const inventoryEvents = await database.query(`
    SELECT * FROM inventory_events
    WHERE business_id = $1
    ORDER BY occurred_at, recorded_at, event_id
  `, [businessId]);
  const expectedInventory = reduceInventory(inventoryEvents.rows).get("storage:iron");
  const actualInventory = await inventoryBalance(database, businessId);
  assert.equal(actualInventory.quantity, expectedInventory.quantity);
  assert.equal(actualInventory.netMovement, expectedInventory.netMovementSinceCount);

  const ledgerEvents = await database.query(`
    SELECT * FROM ledger_events
    WHERE business_id = $1
    ORDER BY occurred_at, recorded_at, event_id
  `, [businessId]);
  const expectedLedger = reduceLedger(ledgerEvents.rows);
  const actualLedger = await ledgerBalance(database, businessId);
  assert.equal(actualLedger.balance, expectedLedger.balance);
  assert.equal(actualLedger.countedBalance, expectedLedger.countedBalance);
  assert.equal(actualLedger.netMovement, expectedLedger.netMovementSinceCount);
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
