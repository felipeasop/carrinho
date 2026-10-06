#include <WiFi.h>
#include <WebServer.h>
#include "esp_camera.h"
#include "esp_timer.h"

// Firmware do carrinho: camera, rede, PWM e confirmacao dos pulsos.
// O painel e o algoritmo ficam em painel/ no notebook.
const char *AP_SSID = "carrinho";
const char *AP_PASSWORD = "carrinho123";

// L298N: PWM nas entradas ENA/ENB; IN1/IN3 fixam o sentido para frente.
// IN2/IN4 não são usados pelo programa. Não há comando de ré.
// Deixe -1 para testar somente câmera/rede. Preencha para usar o carrinho.
const int ENA = 2; // PWM da roda esquerda
const int IN1 = 14; // direção fixa para frente, roda esquerda
const int IN3 = 13; // direção fixa para frente, roda direita
const int ENB = 12; // PWM da roda direita

// Cada pulso termina na ESP32, mesmo se o navegador ou a rede travarem.
const unsigned long COMMAND_TIMEOUT_MS = 1200;
const unsigned long PULSE_MIN_MS = 60;
const unsigned long PULSE_MAX_MS = 260;
const unsigned long FRAME_MAX_AGE_MS = 250;
const uint32_t MAX_PWM = 255;

// Camera AI-Thinker ESP32-CAM. Altere somente para outro mapa de câmera.
#define CAM_PWDN 32
#define CAM_RESET -1
#define CAM_XCLK 0
#define CAM_SIOD 26
#define CAM_SIOC 27
#define CAM_Y9 35
#define CAM_Y8 34
#define CAM_Y7 39
#define CAM_Y6 36
#define CAM_Y5 21
#define CAM_Y4 19
#define CAM_Y3 18
#define CAM_Y2 5
#define CAM_VSYNC 25
#define CAM_HREF 23
#define CAM_PCLK 22

// Camera: imagem pequena e monocromatica para reduzir trafego.
const framesize_t CAMERA_FRAME_SIZE = FRAMESIZE_QQVGA; // 160 x 120
const int CAMERA_JPEG_QUALITY = 25;
const int CAMERA_FRAME_BUFFERS = 1;

WebServer server(80);
bool motorsEnabled = false, cameraReady = false;
unsigned long lastCommandMs = 0;
unsigned long pulseStoppedAt = 0, frameCapturedAt = 0;
int64_t pulseStoppedUs = 0;
uint32_t controlToken = 0, lastStepSeq = 0, completedSeq = 0, confirmedSeq = 0;
uint32_t lastFrameId = 0, lastUsedFrameId = 0, frameAfterSeq = 0;
bool pulseActive = false;
esp_timer_handle_t pulseTimer = nullptr;
portMUX_TYPE pulseMux = portMUX_INITIALIZER_UNLOCKED;

// A pagina e a visao rodam no notebook (painel/app.js).

void stopMotors() {
  if (!motorsEnabled) return;
  ledcWrite(ENA, 0);
  ledcWrite(ENB, 0);
}

void pulseTimerCallback(void *) {
  stopMotors();
  portENTER_CRITICAL(&pulseMux);
  completedSeq = lastStepSeq;
  pulseStoppedAt = millis();
  pulseStoppedUs = esp_timer_get_time();
  pulseActive = false;
  portEXIT_CRITICAL(&pulseMux);
}

void cancelControl() {
  if (pulseTimer) esp_timer_stop(pulseTimer);
  stopMotors();
  portENTER_CRITICAL(&pulseMux);
  pulseActive = false;
  controlToken = 0;
  portEXIT_CRITICAL(&pulseMux);
}

bool pinsValid() {
  const int pins[] = {ENA, IN1, IN3, ENB};
  const int reserved[] = {0, 1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 34, 35, 36, 39};
  for (int i = 0; i < 4; i++) {
    if (pins[i] < 0 || pins[i] > 33) return false;
    for (unsigned int j = 0; j < sizeof(reserved) / sizeof(reserved[0]); j++) {
      if (pins[i] == reserved[j]) return false;
    }
    for (int j = i + 1; j < 4; j++) {
      if (pins[i] == pins[j]) return false;
    }
  }
  return true;
}

void configureMotors() {
  motorsEnabled = pinsValid();
  if (!motorsEnabled) {
    Serial.println("Motores desabilitados: revise os quatro GPIOs e os pinos reservados.");
    return;
  }
  pinMode(IN1, OUTPUT);
  pinMode(IN3, OUTPUT);
  digitalWrite(IN1, HIGH);
  digitalWrite(IN3, HIGH);
  // A camera usa o canal LEDC 0; reservar canais separados para ENA e ENB.
  if (!ledcAttachChannel(ENA, 1000, 8, 2) ||
      !ledcAttachChannel(ENB, 1000, 8, 3)) {
    motorsEnabled = false;
    Serial.println("Falha ao configurar PWM.");
    return;
  }
  stopMotors();
}

void handleCapture() {
  if (!cameraReady) { server.send(503, "text/plain", "Camera indisponivel"); return; }
  portENTER_CRITICAL(&pulseMux);
  const bool moving = pulseActive;
  const int64_t stoppedUs = pulseStoppedUs;
  portEXIT_CRITICAL(&pulseMux);
  if (moving) { server.send(409, "text/plain", "Pulso em andamento"); return; }
  camera_fb_t *frame = nullptr;
  int64_t capturedUs = 0;
  for (int attempt = 0; attempt < 3; ++attempt) {
    frame = esp_camera_fb_get();
    if (!frame) break;
    capturedUs = int64_t(frame->timestamp.tv_sec) * 1000000 + frame->timestamp.tv_usec;
    const int64_t ageUs = esp_timer_get_time() - capturedUs;
    if (capturedUs > stoppedUs && ageUs >= 0 && ageUs <= int64_t(FRAME_MAX_AGE_MS) * 1000) break;
    esp_camera_fb_return(frame);
    frame = nullptr;
  }
  if (!frame) {
    server.send(503, "text/plain", "Imagem recente indisponivel");
    return;
  }
  frameCapturedAt = capturedUs / 1000;
  if (++lastFrameId == 0) ++lastFrameId;
  portENTER_CRITICAL(&pulseMux);
  frameAfterSeq = completedSeq;
  portEXIT_CRITICAL(&pulseMux);
  server.sendHeader("X-Frame-Id", String(lastFrameId));
  server.setContentLength(frame->len);
  server.sendHeader("Cache-Control", "no-store");
  server.send(200, "image/jpeg", "");
  WiFiClient client = server.client();
  size_t sent = 0;
  const unsigned long started = millis();
  while (sent < frame->len && client.connected() && millis() - started < 300) {
    const size_t remaining = frame->len - sent;
    const size_t chunk = remaining > 1024 ? 1024 : remaining;
    const size_t written = client.write(frame->buf + sent, chunk);
    if (written) sent += written;
    else delay(1);
  }
  if (sent != frame->len) client.stop();
  esp_camera_fb_return(frame);
}

bool readNumber(const char *name, uint32_t maximum, uint32_t &value) {
  if (!server.hasArg(name)) return false;
  const String text = server.arg(name);
  if (text.isEmpty() || text.length() > 10) return false;
  for (unsigned int i = 0; i < text.length(); ++i) if (!isDigit(text[i])) return false;
  const unsigned long long parsed = strtoull(text.c_str(), nullptr, 10);
  if (parsed > maximum) return false;
  value = static_cast<uint32_t>(parsed);
  return true;
}

void handleArm() {
  if (!motorsEnabled || !pulseTimer || !cameraReady) {
    server.send(503, "text/plain", "Camera ou motores indisponiveis"); return;
  }
  portENTER_CRITICAL(&pulseMux);
  const bool moving = pulseActive;
  portEXIT_CRITICAL(&pulseMux);
  if (moving || controlToken) { server.send(409, "text/plain", "Sessao ja ativa"); return; }
  controlToken = esp_random();
  if (!controlToken) controlToken = 1;
  lastStepSeq = completedSeq = confirmedSeq = lastUsedFrameId = frameAfterSeq = 0;
  pulseStoppedAt = 0;
  pulseStoppedUs = 0;
  lastCommandMs = millis();
  server.send(200, "application/json", String("{\"token\":") + controlToken + ",\"motors_enabled\":true}");
}

void handleStop() {
  cancelControl();
  server.send(200, "application/json", "{\"stopped\":true}");
}

void handleStep() {
  uint32_t token,seq,frame,left,right,duration;
  if (!readNumber("token", UINT32_MAX, token) || !readNumber("seq", UINT32_MAX, seq) ||
      !readNumber("frame", UINT32_MAX, frame) || !readNumber("left", MAX_PWM, left) ||
      !readNumber("right", MAX_PWM, right) || !readNumber("duration", PULSE_MAX_MS, duration) ||
      duration < PULSE_MIN_MS) {
    server.send(400, "text/plain", "Pulso invalido"); return;
  }
  portENTER_CRITICAL(&pulseMux);
  const bool moving = pulseActive;
  const uint32_t done = completedSeq;
  portEXIT_CRITICAL(&pulseMux);
  const unsigned long now = millis();
  if (!motorsEnabled || !pulseTimer || !controlToken || token != controlToken || moving ||
      seq != lastStepSeq + 1 || !frame || frame != lastFrameId || frame <= lastUsedFrameId ||
      frameAfterSeq != done || confirmedSeq != done || now - frameCapturedAt > FRAME_MAX_AGE_MS ||
      (lastStepSeq && now - pulseStoppedAt < 25)) {
    server.send(409, "text/plain", "Pulso fora de sequencia ou imagem antiga"); return;
  }
  lastStepSeq = seq;
  lastUsedFrameId = frame;
  lastCommandMs = now;
  portENTER_CRITICAL(&pulseMux);
  pulseActive = true;
  portEXIT_CRITICAL(&pulseMux);
  ledcWrite(ENA, left);
  ledcWrite(ENB, right);
  if (esp_timer_start_once(pulseTimer, duration * 1000) != ESP_OK) {
    cancelControl();
    server.send(500, "text/plain", "Falha no temporizador do pulso"); return;
  }
  server.send(200, "application/json", String("{\"seq\":") + seq + ",\"accepted\":true}");
}

void handleStepStatus() {
  uint32_t token,seq;
  if (!readNumber("token", UINT32_MAX, token) || !readNumber("seq", UINT32_MAX, seq) ||
      !controlToken || token != controlToken || seq != lastStepSeq) {
    server.send(409, "text/plain", "Sessao ou sequencia invalida"); return;
  }
  portENTER_CRITICAL(&pulseMux);
  const bool moving = pulseActive;
  const uint32_t done = completedSeq;
  portEXIT_CRITICAL(&pulseMux);
  if (!moving && done == seq) confirmedSeq = seq;
  server.send(200, "application/json", String("{\"seq\":") + seq +
    ",\"done\":" + (moving || done != seq ? "false" : "true") + ",\"motors_enabled\":true}");
}

void handleStatus() {
  portENTER_CRITICAL(&pulseMux);
  const bool moving = pulseActive;
  portEXIT_CRITICAL(&pulseMux);
  char json[220];
  snprintf(json, sizeof(json),
           "{\"camera_ready\":%s,"
           "\"motors_enabled\":%s,\"pulse_active\":%s,\"max_pwm\":%lu,"
           "\"pulse_min_ms\":%lu,\"pulse_max_ms\":%lu}",
           cameraReady ? "true" : "false", motorsEnabled ? "true" : "false",
           moving ? "true" : "false", static_cast<unsigned long>(MAX_PWM),
           PULSE_MIN_MS, PULSE_MAX_MS);
  server.sendHeader("Cache-Control", "no-store");
  server.send(200, "application/json", json);
}

bool configureCamera() {
  camera_config_t config = {};
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = CAM_Y2;
  config.pin_d1 = CAM_Y3;
  config.pin_d2 = CAM_Y4;
  config.pin_d3 = CAM_Y5;
  config.pin_d4 = CAM_Y6;
  config.pin_d5 = CAM_Y7;
  config.pin_d6 = CAM_Y8;
  config.pin_d7 = CAM_Y9;
  config.pin_xclk = CAM_XCLK;
  config.pin_pclk = CAM_PCLK;
  config.pin_vsync = CAM_VSYNC;
  config.pin_href = CAM_HREF;
  config.pin_sccb_sda = CAM_SIOD;
  config.pin_sccb_scl = CAM_SIOC;
  config.pin_pwdn = CAM_PWDN;
  config.pin_reset = CAM_RESET;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;
  config.frame_size = CAMERA_FRAME_SIZE;
  config.jpeg_quality = CAMERA_JPEG_QUALITY;
  config.fb_count = CAMERA_FRAME_BUFFERS;
  const esp_err_t cameraError = esp_camera_init(&config);
  if (cameraError != ESP_OK) {
    Serial.printf("Falha camera: esp_camera_init=0x%x (%s)\n", cameraError, esp_err_to_name(cameraError));
    return false;
  }
  sensor_t *sensor = esp_camera_sensor_get();
  if (!sensor || !sensor->set_special_effect || sensor->set_special_effect(sensor, 2) != 0) {
    Serial.println("Aviso: o sensor nao confirmou o efeito em tons de cinza.");
  }
  return true;
}

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("Inicializando firmware do carrinho...");
  pinMode(4, OUTPUT); // Flash da camera desligado.
  digitalWrite(4, LOW);
  configureMotors();
  esp_timer_create_args_t timerConfig = {};
  timerConfig.callback = pulseTimerCallback;
  timerConfig.name = "fim_pulso";
  if (esp_timer_create(&timerConfig, &pulseTimer) != ESP_OK) {
    stopMotors();
    motorsEnabled = false;
    Serial.println("Falha no temporizador dos motores.");
  }
  if (!WiFi.mode(WIFI_AP)) {
    Serial.println("Falha: WiFi.mode(WIFI_AP) nao iniciou.");
  } else if (!WiFi.softAP(AP_SSID, AP_PASSWORD)) {
    Serial.printf("Falha: nao foi possivel criar a rede '%s'.\n", AP_SSID);
  } else {
    Serial.printf("Wi-Fi iniciado: SSID='%s' | IP=http://%s\n",
                  AP_SSID, WiFi.softAPIP().toString().c_str());
  }
  cameraReady = configureCamera();
  if (!cameraReady) Serial.println("Wi-Fi segue ativo; captura de imagem indisponivel.");
  server.on("/", HTTP_GET, []() {
    server.sendHeader("Cache-Control", "no-store");
    server.send(200, "text/plain; charset=utf-8",
                "ESP32-CAM pronta. No notebook, execute python3 notebook_server.py "
                "e abra http://127.0.0.1:8765/. Diagnostico: /status");
  });
  server.on("/status", HTTP_GET, handleStatus);
  server.on("/capture", HTTP_GET, handleCapture);
  server.on("/arm", HTTP_POST, handleArm);
  server.on("/stop", HTTP_POST, handleStop);
  server.on("/step", HTTP_POST, handleStep);
  server.on("/step-status", HTTP_GET, handleStepStatus);
  server.begin();
  Serial.println("Servidor HTTP iniciado na porta 80.");
}

void loop() {
  server.handleClient();
  if (controlToken && millis() - lastCommandMs > COMMAND_TIMEOUT_MS) cancelControl();
  delay(2);
}
