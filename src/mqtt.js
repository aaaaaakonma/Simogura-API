const mqtt = require('mqtt');
require('dotenv').config();

function initMQTT(onMessage) {
  const host = process.env.HIVEMQ_HOST;
  const port = process.env.HIVEMQ_PORT || '8883';
  const username = process.env.HIVEMQ_USERNAME;
  const password = process.env.HIVEMQ_PASSWORD;

  if (!host) {
    console.warn('[MQTT] Warning: HIVEMQ_HOST is not defined. MQTT listener will not start.');
    return null;
  }

  // Determine protocol: secure MQTT (mqtts) or WebSockets (wss)
  let protocol = 'mqtts';
  if (port === '8884' || port === '443') {
    protocol = 'wss';
  } else if (port === '1883') {
    protocol = 'mqtt';
  } else if (port === '8000' || port === '8083') {
    protocol = 'ws';
  }

  const connectUrl = `${protocol}://${host}:${port}${protocol.startsWith('ws') ? '/mqtt' : ''}`;
  console.log(`[MQTT] Connecting to HiveMQ at ${connectUrl}...`);

  const client = mqtt.connect(connectUrl, {
    username,
    password,
    clientId: `simogura-server-${Math.random().toString(16).substring(2, 10)}`,
    clean: true,
    connectTimeout: 5000,
    reconnectPeriod: 2000,
    rejectUnauthorized: false, // Helps with connection reliability on custom configurations
  });

  client.on('connect', () => {
    console.log('[MQTT] Connected to HiveMQ Cloud broker successfully!');
    
    // Subscribe to default and wildcard topics
    const topics = [
      'water_control/telemetry',
      'water_control/+/telemetry',
      'water_control/valves',
      'water_control/+/valves'
    ];
    
    client.subscribe(topics, (err) => {
      if (!err) {
        console.log('[MQTT] Subscribed to topics:', topics.join(', '));
      } else {
        console.error('[MQTT] Subscription error:', err);
      }
    });
  });

  client.on('message', (topic, message) => {
    const payloadStr = message.toString();
    let payload;
    try {
      payload = JSON.parse(payloadStr);
    } catch (e) {
      console.warn(`[MQTT] Non-JSON payload received on topic "${topic}":`, payloadStr);
      payload = { raw: payloadStr };
    }

    if (onMessage) {
      onMessage(topic, payload);
    }
  });

  client.on('error', (err) => {
    console.error('[MQTT] Connection error:', err.message);
  });

  client.on('close', () => {
    console.warn('[MQTT] Connection closed');
  });

  client.on('reconnect', () => {
    console.log('[MQTT] Reconnecting to HiveMQ...');
  });

  return client;
}

// Helper to extract kolam_id from topic (e.g. "water_control/<kolam_id>/telemetry")
function extractKolamId(topic) {
  const parts = topic.split('/');
  if (parts.length === 3) {
    return parts[1];
  }
  return process.env.DEFAULT_KOLAM_ID || null;
}

module.exports = { initMQTT, extractKolamId };
