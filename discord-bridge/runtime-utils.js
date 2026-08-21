const fs = require('fs');

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;

  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function normalizeSnowflake(value) {
  const match = String(value || '').match(/\d{15,25}/);
  return match ? match[0] : String(value || '').trim();
}

function embedToText(embed) {
  const parts = [];
  if (embed.description) parts.push(embed.description);
  for (const field of embed.fields || []) parts.push(`${field.name}:\n${field.value}`);
  return parts.join('\n');
}

function prepareSheetPayload(payload) {
  if (!payload?.review_required) return payload;
  return {
    ...payload,
    proposed_item_name: payload.item_name || '',
    proposed_quantity: payload.quantity || 0,
    item_name: '',
    quantity: 0
  };
}

function resolveCaptureMode(environment = process.env) {
  const configured = String(environment.CAPTURE_ONLY ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(configured)) {
    return { captureOnly: true, source: 'explicit' };
  }
  if (['0', 'false', 'no', 'off'].includes(configured)) {
    return { captureOnly: false, source: 'explicit' };
  }
  if (configured) {
    throw new Error('CAPTURE_ONLY must be 1 or 0');
  }

  const apiConfigured = Boolean(
    String(environment.BUSINESS_API_URL || '').trim()
    && String(environment.BRIDGE_API_TOKEN || '').trim()
  );
  return {
    captureOnly: !apiConfigured,
    source: apiConfigured ? 'api-configured-default' : 'capture-safe-default'
  };
}

function createBridgeTelemetry(now = () => new Date().toISOString()) {
  const state = {
    startedAt: now(),
    discordReadyAt: '',
    lastDiscordMessageAt: '',
    lastRelevantMessageAt: '',
    lastIgnoredMessageAt: '',
    lastCapturedAt: '',
    lastForwardAttemptAt: '',
    lastForwardSuccessAt: '',
    lastForwardFailureAt: '',
    lastForwardError: '',
    lastMessageId: '',
    lastChannelId: '',
    seenMessages: 0,
    relevantMessages: 0,
    ignoredMessages: 0,
    capturedPayloads: 0,
    forwardedPayloads: 0,
    failedPayloads: 0
  };

  function messageSeen(message = {}) {
    state.lastDiscordMessageAt = now();
    state.lastMessageId = String(message.id || '');
    state.lastChannelId = String(message.channelId || '');
    state.seenMessages += 1;
  }

  return {
    discordReady() {
      state.discordReadyAt = now();
    },
    messageSeen,
    messageRelevant() {
      state.lastRelevantMessageAt = now();
      state.relevantMessages += 1;
    },
    messageIgnored() {
      state.lastIgnoredMessageAt = now();
      state.ignoredMessages += 1;
    },
    payloadCaptured() {
      state.lastCapturedAt = now();
      state.capturedPayloads += 1;
    },
    forwardAttempt() {
      state.lastForwardAttemptAt = now();
    },
    forwardSuccess() {
      state.lastForwardSuccessAt = now();
      state.lastForwardError = '';
      state.forwardedPayloads += 1;
    },
    forwardFailure(error) {
      state.lastForwardFailureAt = now();
      state.lastForwardError = String(error?.message || error || 'Unknown forwarding error').slice(0, 500);
      state.failedPayloads += 1;
    },
    health() {
      return {
        started_at: state.startedAt,
        discord_ready_at: state.discordReadyAt,
        last_discord_message_at: state.lastDiscordMessageAt,
        last_relevant_message_at: state.lastRelevantMessageAt,
        last_ignored_message_at: state.lastIgnoredMessageAt,
        last_captured_at: state.lastCapturedAt,
        last_forward_attempt_at: state.lastForwardAttemptAt,
        last_forward_success_at: state.lastForwardSuccessAt,
        last_forward_failure_at: state.lastForwardFailureAt,
        last_forward_error: state.lastForwardError,
        last_message_id: state.lastMessageId,
        last_channel_id: state.lastChannelId,
        seen_messages: state.seenMessages,
        relevant_messages: state.relevantMessages,
        ignored_messages: state.ignoredMessages,
        captured_payloads: state.capturedPayloads,
        forwarded_payloads: state.forwardedPayloads,
        failed_payloads: state.failedPayloads
      };
    }
  };
}

module.exports = {
  createBridgeTelemetry,
  embedToText,
  loadEnvFile,
  normalizeSnowflake,
  prepareSheetPayload,
  resolveCaptureMode
};
