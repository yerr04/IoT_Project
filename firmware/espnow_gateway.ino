/**
 * ESP32 gateway: receives the same struct_message as sensor nodes over ESP-NOW
 * and forwards each packet to the Node server (POST /api/readings), which writes Firebase.
 *
 * Update WIFI_SSID, WIFI_PASSWORD, SERVER_HOST, SERVER_PORT, and optionally INGEST_TOKEN
 * to match your LAN and server. Flash this to the MAC address used as gatewayAddress
 * on your sensor sketches.
 */
#include <WiFi.h>
#include <HTTPClient.h>
#include <esp_now.h>
#include <esp_wifi.h>

typedef struct struct_message {
  char nodeName[16];
  float temp;
  float pressure;
  int soundActivity;
} struct_message;

const char *WIFI_SSID = "YOUR_WIFI";
const char *WIFI_PASSWORD = "YOUR_PASSWORD";
const char *SERVER_HOST = "192.168.1.100";
const uint16_t SERVER_PORT = 3000;
// If server sets INGEST_SECRET, set the same value here (or leave empty).
const char *INGEST_TOKEN = "";

// Core 3.x: (const esp_now_recv_info_t *info, ...); Core 2.x: (const uint8_t *mac, ...).
#if defined(ESP_ARDUINO_VERSION) && \
    (ESP_ARDUINO_VERSION >= ESP_ARDUINO_VERSION_VAL(3, 0, 0))
void onRecv(const esp_now_recv_info_t *info, const uint8_t *data, int len)
#else
void onRecv(const uint8_t *mac, const uint8_t *data, int len)
#endif
{
  if (len != sizeof(struct_message)) {
    Serial.printf("Ignore packet len %d (expected %u)\n", len,
                  (unsigned)sizeof(struct_message));
    return;
  }

  struct_message msg;
  memcpy(&msg, data, sizeof(msg));

  if (WiFi.status() != WL_CONNECTED) return;

  WiFiClient client;
  HTTPClient http;
  String url = String("http://") + SERVER_HOST + ":" + SERVER_PORT + "/api/readings";

  http.begin(client, url);
  http.addHeader("Content-Type", "application/json");
  if (strlen(INGEST_TOKEN) > 0) {
    http.addHeader("X-Ingest-Token", INGEST_TOKEN);
  }

  char body[320];
  snprintf(
      body, sizeof(body),
      "{\"nodeName\":\"%.15s\",\"temp\":%.4f,\"pressure\":%.4f,\"soundActivity\":%d}",
      msg.nodeName, (double)msg.temp, (double)msg.pressure, msg.soundActivity);

  int code = http.POST(body);
  Serial.printf("POST %s -> %d\n", url.c_str(), code);
  if (code < 0) {
    Serial.println(http.errorToString(code));
  }
  http.end();
}

void setup() {
  Serial.begin(115200);
  delay(500);

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) {
    delay(300);
    Serial.print(".");
  }
  Serial.println();
  Serial.print("WiFi OK, IP: ");
  Serial.println(WiFi.localIP());

  if (esp_now_init() != ESP_OK) {
    Serial.println("esp_now_init failed");
    return;
  }
  esp_now_register_recv_cb(onRecv);
  Serial.println("Gateway listening (ESP-NOW -> HTTP)");
}

void loop() {}
