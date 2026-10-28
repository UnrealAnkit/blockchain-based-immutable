// ESP32 + DHT22 sensor node for the immutable IoT logger.
//
// STATUS: written for the hardware stage; NOT yet tested on a physical board.
// All Phase III results were produced with emulated sensors (src/sensors.js).
//
// Publishes {"t": <deg C>, "h": <%RH>} every PERIOD_MS to iot/<DEVICE_ID>/reading.
// The gateway (npm run dashboard -- --broker mqtt://<pc-ip>:1883 --no-sensors)
// adds the sequence number and timestamp, hashes and signs the record.
//
// Libraries (Arduino Library Manager): "PubSubClient" by Nick O'Leary,
// "DHT sensor library" by Adafruit (+ "Adafruit Unified Sensor").
// Wiring: DHT22 data -> GPIO 4, 10k pull-up to 3V3; VCC -> 3V3; GND -> GND.

#include <WiFi.h>
#include <PubSubClient.h>
#include <DHT.h>

const char* WIFI_SSID = "your-wifi";
const char* WIFI_PASS = "your-password";
const char* MQTT_HOST = "192.168.1.20";   // computer running the gateway
const uint16_t MQTT_PORT = 1883;
const char* DEVICE_ID = "sensor-01";      // lower-case letters, digits and '-' only
const uint32_t PERIOD_MS = 1000;

DHT dht(4, DHT22);
WiFiClient net;
PubSubClient mqtt(net);
char topic[64];

void connectWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) delay(250);
}

void connectMqtt() {
  while (!mqtt.connected()) {
    if (!mqtt.connect(DEVICE_ID)) delay(1000);
  }
}

void setup() {
  Serial.begin(115200);
  dht.begin();
  connectWifi();
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  snprintf(topic, sizeof(topic), "iot/%s/reading", DEVICE_ID);
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) connectWifi();
  connectMqtt();
  mqtt.loop();

  static uint32_t last = 0;
  if (millis() - last < PERIOD_MS) return;
  last = millis();

  float t = dht.readTemperature();
  float h = dht.readHumidity();
  if (isnan(t) || isnan(h)) return;  // skip failed reads; the gateway would reject them anyway

  char payload[48];
  snprintf(payload, sizeof(payload), "{\"t\":%.2f,\"h\":%.1f}", t, h);
  mqtt.publish(topic, payload);
  Serial.println(payload);
}
