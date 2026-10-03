#include <WiFi.h>
#include <WebServer.h>
#include "esp_camera.h"

// ==================== CONFIGURACAO PRINCIPAL ====================
// Edite aqui os valores do projeto antes de gravar o sketch.

// Wi-Fi criado pela ESP32-CAM.
const char *AP_SSID = "Carrinho-CAM";
const char *AP_PASSWORD = "carrinho123";

// Velocidade inicial (0..255 PWM); tambem ajustavel ao vivo pelo painel.
const int velocidade = 90;

// L298N: PWM nas entradas ENA/ENB; IN1/IN3 fixam o sentido para frente.
// IN2/IN4 não são usados pelo programa. Não há comando de ré.
// Deixe -1 para testar somente câmera/rede. Preencha para usar o carrinho.
const int ENA = -1; // PWM da roda esquerda
const int IN1 = -1; // direção fixa para frente, roda esquerda
const int IN3 = -1; // direção fixa para frente, roda direita
const int ENB = -1; // PWM da roda direita

// Limite de parada dos motores se os comandos do navegador cessarem.
const unsigned long COMMAND_TIMEOUT_MS = 600;

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

// ================== FIM DA CONFIGURACAO PRINCIPAL ==================

static_assert(velocidade >= 0 && velocidade <= 255,
              "velocidade deve estar entre 0 e 255");

WebServer server(80);
bool motorsEnabled = false;
unsigned long lastCommandMs = 0;

const char INDEX_HTML[] PROGMEM = R"PAGE(<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Carrinho seguidor de linha</title><style>
:root{font-family:system-ui,sans-serif;color-scheme:dark;background:#101820;color:#eaf2f5}body{max-width:900px;margin:auto;padding:18px}
.panel{background:#192731;border:1px solid #36505a;border-radius:12px;padding:16px}canvas{display:block;width:100%;background:#090d10;border-radius:8px;image-rendering:auto}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:10px;margin-top:14px}.stat{border:1px solid #36505a;border-radius:8px;padding:10px}.stat span{display:block;color:#adc1ca;font-size:.85rem}.stat strong{display:block;margin-top:4px}
label{display:block;margin:16px 0 6px}input[type=range]{width:100%}#error{color:#ffb5a8;min-height:1.4em}.hint{color:#adc1ca;font-size:.9rem}
</style></head><body><h1>Carrinho seguidor de linha</h1>
<p class="hint">A imagem é analisada neste navegador. A ESP32 transmite JPEG em baixa resolução e recebe PWM por HTTP.</p>
<main class="panel"><canvas id="video" width="160" height="120"></canvas>
<label for="speed">Velocidade base: <strong><span id="speedValue">__VELOCIDADE__</span> / 255 PWM</strong></label>
<input id="speed" type="range" min="0" max="255" value="__VELOCIDADE__">
<p id="speedNote" class="hint">A correção acelera a roda externa, respeitando o máximo de 255.</p>
<div class="grid">
<div class="stat"><span>Conexão</span><strong id="connection">Conectando</strong></div>
<div class="stat"><span>Ação</span><strong id="action">Parar</strong></div>
<div class="stat"><span>Ajuste da curva</span><strong id="amount">0 PWM</strong></div>
<div class="stat"><span>Roda esquerda</span><strong id="left">0 / 255</strong></div>
<div class="stat"><span>Roda direita</span><strong id="right">0 / 255</strong></div>
<div class="stat"><span>Saída dos motores</span><strong id="motorState">—</strong></div>
<div class="stat"><span>Quadro recebido</span><strong id="frameBytes">—</strong></div>
<div class="stat"><span>Tempo câmera / comando</span><strong><span id="latency">—</span> / <span id="commandLatency">—</span></strong></div>
<div class="stat"><span>Quadros por segundo</span><strong id="fps">—</strong></div>
</div><p id="error"></p></main>
<script>
const canvas=document.querySelector('#video'),ctx=canvas.getContext('2d',{willReadFrequently:true});
const speed=document.querySelector('#speed');
let active=true,frames=0,lastFpsTime=performance.now(),currentFps=0;
speed.addEventListener('input',()=>{document.querySelector('#speedValue').textContent=speed.value;document.querySelector('#speedNote').textContent=Number(speed.value)===255?'Em 255 não sobra margem para acelerar na curva.':'A correção acelera a roda externa, respeitando o máximo de 255.'});

function otsu(hist,total){let sum=0;for(let i=0;i<256;i++)sum+=i*hist[i];let sumB=0,wB=0,best=-1,threshold=0;
 for(let i=0;i<256;i++){wB+=hist[i];if(!wB)continue;let wF=total-wB;if(!wF)break;sumB+=i*hist[i];let d=sumB/wB-(sum-sumB)/wF,v=wB*wF*d*d;if(v>best){best=v;threshold=i}}
 return threshold}

function findLine(image){const w=image.width,rh=image.height,n=w*rh,data=image.data,hist=new Uint32Array(256),gray=new Uint8Array(n);
 for(let y=0;y<rh;y++)for(let x=0;x<w;x++){let p=(y*w+x)*4,g=(data[p]*77+data[p+1]*150+data[p+2]*29)>>8;gray[y*w+x]=g;hist[g]++}
 const t=otsu(hist,n),mask=new Uint8Array(n);let dark=0;for(let i=0;i<n;i++){if(gray[i]<=t){mask[i]=1;dark++}}
 if(dark<n*.005||dark>n*.35)return{found:false};
 const queue=new Int32Array(n);let bestCount=0,bestX=0,bestY=0;
 for(let seed=0;seed<n;seed++){if(!mask[seed])continue;let head=0,tail=0,sx=0,sy=0;mask[seed]=0;queue[tail++]=seed;
  while(head<tail){let i=queue[head++],x=i%w,y=(i/w)|0;sx+=x;sy+=y;
   if(x>0&&mask[i-1]){mask[i-1]=0;queue[tail++]=i-1}if(x+1<w&&mask[i+1]){mask[i+1]=0;queue[tail++]=i+1}
   if(y>0&&mask[i-w]){mask[i-w]=0;queue[tail++]=i-w}if(y+1<rh&&mask[i+w]){mask[i+w]=0;queue[tail++]=i+w}}
  if(tail>bestCount){bestCount=tail;bestX=sx;bestY=sy}}
 if(bestCount<n*.005||bestCount>n*.35)return{found:false};
 const x=bestX/bestCount,y=bestY/bestCount,offset=Math.max(-1,Math.min(1,(x-w/2)/(w/2)));
 return{found:true,x,y,offset}}

function commandFor(line){const base=Number(speed.value);if(!line.found||base===0)return{action:'parar',amount:0,left:0,right:0};
 if(Math.abs(line.offset)<.08)return{action:'frente',amount:0,left:base,right:base};
 const delta=Math.round(Math.abs(line.offset)*Math.min(120,255-base));
 if(line.offset<0)return{action:'esquerda',amount:delta,left:base,right:base+delta};
 return{action:'direita',amount:delta,left:base+delta,right:base}}

function annotate(line,cmd){const w=canvas.width,h=canvas.height;ctx.strokeStyle='#a0a0a0';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(w/2,line.top);ctx.lineTo(w/2,h);ctx.moveTo(0,line.top);ctx.lineTo(w,line.top);ctx.stroke();
 if(line.found){ctx.fillStyle='#ffffff';ctx.beginPath();ctx.arc(line.x,line.top+line.y,4,0,Math.PI*2);ctx.fill()}
 ctx.fillStyle='rgba(0,0,0,.8)';ctx.fillRect(0,0,w,20);ctx.fillStyle='white';ctx.font='12px sans-serif';ctx.fillText(`${cmd.action.toUpperCase()}  ajuste ${cmd.amount}  L ${cmd.left} R ${cmd.right}`,5,14)}

async function stopMotors(){try{await fetch('/command?left=0&right=0',{cache:'no-store',keepalive:true})}catch(_){}}
async function loop(){if(!active)return;let started=performance.now();
 try{const response=await fetch('/capture?t='+Date.now(),{cache:'no-store'});if(!response.ok)throw Error('camera HTTP '+response.status);
  const blob=await response.blob(),cameraMs=performance.now()-started,bitmap=await createImageBitmap(blob);canvas.width=bitmap.width;canvas.height=bitmap.height;ctx.drawImage(bitmap,0,0);bitmap.close();
  const top=Math.floor(canvas.height*.62),line=findLine(ctx.getImageData(0,top,canvas.width,canvas.height-top));line.top=top;const cmd=commandFor(line);annotate(line,cmd);
  const commandStart=performance.now();const control=await fetch(`/command?left=${cmd.left}&right=${cmd.right}`,{cache:'no-store'});if(!control.ok)throw Error('comando HTTP '+control.status);
  const result=await control.json(),commandMs=performance.now()-commandStart;document.querySelector('#connection').textContent='Conectada';document.querySelector('#action').textContent=cmd.action;
  document.querySelector('#amount').textContent=`${cmd.amount} PWM`;document.querySelector('#left').textContent=`${cmd.left} / 255`;document.querySelector('#right').textContent=`${cmd.right} / 255`;
  document.querySelector('#motorState').textContent=result.motors_enabled?'Configurados':'Desativados (pinos)';document.querySelector('#frameBytes').textContent=`${blob.size} bytes`;
  document.querySelector('#latency').textContent=`${cameraMs.toFixed(0)} ms`;document.querySelector('#commandLatency').textContent=`${commandMs.toFixed(0)} ms`;
  frames++;let now=performance.now();if(now-lastFpsTime>=1000){currentFps=frames*1000/(now-lastFpsTime);frames=0;lastFpsTime=now}document.querySelector('#fps').textContent=currentFps.toFixed(1);
  document.querySelector('#error').textContent='';
 }catch(error){document.querySelector('#connection').textContent='Desconectada';document.querySelector('#action').textContent='Parar';document.querySelector('#left').textContent='0 / 255';document.querySelector('#right').textContent='0 / 255';document.querySelector('#error').textContent=String(error);await stopMotors();await new Promise(resolve=>setTimeout(resolve,400))}
 if(active)setTimeout(loop,30)}
window.addEventListener('pagehide',()=>{active=false;stopMotors()});loop();
</script></body></html>)PAGE";

void stopMotors() {
  if (!motorsEnabled) return;
  ledcWrite(ENA, 0);
  ledcWrite(ENB, 0);
}

bool pinsValid() {
  const int pins[] = {ENA, IN1, IN3, ENB};
  const int reserved[] = {0, 1, 3, 5, 6, 7, 8, 9, 10, 11, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 34, 35, 36, 39};
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
  camera_fb_t *frame = esp_camera_fb_get();
  if (!frame) {
    server.send(503, "text/plain", "Falha na captura");
    return;
  }
  server.setContentLength(frame->len);
  server.sendHeader("Cache-Control", "no-store");
  server.send(200, "image/jpeg", "");
  server.client().write(frame->buf, frame->len);
  esp_camera_fb_return(frame);
}

void handleCommand() {
  if (!server.hasArg("left") || !server.hasArg("right")) {
    server.send(400, "application/json", "{\"error\":\"left e right obrigatorios\"}");
    return;
  }
  const String leftText = server.arg("left");
  const String rightText = server.arg("right");
  for (unsigned int i = 0; i < leftText.length(); i++) {
    if (!isDigit(leftText[i])) { server.send(400, "text/plain", "PWM invalido"); return; }
  }
  for (unsigned int i = 0; i < rightText.length(); i++) {
    if (!isDigit(rightText[i])) { server.send(400, "text/plain", "PWM invalido"); return; }
  }
  const int left = leftText.toInt();
  const int right = rightText.toInt();
  if (leftText.isEmpty() || rightText.isEmpty() || left < 0 || left > 255 || right < 0 || right > 255) {
    server.send(400, "text/plain", "PWM fora de 0..255");
    return;
  }
  lastCommandMs = millis();
  if (motorsEnabled) {
    // Os pinos reversos permanecem sempre em LOW: nenhuma manobra de ré.
    ledcWrite(ENA, left);
    ledcWrite(ENB, right);
  } else {
    stopMotors();
  }
  String result = String("{\"motors_enabled\":") + (motorsEnabled ? "true" : "false") + "}";
  server.send(200, "application/json", result);
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
  if (esp_camera_init(&config) != ESP_OK) return false;
  sensor_t *sensor = esp_camera_sensor_get();
  if (!sensor || !sensor->set_special_effect || sensor->set_special_effect(sensor, 2) != 0) {
    Serial.println("Aviso: o sensor nao confirmou o efeito em tons de cinza.");
  }
  return true;
}

void setup() {
  Serial.begin(115200);
  configureMotors();
  if (!configureCamera()) {
    Serial.println("Falha ao iniciar camera. Confira o modelo e a alimentacao.");
    return;
  }
  WiFi.mode(WIFI_AP);
  WiFi.softAP(AP_SSID, AP_PASSWORD);
  Serial.print("Wi-Fi: ");
  Serial.println(WiFi.softAPIP());
  server.on("/", HTTP_GET, []() {
    server.sendHeader("Cache-Control", "no-store");
    String page = INDEX_HTML;
    page.replace("__VELOCIDADE__", String(velocidade));
    server.send(200, "text/html; charset=utf-8", page);
  });
  server.on("/capture", HTTP_GET, handleCapture);
  server.on("/command", HTTP_GET, handleCommand);
  server.begin();
}

void loop() {
  server.handleClient();
  if (motorsEnabled && millis() - lastCommandMs > COMMAND_TIMEOUT_MS) stopMotors();
  delay(2);
}
