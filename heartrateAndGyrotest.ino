/*
 * Sleep Apnea Episode Detector v8 + ESP-NOW Sender
 * v7 fixes: warm-up period, buzzer cooldown, non-blocking alerts
 * v8 fixes: hardware watchdog to recover from I2C hangs,
 *           MAX30102 bus recovery, FIFO read guard,
 *           minimum HR samples before trusting readings.
 */

#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <Wire.h>
#include <esp_task_wdt.h>
#include "MAX30105.h"
#include "heartRate.h"

const uint8_t ESPNOW_CHANNEL = 6;

// gateway MAC
uint8_t gatewayAddress[] = {0x20, 0xE7, 0xC8, 0xB1, 0xEC, 0x98};

// pins
#define BUZZER_PIN        25

// MAX30102 I2C bus (Wire)
#define SDA_PIN           21
#define SCL_PIN           22

// MPU6050 I2C bus (Wire1 – separate bus)
#define MPU_SDA_PIN       33
#define MPU_SCL_PIN       26

// MPU6050 register defines
#define MPU6050_ADDR       0x68
#define MPU6050_WHO_AM_I   0x75
#define MPU6050_PWR_MGMT_1 0x6B
#define MPU6050_ACCEL_CONFIG 0x1C
#define MPU6050_CONFIG     0x1A
#define MPU6050_ACCEL_XOUT_H 0x3B

// MAX30102 thresholds
#define SPO2_LOW_THRESHOLD      90
#define HR_LOW_THRESHOLD        40
#define HR_HIGH_THRESHOLD       100
#define FINGER_DETECT_THRESHOLD 50000

// MAX30102 warmup + reliability
#define SENSOR_WARMUP_MS        10000
#define MIN_HR_SAMPLES          4
#define SPO2_LOW_HOLD_MS        3000
#define MAX_FIFO_READS          32

// MPU6050 thresholds
#define FACE_DOWN_Z_THRESHOLD   -5.0
#define FACE_DOWN_HOLD_MS       3000

// combined thresholds
#define SPO2_COMBINED_THRESHOLD 94
#define HR_LOW_COMBINED         45
#define HR_HIGH_COMBINED        95

// alert settings
#define BUZZER_COOLDOWN_MS      5000
#define READING_INTERVAL_MS     10

// buzzer settings
#define BUZZER_FREQ             2700
#define BUZZER_RESOLUTION       8

#define PATTERN_VITALS          0
#define PATTERN_POSITION        1
#define PATTERN_COMBINED        2
#define PATTERN_NONE            255

// heart rate averaging
#define HR_BUFFER_SIZE 8

#define I2C_TIMEOUT_MS          50
#define MAX_I2C_FAILURES        10
#define MAX_ESPNOW_FAILURES     5
#define WDT_TIMEOUT_S           8

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

BodyPacket outgoingData;

MAX30105 maxSensor;

// heart rate tracking
byte   hrRateBuffer[HR_BUFFER_SIZE];
byte   hrBufferIndex   = 0;
byte   hrSamplesCount  = 0;
long   lastBeat        = 0;
float  currentBPM      = 0;
float  avgBPM          = 0;

// SpO2 tracking
double avRed           = 0;
double avIR            = 0;
double SpO2            = 0;
bool   SpO2Valid       = false;
unsigned long spo2LowSince = 0;
bool   spo2WasLow      = false;

// warm-up tracking
unsigned long fingerOnTime = 0;
bool          fingerWasOn = false;
bool          sensorWarmedUp = false;

// MAX30102 I2C health
uint8_t maxFailCount = 0;
bool    maxHealthy   = true;

// MPU6050 tracking
float  accelX = 0;
float  accelY = 0;
float  accelZ = 0;
bool   isFaceDown = false;
unsigned long faceDownStartTime = 0;
bool   faceDownConfirmed = false;

// alert state
bool      alertActive = false;
bool      alertConditionMet = false;
unsigned long conditionClearedTime = 0;
int       currentAlertPattern = PATTERN_NONE;

// buzzer pattern state
unsigned long lastPatternToggle = 0;
bool buzzerOn = false;

// ESP-NOW timing and health
unsigned long lastSendTime = 0;
const unsigned long sendInterval = 1000;
volatile bool lastSendSuccess = true;
uint8_t espNowFailCount = 0;
bool espNowInitialized = false;

// I2C health tracking (MPU)
uint8_t mpuFailCount = 0;
bool    mpuHealthy   = true;

// uptime tracking
unsigned long loopCount = 0;
unsigned long lastWifiKeepAlive = 0;

void mpuWriteReg(uint8_t reg, uint8_t value) {
  Wire1.beginTransmission(MPU6050_ADDR);
  Wire1.write(reg);
  Wire1.write(value);
  uint8_t err = Wire1.endTransmission();
  if (err != 0) {
    Serial.print("MPU I2C write error: ");
    Serial.println(err);
  }
}

bool mpuReadRegSafe(uint8_t reg, uint8_t &value) {
  Wire1.beginTransmission(MPU6050_ADDR);
  Wire1.write(reg);
  uint8_t err = Wire1.endTransmission(false);
  if (err != 0) return false;

  uint8_t count = Wire1.requestFrom((uint8_t)MPU6050_ADDR, (uint8_t)1);
  if (count < 1) return false;

  value = Wire1.read();
  return true;
}

bool mpuInit() {
  uint8_t whoAmI = 0;
  if (!mpuReadRegSafe(MPU6050_WHO_AM_I, whoAmI)) {
    Serial.println("MPU6050: No I2C response");
    return false;
  }

  Serial.print("MPU6050 WHO_AM_I: 0x");
  Serial.println(whoAmI, HEX);

  if (whoAmI != 0x68 && whoAmI != 0x70 && whoAmI != 0x71 &&
      whoAmI != 0x72 && whoAmI != 0x73 && whoAmI != 0x19) {
    return false;
  }

  mpuWriteReg(MPU6050_PWR_MGMT_1, 0x00);
  delay(100);
  mpuWriteReg(MPU6050_ACCEL_CONFIG, 0x00);
  mpuWriteReg(MPU6050_CONFIG, 0x04);

  return true;
}

bool mpuReadAccel(float &ax, float &ay, float &az) {
  Wire1.beginTransmission(MPU6050_ADDR);
  Wire1.write(MPU6050_ACCEL_XOUT_H);
  uint8_t err = Wire1.endTransmission(false);
  if (err != 0) return false;

  uint8_t count = Wire1.requestFrom((uint8_t)MPU6050_ADDR, (uint8_t)6);
  if (count < 6) {
    while (Wire1.available()) Wire1.read();
    return false;
  }

  int16_t rawX = (Wire1.read() << 8) | Wire1.read();
  int16_t rawY = (Wire1.read() << 8) | Wire1.read();
  int16_t rawZ = (Wire1.read() << 8) | Wire1.read();

  const float scale = 9.81 / 16384.0;
  ax = rawX * scale;
  ay = rawY * scale;
  az = rawZ * scale;
  return true;
}

void recoverI2CBus1() {
  Serial.println("!! Recovering MPU I2C bus (Wire1)...");
  Wire1.end();
  delay(10);

  pinMode(MPU_SCL_PIN, OUTPUT);
  pinMode(MPU_SDA_PIN, INPUT_PULLUP);
  for (int i = 0; i < 16; i++) {
    digitalWrite(MPU_SCL_PIN, HIGH);
    delayMicroseconds(5);
    digitalWrite(MPU_SCL_PIN, LOW);
    delayMicroseconds(5);
  }
  digitalWrite(MPU_SCL_PIN, HIGH);
  delay(10);

  Wire1.begin(MPU_SDA_PIN, MPU_SCL_PIN);
  Wire1.setTimeOut(I2C_TIMEOUT_MS);
  delay(50);

  mpuWriteReg(MPU6050_PWR_MGMT_1, 0x00);
  delay(100);
  mpuWriteReg(MPU6050_ACCEL_CONFIG, 0x00);
  mpuWriteReg(MPU6050_CONFIG, 0x04);

  Serial.println("   Wire1 recovery complete.");
}

void recoverI2CBus0() {
  Serial.println("!! Recovering MAX30102 I2C bus (Wire)...");
  Wire.end();
  delay(10);

  pinMode(SCL_PIN, OUTPUT);
  pinMode(SDA_PIN, INPUT_PULLUP);
  for (int i = 0; i < 16; i++) {
    digitalWrite(SCL_PIN, HIGH);
    delayMicroseconds(5);
    digitalWrite(SCL_PIN, LOW);
    delayMicroseconds(5);
  }
  digitalWrite(SCL_PIN, HIGH);
  delay(10);

  Wire.begin(SDA_PIN, SCL_PIN);
  Wire.setTimeOut(I2C_TIMEOUT_MS);
  delay(50);

  if (maxSensor.begin(Wire, I2C_SPEED_FAST)) {
    maxSensor.setup(60, 4, 2, 400, 411, 4096);
    maxHealthy = true;
    Serial.println("   Wire recovery complete — MAX30102 re-initialized.");
  } else {
    maxHealthy = false;
    Serial.println("   Wire recovery FAILED — MAX30102 not responding.");
  }
}

void onDataSent(const wifi_tx_info_t *tx_info, esp_now_send_status_t status) {
  lastSendSuccess = (status == ESP_NOW_SEND_SUCCESS);
}

bool initESPNow() {
  if (espNowInitialized) {
    esp_now_deinit();
    espNowInitialized = false;
    delay(100);
  }

  WiFi.mode(WIFI_STA);
  WiFi.disconnect(true, true);
  delay(100);

  esp_wifi_set_ps(WIFI_PS_NONE);

  esp_wifi_set_promiscuous(true);
  esp_wifi_set_channel(ESPNOW_CHANNEL, WIFI_SECOND_CHAN_NONE);
  esp_wifi_set_promiscuous(false);

  if (esp_now_init() != ESP_OK) {
    Serial.println("ESP-NOW init failed!");
    return false;
  }

  esp_now_register_send_cb(onDataSent);

  esp_now_peer_info_t peerInfo = {};
  memcpy(peerInfo.peer_addr, gatewayAddress, 6);
  peerInfo.channel = ESPNOW_CHANNEL;
  peerInfo.encrypt = false;

  esp_now_del_peer(gatewayAddress);

  if (esp_now_add_peer(&peerInfo) != ESP_OK) {
    Serial.println("Failed to add gateway peer!");
    return false;
  }

  espNowInitialized = true;
  Serial.println("ESP-NOW initialized.");
  return true;
}

void setup() {
  Serial.begin(115200);
  Serial.println("\n=== Body Node v8 (Watchdog + Bus Recovery) ===");

  esp_task_wdt_config_t wdtConfig = {
    .timeout_ms = WDT_TIMEOUT_S * 1000,
    .idle_core_mask = 0,
    .trigger_panic = true
  };
  esp_task_wdt_reconfigure(&wdtConfig);
  esp_task_wdt_add(NULL);

  Serial.print("Watchdog armed: ");
  Serial.print(WDT_TIMEOUT_S);
  Serial.println("s timeout");

  ledcAttach(BUZZER_PIN, BUZZER_FREQ, BUZZER_RESOLUTION);
  ledcWriteTone(BUZZER_PIN, 0);

  Wire.begin(SDA_PIN, SCL_PIN);
  Wire.setTimeOut(I2C_TIMEOUT_MS);

  Wire1.begin(MPU_SDA_PIN, MPU_SCL_PIN);
  Wire1.setTimeOut(I2C_TIMEOUT_MS);

  if (!maxSensor.begin(Wire, I2C_SPEED_FAST)) {
    Serial.println("ERROR: MAX30102 not found");
    while (1) { esp_task_wdt_reset(); delay(1000); }
  }
  Serial.println("MAX30102 initialized.");
  maxSensor.setup(60, 4, 2, 400, 411, 4096);

  if (!mpuInit()) {
    Serial.println("WARNING: MPU6050 not found - continuing without it");
    mpuHealthy = false;
  } else {
    Serial.println("MPU6050 initialized.");
    mpuHealthy = true;
  }

  for (byte i = 0; i < HR_BUFFER_SIZE; i++) {
    hrRateBuffer[i] = 0;
  }

  if (!initESPNow()) {
    Serial.println("ESP-NOW init failed - will retry in loop");
  }

  strcpy(outgoingData.nodeName, "BODY");

  ledcWriteTone(BUZZER_PIN, BUZZER_FREQ);
  delay(100);
  ledcWriteTone(BUZZER_PIN, 0);
  delay(100);
  ledcWriteTone(BUZZER_PIN, BUZZER_FREQ);
  delay(100);
  ledcWriteTone(BUZZER_PIN, 0);

  Serial.println("Body node ready.\n");
}

void loop() {
  loopCount++;
  unsigned long now = millis();

  esp_task_wdt_reset();

  if (mpuHealthy) {
    if (mpuReadAccel(accelX, accelY, accelZ)) {
      mpuFailCount = 0;
    } else {
      mpuFailCount++;
      if (mpuFailCount >= MAX_I2C_FAILURES) {
        Serial.print("MPU6050: ");
        Serial.print(mpuFailCount);
        Serial.println(" consecutive failures - recovering bus");
        recoverI2CBus1();
        mpuFailCount = 0;
      }
    }
  }

  if (accelZ < FACE_DOWN_Z_THRESHOLD) {
    if (!isFaceDown) {
      isFaceDown = true;
      faceDownStartTime = now;
      faceDownConfirmed = false;
    } else if (!faceDownConfirmed && (now - faceDownStartTime > FACE_DOWN_HOLD_MS)) {
      faceDownConfirmed = true;
    }
  } else {
    isFaceDown = false;
    faceDownConfirmed = false;
  }

  uint32_t irValue  = 0;
  uint32_t redValue = 0;
  bool gotNewSample = false;

  if (maxHealthy) {
    maxSensor.check();

    uint8_t fifoReads = 0;
    while (maxSensor.available() && fifoReads < MAX_FIFO_READS) {
      irValue  = maxSensor.getFIFOIR();
      redValue = maxSensor.getFIFORed();
      gotNewSample = true;
      maxSensor.nextSample();
      fifoReads++;
    }

    if (gotNewSample && irValue == 0 && redValue == 0) {
      maxFailCount++;
      if (maxFailCount >= MAX_I2C_FAILURES) {
        Serial.println("MAX30102: sustained zero reads - recovering bus");
        recoverI2CBus0();
        maxFailCount = 0;
      }
    } else if (gotNewSample) {
      maxFailCount = 0;
    }
  }

  bool fingerPresent = (gotNewSample && irValue >= FINGER_DETECT_THRESHOLD);

  if (fingerPresent) {
    if (!fingerWasOn) {
      fingerOnTime   = now;
      sensorWarmedUp = false;
      fingerWasOn    = true;

      for (byte i = 0; i < HR_BUFFER_SIZE; i++) hrRateBuffer[i] = 0;
      hrBufferIndex  = 0;
      hrSamplesCount = 0;
      avgBPM         = 0;
      currentBPM     = 0;
      SpO2           = 0;
      SpO2Valid      = false;
      spo2LowSince   = 0;
      spo2WasLow     = false;
      avRed          = 0;
      avIR           = 0;
    }

    if (!sensorWarmedUp && (now - fingerOnTime >= SENSOR_WARMUP_MS)) {
      sensorWarmedUp = true;
      Serial.println(">> MAX30102 warmed up — readings now trusted");
    }
  } else {
    fingerWasOn    = false;
    sensorWarmedUp = false;
  }

  if (fingerPresent && gotNewSample) {
    if (checkForBeat(irValue)) {
      long delta = now - lastBeat;
      lastBeat = now;
      currentBPM = 60.0 / (delta / 1000.0);

      if (currentBPM > 20 && currentBPM < 200) {
        hrRateBuffer[hrBufferIndex++ % HR_BUFFER_SIZE] = (byte)currentBPM;
        if (hrSamplesCount < 255) hrSamplesCount++;

        float total = 0;
        byte count = 0;
        for (byte i = 0; i < HR_BUFFER_SIZE; i++) {
          if (hrRateBuffer[i] > 0) {
            total += hrRateBuffer[i];
            count++;
          }
        }
        avgBPM = (count > 0) ? total / count : 0;
      }
    }

    const double alpha = 0.95;
    avRed = avRed * alpha + (double)redValue * (1.0 - alpha);
    avIR  = avIR  * alpha + (double)irValue  * (1.0 - alpha);

    if (avIR > 0) {
      double redAC = fabs((double)redValue - avRed);
      double irAC  = fabs((double)irValue  - avIR);
      if (irAC > 0 && avRed > 0) {
        double R = (redAC / avRed) / (irAC / avIR);
        SpO2 = 110.0 - 25.0 * R;
        SpO2 = constrain(SpO2, 0, 100);
        SpO2Valid = (SpO2 > 50);
      }
    }
  }

  bool hrReady = (hrSamplesCount >= MIN_HR_SAMPLES);

  bool spo2Low = (fingerPresent && sensorWarmedUp && SpO2Valid && SpO2 < SPO2_LOW_THRESHOLD);

  if (spo2Low) {
    if (!spo2WasLow) {
      spo2LowSince = now;
      spo2WasLow = true;
    }
  } else {
    spo2WasLow = false;
    spo2LowSince = 0;
  }

  bool spo2AlertConfirmed = (spo2WasLow && (now - spo2LowSince >= SPO2_LOW_HOLD_MS));

  bool vitalsAlert = false;
  if (fingerPresent && sensorWarmedUp) {
    if (spo2AlertConfirmed) vitalsAlert = true;
    if (hrReady && avgBPM > 0 && avgBPM < HR_LOW_THRESHOLD) vitalsAlert = true;
    if (hrReady && avgBPM > HR_HIGH_THRESHOLD) vitalsAlert = true;
  }

  bool positionAlert = faceDownConfirmed;

  bool combinedAlert = false;
  if (faceDownConfirmed && fingerPresent && sensorWarmedUp) {
    if (spo2AlertConfirmed && SpO2 < SPO2_COMBINED_THRESHOLD) combinedAlert = true;
    if (hrReady && avgBPM > 0 && avgBPM < HR_LOW_COMBINED) combinedAlert = true;
    if (hrReady && avgBPM > HR_HIGH_COMBINED) combinedAlert = true;
  }

  bool anyCondition = (vitalsAlert || positionAlert || combinedAlert);

  if (anyCondition) {
    int newPattern = PATTERN_NONE;
    if (combinedAlert)       newPattern = PATTERN_COMBINED;
    else if (vitalsAlert)    newPattern = PATTERN_VITALS;
    else if (positionAlert)  newPattern = PATTERN_POSITION;

    if (!alertActive) {
      alertActive = true;
      currentAlertPattern = newPattern;
      buzzerOn = true;
      ledcWriteTone(BUZZER_PIN, BUZZER_FREQ);
    } else {
      currentAlertPattern = newPattern;
    }

    alertConditionMet = true;
  } else {
    if (alertConditionMet) {
      alertConditionMet = false;
      conditionClearedTime = now;
    }

    if (alertActive) {
      if (now - conditionClearedTime >= BUZZER_COOLDOWN_MS) {
        alertActive = false;
        currentAlertPattern = PATTERN_NONE;
        stopBuzzer();
      }
    }
  }

  updateBuzzerPattern();

  if (now - lastWifiKeepAlive >= 10000) {
    lastWifiKeepAlive = now;
    esp_wifi_set_ps(WIFI_PS_NONE);
  }

  if (now - lastSendTime >= sendInterval) {
    lastSendTime = now;

    outgoingData.heartRate     = avgBPM;
    outgoingData.spo2          = SpO2Valid ? SpO2 : -1;
    outgoingData.accelZ        = accelZ;
    outgoingData.fingerPresent = fingerPresent ? 1 : 0;
    outgoingData.prone         = faceDownConfirmed ? 1 : 0;
    outgoingData.alertActive   = alertActive ? 1 : 0;
    outgoingData.alertType     = alertActive ? currentAlertPattern : PATTERN_NONE;

    esp_err_t result = esp_now_send(gatewayAddress, (uint8_t*)&outgoingData, sizeof(outgoingData));

    if (result != ESP_OK) {
      espNowFailCount++;
      Serial.print("ESP-NOW send error (");
      Serial.print(espNowFailCount);
      Serial.print("): ");
      Serial.println(result);

      if (espNowFailCount >= MAX_ESPNOW_FAILURES) {
        Serial.println("!! Too many ESP-NOW failures - reinitializing...");
        if (initESPNow()) {
          espNowFailCount = 0;
          Serial.println("   ESP-NOW recovered.");
        } else {
          Serial.println("   ESP-NOW recovery failed - will retry next cycle.");
          espNowFailCount = MAX_ESPNOW_FAILURES - 1;
        }
      }
    } else {
      if (!lastSendSuccess && espNowFailCount > 0) {
        espNowFailCount++;
      } else {
        espNowFailCount = 0;
      }
    }

    Serial.print("BODY | HR: ");
    if (fingerPresent && sensorWarmedUp) {
      if (hrReady) Serial.print(avgBPM, 0);
      else {
        Serial.print(avgBPM, 0);
        Serial.print("(filling)");
      }
    }
    else if (fingerPresent) Serial.print("WARMUP");
    else Serial.print("--");

    Serial.print(" | SpO2: ");
    if (fingerPresent && SpO2Valid && sensorWarmedUp) Serial.print(SpO2, 1);
    else if (fingerPresent) Serial.print("WARMUP");
    else Serial.print("--");

    Serial.print(" | Z: ");
    Serial.print(accelZ, 2);

    Serial.print(" | Prone: ");
    Serial.print(faceDownConfirmed ? "YES" : "no");

    Serial.print(" | Alert: ");
    if (alertActive) {
      if (currentAlertPattern == PATTERN_VITALS) Serial.print("VITALS");
      else if (currentAlertPattern == PATTERN_POSITION) Serial.print("POSITION");
      else if (currentAlertPattern == PATTERN_COMBINED) Serial.print("COMBINED");
      if (!alertConditionMet) Serial.print("(cooldown)");
    } else {
      Serial.print("NONE");
    }

    Serial.print(" | Up: ");
    Serial.print(now / 1000);
    Serial.println("s");
  }

  delay(READING_INTERVAL_MS);
}

void updateBuzzerPattern() {
  if (!alertActive) return;

  unsigned long now = millis();

  switch (currentAlertPattern) {
    case PATTERN_VITALS:
      if (!buzzerOn) {
        ledcWriteTone(BUZZER_PIN, BUZZER_FREQ);
        buzzerOn = true;
      }
      break;

    case PATTERN_POSITION:
      if (now - lastPatternToggle > 500) {
        lastPatternToggle = now;
        buzzerOn = !buzzerOn;
        ledcWriteTone(BUZZER_PIN, buzzerOn ? BUZZER_FREQ : 0);
      }
      break;

    case PATTERN_COMBINED:
      if (now - lastPatternToggle > 150) {
        lastPatternToggle = now;
        buzzerOn = !buzzerOn;
        ledcWriteTone(BUZZER_PIN, buzzerOn ? (BUZZER_FREQ + 500) : 0);
      }
      break;
  }
}

void stopBuzzer() {
  ledcWriteTone(BUZZER_PIN, 0);
  buzzerOn = false;
}

