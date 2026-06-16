const { supabase } = require('./db');
require('dotenv').config();

// Helper to validate UUID format
function isValidUUID(uuid) {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuid && uuidRegex.test(uuid) && uuid !== '00000000-0000-0000-0000-000000000000';
}

/**
 * Saves telemetry data to the Supabase database.
 * Mapped from ESP32 fields to Supabase public.data_sensor fields:
 * - ph_voltage (or ph) -> ph
 * - temperature (or temp) -> temp
 * - distance (or ketinggian) -> ketinggian
 * - ammonia (or amonia) -> amonia
 * - kolam_id -> kolam_id
 */
async function saveTelemetry(kolamId, data) {
  if (!isValidUUID(kolamId)) {
    console.warn(`[Bridge] Skipping insert: "${kolamId}" is not a valid kolam_id UUID. Set a valid DEFAULT_KOLAM_ID or use water_control/<kolam_id>/telemetry`);
    return { error: 'Invalid or missing kolam_id UUID' };
  }

  // Extract and map fields (supporting both ESP32 names and Database names)
  const ph = data.ph_voltage !== undefined ? data.ph_voltage : data.ph;
  const temp = data.temperature !== undefined ? data.temperature : data.temp;
  const ketinggian = data.distance !== undefined ? data.distance : data.ketinggian;
  const amonia = data.ammonia !== undefined ? data.ammonia : data.amonia;

  const dbPayload = {
    ph: ph !== undefined ? parseFloat(ph) : null,
    temp: temp !== undefined ? parseFloat(temp) : null,
    ketinggian: ketinggian !== undefined ? parseFloat(ketinggian) : null,
    amonia: amonia !== undefined ? parseFloat(amonia) : null,
    kolam_id: kolamId
  };

  console.log(`[Bridge] Inserting telemetry into Supabase for kolam_id: ${kolamId}...`);

  const { data: insertedData, error } = await supabase
    .from('data_sensor')
    .insert([dbPayload])
    .select();

  if (error) {
    console.error('[Bridge] Supabase Insert Error:', error.message);
    return { success: false, error: error.message };
  }

  console.log('[Bridge] Telemetry saved successfully:', insertedData[0]);
  return { success: true, data: insertedData[0] };
}

module.exports = {
  saveTelemetry,
  isValidUUID
};
