#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <Wire.h>
#include <esp_task_wdt.h>
#include "MAX30105.h"
#include "heartRate.h"

//pins define
#define BUZZER_PIN        25
#define SDA_PIN           21
#define SCL_PIN           22
#define MPU_SDA_PIN       33
#define MPU_SCL_PIN       26

//MPU6050 Registers
#define MPU6050_ADDR         0x68
#define MPU6050_WHO_AM_I     0x75
#define MPU6050_PWR_MGMT_1   0x6B
#define MPU6050_ACCEL_CONFIG 0x1C
#define MPU6050_CONFIG       0x1A
#define MPU6050_ACCEL_XOUT_H 0x3B

//thresholds 
#define SPO2_LOW_THRESHOLD      90
#define HR_LOW_THRESHOLD        40
#define HR_HIGH_THRESHOLD       100
#define FINGER_DETECT_THRESHOLD 50000
#define FACE_DOWN_Z_THRESHOLD   -5.0
#define FACE_DOWN_HOLD_MS       3000

//lower bar when face-down
#define SPO2_COMBINED_THRESHOLD 94
#define HR_LOW_COMBINED         45
#define HR_HIGH_COMBINED        95

//timing 
#define SENSOR_WARMUP_MS    10000
#define MIN_HR_SAMPLES      4
#define SPO2_LOW_HOLD_MS    3000
#define MAX_FIFO_READS      32
#define BUZZER_COOLDOWN_MS  5000
#define READING_INTERVAL_MS 10
#define I2C_TIMEOUT_MS      50
#define MAX_I2C_FAILURES    10
#define MAX_ESPNOW_FAILURES 5
#define WDT_TIMEOUT_S       8
#define HR_BUFFER_SIZE      8

//buzzer defines
#define BUZZER_FREQ       2700
#define BUZZER_RESOLUTION 8
#define PATTERN_VITALS    0
#define PATTERN_POSITION  1
#define PATTERN_COMBINED  2
#define PATTERN_NONE      255

//esp now gate
uint8_t gatewayAddress[] = {0x20, 0xE7, 0xC8, 0xB1, 0xEC, 0x98};

typedef struct {
  char    nodeName[16];
  float   heartRate;
  float   spo2;
  float   accelZ;
  uint8_t fingerPresent;
  uint8_t prone;
  uint8_t alertActive;
  uint8_t alertType;
} BodyPacket;

BodyPacket outgoingData;


MAX30105 maxSensor;

byte   hrRateBuffer[HR_BUFFER_SIZE];
byte   hrBufferIndex   = 0;
byte   hrSamplesCount  = 0;
long   lastBeat        = 0;
float  avgBPM          = 0;

double avRed = 0, avIR = 0, SpO2 = 0;
bool   SpO2Valid       = false;
unsigned long spo2LowSince = 0;
bool   spo2WasLow     = false;

unsigned long fingerOnTime   = 0;
bool   fingerWasOn     = false;
bool   sensorWarmedUp  = false;

uint8_t maxFailCount = 0;
bool    maxHealthy   = true;

float  accelZ         = 0;
bool   isFaceDown     = false;
unsigned long faceDownStartTime = 0;
bool   faceDownConfirmed = false;

bool      alertActive        = false;
bool      alertConditionMet  = false;
unsigned long conditionClearedTime = 0;
int       currentAlertPattern = PATTERN_NONE;
unsigned long lastPatternToggle = 0;
bool      buzzerOn = false;

unsigned long lastSendTime = 0;
uint8_t espNowFailCount    = 0;
bool    espNowInitialized  = false;

uint8_t mpuFailCount = 0;
bool    mpuHealthy   = true;

unsigned long lastWifiKeepAlive = 0;


//MPU6050 I2C helprers


void mpuWriteReg(uint8_t reg, uint8_t value) {
  Wire1.beginTransmission(MPU6050_ADDR);
  Wire1.write(reg);
  Wire1.write(value);
  Wire1.endTransmission();
}

bool mpuReadRegSafe(uint8_t reg, uint8_t &value) {
  Wire1.beginTransmission(MPU6050_ADDR);
  Wire1.write(reg);
  if (Wire1.endTransmission(false) != 0) return false;
  if (Wire1.requestFrom((uint8_t)MPU6050_ADDR, (uint8_t)1) < 1) return false;
  value = Wire1.read();
  return true;
}

bool mpuInit() {
  uint8_t whoAmI = 0;
  if (!mpuReadRegSafe(MPU6050_WHO_AM_I, whoAmI)) {
    Serial.println("MPU6050: No I2C response");
    return false;
  }
  if (whoAmI != 0x68 && whoAmI != 0x70 && whoAmI != 0x71 &&
      whoAmI != 0x72 && whoAmI != 0x73 && whoAmI != 0x19) return false;

  mpuWriteReg(MPU6050_PWR_MGMT_1, 0x00);
  delay(100);
  mpuWriteReg(MPU6050_ACCEL_CONFIG, 0x00);
  mpuWriteReg(MPU6050_CONFIG, 0x04);
  return true;
}

bool mpuReadAccelZ(float &az) {
  Wire1.beginTransmission(MPU6050_ADDR);
  Wire1.write(MPU6050_ACCEL_XOUT_H);
  if (Wire1.endTransmission(false) != 0) return false;
  if (Wire1.requestFrom((uint8_t)MPU6050_ADDR, (uint8_t)6) < 6) {
    while (Wire1.available()) Wire1.read();
    return false;
  }
  Wire1.read(); Wire1.read();  // skip X
  Wire1.read(); Wire1.read();  // skip Y
  int16_t rawZ = (Wire1.read() << 8) | Wire1.read();
  az = rawZ * (9.81 / 16384.0);
  return true;
}


//I2C bus recovery 

void recoverI2CBus(TwoWire &bus, int sdaPin, int sclPin) {
  bus.end();
  delay(10);
  pinMode(sclPin, OUTPUT);
  pinMode(sdaPin, INPUT_PULLUP);
  for (int i = 0; i < 16; i++) {
    digitalWrite(sclPin, HIGH); delayMicroseconds(5);
    digitalWrite(sclPin, LOW);  delayMicroseconds(5);
  }
  digitalWrite(sclPin, HIGH);
  delay(10);
  bus.begin(sdaPin, sclPin);
  bus.setTimeOut(I2C_TIMEOUT_MS);
  delay(50);
}

void recoverMPU() {
  Serial.println("!! Recovering MPU I2C bus...");
  recoverI2CBus(Wire1, MPU_SDA_PIN, MPU_SCL_PIN);
  mpuWriteReg(MPU6050_PWR_MGMT_1, 0x00);
  delay(100);
  mpuWriteReg(MPU6050_ACCEL_CONFIG, 0x00);
  mpuWriteReg(MPU6050_CONFIG, 0x04);
}

void recoverMAX() {
  Serial.println("!! Recovering MAX30102 I2C bus...");
  recoverI2CBus(Wire, SDA_PIN, SCL_PIN);
  if (maxSensor.begin(Wire, I2C_SPEED_FAST)) {
    maxSensor.setup(60, 4, 2, 400, 411, 4096);
    maxHealthy = true;
  } else {
    maxHealthy = false;
    Serial.println("   MAX30102 recovery FAILED");
  }
}

//ESP-BOW

void onDataSent(const wifi_tx_info_t *tx_info, esp_now_send_status_t status) {
  (void)tx_info; (void)status;
}

bool initESPNow() {
  if (espNowInitialized) { esp_now_deinit(); espNowInitialized = false; delay(100); }

  WiFi.mode(WIFI_STA);
  WiFi.disconnect(true, true);
  delay(100);
  esp_wifi_set_ps(WIFI_PS_NONE);
  esp_wifi_set_promiscuous(true);
  esp_wifi_set_channel(6, WIFI_SECOND_CHAN_NONE);
  esp_wifi_set_promiscuous(false);

  if (esp_now_init() != ESP_OK) { Serial.println("ESP-NOW init failed!"); return false; }
  esp_now_register_send_cb(onDataSent);

  esp_now_peer_info_t peerInfo = {};
  memcpy(peerInfo.peer_addr, gatewayAddress, 6);
  peerInfo.channel = 6;
  peerInfo.encrypt = false;
  esp_now_del_peer(gatewayAddress);
  if (esp_now_add_peer(&peerInfo) != ESP_OK) { Serial.println("Failed to add peer!"); return false; }

  espNowInitialized = true;
  return true;
}


//buzzer logic

void stopBuzzer() { ledcWriteTone(BUZZER_PIN, 0); buzzerOn = false; }

void updateBuzzerPattern() {
  if (!alertActive) return;
  unsigned long now = millis();

  switch (currentAlertPattern) {
    case PATTERN_VITALS:
      if (!buzzerOn) { ledcWriteTone(BUZZER_PIN, BUZZER_FREQ); buzzerOn = true; }
      break;
    case PATTERN_POSITION:
      if (now - lastPatternToggle > 500) {
        lastPatternToggle = now; buzzerOn = !buzzerOn;
        ledcWriteTone(BUZZER_PIN, buzzerOn ? BUZZER_FREQ : 0);
      }
      break;
    case PATTERN_COMBINED:
      if (now - lastPatternToggle > 150) {
        lastPatternToggle = now; buzzerOn = !buzzerOn;
        ledcWriteTone(BUZZER_PIN, buzzerOn ? (BUZZER_FREQ + 500) : 0);
      }
      break;
  }
}



void setup() {
  Serial.begin(115200);
  Serial.println("\n=== Body Node v9 ===");

  esp_task_wdt_config_t wdtCfg = { .timeout_ms = WDT_TIMEOUT_S * 1000, .idle_core_mask = 0, .trigger_panic = true };
  esp_task_wdt_reconfigure(&wdtCfg);
  esp_task_wdt_add(NULL);

  ledcAttach(BUZZER_PIN, BUZZER_FREQ, BUZZER_RESOLUTION);
  ledcWriteTone(BUZZER_PIN, 0);

  Wire.begin(SDA_PIN, SCL_PIN);       Wire.setTimeOut(I2C_TIMEOUT_MS);
  Wire1.begin(MPU_SDA_PIN, MPU_SCL_PIN); Wire1.setTimeOut(I2C_TIMEOUT_MS);

  if (!maxSensor.begin(Wire, I2C_SPEED_FAST)) {
    Serial.println("ERROR: MAX30102 not found");
    while (1) { esp_task_wdt_reset(); delay(1000); }
  }
  maxSensor.setup(60, 4, 2, 400, 411, 4096);

  mpuHealthy = mpuInit();
  if (!mpuHealthy) Serial.println("WARNING: MPU6050 not found");

  memset(hrRateBuffer, 0, HR_BUFFER_SIZE);

  if (!initESPNow()) Serial.println("ESP-NOW init failed - will retry");
  strcpy(outgoingData.nodeName, "BODY");

  //startup beep
  ledcWriteTone(BUZZER_PIN, BUZZER_FREQ); delay(100);
  ledcWriteTone(BUZZER_PIN, 0);           delay(100);
  ledcWriteTone(BUZZER_PIN, BUZZER_FREQ); delay(100);
  ledcWriteTone(BUZZER_PIN, 0);

  Serial.println("Ready.\n");
}

void loop() {
  unsigned long now = millis();
  esp_task_wdt_reset();

  //MPU6050
  if (mpuHealthy) {
    if (mpuReadAccelZ(accelZ)) {
      mpuFailCount = 0;
    } else if (++mpuFailCount >= MAX_I2C_FAILURES) {
      recoverMPU();
      mpuFailCount = 0;
    }
  }

  if (accelZ < FACE_DOWN_Z_THRESHOLD) {
    if (!isFaceDown) { isFaceDown = true; faceDownStartTime = now; faceDownConfirmed = false; }
    else if (!faceDownConfirmed && (now - faceDownStartTime > FACE_DOWN_HOLD_MS)) faceDownConfirmed = true;
  } else {
    isFaceDown = false;
    faceDownConfirmed = false;
  }

  //MAX30102
  uint32_t irValue = 0, redValue = 0;
  bool gotNewSample = false;

  if (maxHealthy) {
    maxSensor.check();
    uint8_t reads = 0;
    while (maxSensor.available() && reads < MAX_FIFO_READS) {
      irValue  = maxSensor.getFIFOIR();
      redValue = maxSensor.getFIFORed();
      gotNewSample = true;
      maxSensor.nextSample();
      reads++;
    }
    if (gotNewSample && irValue == 0 && redValue == 0) {
      if (++maxFailCount >= MAX_I2C_FAILURES) { recoverMAX(); maxFailCount = 0; }
    } else if (gotNewSample) { maxFailCount = 0; }
  }

  bool fingerPresent = (gotNewSample && irValue >= FINGER_DETECT_THRESHOLD);

  //warm-up tracking (helps start up )
  if (fingerPresent) {
    if (!fingerWasOn) {
      fingerOnTime = now; sensorWarmedUp = false; fingerWasOn = true;
      memset(hrRateBuffer, 0, HR_BUFFER_SIZE);
      hrBufferIndex = 0; hrSamplesCount = 0; avgBPM = 0;
      SpO2 = 0; SpO2Valid = false; spo2LowSince = 0; spo2WasLow = false;
      avRed = 0; avIR = 0;
    }
    if (!sensorWarmedUp && (now - fingerOnTime >= SENSOR_WARMUP_MS)) {
      sensorWarmedUp = true;
      Serial.println(">> Sensor warmed up");
    }
  } else {
    fingerWasOn = false;
    sensorWarmedUp = false;
  }

  //process HR & SpO2 (runs during warm-up so averages converge)
  if (fingerPresent && gotNewSample) {
    if (checkForBeat(irValue)) {
      long delta = now - lastBeat;
      lastBeat = now;
      float bpm = 60.0 / (delta / 1000.0);
      if (bpm > 20 && bpm < 200) {
        hrRateBuffer[hrBufferIndex++ % HR_BUFFER_SIZE] = (byte)bpm;
        if (hrSamplesCount < 255) hrSamplesCount++;
        float total = 0; byte count = 0;
        for (byte i = 0; i < HR_BUFFER_SIZE; i++) {
          if (hrRateBuffer[i] > 0) { total += hrRateBuffer[i]; count++; }
        }
        avgBPM = (count > 0) ? total / count : 0;
      }
    }

    const double alpha = 0.95;
    avRed = avRed * alpha + (double)redValue * (1.0 - alpha);
    avIR  = avIR  * alpha + (double)irValue  * (1.0 - alpha);
    if (avIR > 0) {
      double redAC = abs((double)redValue - avRed);
      double irAC  = abs((double)irValue  - avIR);
      if (irAC > 0 && avRed > 0) {
        double R = (redAC / avRed) / (irAC / avIR);
        SpO2 = constrain(110.0 - 25.0 * R, 0, 100);
        SpO2Valid = (SpO2 > 50);
      }
    }
  }

  //alert detection
  bool hrReady = (hrSamplesCount >= MIN_HR_SAMPLES);
  bool spo2Low = (fingerPresent && sensorWarmedUp && SpO2Valid && SpO2 < SPO2_LOW_THRESHOLD);

  if (spo2Low) {
    if (!spo2WasLow) { spo2LowSince = now; spo2WasLow = true; }
  } else {
    spo2WasLow = false; spo2LowSince = 0;
  }
  bool spo2Confirmed = (spo2WasLow && (now - spo2LowSince >= SPO2_LOW_HOLD_MS));

  bool vitalsAlert = false;
  if (fingerPresent && sensorWarmedUp) {
    if (spo2Confirmed) vitalsAlert = true;
    if (hrReady && avgBPM > 0 && avgBPM < HR_LOW_THRESHOLD) vitalsAlert = true;
    if (hrReady && avgBPM > HR_HIGH_THRESHOLD) vitalsAlert = true;
  }

  bool positionAlert = faceDownConfirmed;

  bool combinedAlert = false;
  if (faceDownConfirmed && fingerPresent && sensorWarmedUp) {
    if (spo2Confirmed && SpO2 < SPO2_COMBINED_THRESHOLD) combinedAlert = true;
    if (hrReady && avgBPM > 0 && avgBPM < HR_LOW_COMBINED) combinedAlert = true;
    if (hrReady && avgBPM > HR_HIGH_COMBINED) combinedAlert = true;
  }

  //alert state machine
  bool anyCondition = (vitalsAlert || positionAlert || combinedAlert);

  if (anyCondition) {
    int pat = combinedAlert ? PATTERN_COMBINED : vitalsAlert ? PATTERN_VITALS : PATTERN_POSITION;
    if (!alertActive) { alertActive = true; buzzerOn = true; ledcWriteTone(BUZZER_PIN, BUZZER_FREQ); }
    currentAlertPattern = pat;
    alertConditionMet = true;
  } else {
    if (alertConditionMet) { alertConditionMet = false; conditionClearedTime = now; }
    if (alertActive && (now - conditionClearedTime >= BUZZER_COOLDOWN_MS)) {
      alertActive = false; currentAlertPattern = PATTERN_NONE; stopBuzzer();
    }
  }
  updateBuzzerPattern();

  //WiFi keepalive
  if (now - lastWifiKeepAlive >= 10000) { lastWifiKeepAlive = now; esp_wifi_set_ps(WIFI_PS_NONE); }

  //ESP-NOW send 
  if (now - lastSendTime >= 1000) {
    lastSendTime = now;

    outgoingData.heartRate     = avgBPM;
    outgoingData.spo2          = SpO2Valid ? SpO2 : -1;
    outgoingData.accelZ        = accelZ;
    outgoingData.fingerPresent = fingerPresent ? 1 : 0;
    outgoingData.prone         = faceDownConfirmed ? 1 : 0;
    outgoingData.alertActive   = alertActive ? 1 : 0;
    outgoingData.alertType     = alertActive ? currentAlertPattern : PATTERN_NONE;

    if (esp_now_send(gatewayAddress, (uint8_t*)&outgoingData, sizeof(outgoingData)) != ESP_OK) {
      if (++espNowFailCount >= MAX_ESPNOW_FAILURES) {
        Serial.println("!! ESP-NOW reinit...");
        if (initESPNow()) espNowFailCount = 0;
        else espNowFailCount = MAX_ESPNOW_FAILURES - 1;
      }
    } else {
      espNowFailCount = 0;
    }

    //serial log
    Serial.print("BODY | HR: ");
    if (fingerPresent && sensorWarmedUp) Serial.print(avgBPM, 0);
    else if (fingerPresent) Serial.print("WARMUP");
    else Serial.print("--");

    Serial.print(" | SpO2: ");
    if (fingerPresent && SpO2Valid && sensorWarmedUp) Serial.print(SpO2, 1);
    else if (fingerPresent) Serial.print("WARMUP");
    else Serial.print("--");

    Serial.print(" | Z: "); Serial.print(accelZ, 2);
    Serial.print(" | Prone: "); Serial.print(faceDownConfirmed ? "YES" : "no");

    Serial.print(" | Alert: ");
    if (alertActive) {
      const char* names[] = {"VITALS", "POSITION", "COMBINED"};
      if (currentAlertPattern <= 2) Serial.print(names[currentAlertPattern]);
      if (!alertConditionMet) Serial.print("(cd)");
    } else Serial.print("--");

    Serial.print(" | "); Serial.print(now / 1000); Serial.println("s");
  }

  delay(READING_INTERVAL_MS);
}
