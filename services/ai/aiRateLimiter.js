const { get, set } = require('../cacheService');

const AI_RATE_LIMIT_WINDOW_SECONDS = Number(process.env.AI_RATE_LIMIT_WINDOW_SECONDS || 60);
const AI_RATE_LIMIT_MAX_REQUESTS = Number(process.env.AI_RATE_LIMIT_MAX_REQUESTS || 12);

const aiRateLimiter = async (req, res, next) => {
  const userId = req.user?.id || req.ip;
  const key = `ai:rate:${userId}:${Math.floor(Date.now() / (AI_RATE_LIMIT_WINDOW_SECONDS * 1000))}`;

  const current = Number((await get(key)) || 0);
  if (current >= AI_RATE_LIMIT_MAX_REQUESTS) {
    return res.status(429).json({
      success: false,
      message: 'AI limit reached. Please wait a moment before trying again.',
    });
  }

  await set(key, current + 1, AI_RATE_LIMIT_WINDOW_SECONDS);
  next();
};

module.exports = {
  AI_RATE_LIMIT_MAX_REQUESTS,
  AI_RATE_LIMIT_WINDOW_SECONDS,
  aiRateLimiter,
};
