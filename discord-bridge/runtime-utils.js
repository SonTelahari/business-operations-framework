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

module.exports = { embedToText, loadEnvFile, normalizeSnowflake };
