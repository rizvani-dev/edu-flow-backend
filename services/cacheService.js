const DEFAULT_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS || 90);
const REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.REDIS_REST_URL || '';
const REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.REDIS_REST_TOKEN || '';

const inMemoryStore = new Map();

const now = () => Date.now();

const isRedisConfigured = Boolean(REDIS_REST_URL && REDIS_REST_TOKEN);

const getMemoryEntry = (key) => {
  const entry = inMemoryStore.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= now()) {
    inMemoryStore.delete(key);
    return null;
  }
  return entry.value;
};

const setMemoryEntry = (key, value, ttlSeconds = DEFAULT_TTL_SECONDS) => {
  inMemoryStore.set(key, {
    value,
    expiresAt: now() + ttlSeconds * 1000,
  });
};

const deleteMemoryEntry = (key) => {
  inMemoryStore.delete(key);
};

const redisRequest = async (command, ...args) => {
  const response = await fetch(`${REDIS_REST_URL.replace(/\/$/, '')}/${command}/${args.map((item) => encodeURIComponent(item)).join('/')}`, {
    headers: {
      Authorization: `Bearer ${REDIS_REST_TOKEN}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Redis request failed with status ${response.status}`);
  }

  return response.json();
};

const get = async (key) => {
  const memoryValue = getMemoryEntry(key);
  if (memoryValue !== null) {
    return memoryValue;
  }

  if (!isRedisConfigured) return null;

  try {
    const data = await redisRequest('get', key);
    if (!data?.result) return null;
    const parsed = JSON.parse(data.result);
    setMemoryEntry(key, parsed);
    return parsed;
  } catch (error) {
    console.warn('Cache get fallback:', error.message);
    return null;
  }
};

const set = async (key, value, ttlSeconds = DEFAULT_TTL_SECONDS) => {
  setMemoryEntry(key, value, ttlSeconds);

  if (!isRedisConfigured) return;

  try {
    await redisRequest('setex', key, String(ttlSeconds), JSON.stringify(value));
  } catch (error) {
    console.warn('Cache set fallback:', error.message);
  }
};

const del = async (key) => {
  deleteMemoryEntry(key);

  if (!isRedisConfigured) return;

  try {
    await redisRequest('del', key);
  } catch (error) {
    console.warn('Cache delete fallback:', error.message);
  }
};

const withCache = async (key, compute, ttlSeconds = DEFAULT_TTL_SECONDS) => {
  const cached = await get(key);
  if (cached !== null) {
    return cached;
  }

  const value = await compute();
  await set(key, value, ttlSeconds);
  return value;
};

module.exports = {
  DEFAULT_TTL_SECONDS,
  del,
  get,
  isRedisConfigured,
  set,
  withCache,
};
