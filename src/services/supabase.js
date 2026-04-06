const { createClient } = require('@supabase/supabase-js');
const logger = require('./logger');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SECRET_KEY;

if (!supabaseUrl || !supabaseKey) {
  logger.warn('Supabase non configuré — SUPABASE_URL ou SUPABASE_SECRET_KEY manquante');
}

const supabase = supabaseUrl && supabaseKey
  ? createClient(supabaseUrl, supabaseKey)
  : null;

// ── Cabinets ──
const getCabinet = async (id) => {
  if (!supabase) return null;
  const { data, error } = await supabase.from('cabinets').select('*').eq('id', id).single();
  if (error) { logger.error(`getCabinet error: ${error.message}`); return null; }
  return data;
};

const getCabinetByEmail = async (email) => {
  if (!supabase) return null;
  const { data, error } = await supabase.from('cabinets').select('*').eq('email', email).single();
  if (error && error.code !== 'PGRST116') { logger.error(`getCabinetByEmail error: ${error.message}`); return null; }
  return data;
};

const createCabinet = async (cabinet) => {
  if (!supabase) return null;
  const { data, error } = await supabase.from('cabinets').insert([cabinet]).select().single();
  if (error) { logger.error(`createCabinet error: ${error.message}`); return null; }
  return data;
};

const updateCabinet = async (id, updates) => {
  if (!supabase) return null;
  const { data, error } = await supabase.from('cabinets').update(updates).eq('id', id).select().single();
  if (error) { logger.error(`updateCabinet error: ${error.message}`); return null; }
  return data;
};

// ── Rendez-vous ──
const getRdvs = async (cabinetId) => {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('rendez_vous')
    .select('*')
    .eq('cabinet_id', cabinetId)
    .gte('debut', new Date().toISOString())
    .order('debut', { ascending: true });
  if (error) { logger.error(`getRdvs error: ${error.message}`); return []; }
  return data;
};

const upsertRdvs = async (cabinetId, rdvs) => {
  if (!supabase || !rdvs.length) return [];
  const rows = rdvs.map(rdv => ({
    cabinet_id: cabinetId,
    doctolib_id: rdv.id,
    patient: rdv.patient,
    debut: rdv.debut,
    fin: rdv.fin,
    type: rdv.titre,
    statut: rdv.statut,
    rappel_sms: rdv.rappelSms || false,
    rappel_email: rdv.rappelEmail || false,
  }));
  const { data, error } = await supabase
    .from('rendez_vous')
    .upsert(rows, { onConflict: 'cabinet_id,doctolib_id' })
    .select();
  if (error) { logger.error(`upsertRdvs error: ${error.message}`); return []; }
  return data;
};

// ── Intégrations ──
const getIntegration = async (cabinetId, type) => {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('integrations')
    .select('*')
    .eq('cabinet_id', cabinetId)
    .eq('type', type)
    .single();
  if (error && error.code !== 'PGRST116') { logger.error(`getIntegration error: ${error.message}`); return null; }
  return data;
};

const upsertIntegration = async (cabinetId, type, data) => {
  if (!supabase) return null;
  const { data: result, error } = await supabase
    .from('integrations')
    .upsert({ cabinet_id: cabinetId, type, ...data }, { onConflict: 'cabinet_id,type' })
    .select()
    .single();
  if (error) { logger.error(`upsertIntegration error: ${error.message}`); return null; }
  return result;
};

// ── Rappels ──
const logRappel = async (cabinetId, rdvId, type, destinataire) => {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('rappels')
    .insert([{ cabinet_id: cabinetId, rdv_id: rdvId, type, destinataire }])
    .select()
    .single();
  if (error) { logger.error(`logRappel error: ${error.message}`); return null; }
  return data;
};

module.exports = {
  supabase,
  getCabinet,
  getCabinetByEmail,
  createCabinet,
  updateCabinet,
  getRdvs,
  upsertRdvs,
  getIntegration,
  upsertIntegration,
  logRappel,
};
