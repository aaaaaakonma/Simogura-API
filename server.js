const app = require('./api/index');
const http = require('http');
const WebSocket = require('ws');
const { initMQTT, extractKolamId } = require('./src/mqtt');
const { saveTelemetry } = require('./src/bridge');
require('dotenv').config();

const PORT = process.env.PORT || 3000;
const server = http.createServer(app);

// Initialize WebSocket server on the same HTTP server instance
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  console.log(`[WS] Client connected. Total active clients: ${wss.clients.size}`);

  ws.send(JSON.stringify({
    type: 'system',
    message: 'Connected to Simogura IoT WebSocket Server',
    timestamp: new Date().toISOString()
  }));

  ws.on('message', (message) => {
    try {
      const parsed = JSON.parse(message.toString());
      console.log('[WS] Client message received:', parsed);
      
      // If client requests ping, return pong
      if (parsed.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
      }
    } catch (err) {
      console.log('[WS] Raw client message (non-JSON):', message.toString());
    }
  });

  ws.on('close', () => {
    console.log(`[WS] Client disconnected. Total active clients: ${wss.clients.size}`);
  });

  ws.on('error', (err) => {
    console.error('[WS] Client WebSocket error:', err.message);
  });
});

// Broadcast function to send live updates to all connected WebSocket clients
function broadcastToWS(topic, payload) {
  const wsMessage = JSON.stringify({
    topic,
    payload,
    timestamp: new Date().toISOString()
  });

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(wsMessage);
    }
  });
}

// Start MQTT bridge daemon only if HiveMQ is configured
console.log('[App] Initializing background MQTT listener...');
const mqttClient = initMQTT(async (topic, payload) => {
  console.log(`[App] Message on MQTT topic [${topic}]:`, JSON.stringify(payload));

  // 1. Broadcast the message to all active WebSocket clients in real-time
  broadcastToWS(topic, payload);

  // 2. Persist telemetry to Supabase
  if (topic.endsWith('/telemetry') || topic === 'water_control/telemetry') {
    const kolamId = extractKolamId(topic);
    if (kolamId) {
      const result = await saveTelemetry(kolamId, payload);
      if (result.success) {
        // Broadcast verification back to WS clients
        broadcastToWS(`${topic}/saved`, { success: true, recordId: result.data.id });
      }
    } else {
      console.warn(`[App] Skipping DB insert: Could not find kolam_id for topic "${topic}".`);
    }
  }
});

// Expose MQTT connection status to express app if needed
app.locals.mqttClient = mqttClient;

// Start Server
server.listen(PORT, () => {
  console.log(`=============================================================`);
  console.log(`🚀 Simogura Water IoT API Server is active!`);
  console.log(`📡 Local Port:      http://localhost:${PORT}`);
  console.log(`🔌 WebSockets URL:  ws://localhost:${PORT}`);
  console.log(`=============================================================`);
});
