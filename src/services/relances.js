const { Resend } = require('resend');
const logger = require('./logger');

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// ════════════════════════════════════════════════════
// Système de relances Losaro
// Process toutes les factures impayées en retard et envoie
// l'email de relance correspondant à l'étape (J+7, J+15, J+30, J+45, J+60).
// Met à jour last_stage_sent + last_sent_at en BDD.
// ════════════════════════════════════════════════════

const RELANCE_SCHEDULE = [7, 15, 30, 45, 60];

function getRelanceTemplate(stage, data) {
  const { clientName, amount, invoiceRef, companyName, contactEmail } = data;
  const safeAmount = (typeof amount === 'number' ? amount : parseFloat(amount || 0)).toFixed(2);

  const head = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:2rem;color:#1a1a17">
    <p style="font-weight:700;font-size:1.1rem;margin-bottom:1.5rem">${companyName}</p>`;
  const foot = `<p>Cordialement,<br>${companyName}</p>
    <hr style="border:none;border-top:1px solid #e8e6dd;margin:1.5rem 0">
    <p style="font-size:0.75rem;color:#aaa">Email automatique envoyé par Losaro · contact : ${contactEmail}</p>
  </div>`;

  const templates = {
    7: {
      subject: `Rappel — Facture ${invoiceRef} en attente de règlement`,
      html: `${head}
        <p>Bonjour ${clientName || 'Madame, Monsieur'},</p>
        <p>Nous vous contactons concernant notre facture <strong>${invoiceRef}</strong> d'un montant de <strong>${safeAmount} € TTC</strong>, dont l'échéance est dépassée de 7 jours.</p>
        <p>Si vous avez déjà procédé au règlement, merci de ne pas tenir compte de ce message. Dans le cas contraire, nous vous remercions de bien vouloir régulariser la situation rapidement.</p>
        <p>Pour toute question : <a href="mailto:${contactEmail}">${contactEmail}</a></p>
        ${foot}`
    },
    15: {
      subject: `2ᵉ rappel — Facture ${invoiceRef} — Règlement urgent`,
      html: `${head}
        <p>Bonjour ${clientName || 'Madame, Monsieur'},</p>
        <p>Sauf erreur de notre part, nous n'avons pas reçu le règlement de notre facture <strong>${invoiceRef}</strong> de <strong>${safeAmount} € TTC</strong>, désormais en retard de 15 jours.</p>
        <p>Merci de procéder au règlement dans les 48 heures. Sans réponse, nous appliquerons les pénalités de retard prévues dans nos CGV.</p>
        ${foot}`
    },
    30: {
      subject: `URGENT — Facture ${invoiceRef} impayée — ${safeAmount} €`,
      html: `${head}
        <p>Bonjour ${clientName || 'Madame, Monsieur'},</p>
        <p>Malgré nos précédentes relances, la facture <strong>${invoiceRef}</strong> de <strong>${safeAmount} € TTC</strong> reste impayée depuis 30 jours.</p>
        <p>Nous vous mettons en demeure de régler cette somme dans un délai de 8 jours. Sans règlement, nous engagerons une procédure de recouvrement.</p>
        ${foot}`
    },
    45: {
      subject: `Mise en demeure — Facture ${invoiceRef} — Action requise`,
      html: `${head}
        <p>Bonjour ${clientName || 'Madame, Monsieur'},</p>
        <p>La facture <strong>${invoiceRef}</strong> de <strong>${safeAmount} € TTC</strong> est impayée depuis 45 jours. Nos tentatives de règlement amiable sont restées sans suite.</p>
        <p>Sans règlement dans les 5 jours ouvrés, ce dossier sera transmis à notre service contentieux pour recouvrement judiciaire.</p>
        ${foot}`
    },
    60: {
      subject: `Dernier avertissement avant procédure — Facture ${invoiceRef}`,
      html: `${head}
        <p>Bonjour ${clientName || 'Madame, Monsieur'},</p>
        <p>Malgré nos précédentes relances, la facture <strong>${invoiceRef}</strong> d'un montant de <strong>${safeAmount} € TTC</strong> reste impayée depuis <strong>60 jours</strong>.</p>
        <p>Ceci constitue notre <strong>dernière relance amiable</strong>. À défaut de règlement intégral sous <strong>5 jours ouvrés</strong>, nous engagerons une procédure de recouvrement sans nouvel avis.</p>
        <p>Dans ce cas, s'ajouteront à la somme due :</p>
        <ul>
          <li>Des <strong>intérêts de retard</strong> calculés depuis la date d'échéance</li>
          <li>Une <strong>indemnité forfaitaire pour frais de recouvrement</strong> (le cas échéant)</li>
          <li>L'ensemble des <strong>frais de procédure et honoraires d'huissier</strong>, à votre charge</li>
        </ul>
        <p>Pour éviter ces frais, merci de procéder au règlement immédiat.</p>
        <p>Pour toute question : <a href="mailto:${contactEmail}">${contactEmail}</a></p>
        ${foot}`
    }
  };
  return templates[stage] || templates[7];
}

async function sendRelanceEmail(stage, data) {
  const template = getRelanceTemplate(stage, data);
  if (!resend) {
    logger.debug(`[EMAIL RELANCE SIMULÉ] J+${stage} → ${data.clientEmail} | ${data.invoiceRef}`);
    return { success: true, simulated: true };
  }
  try {
    const result = await resend.emails.send({
      from: `${data.companyName} <relances@losaro.fr>`,
      to: data.clientEmail,
      subject: template.subject,
      html: template.html,
      reply_to: data.contactEmail || 'contact@losaro.fr',
    });
    logger.info(`Relance J+${stage} envoyée → ${data.clientEmail} | ${data.invoiceRef}`);
    return { success: true, id: result.id };
  } catch (err) {
    logger.error(`Resend error: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// ════════════════════════════════════════════════════
// processRelancesForCabinet
// Traite toutes les factures pending en retard pour UN cabinet.
// ════════════════════════════════════════════════════
async function processRelancesForCabinet(supabase, cabinet) {
  const now = new Date();
  const results = [];

  const { data: factures, error } = await supabase
    .from('factures')
    .select('*')
    .eq('cabinet_id', cabinet.id)
    .eq('statut', 'pending');

  if (error) {
    logger.error(`processRelances cabinet=${cabinet.id} error: ${error.message}`);
    return [];
  }

  const companyName = cabinet.entreprise || cabinet.nom || 'Losaro';
  const contactEmail = cabinet.email || 'contact@losaro.fr';

  for (const f of factures || []) {
    if (!f.date_echeance || !f.client_email) continue;

    const dueDate = new Date(f.date_echeance);
    const daysLate = Math.floor((now - dueDate) / (1000 * 60 * 60 * 24));
    if (daysLate < RELANCE_SCHEDULE[0]) continue; // pas encore en retard

    const lastSent = f.last_stage_sent || 0;
    const nextStage = RELANCE_SCHEDULE.find(s => s > lastSent && daysLate >= s);
    if (!nextStage) continue;

    const result = await sendRelanceEmail(nextStage, {
      clientName: f.client_nom || 'Client',
      clientEmail: f.client_email,
      amount: f.montant,
      invoiceRef: f.reference,
      companyName,
      contactEmail,
    });

    if (result.success) {
      await supabase
        .from('factures')
        .update({
          last_stage_sent: nextStage,
          last_sent_at: now.toISOString(),
        })
        .eq('id', f.id);
    }

    results.push({ facture_id: f.id, reference: f.reference, stage: nextStage, ...result });
  }

  return results;
}

// ════════════════════════════════════════════════════
// processRelancesAll
// Boucle sur tous les cabinets actifs. Appelé par le cron quotidien.
// ════════════════════════════════════════════════════
async function processRelancesAll(supabase) {
  const { data: cabinets, error } = await supabase
    .from('cabinets')
    .select('*')
    .eq('actif', true);

  if (error) {
    logger.error(`processRelancesAll list cabinets error: ${error.message}`);
    return { processed: 0, results: [] };
  }

  const allResults = [];
  for (const cabinet of cabinets || []) {
    const results = await processRelancesForCabinet(supabase, cabinet);
    allResults.push({ cabinet_id: cabinet.id, count: results.length, results });
  }

  const total = allResults.reduce((s, c) => s + c.count, 0);
  logger.info(`Cron relances: ${total} relances envoyées sur ${cabinets?.length || 0} cabinets`);
  return { processed: total, cabinets: allResults };
}

module.exports = {
  RELANCE_SCHEDULE,
  sendRelanceEmail,
  getRelanceTemplate,
  processRelancesForCabinet,
  processRelancesAll,
};
