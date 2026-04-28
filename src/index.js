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
  'https://losaro.fr',
  'https://www.losaro.fr',
  'https://losaro-frontend.vercel.app',
].filter(Boolean);

// CORS — pour l'instant on garde origin: true le temps de stabiliser, à resserrer plus tard
app.use(cors({
  origin: true,
  credentials: true,
}));

app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 200 }));

// JSON body parser sauf pour le webhook Stripe (raw body requis)
app.use((req, res, next) => {
  if (req.originalUrl === '/api/stripe/webhook') next();
  else express.json({ limit: '1mb' })(req, res, next);
});

app.use((req, res, next) => { logger.debug(`${req.method} ${req.path}`); next(); });

// ═══════════ ROUTES LOSARO ═══════════
app.use('/api/auth',      require('./routes/auth'));
app.use('/api/cabinets',  require('./routes/cabinets'));
app.use('/api/clients',   require('./routes/clients'));
app.use('/api/factures',  require('./routes/factures'));
app.use('/api/devis',     require('./routes/devis'));
app.use('/api/reminders', require('./routes/reminders'));
app.use('/api/chat',      require('./routes/chat'));
app.use('/api/stripe',    require('./routes/stripe'));

// ═══════════ HEALTH ═══════════
app.get('/health', (req, res) => res.json({
  status: 'ok',
  service: 'losaro-backend',
  version: '2.0.0',
  uptime: Math.floor(process.uptime()) + 's',
  services: {
    supabase: !!(process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY),
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    stripe: !!process.env.STRIPE_SECRET_KEY,
    resend: !!process.env.RESEND_API_KEY,
    cron_secret: !!process.env.CRON_SECRET,
  },
}));

app.use((req, res) => res.status(404).json({ error: `Route ${req.method} ${req.path} introuvable.` }));
app.use((err, req, res, next) => {
  logger.error(`Unhandled: ${err.message}`);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
  logger.info(`🚀 Losaro Backend — port ${PORT}`);
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY) {
    startCronJobs();
  } else {
    logger.warn('Cron jobs non démarrés — variables Supabase manquantes');
  }
});

process.on('SIGTERM', () => {
  require('./services/cron').stopCronJobs();
  process.exit(0);
});

module.exports = app;
