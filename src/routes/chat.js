const express = require('express');
const fetch = require('node-fetch');
const { aiRateLimiter } = require('../middleware/auth');
const logger = require('../services/logger');

const router = express.Router();

const buildSystemPrompt = (config = {}) => {
  const {
    medecin = 'Dr. Marie Dupont',
    specialite = 'Médecin généraliste',
    telephone = '01 23 45 67 89',
    horaires = 'lundi au vendredi de 8h à 19h',
    adresse = '12 rue de la Paix, 75001 Paris',
    delai_rdv = '48 à 72 heures',
  } = config;
  return `Tu es l'assistant IA du cabinet de ${medecin}, ${specialite}.
Informations : Tél: ${telephone}, Horaires: ${horaires}, Adresse: ${adresse}, Délai RDV: ${delai_rdv}.
Règles : 1) Jamais de conseils médicaux. 2) Renvoie vers le médecin pour questions cliniques.
3) Chaleureux et concis. 4) Français uniquement. 5) Max 3-4 phrases.
6) Urgence → donner le 15 (SAMU) et le 18 immédiatement.`;
};

router.post('/', aiRateLimiter, async (req, res) => {
  const { messages, config, mode = 'patient' } = req.body;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages requis.' });
  }
  const safeMessages = messages.slice(-20).map(m => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: String(m.content).slice(0, 2000)
  }));
  const systemPrompt = buildSystemPrompt(config);
  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: systemPrompt,
        stream: true,
        messages: safeMessages,
      }),
    });
    if (!anthropicRes.ok) {
      const error = await anthropicRes.json();
      return res.status(anthropicRes.status).json({ error: error.error?.message });
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    anthropicRes.body.on('data', chunk => res.write(chunk));
    anthropicRes.body.on('end', () => res.end());
    anthropicRes.body.on('error', () => res.end());
  } catch (err) {
    logger.error(`Chat error: ${err.message}`);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

module.exports = router;
