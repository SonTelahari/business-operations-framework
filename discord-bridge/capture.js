const fs = require('fs');
const path = require('path');

function createCaptureRecord(message, source) {
  return {
    parser_profile: 'still-water',
    discord_message_id: message.id || '',
    discord_channel_id: message.channelId || '',
    webhook_id: message.webhookId || '',
    timestamp: toIsoTimestamp(message.createdAt),
    title: source.title || '',
    description: source.description || ''
  };
}

function serializeCaptureRecord(record) {
  return JSON.stringify(record);
}

function appendCaptureRecord(filePath, record) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${serializeCaptureRecord(record)}\n`, 'utf8');
}

function toIsoTimestamp(value) {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value.toISOString();
  const parsed = new Date(value || 0);
  return Number.isNaN(parsed.valueOf()) ? '' : parsed.toISOString();
}

module.exports = {
  appendCaptureRecord,
  createCaptureRecord,
  serializeCaptureRecord
};
