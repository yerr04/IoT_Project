#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>

const uint8_t ESPNOW_CHANNEL = 6;

#define ALERT_VITALS    0
#define ALERT_POSITION  1
#define ALERT_COMBINED  2
#define ALERT_NONE      255

// ---------- packet from bedside node ----------
typedef struct {
  char nodeName[16];
  float temp;
  float pressure;
  int soundActivity;
} BedsidePacket;

// ---------- packet from worn/body node ----------
typedef struct {
  char nodeName[16];
  float heartRate;
  float spo2;
  float accelZ;
  uint8_t fingerPresent;
  uint8_t prone;
  uint8_t alertActive;
  uint8_t alertType;
} BodyPacket;

const char* WIFI_SSID = "iPhone (85)";
const char* WIFI_PASS = "1234567890";
const char* FIREBASE_DB_URL = "https://iot-project-36aef-default-rtdb.firebaseio.com";
const char* FIREBASE_AUTH = "";

BedsidePacket latestBedside = {};
BodyPacket latestBody = {};

volatile bool newBedsideData = false;
volatile bool newBodyData = false;

unsigned long lastConfigPoll = 0;
unsigned long lastStatusUpload = 0;
String lastDemoMode = "";
uint8_t currentWifiChannel = ESPNOW_CHANNEL;

void printMac(const uint8_t *mac) {
  for (int i = 0; i < 6; i++) {
    if (mac[i] < 16) Serial.print("0");
    Serial.print(mac[i], HEX);
    if (i < 5) Serial.print(":");
  }
}

const char* alertName(uint8_t type) {
  if (type == ALERT_VITALS) return "VITALS";
  if (type == ALERT_POSITION) return "POSITION";
  if (type == ALERT_COMBINED) return "COMBINED";
  return "NONE";
}

String boolJson(bool value) {
  return value ? "true" : "false";
}

String stripJsonQuotes(String s) {
  s.trim();
  if (s.length() >= 2 && s[0] == '"' && s[s.length() - 1] == '"') {
    s = s.substring(1, s.length() - 1);
  }
  return s;
}

bool connectToWiFi() {
  if (WiFi.status() == WL_CONNECTED) return true;

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  esp_wifi_set_ps(WIFI_PS_NONE);

  WiFi.begin(WIFI_SSID, WIFI_PASS);

  Serial.print("Connecting to Wi-Fi");
  unsigned long start = millis();

  while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Wi-Fi connect failed");
    return false;
  }

  Serial.print("Wi-Fi connected. IP: ");
  Serial.println(WiFi.localIP());

  wifi_second_chan_t second;
  esp_wifi_get_channel(&currentWifiChannel, &second);

  Serial.print("Gateway Wi-Fi channel: ");
  Serial.println(currentWifiChannel);

  if (currentWifiChannel != ESPNOW_CHANNEL) {
    Serial.println("WARNING: gateway Wi-Fi channel does not match ESPNOW_CHANNEL");
  }

  return true;
}

void ensureWiFiConnected() {
  if (WiFi.status() == WL_CONNECTED) return;

  Serial.println("Wi-Fi lost. Reconnecting...");
  WiFi.disconnect();
  connectToWiFi();
}

bool firebasePut(const String& path, const String& json) {
  if (WiFi.status() != WL_CONNECTED) return false;

  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient https;
  String url = String(FIREBASE_DB_URL) + path + ".json";

  if (strlen(FIREBASE_AUTH) > 0) {
    url += "?auth=" + String(FIREBASE_AUTH);
  }

  if (!https.begin(client, url)) {
    Serial.println("HTTPS begin failed");
    return false;
  }

  https.addHeader("Content-Type", "application/json");
  int code = https.PUT(json);
  String response = https.getString();
  https.end();

  Serial.print("Firebase PUT ");
  Serial.print(path);
  Serial.print(" -> HTTP ");
  Serial.println(code);

  if (code < 200 || code >= 300) {
    Serial.print("Response: ");
    Serial.println(response);
  }

  return (code >= 200 && code < 300);
}

String firebaseGet(const String& path) {
  if (WiFi.status() != WL_CONNECTED) return "";

  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient https;
  String url = String(FIREBASE_DB_URL) + path + ".json";

  if (strlen(FIREBASE_AUTH) > 0) {
    url += "?auth=" + String(FIREBASE_AUTH);
  }

  if (!https.begin(client, url)) {
    Serial.println("HTTPS begin failed");
    return "";
  }

  int code = https.GET();
  String response = (code > 0) ? https.getString() : "";
  https.end();

  Serial.print("Firebase GET ");
  Serial.print(path);
  Serial.print(" -> HTTP ");
  Serial.println(code);

  return response;
}

void uploadGatewayStatus() {
  String json = "{";
  json += "\"wifiConnected\":" + boolJson(WiFi.status() == WL_CONNECTED) + ",";
  json += "\"ip\":\"" + WiFi.localIP().toString() + "\",";
  json += "\"channel\":" + String(currentWifiChannel) + ",";
  json += "\"uptimeMs\":" + String(millis());
  json += "}";

  firebasePut("/status/gateway", json);
}

void uploadBedsideReading() {
  String json = "{";
  json += "\"nodeName\":\"" + String(latestBedside.nodeName) + "\",";
  json += "\"temp\":" + String(latestBedside.temp, 2) + ",";
  json += "\"pressure\":" + String(latestBedside.pressure, 2) + ",";
  json += "\"soundActivity\":" + String(latestBedside.soundActivity) + ",";
  json += "\"receivedAtMs\":" + String(millis());
  json += "}";

  firebasePut("/readings/bedside", json);
}

void uploadBodyReading() {
  String json = "{";
  json += "\"nodeName\":\"" + String(latestBody.nodeName) + "\",";
  json += "\"heartRate\":" + String(latestBody.heartRate, 1) + ",";
  json += "\"spo2\":" + String(latestBody.spo2, 1) + ",";
  json += "\"accelZ\":" + String(latestBody.accelZ, 2) + ",";
  json += "\"fingerPresent\":" + boolJson(latestBody.fingerPresent != 0) + ",";
  json += "\"prone\":" + boolJson(latestBody.prone != 0) + ",";
  json += "\"alertActive\":" + boolJson(latestBody.alertActive != 0) + ",";
  json += "\"alertType\":" + String(latestBody.alertType) + ",";
  json += "\"alertName\":\"" + String(alertName(latestBody.alertType)) + "\",";
  json += "\"receivedAtMs\":" + String(millis());
  json += "}";

  firebasePut("/readings/body", json);
}

void pollConfig() {
  if (millis() - lastConfigPoll < 5000) return;
  lastConfigPoll = millis();

  String demoMode = firebaseGet("/config/demoMode");
  demoMode = stripJsonQuotes(demoMode);

  if (demoMode.length() > 0 && demoMode != "null" && demoMode != lastDemoMode) {
    lastDemoMode = demoMode;
    Serial.print("Config change detected. demoMode = ");
    Serial.println(lastDemoMode);
  }
}

void onDataRecv(const esp_now_recv_info_t *info, const uint8_t *incomingData, int len) {
  Serial.println();
  Serial.println("========================================");
  Serial.print("RX from: ");
  printMac(info->src_addr);
  Serial.println();

  if (len == sizeof(BedsidePacket)) {
    memcpy(&latestBedside, incomingData, sizeof(latestBedside));
    newBedsideData = true;

    Serial.println("[BEDSIDE NODE]");
    Serial.print("Temp: ");
    Serial.print(latestBedside.temp, 2);
    Serial.print(" C | Pressure: ");
    Serial.print(latestBedside.pressure, 2);
    Serial.print(" hPa | Sound: ");
    Serial.println(latestBedside.soundActivity);
  }
  else if (len == sizeof(BodyPacket)) {
    memcpy(&latestBody, incomingData, sizeof(latestBody));
    newBodyData = true;

    Serial.println("[BODY NODE]");
    Serial.print("HR: ");
    if (latestBody.fingerPresent) Serial.print(latestBody.heartRate, 0);
    else Serial.print("No finger");

    Serial.print(" | SpO2: ");
    if (latestBody.fingerPresent) Serial.print(latestBody.spo2, 1);
    else Serial.print("--");

    Serial.print(" | Z: ");
    Serial.print(latestBody.accelZ, 2);
    Serial.print(" | Prone: ");
    Serial.print(latestBody.prone ? "YES" : "no");

    Serial.print(" | Alert: ");
    if (latestBody.alertActive) Serial.print(alertName(latestBody.alertType));
    else Serial.print("NONE");

    Serial.println();
  }
  else {
    Serial.print("Unknown packet size: ");
    Serial.println(len);
  }

  Serial.println("========================================");
}

bool initESPNowReceiver() {
  esp_wifi_set_ps(WIFI_PS_NONE);

  if (WiFi.status() != WL_CONNECTED) {
    esp_wifi_set_promiscuous(true);
    esp_wifi_set_channel(ESPNOW_CHANNEL, WIFI_SECOND_CHAN_NONE);
    esp_wifi_set_promiscuous(false);
    currentWifiChannel = ESPNOW_CHANNEL;
  }

  if (esp_now_init() != ESP_OK) {
    Serial.println("ESP-NOW init failed");
    return false;
  }

  esp_now_register_recv_cb(onDataRecv);

  Serial.print("Gateway MAC Address: ");
  Serial.println(WiFi.macAddress());
  Serial.println("ESP-NOW receive callback registered");

  return true;
}

void setup() {
  Serial.begin(115200);
  delay(1500);

  if (!connectToWiFi()) {
    Serial.println("Gateway booted without Wi-Fi. Will keep retrying in loop.");
  }

  if (!initESPNowReceiver()) {
    while (true) {
      Serial.println("ESP-NOW failed. Restarting in 2s...");
      delay(2000);
      ESP.restart();
    }
  }

  Serial.println("Gateway ready for bedside + body nodes");
  uploadGatewayStatus();
}

void loop() {
  ensureWiFiConnected();

  if (newBedsideData) {
    newBedsideData = false;
    uploadBedsideReading();
  }

  if (newBodyData) {
    newBodyData = false;
    uploadBodyReading();
  }

  if (millis() - lastStatusUpload >= 10000) {
    lastStatusUpload = millis();

    wifi_second_chan_t second;
    esp_wifi_get_channel(&currentWifiChannel, &second);

    uploadGatewayStatus();
  }

  pollConfig();

  delay(20);
}
