const express = require('express');
const cors = require('cors');
const path = require('path');
const { supabase } = require('../src/db');
const { saveTelemetry, isValidUUID } = require('../src/bridge');
const mqtt = require('mqtt');
require('dotenv').config();

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Helper function to publish a single MQTT message in serverless environment
async function publishMQTTMessage(topic, payload) {
  return new Promise((resolve, reject) => {
    const host = process.env.HIVEMQ_HOST;
    const port = process.env.HIVEMQ_PORT || '8884';
    const username = process.env.HIVEMQ_USERNAME;
    const password = process.env.HIVEMQ_PASSWORD;

    if (!host) {
      return reject(new Error('HiveMQ host is not configured.'));
    }

    let protocol = 'mqtts';
    if (port === '8884' || port === '443') {
      protocol = 'wss';
    } else if (port === '1883') {
      protocol = 'mqtt';
    } else if (port === '8000' || port === '8083') {
      protocol = 'ws';
    }

    const connectUrl = `${protocol}://${host}:${port}${protocol.startsWith('ws') ? '/mqtt' : ''}`;
    
    const client = mqtt.connect(connectUrl, {
      username,
      password,
      clientId: `vercel-pub-${Math.random().toString(16).substring(2, 8)}`,
      connectTimeout: 3000,
      rejectUnauthorized: false,
    });

    client.on('connect', () => {
      client.publish(topic, JSON.stringify(payload), { qos: 1 }, (err) => {
        client.end();
        if (err) reject(err);
        else resolve();
      });
    });

    client.on('error', (err) => {
      client.end();
      reject(err);
    });

    // Timeout fallback
    setTimeout(() => {
      client.end();
      reject(new Error('MQTT publish timed out'));
    }, 4000);
  });
}

// ── HTTP Endpoints ────────────────────────

// Health & Status Check
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'Simogura Water IoT API (Vercel Serverless)',
    endpoints: {
      telemetry: {
        get: '/api/telemetry?kolam_id=<uuid>&limit=<number>',
        post: '/api/telemetry'
      },
      valves: {
        post: '/api/valves'
      },
      pools: {
        get: '/api/pools',
        telemetry: '/api/pools/:id/telemetry',
        delete: '/api/pools/:id'
      }
    }
  });
});

// Fetch Latest Telemetry (from Supabase)
app.get('/api/telemetry', async (req, res) => {
  try {
    const { kolam_id, limit = 20 } = req.query;

    let query = supabase
      .from('data_sensor')
      .select('*, kolam:kolam_id(nama, alamat)')
      .order('created_at', { ascending: false });

    if (kolam_id) {
      if (!isValidUUID(kolam_id)) {
        return res.status(400).json({ error: 'Invalid UUID format for kolam_id' });
      }
      query = query.eq('kolam_id', kolam_id);
    }

    const { data, error } = await query.limit(parseInt(limit));

    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Save Telemetry Manually (ideal for HTTP Webhooks / ESP32 direct posting)
app.post('/api/telemetry', async (req, res) => {
  try {
    const { distance, temperature, ph_voltage, mq_raw, ammonia, kolam_id } = req.body;
    const targetKolamId = kolam_id || process.env.DEFAULT_KOLAM_ID;

    if (!targetKolamId) {
      return res.status(400).json({ error: 'Missing kolam_id and no DEFAULT_KOLAM_ID configured' });
    }

    const result = await saveTelemetry(targetKolamId, {
      distance,
      temperature,
      ph_voltage,
      mq_raw,
      ammonia
    });

    if (!result.success) {
      return res.status(500).json({ error: result.error });
    }

    // Try publishing to HiveMQ in the background so MQTT clients get the update too
    try {
      await publishMQTTMessage(`water_control/${targetKolamId}/telemetry`, req.body);
    } catch (mqttErr) {
      console.warn('[Vercel API] Could not publish webhook to MQTT:', mqttErr.message);
      // Don't fail the request if MQTT is down; data is already saved in Supabase
    }

    res.status(201).json({ success: true, data: result.data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch all Pools (Kolam)
app.get('/api/pools', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('kolam')
      .select('*')
      .order('nama', { ascending: true });

    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch telemetry for specific pool
app.get('/api/pools/:id/telemetry', async (req, res) => {
  try {
    const { id } = req.params;
    const { limit = 20 } = req.query;

    if (!isValidUUID(id)) {
      return res.status(400).json({ error: 'Invalid pool UUID format' });
    }

    const { data, error } = await supabase
      .from('data_sensor')
      .select('*')
      .eq('kolam_id', id)
      .order('created_at', { ascending: false })
      .limit(parseInt(limit));

    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete a Pool (Kolam) and all its sensor data
app.delete('/api/pools/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidUUID(id)) {
      return res.status(400).json({ error: 'Invalid pool UUID format' });
    }

    // 1. Delete associated sensor data first to prevent foreign key constraint issues
    const { error: sensorError } = await supabase
      .from('data_sensor')
      .delete()
      .eq('kolam_id', id);

    if (sensorError) throw sensorError;

    // 2. Delete the pool itself
    const { error: poolError } = await supabase
      .from('kolam')
      .delete()
      .eq('id', id);

    if (poolError) throw poolError;

    res.json({ success: true, message: `Pool ${id} and its telemetry data have been deleted successfully.` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Control Valves via MQTT
app.post('/api/valves', async (req, res) => {
  try {
    const { solenoid_in, solenoid_out, kolam_id } = req.body;
    const targetKolamId = kolam_id || process.env.DEFAULT_KOLAM_ID;

    if (!solenoid_in && !solenoid_out) {
      return res.status(400).json({ error: 'Provide solenoid_in or solenoid_out command (OPEN/CLOSED)' });
    }

    const payload = {
      solenoid_in: solenoid_in || 'CLOSED',
      solenoid_out: solenoid_out || 'CLOSED',
      timestamp: new Date().toISOString()
    };

    const topic = targetKolamId && targetKolamId !== '00000000-0000-0000-0000-000000000000'
      ? `water_control/${targetKolamId}/valves`
      : `water_control/valves`;

    await publishMQTTMessage(topic, payload);

    // Also publish to the global topic if it's not already the global topic
    // so the ESP32 (which is hardcoded to listen only to water_control/valves) will receive it
    if (topic !== 'water_control/valves') {
      try {
        await publishMQTTMessage('water_control/valves', payload);
      } catch (mqttErr) {
        console.warn('[Vercel API] Could not publish to global valves topic:', mqttErr.message);
      }
    }

    res.json({ success: true, message: `Command published to topic: ${topic}`, payload });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = app;
