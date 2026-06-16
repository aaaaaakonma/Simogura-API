// ─────────────────────────────────────────
//  ESP32 Water Control IoT System with HiveMQ
//  MQ sensor     → GPIO 33 (ADC1)
//  DS18B20       → GPIO 32 (1-Wire) + 4.7kΩ pull-up to 3.3V
//  Ultrasonic    → TRIG 19 / ECHO 18
//  pH Sensor     → GPIO 34 (ADC1)
//  Solenoid In   → GPIO 25 (Output via Relay/MOSFET)
//  Solenoid Out  → GPIO 26 (Output via Relay/MOSFET)
// ─────────────────────────────────────────

#include <WiFi.h>
#include <PubSubClient.h>
#include <OneWire.h>
#include <DallasTemperature.h>

#define MQ_PIN          33
#define TEMP_PIN        32
#define TRIG_PIN        19
#define ECHO_PIN        18
#define PH_PIN          34
#define SOLENOID_IN     25
#define SOLENOID_OUT    26

// ── WiFi & HiveMQ Configuration ───────────
const char* ssid          = "POCO X3 Pro";
const char* password      = "12345678";

// For HiveMQ Cloud, use your cluster URL (e.g., "xxxxxx.s1.eu.hivemq.cloud")
// For public testing, you can use "broker.hivemq.com"
const char* mqtt_server   = "e8cbe8482ad84782a618ee7310d3d0d7.s1.eu.hivemq.cloud"; 
const int   mqtt_port     = 8883; // Use 8883 if using WiFiClientSecure with TLS
const char* mqtt_user     = "simogura";
const char* mqtt_password = "Simogura132";

// ── Device / Kolam Configuration ───────────
// Unique Identifier (UUID) for this specific pond (kolam) in Supabase.
const char* kolam_id        = "0d769bb1-6368-469a-99a3-b61b73cbc344";

// MQTT Topics (will be dynamically updated in setup() using kolam_id)
String topic_telemetry      = "water_control/telemetry";
String topic_solenoid       = "water_control/valves";

WiFiClient espClient;
PubSubClient client(espClient);

// 1-Wire bus & DS18B20 setup
OneWire           oneWire(TEMP_PIN);
DallasTemperature tempSensor(&oneWire);

unsigned long lastMsgTime = 0;
const long msgInterval = 5000; // Publish data every 5 seconds

// ── WiFi Setup ────────────────────────────
void setup_wifi() {
  delay(10);
  Serial.println();
  Serial.print("Connecting to WiFi: ");
  Serial.println(ssid);

  WiFi.begin(ssid, password);

  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }

  Serial.println("\nWiFi connected!");
  Serial.print("IP address: ");
  Serial.println(WiFi.localIP());
}

// ── HiveMQ MQTT Reconnect ─────────────────
void reconnect() {
  while (!client.connected()) {
    Serial.print("Attempting MQTT connection to HiveMQ...");
    // Create a unique client ID
    String clientId = "ESP32WaterClient-";
    clientId += String(random(0xffff), HEX);
    
    // Attempt to connect
    if (client.connect(clientId.c_str(), mqtt_user, mqtt_password)) {
      Serial.println("connected!");
      // Option to subscribe to incoming commands here if needed
      // client.subscribe("water_control/commands");
    } else {
      Serial.print("failed, rc=");
      Serial.print(client.state());
      Serial.println(" try again in 5 seconds");
      delay(5000);
    }
  }
}

// ── Ultrasonic ────────────────────────────
float getDistance() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);

  long duration = pulseIn(ECHO_PIN, HIGH, 30000); 
  if (duration == 0) return -1;                   

  return (duration * 0.0343) / 2.0;              
}

// ── DS18B20 Temperature ───────────────────
float getTemperature() {
  tempSensor.requestTemperatures();
  float tempC = tempSensor.getTempCByIndex(0);    
  return tempC;                                   
}

// ── MQ Gas Sensor ─────────────────────────
int getMQRaw() {
  return analogRead(MQ_PIN);                      
}

// ── pH Sensor Voltage Return ──────────────
float getPHVoltage() {
  int rawAdc = analogRead(PH_PIN);
  // Returns raw voltage (0.0V to 3.3V) based on ESP32 12-bit resolution
  float voltage = rawAdc * (3.3 / 4095.0);
  return voltage;
}

// ── Ammonia Guide Estimation ──────────────
float estimateAmmonia(float temp, float ph_voltage, int mqValue) {
  if (temp == DEVICE_DISCONNECTED_C) return -1.0;

  // Placeholder mapping: Uncalibrated approximation using voltage as a relative indicator
  float estimatedNh3 = (mqValue / 4095.0) * (ph_voltage / 2.5) * (temp / 25.0);
  return estimatedNh3; 
}

// ── Solenoid Valve Controls ───────────────
void controlSolenoidIn(bool openValve) {
  digitalWrite(SOLENOID_IN, openValve ? HIGH : LOW);
}

void controlSolenoidOut(bool openValve) {
  digitalWrite(SOLENOID_OUT, openValve ? HIGH : LOW);
}

// ─────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  while (!Serial) delay(10);

  // Initialize dynamic topics using kolam_id
  if (strlen(kolam_id) > 0) {
    topic_telemetry = "water_control/" + String(kolam_id) + "/telemetry";
    topic_solenoid  = "water_control/" + String(kolam_id) + "/valves";
  }

  // Sensor configuration
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  pinMode(PH_PIN, INPUT);
  analogReadResolution(12);

  // Solenoid configuration
  pinMode(SOLENOID_IN, OUTPUT);
  pinMode(SOLENOID_OUT, OUTPUT);
  
  controlSolenoidIn(false);
  controlSolenoidOut(false);

  tempSensor.setResolution(9);
  tempSensor.begin();

  // Network initialization
  setup_wifi();
  client.setServer(mqtt_server, mqtt_port);

  Serial.println("=== ESP32 Water IoT Configured ===");
}

void loop() {
  if (!client.connected()) {
    reconnect();
  }
  client.loop();

  unsigned long now = millis();
  // Read and transmit data at regular intervals
  if (now - lastMsgTime > msgInterval) {
    lastMsgTime = now;

    // 1. Gather Sensor Data
    float dist      = getDistance();
    float tempC     = getTemperature();
    int   mqRaw     = getMQRaw();
    float phVoltage = getPHVoltage();
    float ammonia   = estimateAmmonia(tempC, phVoltage, mqRaw);

    // 2. Control Logic Status Strings
    String inValveStatus  = "CLOSED";
    String outValveStatus = "CLOSED";

    // Dynamic Logic
    if (dist > 30.0 && dist != -1) {
      controlSolenoidIn(true);
      controlSolenoidOut(false);
      inValveStatus = "OPEN";
    } 
    else if (ammonia > 5.0) { 
      controlSolenoidIn(false);
      controlSolenoidOut(true);
      outValveStatus = "OPEN";
    } 
    else {
      controlSolenoidIn(false);
      controlSolenoidOut(false);
    }

    // 3. Print Local Diagnostics
    Serial.println("── Local Telemetry ─────────");
    Serial.printf("Distance   : %.1f cm\n", dist);
    Serial.printf("Temp       : %.1f °C\n", tempC);
    Serial.printf("pH Voltage : %.3f V\n", phVoltage);
    Serial.printf("MQ Raw     : %d\n", mqRaw);
    Serial.printf("Ammonia Est: %.4f\n", ammonia);
    Serial.printf("Valves     : IN [%s] | OUT [%s]\n", inValveStatus.c_str(), outValveStatus.c_str());
    Serial.println("────────────────────────────");

    // 4. Construct and Publish MQTT Payloads
    // Packaging metrics as a lightweight JSON string
    String telemetryPayload = "{";
    telemetryPayload += "\"distance\":" + String(dist, 1) + ",";
    telemetryPayload += "\"temperature\":" + String(tempC, 1) + ",";
    telemetryPayload += "\"ph_voltage\":" + String(phVoltage, 3) + ",";
    telemetryPayload += "\"mq_raw\":" + String(mqRaw) + ",";
    telemetryPayload += "\"ammonia\":" + String(ammonia, 4);
    telemetryPayload += "}";

    String valvePayload = "{\"solenoid_in\":\"" + inValveStatus + "\",\"solenoid_out\":\"" + outValveStatus + "\"}";

    // Publish to HiveMQ
    client.publish(topic_telemetry.c_str(), telemetryPayload.c_str());
    client.publish(topic_solenoid.c_str(), valvePayload.c_str());
  }
}