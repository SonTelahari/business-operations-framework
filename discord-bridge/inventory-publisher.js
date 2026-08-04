const INVENTORY_MARKER = 'Business Operations inventory';
const ALERT_MARKER = 'Business Operations stock alerts';
const LEGACY_INVENTORY_MARKER = 'Frontier Firearms inventory';
const LEGACY_ALERT_MARKER = 'Frontier Firearms stock alerts';
const INVENTORY_PREVIOUS_ID = 'frontier_inventory_previous';
const INVENTORY_NEXT_ID = 'frontier_inventory_next';
const DEFAULT_REFRESH_MS = 5 * 60 * 1000;
const DEFAULT_PAGE_SIZE = 18;

function createInventoryPublisher(options) {
  const client = options.client;
  const snapshotUrl = String(options.snapshotUrl || '').trim();
  const requestHeaders = options.requestHeaders && typeof options.requestHeaders === 'object'
    ? { ...options.requestHeaders }
    : {};
  const inventoryChannelId = String(options.inventoryChannelId || '').trim();
  const alertChannelId = String(options.alertChannelId || '').trim();
  const configuredInventoryMessageId = String(options.inventoryMessageId || '').trim();
  const configuredAlertMessageId = String(options.alertMessageId || '').trim();
  const fetchImpl = options.fetchImpl || fetch;
  const logger = options.logger || console;
  const refreshMs = Math.max(30000, numberOrZero(options.refreshMs) || DEFAULT_REFRESH_MS);
  const enabled = Boolean(snapshotUrl && (inventoryChannelId || alertChannelId));
  const state = {
    pages: [],
    pageIndex: 0,
    inventoryMessage: null,
    alertMessage: null,
    lastAttemptAt: '',
    lastSuccessAt: '',
    lastError: '',
    productCount: 0,
    shortageCount: 0
  };
  let interval = null;
  let refreshPromise = null;
  let queuedRefresh = false;
  let debounceTimer = null;

  async function start() {
    if (!enabled) return;
    try {
      await refresh('startup');
    } catch {}
    interval = setInterval(() => {
      refresh('interval').catch(() => {});
    }, refreshMs);
    if (typeof interval.unref === 'function') interval.unref();
  }

  function stop() {
    if (interval) clearInterval(interval);
    if (debounceTimer) clearTimeout(debounceTimer);
    interval = null;
    debounceTimer = null;
  }

  function requestRefresh(reason = 'storefront event', delayMs = 2500) {
    if (!enabled) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      refresh(reason).catch(() => {});
    }, Math.max(0, Number(delayMs) || 0));
    if (typeof debounceTimer.unref === 'function') debounceTimer.unref();
  }

  async function refresh(reason = 'manual') {
    if (!enabled) return null;
    if (refreshPromise) {
      queuedRefresh = true;
      return refreshPromise;
    }
    refreshPromise = runRefresh(reason);
    try {
      return await refreshPromise;
    } finally {
      refreshPromise = null;
      if (queuedRefresh) {
        queuedRefresh = false;
        requestRefresh('queued refresh', 250);
      }
    }
  }

  async function runRefresh(reason) {
    state.lastAttemptAt = new Date().toISOString();
    try {
      const snapshot = await fetchInventorySnapshot(snapshotUrl, fetchImpl, requestHeaders);
      state.pages = buildInventoryPages(snapshot);
      state.pageIndex = Math.min(state.pageIndex, Math.max(0, state.pages.length - 1));
      state.productCount = snapshot.products.length;
      state.shortageCount = snapshot.products.filter(product => product.missing > 0).length;

      if (inventoryChannelId) {
        state.inventoryMessage = await publishManagedMessage({
          client,
          channelId: inventoryChannelId,
          configuredMessageId: configuredInventoryMessageId,
          currentMessage: state.inventoryMessage,
          marker: INVENTORY_MARKER,
          markerAliases: [LEGACY_INVENTORY_MARKER],
          payload: inventoryMessagePayload(state.pages, state.pageIndex),
          logger
        });
      }
      if (alertChannelId) {
        state.alertMessage = await publishManagedMessage({
          client,
          channelId: alertChannelId,
          configuredMessageId: configuredAlertMessageId,
          currentMessage: state.alertMessage,
          marker: ALERT_MARKER,
          markerAliases: [LEGACY_ALERT_MARKER],
          payload: stockAlertMessagePayload(snapshot),
          logger
        });
      }

      state.lastSuccessAt = new Date().toISOString();
      state.lastError = '';
      logger.info(
        `Discord inventory refreshed (${reason}): ${state.productCount} products, ${state.shortageCount} shortages`
      );
      return snapshot;
    } catch (error) {
      state.lastError = error.message;
      logger.error(`Discord inventory refresh failed (${reason}): ${error.message}`);
      throw error;
    }
  }

  async function handleInteraction(interaction) {
    if (!interaction?.isButton?.()) return false;
    if (![INVENTORY_PREVIOUS_ID, INVENTORY_NEXT_ID].includes(interaction.customId)) return false;
    if (!state.inventoryMessage || interaction.message?.id !== state.inventoryMessage.id) return false;
    if (!state.pages.length) return false;

    const direction = interaction.customId === INVENTORY_NEXT_ID ? 1 : -1;
    state.pageIndex = Math.max(0, Math.min(state.pages.length - 1, state.pageIndex + direction));
    await interaction.update(inventoryMessagePayload(state.pages, state.pageIndex));
    return true;
  }

  function health() {
    return {
      enabled,
      inventory_channel_configured: Boolean(inventoryChannelId),
      alert_channel_configured: Boolean(alertChannelId),
      inventory_message_id: state.inventoryMessage?.id || configuredInventoryMessageId || '',
      alert_message_id: state.alertMessage?.id || configuredAlertMessageId || '',
      refresh_seconds: Math.round(refreshMs / 1000),
      last_attempt_at: state.lastAttemptAt,
      last_success_at: state.lastSuccessAt,
      last_error: state.lastError,
      product_count: state.productCount,
      shortage_count: state.shortageCount
    };
  }

  return { enabled, start, stop, refresh, requestRefresh, handleInteraction, health };
}

async function fetchInventorySnapshot(snapshotUrl, fetchImpl = fetch, requestHeaders = {}) {
  const url = new URL(snapshotUrl);
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json', ...requestHeaders },
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) throw new Error(`Business inventory request failed (${response.status})`);
  return normalizeInventorySnapshot(await response.json());
}

function normalizeInventorySnapshot(payload) {
  if (!payload?.ok || !Array.isArray(payload.inventory?.products)) {
    throw new Error(payload?.error || 'Business API did not return storefront products');
  }
  const products = payload.inventory.products
    .filter(product =>
      product
      && product.itemName
      && product.active !== false
      && numberOrZero(product.target) > 0
    )
    .map(product => {
      const currentStock = Math.max(0, numberOrZero(product.currentStock));
      const target = Math.max(0, numberOrZero(product.target));
      return {
        name: String(product.itemName),
        label: String(product.itemLabel || product.itemName),
        category: String(product.category || 'Other'),
        currentStock,
        target,
        missing: Math.max(0, target - currentStock),
        salePrice: Math.max(0, numberOrZero(product.salePrice))
      };
    })
    .sort((a, b) =>
      a.category.localeCompare(b.category)
      || a.label.localeCompare(b.label)
      || a.name.localeCompare(b.name)
    );
  return {
    businessName: String(payload.workspace?.name || payload.business?.name || 'Business'),
    schemaVersion: numberOrZero(payload.schemaVersion),
    generatedAt: validDateText(payload.generatedAt) || new Date().toISOString(),
    products
  };
}

function buildInventoryPages(snapshot, pageSize = DEFAULT_PAGE_SIZE) {
  const size = Math.max(8, Math.min(20, Math.round(numberOrZero(pageSize) || DEFAULT_PAGE_SIZE)));
  const chunks = chunkArray(snapshot.products, size);
  if (!chunks.length) chunks.push([]);
  const totalStock = snapshot.products.reduce((sum, product) => sum + product.currentStock, 0);
  const knownValue = snapshot.products.reduce(
    (sum, product) => sum + product.currentStock * product.salePrice,
    0
  );
  const targetShortages = snapshot.products.filter(product => product.missing > 0);

  return chunks.map((products, pageIndex) => {
    const fields = groupedProductFields(products, inventoryProductLine);
    fields.push({
      name: 'Summary',
      value: [
        `${snapshot.products.length} unique wares | ${formatNumber(totalStock)} total units`,
        `Known storefront value: ${formatCurrency(knownValue)}`,
        `${targetShortages.length} target ${targetShortages.length === 1 ? 'shortage' : 'shortages'}`
      ].join('\n'),
      inline: false
    });
    return {
      color: targetShortages.length ? 0x9b722e : 0x3f704f,
      title: `${escapeDiscordText(snapshot.businessName)} - Storefront Stock`,
      description: 'Live stock for configured storefront targets.',
      fields,
      footer: {
        text: `${INVENTORY_MARKER} | Page ${pageIndex + 1}/${chunks.length} | Updated ${formatDateTime(snapshot.generatedAt)}`
      },
      timestamp: snapshot.generatedAt
    };
  });
}

function inventoryProductLine(product) {
  const status = product.currentStock <= 0
    ? '\u274c'
    : product.currentStock < product.target
      ? '\u26a0\ufe0f'
      : '\u2705';
  const quantity = `${formatNumber(product.currentStock)}/${formatNumber(product.target)}`;
  const price = product.salePrice > 0 ? ` | ${formatCurrency(product.salePrice)}` : '';
  return `${status} **${escapeDiscordText(product.label)}**: ${quantity}${price}`;
}

function inventoryMessagePayload(pages, pageIndex) {
  const safeIndex = Math.max(0, Math.min(pages.length - 1, pageIndex));
  return {
    embeds: [pages[safeIndex]],
    components: paginationComponents(safeIndex, pages.length),
    allowedMentions: { parse: [] }
  };
}

function stockAlertMessagePayload(snapshot) {
  const shortages = snapshot.products
    .filter(product => product.target > 0 && product.missing > 0)
    .sort((a, b) =>
      Number(a.currentStock > 0) - Number(b.currentStock > 0)
      || b.missing - a.missing
      || a.label.localeCompare(b.label)
    );
  const missingUnits = shortages.reduce((sum, product) => sum + product.missing, 0);
  const hasTargets = snapshot.products.length > 0;
  const visibleShortages = [];
  let renderedCharacters = 0;
  shortages.forEach(product => {
    const lineLength = alertProductLine(product).length + 1;
    if (renderedCharacters + lineLength > 4200) return;
    visibleShortages.push(product);
    renderedCharacters += lineLength;
  });
  const fields = shortages.length
    ? groupedProductFields(visibleShortages, alertProductLine)
    : [{
        name: 'Status',
        value: hasTargets
          ? '\u2705 All storefront targets are currently met.'
          : 'No storefront targets are configured.',
        inline: false
      }];
  const hiddenShortages = shortages.length - visibleShortages.length;
  if (hiddenShortages > 0) {
    fields.push({
      name: 'Additional shortages',
      value: `${hiddenShortages} more ${hiddenShortages === 1 ? 'ware is' : 'wares are'} below target. Open the Restock tab for the complete list.`,
      inline: false
    });
  }
  const generatedAt = snapshot.generatedAt;
  return {
    embeds: [{
      color: shortages.length ? 0xa33b31 : 0x3f704f,
      title: `${escapeDiscordText(snapshot.businessName)} - Stock Alerts`,
      description: shortages.length
        ? `${shortages.length} ${shortages.length === 1 ? 'ware is' : 'wares are'} below target by ${formatNumber(missingUnits)} total units.`
        : hasTargets
          ? 'No storefront restock action is currently required.'
          : 'Set storefront targets in the app to begin stock monitoring.',
      fields,
      footer: { text: `${ALERT_MARKER} | Updated ${formatDateTime(generatedAt)}` },
      timestamp: generatedAt
    }],
    components: [],
    allowedMentions: { parse: [] }
  };
}

function alertProductLine(product) {
  const status = product.currentStock <= 0 ? '\u274c OUT' : '\u26a0\ufe0f LOW';
  return `${status} | **${escapeDiscordText(product.label)}**: ${formatNumber(product.currentStock)}/${formatNumber(product.target)} | Need ${formatNumber(product.missing)}`;
}

function groupedProductFields(products, lineBuilder) {
  if (!products.length) {
    return [{ name: 'Items', value: 'No storefront targets are configured.', inline: false }];
  }
  const groups = new Map();
  products.forEach(product => {
    const category = product.category || 'Other';
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(lineBuilder(product));
  });
  const fields = [];
  groups.forEach((lines, category) => {
    splitLines(lines, 960).forEach((value, index) => {
      fields.push({
        name: index ? `${escapeDiscordText(category)} (continued)` : escapeDiscordText(category),
        value,
        inline: false
      });
    });
  });
  return fields.slice(0, 24);
}

function paginationComponents(pageIndex, pageCount) {
  if (pageCount <= 1) return [];
  return [{
    type: 1,
    components: [
      {
        type: 2,
        style: 2,
        custom_id: INVENTORY_PREVIOUS_ID,
        label: 'Previous',
        disabled: pageIndex <= 0
      },
      {
        type: 2,
        style: 2,
        custom_id: INVENTORY_NEXT_ID,
        label: 'Next',
        disabled: pageIndex >= pageCount - 1
      }
    ]
  }];
}

async function publishManagedMessage(options) {
  const channel = await options.client.channels.fetch(options.channelId);
  if (!channel?.isTextBased?.() || !channel.messages || typeof channel.send !== 'function') {
    throw new Error(`Discord channel ${options.channelId} is not a writable text channel`);
  }

  let message = options.currentMessage;
  if (!message && options.configuredMessageId) {
    message = await channel.messages.fetch(options.configuredMessageId).catch(() => null);
  }
  if (!message) {
    message = await findManagedMessage(
      channel,
      options.client.user?.id,
      [options.marker, ...(options.markerAliases || [])]
    );
  }

  if (message) {
    try {
      await message.edit(options.payload);
      return message;
    } catch (error) {
      options.logger.warn(`Unable to edit Discord message ${message.id}; creating a replacement: ${error.message}`);
    }
  }

  const created = await channel.send(options.payload);
  options.logger.info(`Created Discord ${options.marker.toLowerCase()} message ${created.id}`);
  return created;
}

async function findManagedMessage(channel, botUserId, markers) {
  try {
    const acceptedMarkers = Array.isArray(markers) ? markers : [markers];
    const messages = await channel.messages.fetch({ limit: 50 });
    return messages.find(message =>
      message.author?.id === botUserId
      && message.embeds?.some(embed => acceptedMarkers.some(marker =>
        String(embed.footer?.text || '').includes(marker)
      ))
    ) || null;
  } catch {
    return null;
  }
}

function chunkArray(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function splitLines(lines, limit) {
  const values = [];
  let current = '';
  lines.forEach(line => {
    const next = current ? `${current}\n${line}` : line;
    if (next.length <= limit) {
      current = next;
      return;
    }
    if (current) values.push(current);
    current = line.slice(0, limit);
  });
  if (current) values.push(current);
  return values;
}

function escapeDiscordText(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/([_*`~|>])/g, '\\$1')
    .replace(/@/g, '@\u200b');
}

function formatNumber(value) {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(numberOrZero(value));
}

function formatCurrency(value) {
  return `$${new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  }).format(numberOrZero(value))}`;
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'unknown';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Oslo',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date).replace(',', '');
}

function validDateText(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

module.exports = {
  ALERT_MARKER,
  INVENTORY_MARKER,
  INVENTORY_NEXT_ID,
  INVENTORY_PREVIOUS_ID,
  buildInventoryPages,
  createInventoryPublisher,
  fetchInventorySnapshot,
  inventoryMessagePayload,
  normalizeInventorySnapshot,
  stockAlertMessagePayload
};
