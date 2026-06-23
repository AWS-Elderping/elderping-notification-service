// rateLimiter.js
// In-memory sliding window rate limiter for protecting write endpoints

const limits = {
  EMAIL: { max: 100, window: 60 * 1000 },
  SMS: { max: 50, window: 60 * 1000 },
  BULK: { max: 10, window: 60 * 1000 }
};

const requestHistory = {
  EMAIL: [],
  SMS: [],
  BULK: []
};

/**
 * Express middleware factory to apply rate limiting based on route category.
 * @param {String} type - 'EMAIL', 'SMS', or 'BULK'
 */
const rateLimiter = (type) => {
  return (req, res, next) => {
    const now = Date.now();
    const config = limits[type];
    if (!config) return next();

    // Prune expired entries
    requestHistory[type] = requestHistory[type].filter(timestamp => timestamp > now - config.window);

    if (requestHistory[type].length >= config.max) {
      console.warn(`[RATE LIMIT EXCEEDED] Route category ${type} has hit maximum limit of ${config.max}/min.`);
      return res.status(429).json({ 
        error: 'Too Many Requests', 
        message: `Rate limit exceeded for channel ${type}. Maximum allowed is ${config.max} requests per minute.` 
      });
    }

    requestHistory[type].push(now);
    next();
  };
};

module.exports = rateLimiter;
