const fs = require('fs');
const path = require('path');

const uploadsRoot = path.join(__dirname, '..', 'uploads');

const stripWrappingQuotes = (value) =>
  String(value || '')
    .trim()
    .replace(/^['"]+|['"]+$/g, '');

const isAbsoluteMediaUrl = (value) =>
  /^https?:\/\//i.test(String(value || '')) || String(value || '').startsWith('blob:');

const localUploadPathExists = (value) => {
  const normalizedValue = String(value || '').trim();
  if (!normalizedValue.startsWith('/uploads/') && !normalizedValue.startsWith('uploads/')) {
    return false;
  }

  const relativePath = normalizedValue.replace(/^\/+/, '').replace(/^uploads[\\/]/, '');
  const absolutePath = path.join(uploadsRoot, relativePath);

  return fs.existsSync(absolutePath);
};

const normalizeStoredMediaPath = (value) => {
  const normalizedValue = stripWrappingQuotes(value);
  if (!normalizedValue) return null;

  if (isAbsoluteMediaUrl(normalizedValue)) {
    return normalizedValue;
  }

  if (normalizedValue.startsWith('/uploads/') || normalizedValue.startsWith('uploads/')) {
    return localUploadPathExists(normalizedValue)
      ? normalizedValue.startsWith('/') ? normalizedValue : `/${normalizedValue}`
      : null;
  }

  return normalizedValue;
};

const mapMediaFields = (row, fields = []) => {
  if (!row) return row;
  const nextRow = { ...row };

  for (const field of fields) {
    if (field in nextRow) {
      nextRow[field] = normalizeStoredMediaPath(nextRow[field]);
    }
  }

  return nextRow;
};

const mapMediaFieldsList = (rows, fields = []) =>
  Array.isArray(rows) ? rows.map((row) => mapMediaFields(row, fields)) : [];

module.exports = {
  stripWrappingQuotes,
  normalizeStoredMediaPath,
  mapMediaFields,
  mapMediaFieldsList,
};
