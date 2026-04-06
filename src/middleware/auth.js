const logger = require('../services/logger');
const { rateLimit } = require('express-rate-limit');

const authMiddleware = (req, res, next) => {
  if (process.env.NODE_ENV === 'development') return next();
  const origin = req.headers.origin;
  const allowedOrigins = [
    process.env.FRONTEND_URL,
    'https://mediflow.fr',
    'https://www.mediflow.fr',
  ].filter(Boolean);
  if (!allowedOrigins.includes(origin)) {
    logger.warn(`Requête bloquée: ${origin}`);
    return res.status(403).json({ error: 'Accès non autorisé' });
  }
  next();
};

const aiRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'Trop de requêtes. Attendez une minute.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const stripeRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Trop de tentatives. Attendez une minute.' },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = { authMiddleware, aiRateLimiter, stripeRateLimiter };
