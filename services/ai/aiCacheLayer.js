const crypto = require('crypto');
const cache = require('../cacheService');

const AI_CACHE_TTL_SECONDS = Number(process.env.AI_CACHE_TTL_SECONDS || 60 * 60 * 6);

const stableStringify = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
};

const createAiCacheKey = (scope, payload) => {
  const hash = crypto.createHash('sha256').update(stableStringify(payload)).digest('hex');
  return `ai:${scope}:${hash}`;
};

const withAiCache = async (scope, payload, compute, ttlSeconds = AI_CACHE_TTL_SECONDS) => {
  return cache.withCache(createAiCacheKey(scope, payload), compute, ttlSeconds);
};

module.exports = {
  AI_CACHE_TTL_SECONDS,
  createAiCacheKey,
  withAiCache,
};
