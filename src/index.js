require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const logger = require('./services/logger');
const { startCronJobs } = require('./services/cron');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(helmet({ crossOriginEmbedderPolicy: false }));

const allowedOrigins = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  process.env.FRONTEND_URL,
  'https://mediflow.fr',
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) callback(null, true);
    else callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 200 }));

app.use((req, res, next) => {
  if (req.originalUrl === '/api/stripe/webhook') next();
  else express.json({ limit: '1mb' })(req, res, next);
});

app.use((req, res, next) => { logger.debug(`${req.method} ${req.path}`); next(); });

app.use('/api/chat',      require('./routes/chat'));
app.use('/api/ical',      require('./routes/ical'));
app.use('/api/stripe',    require('./routes/stripe'));
app.use('/api/reminders', require('./routes/reminders'));
app.use('/api/cabinets',  require('./routes/cabinets'));
app.use('/api/auth',      require('./routes/auth'));

app.get('/health', (req, res) => res.json({
  status: 'ok',
  version: '1.0.0',
  uptime: Math.floor(process.uptime()) + 's',
  services: {
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    stripe: !!process.env.STRIPE_SECRET_KEY,
    twilio: !!process.env.TWILIO_ACCOUNT_SID,
  }
}));

app.use((req, res) => res.status(404).json({ error: `Route ${req.method} ${req.path} introuvable.` }));
app.use((err, req, res, next) => res.status(500).json({ error: err.message }));

app.listen(PORT, () => {
  logger.info(`🚀 MediFlow Backend — port ${PORT}`);
  if (process.env.ANTHROPIC_API_KEY) startCronJobs();
  else logger.warn('Cron jobs non démarrés — ANTHROPIC_API_KEY manquante');
});

process.on('SIGTERM', () => {
  require('./services/cron').stopCronJobs();
  process.exit(0);
});

module.exports = app;
