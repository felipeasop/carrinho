/*
 * Autoteste de saída digital e read-back para ESP32 clássico.
 * O programa imprime apenas pinos nos quais o read-back falhou.
 * Não conecta motores nem altera GPIOs da flash ou da UART USB.
 */

// Selecione o perfil antes de gravar cada placa:
// 1 = ESP32-CAM AI-Thinker (câmera conectada; microSD removido)
// 2 = ESP32-WROOM-32 DevKit, sem PSRAM
#define BOARD_PROFILE_AI_THINKER 1
#define BOARD_PROFILE_WROOM32 2
#define TEST_BOARD_PROFILE BOARD_PROFILE_AI_THINKER

#if TEST_BOARD_PROFILE == BOARD_PROFILE_AI_THINKER
// GPIOs expostos e não usados pelo mapa da câmera AI-Thinker.
// GPIO15 é testado depois do boot; remova qualquer cartão microSD.
const uint8_t testPins[] = {2, 4, 12, 13, 14, 15};
#elif TEST_BOARD_PROFILE == BOARD_PROFILE_WROOM32
// GPIOs digitais do ESP32-WROOM-32 DevKit.
// GPIO1/3 (serial), GPIO6-11 (flash) ficam excluídos.
const uint8_t testPins[] = {0, 2, 4, 5, 12, 13, 14, 15, 16, 17, 18, 19,
                            21, 22, 23, 25, 26, 27, 32, 33};
#else
#error "Escolha um perfil suportado em TEST_BOARD_PROFILE"
#endif

const size_t testPinCount = sizeof(testPins) / sizeof(testPins[0]);
const uint16_t settleMs = 3;

bool expectLevel(uint8_t pin, uint8_t expected) {
  delay(settleMs);
  return digitalRead(pin) == expected;
}

void testPin(uint8_t pin) {
  pinMode(pin, OUTPUT);
  digitalWrite(pin, LOW);
  const bool lowOk = expectLevel(pin, LOW);

  digitalWrite(pin, HIGH);
  const bool highOk = expectLevel(pin, HIGH);

  pinMode(pin, INPUT);
  if (!lowOk || !highOk) {
    Serial.printf("FALHA GPIO%d: nivel LOW=%s, nivel HIGH=%s\n",
                  pin, lowOk ? "OK" : "FALHA", highOk ? "OK" : "FALHA");
  }
}

void setup() {
  Serial.begin(115200);
  delay(1200);
  for (size_t i = 0; i < testPinCount; ++i) {
    testPin(testPins[i]);
  }
}

void loop() {
  // Executa uma única vez. Se não aparecer "FALHA GPIO", os read-backs das
  // saídas testadas passaram. GPIOs input-only e reservados ficam de fora.
  delay(1000);
}
