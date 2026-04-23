const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

// Relance schedules in days
const RELANCE_SCHEDULE = [7, 15, 30, 45, 60];

// Email templates for each stage
function getRelanceEmail(stage, data) {
  const { clientName, clientEmail, amount, invoiceRef, companyName, contactEmail } = data;
  
  const templates = {
    7: {
      subject: `Rappel - Facture ${invoiceRef} en attente de règlement`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:2rem;color:#1a1a17">
          <div style="margin-bottom:2rem">
            <strong style="font-size:1.1rem;letter-spacing:-0.02em">${companyName}</strong>
          </div>
          <p>Bonjour ${clientName},</p>
          <p>Nous vous contactons concernant notre facture <strong>${invoiceRef}</strong> d'un montant de <strong>${amount}€ HT</strong>, dont l'échéance est maintenant dépassée de 7 jours.</p>
          <p>Si vous avez déjà procédé au règlement, veuillez ne pas tenir compte de ce message. Dans le cas contraire, nous vous remercions de bien vouloir régulariser cette situation dans les meilleurs délais.</p>
          <p>Pour toute question, n'hésitez pas à nous contacter à <a href="mailto:${contactEmail}">${contactEmail}</a>.</p>
          <p>Cordialement,<br>${companyName}</p>
        </div>
      `
    },
    15: {
      subject: `2ème rappel - Facture ${invoiceRef} - Règlement urgent`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:2rem;color:#1a1a17">
          <div style="margin-bottom:2rem">
            <strong style="font-size:1.1rem;letter-spacing:-0.02em">${companyName}</strong>
          </div>
          <p>Bonjour ${clientName},</p>
          <p>Sauf erreur de notre part, nous n'avons pas encore reçu le règlement de notre facture <strong>${invoiceRef}</strong> d'un montant de <strong>${amount}€ HT</strong>, qui accuse désormais un retard de 15 jours.</p>
          <p>Nous vous demandons de bien vouloir procéder au règlement de cette somme dans un délai de 48 heures.</p>
          <p>Sans réponse de votre part, nous nous verrons contraints d'appliquer les pénalités de retard prévues dans nos conditions générales de vente.</p>
          <p>Cordialement,<br>${companyName}</p>
        </div>
      `
    },
    30: {
      subject: `URGENT - Facture ${invoiceRef} impayée - ${amount}€`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:2rem;color:#1a1a17">
          <div style="margin-bottom:2rem">
            <strong style="font-size:1.1rem;letter-spacing:-0.02em">${companyName}</strong>
          </div>
          <p>Bonjour ${clientName},</p>
          <p>Malgré nos précédentes relances, la facture <strong>${invoiceRef}</strong> d'un montant de <strong>${amount}€ HT</strong> reste impayée depuis 30 jours.</p>
          <p>Nous vous mettons en demeure de régler cette somme dans un délai de 8 jours à compter de la réception de ce message.</p>
          <p>Sans règlement de votre part dans ce délai, nous serons contraints d'engager une procédure de recouvrement.</p>
          <p>Cordialement,<br>${companyName}</p>
        </div>
      `
    },
    45: {
      subject: `Mise en demeure - Facture ${invoiceRef} - Action requise`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:2rem;color:#1a1a17">
          <div style="margin-bottom:2rem">
            <strong style="font-size:1.1rem;letter-spacing:-0.02em">${companyName}</strong>
          </div>
          <p>Bonjour ${clientName},</p>
          <p>La facture <strong>${invoiceRef}</strong> de <strong>${amount}€ HT</strong> est impayée depuis 45 jours. Toutes nos tentatives de règlement amiable sont restées sans suite.</p>
          <p>Sans règlement dans les 5 jours ouvrés, nous transmettrons ce dossier à notre service contentieux pour recouvrement judiciaire.</p>
          <p>Cordialement,<br>${companyName}</p>
        </div>
      `
    },
    60: {
      subject: `Dernier avertissement - Facture ${invoiceRef} - Recouvrement imminent`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:2rem;color:#1a1a17">
          <div style="margin-bottom:2rem">
            <strong style="font-size:1.1rem;letter-spacing:-0.02em">${companyName}</strong>
          </div>
          <p>Bonjour ${clientName},</p>
          <p>Ceci est notre dernier avertissement concernant la facture <strong>${invoiceRef}</strong> de <strong>${amount}€ HT</strong>, impayée depuis 60 jours.</p>
          <p>Sans règlement immédiat, nous engageons une procédure de recouvrement judiciaire sans autre préavis. Les frais de procédure seront à votre charge.</p>
          <p>Cordialement,<br>${companyName}</p>
        </div>
      `
    }
  };

  return templates[stage] || templates[7];
}

// Send a relance email
async function sendRelanceEmail(stage, data) {
  const template = getRelanceEmail(stage, data);
  
  try {
    const result = await resend.emails.send({
      from: `${data.companyName} <relances@losaro.fr>`,
      to: data.clientEmail,
      subject: template.subject,
      html: template.html,
      reply_to: data.contactEmail
    });
    return { success: true, id: result.id };
  } catch (error) {
    console.error('Resend error:', error);
    return { success: false, error: error.message };
  }
}

// Process all pending relances for a cabinet
async function processRelances(supabase, cabinetId) {
  const results = [];
  const now = new Date();

  try {
    // Get all unpaid invoices for this cabinet
    const { data: rappels, error } = await supabase
      .from('rappels')
      .select('*')
      .eq('cabinet_id', cabinetId)
      .eq('statut', 'pending');

    if (error) throw error;

    for (const rappel of rappels || []) {
      const dueDate = new Date(rappel.due_date);
      const daysLate = Math.floor((now - dueDate) / (1000 * 60 * 60 * 24));

      // Find next relance stage
      const nextStage = RELANCE_SCHEDULE.find(s => {
        const lastSent = rappel.last_stage_sent || 0;
        return s > lastSent && daysLate >= s;
      });

      if (!nextStage) continue;

      // Send the email
      const emailResult = await sendRelanceEmail(nextStage, {
        clientName: rappel.client_name,
        clientEmail: rappel.client_email,
        amount: rappel.amount,
        invoiceRef: rappel.invoice_ref,
        companyName: rappel.company_name || 'Votre prestataire',
        contactEmail: rappel.contact_email || 'contact@losaro.fr'
      });

      if (emailResult.success) {
        // Update last stage sent
        await supabase
          .from('rappels')
          .update({
            last_stage_sent: nextStage,
            last_sent_at: now.toISOString(),
            status_details: `Relance J+${nextStage} envoyée`
          })
          .eq('id', rappel.id);

        results.push({ rappelId: rappel.id, stage: nextStage, success: true });
      } else {
        results.push({ rappelId: rappel.id, stage: nextStage, success: false, error: emailResult.error });
      }
    }
  } catch (err) {
    console.error('processRelances error:', err);
  }

  return results;
}

// Manual trigger: send a specific relance now
async function sendManualRelance(data) {
  const { stage = 7, ...emailData } = data;
  return await sendRelanceEmail(stage, emailData);
}

module.exports = { processRelances, sendManualRelance, sendRelanceEmail, RELANCE_SCHEDULE };
