# Carrinho seguidor de linha - Redes

## Funcionamento

O ESP32-CAM cria uma rede Wi-Fi à qual o notebook se conecta. A placa transmite as imagens da câmera; o navegador do notebook processa o vídeo e envia o comando para seguir em frente, virar à direita, virar à esquerda ou parar.

A comunicação usa HTTP sobre TCP. A página mostra o vídeo, a ação calculada, os valores enviados às rodas, o tamanho do quadro, os quadros por segundo e os tempos de captura e comando. O tempo de captura inclui a transferência e a decodificação da imagem, não apenas a latência da rede.

O HTML e o JavaScript estão dentro de [`carrinho.ino`](carrinho.ino) e são servidos pela ESP32. O processamento acontece no navegador; não é preciso instalar Python nem executar um servidor no notebook.

## Como utilizar

1. No Arduino IDE, selecione **AI-Thinker ESP32-CAM** e o Arduino ESP32 Core **3.x**.
2. Grave [`carrinho.ino`](carrinho.ino) na placa.
3. Conecte o notebook à rede Wi-Fi `Carrinho-CAM` (senha inicial: `carrinho123`).
4. Abra `http://192.168.4.1/` no navegador para ver o vídeo.

O IP também aparece no Monitor Serial em **115200 baud**. A rede da placa não precisa ter acesso à internet.

## Ajustes

As configurações principais ficam no início de `carrinho.ino`:

- `AP_SSID` e `AP_PASSWORD`: nome e senha do Wi-Fi.
- `velocidade`: valor inicial do controle no painel, de `0` a `255`. Também pode ser alterado pelo seletor da página.
- `ENA`, `IN1`, `IN3` e `ENB`: GPIOs do L298N. Deixe em `-1` para testar só câmera e conexão; preencha com os GPIOs usados na montagem para movimentar o carrinho.
- `COMMAND_TIMEOUT_MS`: tempo sem comandos antes de zerar o PWM.
- `CAMERA_FRAME_SIZE`, `CAMERA_JPEG_QUALITY` e `CAMERA_FRAME_BUFFERS`: resolução, qualidade JPEG e quantidade de buffers.
- `CAM_PWDN` até `CAM_PCLK`: pinos da câmera AI-Thinker.

A câmera está configurada em 160 × 120 pixels (QQVGA), JPEG qualidade 25 e um buffer. O programa tenta usar tons de cinza; se o sensor não aceitar, a detecção no navegador ainda converte a imagem para cinza.

## Detecção da linha

O JavaScript converte os pixels para escala de cinza, usa o limiar de Otsu para separar regiões escuras e claras e procura o maior grupo conectado de pixels escuros na parte inferior do quadro. O centro desse grupo determina a direção e a correção dos motores.
