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
  const { clientName, amount, invoiceRef, companyName, contactEmail, tvaRegime } = data;
  const safeAmount = (typeof amount === 'number' ? amount : parseFloat(amount || 0)).toFixed(2);
  const franchise = tvaRegime === 'franchise';
  const amountTxt = `${safeAmount} €${franchise ? '' : ' TTC'}`;

  const head = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:2rem;color:#1a1a17">
    <p style="font-weight:700;font-size:1.1rem;margin-bottom:1.5rem">${companyName}</p>`;
  const foot = `<p>Cordialement,<br>${companyName}</p>
    ${franchise ? '<p style="font-size:0.72rem;color:#888">TVA non applicable, art. 293 B du CGI</p>' : ''}
    <hr style="border:none;border-top:1px solid #e8e6dd;margin:1.5rem 0">
    <p style="font-size:0.75rem;color:#aaa">Email automatique envoyé par Losaro · contact : ${contactEmail}</p>
  </div>`;

  const bonjour = `<p>Bonjour ${clientName || 'Madame, Monsieur'},</p>`;
  const contact = `<p>Pour toute question : <a href="mailto:${contactEmail}">${contactEmail}</a></p>`;
  // Mentions légales entre professionnels (art. L441-10 du Code de commerce)
  const penalites = `<p style="font-size:0.85rem;color:#555">Tout retard de paiement entraîne de plein droit des pénalités de retard ainsi qu'une indemnité forfaitaire de 40 € pour frais de recouvrement (article L441-10 du Code de commerce).</p>`;

  // Le ton monte palier par palier : un oubli à J+7, une mise en demeure formelle à J+45, un dernier avis à J+60.
  const templates = {
    7: {
      subject: `Petit rappel : facture ${invoiceRef}`,
      html: `${head}
        ${bonjour}
        <p>Sauf erreur de notre part, la facture <strong>${invoiceRef}</strong> d'un montant de <strong>${amountTxt}</strong> est arrivée à échéance il y a 7 jours et n'a pas encore été réglée.</p>
        <p>C'est sans doute un simple oubli. Si le paiement est déjà parti, merci de ne pas tenir compte de ce message. Si vous avez besoin d'un nouvel exemplaire de la facture, il suffit de répondre à ce mail.</p>
        ${foot}`
    },
    15: {
      subject: `Facture ${invoiceRef} toujours en attente de règlement`,
      html: `${head}
        ${bonjour}
        <p>Nous revenons vers vous au sujet de la facture <strong>${invoiceRef}</strong> de <strong>${amountTxt}</strong>, dont l'échéance est dépassée de 15 jours.</p>
        <p>Pourriez-vous nous indiquer la date à laquelle le règlement est prévu ? Si un point de la facture pose question, dites-le-nous, nous le réglerons rapidement ensemble.</p>
        ${contact}
        ${foot}`
    },
    30: {
      subject: `Facture ${invoiceRef} : 30 jours de retard`,
      html: `${head}
        ${bonjour}
        <p>Malgré nos deux précédents rappels, la facture <strong>${invoiceRef}</strong> de <strong>${amountTxt}</strong> reste impayée, 30 jours après son échéance.</p>
        <p>Nous vous demandons de procéder au règlement sous <strong>8 jours</strong>. Passé ce délai, nous serons contraints d'appliquer les pénalités prévues par la loi et nos conditions de vente.</p>
        ${penalites}
        ${contact}
        ${foot}`
    },
    45: {
      subject: `Mise en demeure de payer : facture ${invoiceRef}`,
      html: `${head}
        ${bonjour}
        <p>La facture <strong>${invoiceRef}</strong> de <strong>${amountTxt}</strong> est impayée depuis 45 jours, et nos relances amiables sont restées sans réponse.</p>
        <p>Par le présent message, nous vous <strong>mettons en demeure</strong> de régler cette somme sous <strong>8 jours</strong> à compter de sa réception.</p>
        <p>À défaut, nous engagerons une procédure de recouvrement judiciaire, notamment par voie d'injonction de payer.</p>
        ${penalites}
        ${contact}
        ${foot}`
    },
    60: {
      subject: `Dernier avis avant procédure : facture ${invoiceRef}`,
      html: `${head}
        ${bonjour}
        <p>Malgré notre mise en demeure, la facture <strong>${invoiceRef}</strong> d'un montant de <strong>${amountTxt}</strong> reste impayée depuis <strong>60 jours</strong>.</p>
        <p>Ce message est notre <strong>dernier avis amiable</strong>. À défaut de règlement intégral sous <strong>5 jours ouvrés</strong>, nous saisirons le tribunal compétent sans nouvel avis.</p>
        <p>La somme réclamée sera alors augmentée :</p>
        <ul>
          <li>des <strong>pénalités de retard</strong>, calculées depuis la date d'échéance ;</li>
          <li>de l'<strong>indemnité forfaitaire de 40 €</strong> pour frais de recouvrement (article L441-10 du Code de commerce).</li>
        </ul>
        <p>Pour éviter cette procédure, merci de procéder au règlement dès maintenant, ou de nous contacter pour en convenir.</p>
        ${contact}
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
    // Le SDK Resend (v6) ne lève pas d'exception en cas de refus : il renvoie { data, error }
    if (result.error) {
      logger.error(`Resend a refusé la relance J+${stage} → ${data.clientEmail} : ${result.error.message}`);
      return { success: false, error: result.error.message };
    }
    logger.info(`Relance J+${stage} envoyée → ${data.clientEmail} | ${data.invoiceRef}`);
    return { success: true, id: result.data?.id };
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
    const applicableStages = RELANCE_SCHEDULE.filter(s => s > lastSent && daysLate >= s);
    if (applicableStages.length === 0) continue;
    const nextStage = applicableStages[applicableStages.length - 1];

    const result = await sendRelanceEmail(nextStage, {
      clientName: f.client_nom, // vide : le mail commence par « Madame, Monsieur »
      clientEmail: f.client_email,
      amount: f.montant,
      invoiceRef: f.reference,
      companyName,
      contactEmail,
      tvaRegime: cabinet.tva_regime,
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
