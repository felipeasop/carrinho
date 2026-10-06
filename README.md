# Carrinho seguidor de linha - Redes

## Funcionamento

O ESP32-CAM cria uma rede Wi-Fi à qual o notebook se conecta. A placa transmite as imagens da câmera; o navegador do notebook processa o vídeo e envia os PWM das duas rodas.

A comunicação usa HTTP sobre TCP. Depois de cada imagem, o navegador envia um movimento curto e confirma que ele terminou antes de pedir a próxima imagem. Um temporizador na ESP32 encerra cada pulso mesmo se a rede falhar.

O firmware [`carrinho.ino`](carrinho.ino) contém câmera, Wi-Fi, PWM e as rotas de imagem e comando.

A interface fica em [`painel/index.html`](painel/index.html), a visão e o movimento em [`painel/algoritmo.js`](painel/algoritmo.js), e a comunicação/gravação em [`painel/app.js`](painel/app.js). O servidor [`notebook_server.py`](notebook_server.py) entrega a página, registra diagnósticos e encaminha as rotas ao ESP32. O processamento da imagem é feito no notebook.

## Como utilizar

1. Grave `carrinho.ino` na ESP32, selecionando **AI-Thinker ESP32-CAM** ou o modelo correspondente no Arduino IDE. Se esse firmware já está gravado, não precisa regravar.
2. Conecte o notebook à rede Wi-Fi `carrinho` (senha: `carrinho123`).
3. Execute `python3 notebook_server.py`. Garanta que exista apenas uma aba do carrinho e um servidor. O navegador abrirá `http://127.0.0.1:8765/` automaticamente.
4. O painel começa parado, com a barra em **130 PWM**. Alinhe o carrinho; se necessário clique em **Calibrar centro**. Selecione 130–200 e clique em **INICIAR**. **PARAR** zera os motores sem alterar a seleção. A barra ajusta o comando PWM, não mede velocidade em km/h.
5. Depois, para mudar visão ou movimento, edite `painel/algoritmo.js` e pressione **F5** na página. Para mudar a interface, use `painel/app.js`. O servidor lê os arquivos atualizados sem reiniciar. `Ctrl+C` encerra o servidor ao terminar a sessão.

O painel local usa apenas a biblioteca padrão do Python e funciona sem internet. A calibração fica salva no navegador para `127.0.0.1`. Se a ESP32 usar outro IP, execute `python3 notebook_server.py --esp-url http://IP_DA_PLACA`. Para evitar abrir o navegador automaticamente, acrescente `--no-open`. `http://192.168.4.1/status` informa se câmera e motores inicializaram; a raiz da placa mostra apenas instruções, não o painel. Alterações em câmera, pinos, rede ou temporizador do firmware ainda exigem uma nova gravação; alterações em `painel/` não.

O servidor envia `Cache-Control: no-store` para HTML, JavaScript, imagens e respostas de controle. Mudanças em `painel/` entram após F5; mudanças em `notebook_server.py` exigem reiniciar o processo Python.

## Registrar um teste

Na página, **Salvar print** baixa um ZIP com o JPEG original, um PNG com a imagem corrigida e a marcação da detecção, e os metadados do quadro em JSON. Ao clicar em **Encerrar gravação**, o vídeo e a coleta de quadros param imediatamente. Antes de baixar o ZIP, a página exige uma nota e uma descrição do resultado; a indicação de intervenção manual é opcional. O pacote inclui o vídeo anotado e os metadados de cada quadro, como posição da linha, desvio, direção calculada, PWM de cada roda e tempos de captura/comando. O vídeo e os metadados ficam no notebook; a ESP32 não armazena a gravação.

Para analisar uma falha, envie o ZIP correspondente. Os metadados incluem o ID da imagem, a trajetória detectada, o comando aplicado, a duração do pulso, sua confirmação e o perfil de visão. O painel local também grava `painel: "notebook"`.

## Ajustes

As configurações físicas ficam no início de `carrinho.ino`:

- `AP_SSID` e `AP_PASSWORD`: nome e senha do Wi-Fi
- `ENA`, `IN1`, `IN3` e `ENB`: GPIOs do L298N
- `COMMAND_TIMEOUT_MS`: tempo sem comandos antes de encerrar a sessão
- `PULSE_MIN_MS`, `PULSE_MAX_MS`, `FRAME_MAX_AGE_MS` e `MAX_PWM`: limites aceitos pela placa. O firmware aceita PWM até 255 e pulsos de 60 a 260 ms; a barra seleciona velocidade base de 130 a 200. PARAR ou uma falha segura aplica 0. Nas curvas fechadas, uma saída pode receber PWM 0 durante um pulso curto.
- `CAMERA_FRAME_SIZE`, `CAMERA_JPEG_QUALITY` e `CAMERA_FRAME_BUFFERS`: resolução, qualidade JPEG e quantidade de buffers.
- `CAM_PWDN` até `CAM_PCLK`: pinos da câmera AI-Thinker.

A câmera está configurada em 160 x 120 pixels (QQVGA), JPEG qualidade 25 e um buffer. O programa tenta usar tons de cinza; se o sensor não aceitar, a detecção no navegador ainda converte a imagem para cinza.

## Detecção da linha

O JavaScript procura a fita em faixas horizontais da imagem 160 x 120, desde a linha 108 até a 24. No interior da imagem, cada trecho precisa ser mais escuro que o piso dos dois lados; na borda, aceita contraste do lado que ainda está visível. O navegador liga trechos próximos em uma trajetória, usa a posição encontrada no quadro anterior para escolher entre trajetórias e desenha os pontos ligados em verde sobre a imagem. Quando a fita só aparece lateralmente, usa um pulso curto de giro para tentar recolocá-la no centro.

Antes da detecção, o navegador espelha a imagem horizontalmente para corrigir a orientação da câmera. A imagem mostrada na página e os comandos usam essa mesma orientação. No painel local, o ajuste está em `MIRROR_CAMERA_IMAGE` dentro de `painel/app.js`.

O controle dá mais peso à fita perto do carrinho e usa a direção adiante para uma pequena correção. Há uma zona central de 5 pixels; em curva suave, a diferença entre as saídas é limitada a 20 PWM. Na reta, ambas recebem o valor escolhido na barra; em curvas fechadas, uma pode receber 0 e a outra até 200. A inversão das saídas fica em `SWAP_STEERING_OUTPUTS` no `painel/algoritmo.js`. Cada novo pulso depende de uma imagem atual e da confirmação do anterior. Sem fita confiável ou imagem nova, os motores param. O flash permanece apagado.

O firmware e o painel usam controle por pulsos. Não há uma cópia alternativa de controle contínuo no repositório.

Para verificar o firmware, compile `carrinho.ino` para AI‑Thinker ESP32‑CAM. A compilação não substitui um teste físico na pista.

Para compensar a posição da câmera, pare o carrinho em um trecho reto com a roda dianteira alinhada à fita e clique em **Calibrar centro**. A posição da fita nessa imagem passa a ser o centro usado pelo navegador; ela fica salva neste navegador.
