import {LINE_NEAR_ROW,LINE_FAR_ROW,SWAP_STEERING_OUTPUTS,FOLLOW,findLine,FollowPlanner,setTargetNearX,resetVisionMemory} from './algoritmo.js';

const canvas=document.querySelector('#video'),ctx=canvas.getContext('2d',{willReadFrequently:true});
const speed=document.querySelector('#speed');
speed.value=String(FOLLOW.minPwm); // Recarregar o JS nunca retoma o movimento automaticamente.
let driveEnabled=false;
const startButton=document.querySelector('#startNow'),driveState=document.querySelector('#driveState');
function commandedSpeed(){return driveEnabled?Number(speed.value):0}
const MIRROR_CAMERA_IMAGE=true;
const VISION_PROFILE='centro-borda';
const CAMERA_PROFILE='camera-baixa';
const CALIBRATION_KEY=`carrinho.targetNearX.${CAMERA_PROFILE}`;
let active=true,frames=0,lastFpsTime=performance.now(),currentFps=0;
let controlToken=0,stepSequence=0,controlEpoch=0;
let targetNearX=80,calibrated=false;
try{
 const saved=localStorage.getItem(CALIBRATION_KEY)??Object.keys(localStorage)
  .filter(key=>key.startsWith(`${CALIBRATION_KEY}-`))
  .map(key=>localStorage.getItem(key))
  .find(value=>Number.isFinite(Number(value))&&Number(value)>=4&&Number(value)<=156);
 const stored=Number(saved);
 if(saved!==null&&Number.isFinite(stored)&&stored>=4&&stored<=156){
  targetNearX=stored;calibrated=true;
  if(localStorage.getItem(CALIBRATION_KEY)===null)localStorage.setItem(CALIBRATION_KEY,saved);
 }
}catch(_){}
setTargetNearX(targetNearX);
speed.disabled=!calibrated;
if(!calibrated)document.querySelector('#speedNote').textContent='Câmera reposicionada: pare, alinhe a roda dianteira na fita reta e clique em Calibrar centro antes de iniciar.';
else document.querySelector('#speedNote').textContent=`Centro salvo neste navegador: x=${targetNearX.toFixed(1)}. Se a câmera mudou, pare e recalibre.`;
let totalFrames=0,lastFrame=null,lastCapturedFrameId=0,recorder=null,recordedChunks=[],recordedFrames=[],recordingStartedAt=0,recordingStartedIso='',recordingName='',pendingRecording=null;
const recordButton=document.querySelector('#record'),snapshotButton=document.querySelector('#snapshot'),captureStatus=document.querySelector('#captureStatus');
const feedbackDialog=document.querySelector('#feedbackDialog'),feedbackForm=document.querySelector('#feedbackForm');
const calibrateButton=document.querySelector('#calibrate');
const motorTestButton=document.querySelector('#motorTest'),motorTestStatus=document.querySelector('#motorTestStatus');
let motorTestRunning=false,motorTestIndex=0;
const motorTestSteps=[];
for(const side of ['Esquerda','Direita'])for(const pwm of [90,100,110,120,130])for(let repeat=1;repeat<=3;repeat++)
 motorTestSteps.push({action:`teste ${side.toLowerCase()} ${pwm} (${repeat}/3)`,left:side==='Esquerda'?pwm:0,right:side==='Direita'?pwm:0,duration:120,amount:pwm});
for(let repeat=1;repeat<=3;repeat++)motorTestSteps.push({action:`teste ambas 130 (${repeat}/3)`,left:130,right:130,duration:120,amount:130});
function updateDriveUi(){driveState.textContent=motorTestRunning?'Teste de motores em andamento':driveEnabled?'Seguindo linha':'Parado · PWM 0';startButton.disabled=!calibrated||driveEnabled||motorTestRunning;calibrateButton.disabled=driveEnabled||motorTestRunning||!lastFrame?.metadata.linha_detectada;updateMotorTestButton()}
function updateMotorTestButton(){motorTestButton.disabled=!motorTestRunning&&driveEnabled;motorTestButton.textContent=motorTestRunning?'Parar teste':'Testar motores'}
async function stopMotorTest(message='Teste interrompido.'){motorTestRunning=false;motorTestIndex=0;motorTestStatus.textContent=message;updateDriveUi();await stopMotors()}
motorTestButton.addEventListener('click',async()=>{
 if(motorTestRunning){await stopMotorTest();return}
 if(driveEnabled){motorTestStatus.textContent='Pare o carrinho antes do teste.';return}
 if(!window.confirm('Suspenda e apoie o carrinho com as duas rodas motrizes livres. As rodas podem girar. Iniciar o teste?'))return;
 motorTestIndex=0;motorTestRunning=true;motorTestStatus.textContent='Preparando teste...';updateDriveUi();
});
speed.addEventListener('input',()=>{document.querySelector('#speedValue').textContent=speed.value;updateDriveUi()});
startButton.addEventListener('click',()=>{if(!calibrated||driveEnabled||motorTestRunning)return;
 driveEnabled=true;document.querySelector('#error').textContent='';resetVisionMemory();updateDriveUi()});
document.querySelector('#stopNow').addEventListener('click',()=>{
 driveEnabled=false;motorTestRunning=false;motorTestIndex=0;motorTestStatus.textContent='Parado pelo usuário.';
 resetVisionMemory();updateDriveUi();stopMotors();
});
calibrateButton.addEventListener('click',()=>{const data=lastFrame?.metadata;
 if(driveEnabled||motorTestRunning||!data?.linha_detectada)return;
 if(Math.abs(data.linha_x-data.linha_adiante_x)>10){captureStatus.textContent='Calibre em um trecho reto da fita';return}
 targetNearX=data.linha_x;setTargetNearX(targetNearX);calibrated=true;speed.disabled=false;
 try{localStorage.setItem(CALIBRATION_KEY,String(targetNearX))}catch(_){}
 document.querySelector('#speedNote').textContent=`Centro calibrado em x=${targetNearX.toFixed(1)}. A mira prioriza a fita próxima; giro fechado exige desvio próximo significativo.`;
 captureStatus.textContent=`Centro calibrado em x=${targetNearX.toFixed(1)}`;updateDriveUi()});

const planner=new FollowPlanner();

function annotate(line,cmd){const w=canvas.width,h=canvas.height;ctx.strokeStyle='#a0a0a0';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(targetNearX,0);ctx.lineTo(targetNearX,h);ctx.moveTo(0,LINE_NEAR_ROW);ctx.lineTo(w,LINE_NEAR_ROW);ctx.moveTo(0,LINE_FAR_ROW);ctx.lineTo(w,LINE_FAR_ROW);ctx.stroke();
 ctx.fillStyle='rgba(255,175,85,.65)';for(const p of line.candidates)ctx.fillRect(p.x-1,p.y-1,2,2);
 if(line.found||line.partial||line.points.length){ctx.strokeStyle=line.found?'#25ff9b':'#ffd05d';ctx.fillStyle=ctx.strokeStyle;ctx.lineWidth=2;ctx.beginPath();
  line.points.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.stroke();
  for(const p of line.points){ctx.beginPath();ctx.arc(p.x,p.y,2,0,Math.PI*2);ctx.fill()}
  if(line.found){ctx.strokeStyle='#7dccff';ctx.beginPath();
   for(let i=0;i<=16;i++){const t=i/16,x=line.curve[0]+line.curve[1]*t+(line.curve[2]??0)*t*t,y=line.y+(line.farY-line.y)*t;
    if(i)ctx.lineTo(x,y);else ctx.moveTo(x,y)}ctx.stroke();
   ctx.fillStyle='#7dccff';ctx.beginPath();ctx.arc(line.farX,line.farY,3,0,Math.PI*2);ctx.fill()}}
 ctx.fillStyle='rgba(0,0,0,.8)';ctx.fillRect(0,0,w,20);ctx.fillStyle='white';ctx.font='12px sans-serif';ctx.fillText(`${cmd.action.toUpperCase()}  ajuste ${cmd.amount}  L ${cmd.left} R ${cmd.right}`,5,14)}

function fileStamp(){return new Date().toISOString().replace(/[:.]/g,'-')}
function saveBlob(blob,name){const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=name;document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000)}
function jsonBlob(value){return new Blob([JSON.stringify(value,null,2)],{type:'application/json'})}

function crc32(bytes){let crc=0xffffffff;
 for(const byte of bytes){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0)}
 return(crc^0xffffffff)>>>0}

async function zipFiles(files){const encoder=new TextEncoder(),parts=[],directory=[];let offset=0;
 for(const file of files){const name=encoder.encode(file.name),data=new Uint8Array(await file.blob.arrayBuffer()),crc=crc32(data);
  const local=new Uint8Array(30+name.length),lv=new DataView(local.buffer);
  lv.setUint32(0,0x04034b50,true);lv.setUint16(4,20,true);lv.setUint32(14,crc,true);lv.setUint32(18,data.length,true);lv.setUint32(22,data.length,true);lv.setUint16(26,name.length,true);local.set(name,30);
  const central=new Uint8Array(46+name.length),cv=new DataView(central.buffer);
  cv.setUint32(0,0x02014b50,true);cv.setUint16(4,20,true);cv.setUint16(6,20,true);cv.setUint32(16,crc,true);cv.setUint32(20,data.length,true);cv.setUint32(24,data.length,true);cv.setUint16(28,name.length,true);cv.setUint32(42,offset,true);central.set(name,46);
  parts.push(local,data);directory.push(central);offset+=local.length+data.length}
 const directoryStart=offset;for(const entry of directory)offset+=entry.length;
 const end=new Uint8Array(22),ev=new DataView(end.buffer);ev.setUint32(0,0x06054b50,true);ev.setUint16(8,files.length,true);ev.setUint16(10,files.length,true);ev.setUint32(12,offset-directoryStart,true);ev.setUint32(16,directoryStart,true);
 return new Blob([...parts,...directory,end],{type:'application/zip'})}

snapshotButton.addEventListener('click',async()=>{if(!lastFrame)return;
 snapshotButton.disabled=true;captureStatus.textContent='Preparando print...';
 try{const selected=lastFrame,name=`print-${fileStamp()}-frame-${selected.metadata.quadro}`;
  const annotated=await new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(Error('falha ao criar o print')),'image/png'));
  const zip=await zipFiles([{name:'imagem.jpg',blob:selected.image},{name:'analise.png',blob:annotated},{name:'metadados.json',blob:jsonBlob(selected.metadata)}]);
  saveBlob(zip,`${name}.zip`);captureStatus.textContent=`Print salvo: quadro ${selected.metadata.quadro}`}
 catch(error){captureStatus.textContent=`Erro ao salvar print: ${error}`}
 finally{snapshotButton.disabled=false}});

recordButton.addEventListener('click',()=>{if(recorder&&recorder.state==='recording'){recordButton.disabled=true;recordButton.textContent='Encerrando...';captureStatus.textContent='Parando e fechando a gravação...';recorder.stop();return}
 if(pendingRecording)return;
 if(!canvas.captureStream||!window.MediaRecorder){captureStatus.textContent='Este navegador não permite gravar o canvas';return}
 const mime=['video/webm;codecs=vp9','video/webm;codecs=vp8','video/webm','video/mp4'].find(type=>MediaRecorder.isTypeSupported(type));
 if(!mime){captureStatus.textContent='Este navegador não oferece gravação de vídeo';return}
 let stream;
 try{stream=canvas.captureStream(12);recorder=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:350000});recorder.start(1000)}
 catch(error){if(stream)stream.getTracks().forEach(track=>track.stop());recorder=null;captureStatus.textContent=`Erro ao iniciar gravação: ${error}`;return}
 recordedChunks=[];recordedFrames=[];recordingStartedAt=performance.now();recordingStartedIso=new Date().toISOString();recordingName=`gravacao-${fileStamp()}`;
 recordButton.textContent='Encerrar gravação';captureStatus.textContent='Gravando...';
 recorder.ondataavailable=event=>{if(event.data.size)recordedChunks.push(event.data)};
 recorder.onstop=()=>{stream.getTracks().forEach(track=>track.stop());
  const video=new Blob(recordedChunks,{type:mime});
  if(!video.size){captureStatus.textContent='Erro: o vídeo ficou vazio';resetRecording();return}
  // Snapshot the completed run before asking anything; no frames are added while feedback is open.
  pendingRecording={video,mime,frames:recordedFrames.slice(),startedIso:recordingStartedIso,
   endedIso:new Date().toISOString(),durationMs:Math.round(performance.now()-recordingStartedAt),name:recordingName};
  recorder=null;recordedChunks=[];recordedFrames=[];recordButton.textContent='Gravação encerrada';
  captureStatus.textContent='Gravação encerrada. Avalie a run para salvar o ZIP.';
  feedbackForm.reset();feedbackDialog.showModal();document.querySelector('#runRating').focus()};
 recorder.onerror=event=>{captureStatus.textContent=`Erro na gravação: ${event.error||'desconhecido'}`}});

function resetRecording(){pendingRecording=null;recorder=null;recordedChunks=[];recordedFrames=[];recordButton.disabled=false;recordButton.textContent='Iniciar gravação'}
feedbackDialog.addEventListener('cancel',event=>event.preventDefault());
feedbackForm.addEventListener('submit',async event=>{event.preventDefault();const note=document.querySelector('#runNote');
 note.setCustomValidity(note.value.trim()?'':'Descreva brevemente o resultado (ou escreva “sem problemas”).');
 if(!pendingRecording||!feedbackForm.reportValidity())return;
 const run=pendingRecording,submit=feedbackForm.querySelector('button[type="submit"]');submit.disabled=true;captureStatus.textContent='Salvando vídeo e metadados...';
 try{const found=run.frames.filter(f=>f.linha_detectada),confirmed=run.frames.filter(f=>f.comando_confirmado);
  const metadata={inicio:run.startedIso,fim:run.endedIso,duracao_ms:run.durationMs,
   avaliacao_usuario:{nota:Number(document.querySelector('#runRating').value),descricao:document.querySelector('#runNote').value.trim(),
    intervencao_manual:document.querySelector('#runAssisted').checked},
   resumo_automatico:{perfil_visao:VISION_PROFILE,quadros:run.frames.length,linha_detectada:found.length,
    linha_lateral:found.filter(f=>f.linha_parcial).length,comandos_confirmados:confirmed.length,
    pwm_bases:[...new Set(run.frames.map(f=>f.velocidade_base).filter(Number.isFinite))]},quadros:run.frames};
  const extension=run.mime.includes('mp4')?'mp4':'webm';
  const zip=await zipFiles([{name:`video.${extension}`,blob:run.video},{name:'metadados.json',blob:jsonBlob(metadata)}]);
  saveBlob(zip,`${run.name}.zip`);feedbackDialog.close();captureStatus.textContent=`Gravação salva: ${run.frames.length} quadros`;resetRecording();feedbackForm.reset()
 }catch(error){captureStatus.textContent=`Erro ao salvar gravação: ${error}`}
 finally{submit.disabled=false}});

let lastTransportFault=null,stepConflictRetries=0;
const STEP_POST_TIMEOUT_MS=850,STEP_STATUS_TIMEOUT_MS=850;
async function requestControl(url,method='GET',timeout=500){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout);
 try{return await fetch(url,{method,cache:'no-store',signal:controller.signal})}
 catch(error){if(error.name==='AbortError')throw Error(`TIMEOUT navegador: ${method} ${url.split('?')[0]} excedeu ${timeout} ms`);throw Error(`FALHA navegador: ${method} ${url.split('?')[0]}: ${error.message}`)}
 finally{clearTimeout(timer)}}
async function httpError(response,label){const detail=(await response.text()).trim();return Error(`${label} HTTP ${response.status}${detail?`: ${detail}`:''}`)}
let stopInFlight=Promise.resolve();
async function stopMotors(){controlEpoch++;controlToken=0;stepSequence=0;
 stepConflictRetries=0;
 stopInFlight=stopInFlight.then(()=>requestControl('/stop','POST',500)).catch(()=>{});await stopInFlight}
async function ensureArmed(epoch){if(controlToken)return;
 await stopInFlight;if(epoch!==controlEpoch)throw Error('início cancelado');
 const response=await requestControl('/arm','POST',500);if(!response.ok)throw await httpError(response,'Armar motores');
 const state=await response.json();if(!state.token||!state.motors_enabled)throw Error('motores indisponíveis');
 if(epoch!==controlEpoch||(!driveEnabled&&!motorTestRunning)){await stopMotors();throw Error('início cancelado')}
 controlToken=state.token;stepSequence=0}
async function sendPulse(cmd,frameId,epoch){await ensureArmed(epoch);
 if(epoch!==controlEpoch)throw Error('pulso cancelado');
 const seq=++stepSequence,token=controlToken;
 const query=`?token=${token}&seq=${seq}&frame=${frameId}&left=${cmd.left}&right=${cmd.right}&duration=${cmd.duration}`;
 const started=performance.now();let response=null;
 try{response=await requestControl('/step'+query,'POST',STEP_POST_TIMEOUT_MS)}
 catch(error){
  // O POST pode ter sido aplicado mesmo sem resposta. Nunca o envie novamente.
  if(!error.message.startsWith('TIMEOUT navegador: POST /step '))throw error;
 }
 if(response){
  if(!response.ok){const error=await httpError(response,'Pulso rejeitado');error.retryableStepConflict=response.status===409;throw error}
  const accepted=await response.json();if(!accepted.accepted||accepted.seq!==seq)throw Error('pulso sem confirmação');
  await new Promise(resolve=>setTimeout(resolve,cmd.duration+15));
 }
 for(let attempt=0;attempt<4;attempt++){
  if(epoch!==controlEpoch)throw Error('pulso cancelado');
  const status=await requestControl(`/step-status?token=${token}&seq=${seq}`,'GET',STEP_STATUS_TIMEOUT_MS);
  if(!status.ok)throw await httpError(status,'Confirmação do pulso');
  const result=await status.json();if(result.seq!==seq)throw Error('sequência de pulso diferente');
  if(epoch!==controlEpoch)throw Error('pulso cancelado');
  if(result.done)return{...result,elapsed:performance.now()-started,postResponseTimedOut:!response};
  await new Promise(resolve=>setTimeout(resolve,25))}
 throw Error('pulso não terminou no prazo')}
async function loop(){if(!active)return;let started=performance.now(),frameMetadata=null;
 try{const response=await requestControl('/capture?t='+Date.now(),'GET',2300);if(!response.ok)throw await httpError(response,'Câmera');
  const frameId=Number(response.headers.get('X-Frame-Id'));
  if(!Number.isSafeInteger(frameId)||frameId<=0)throw Error('imagem sem identificação');
  if(lastCapturedFrameId&&frameId<lastCapturedFrameId){const previous=lastCapturedFrameId;lastCapturedFrameId=frameId;throw Error(`ESP32 reiniciou: imagem ${previous} → ${frameId}`)}
  lastCapturedFrameId=frameId;
  const blob=await response.blob(),bitmap=await createImageBitmap(blob),cameraMs=performance.now()-started;canvas.width=bitmap.width;canvas.height=bitmap.height;
  if(MIRROR_CAMERA_IMAGE){ctx.save();ctx.translate(canvas.width,0);ctx.scale(-1,1)}
  ctx.drawImage(bitmap,0,0);if(MIRROR_CAMERA_IMAGE)ctx.restore();bitmap.close();
  const line=findLine(ctx.getImageData(0,0,canvas.width,canvas.height));
  const decision=motorTestRunning
   ?{command:{...motorTestSteps[motorTestIndex],sourceFrame:frameId},state:'teste'}
   :planner.observe(line,commandedSpeed(),frameId),cmd=decision.command;
  annotate(line,cmd);
  const renderedAt=performance.now(),isRecording=recorder&&recorder.state==='recording';
  frameMetadata={quadro:++totalFrames,id_imagem:frameId,perfil_visao:VISION_PROFILE,painel:'notebook',perfil_camera:CAMERA_PROFILE,centro_calibrado_x:targetNearX,
   instante:new Date().toISOString(),tempo_video_ms:isRecording?Math.round(renderedAt-recordingStartedAt):null,
   espelhamento_horizontal:MIRROR_CAMERA_IMAGE,
   largura:canvas.width,altura:canvas.height,jpeg_bytes:blob.size,captura_ms:Math.round(cameraMs),
   linha_detectada:line.found,linha_parcial:!!line.partial,linha_cortada_na_borda:!!line.edgeClipped,linha_ambigua:!!line.ambiguous,
   confianca_linha:Number(line.confidence.toFixed(3)),motivo_visao:line.reason,
   limiar_preto:line.threshold,contraste_pista:Number(line.lightingContrast.toFixed(1)),
   residuos_trajeto:line.residual===undefined?null:Number(line.residual.toFixed(2)),candidatos_linha:line.candidates.length,
   linha_x:line.found?Number(line.x.toFixed(2)):null,linha_y:line.found?line.y:null,
   linha_mira_x:line.found?Number(line.lookX.toFixed(2)):null,
   linha_adiante_x:line.found&&line.farX!==null?Number(line.farX.toFixed(2)):null,
   linha_adiante_y:line.found?line.farY:null,
   pontos_trajeto:line.points.map(p=>[p.x,p.y]),
   largura_linha:line.found?line.nearWidth:null,
   desvio:line.found?Number(line.offset.toFixed(3)):null,erro_pixels:line.found?Number(line.error.toFixed(2)):null,
   inclinacao_pixels:line.found?Number(line.heading.toFixed(2)):null,
   erro_controle_pixels:cmd.controlError,tolerancia_centro_pixels:cmd.nearTolerance??null,
   alvo_seguimento_x:cmd.targetX??null,peso_antecipacao:cmd.lookWeight??null,
   pwm_minimo_automatico:FOLLOW.minPwm,velocidade_base:commandedSpeed(),velocidade_selecionada:Number(speed.value),direcao:cmd.action,
   velocidade_efetiva:cmd.cruise??0,deslocamento_linha_pixels:cmd.drift??null,
   ajuste_pwm:cmd.amount,roda_esquerda_pwm:cmd.left,roda_direita_pwm:cmd.right,duracao_pulso_ms:cmd.duration,
   fila_estado:decision.state,modo_curva:cmd.mode??null,
   direcao_automatica_invertida:SWAP_STEERING_OUTPUTS,origem_comando_quadro:cmd.sourceFrame,
   comando_ms:null,motores_ativos:null,comando_confirmado:false};
  lastFrame={image:blob,metadata:frameMetadata};snapshotButton.disabled=false;
  updateDriveUi();
  if(isRecording){recordedFrames.push(frameMetadata);captureStatus.textContent=`Gravando: ${recordedFrames.length} quadros`}
  else if(totalFrames===1)captureStatus.textContent='Pronto para print';
  const epoch=controlEpoch,commandStart=performance.now();let result={motors_enabled:false},commandMs=0,armedForNextFrame=false;
  if(cmd.duration>0){
   // Armar depois da captura envelhece o quadro antes de /step (limite: 250 ms).
   // Descarta este comando e observa um novo quadro já com a sessão armada.
   if(!controlToken){await ensureArmed(epoch);armedForNextFrame=true;result.motors_enabled=true}
   else{result=await sendPulse(cmd,frameId,epoch);stepConflictRetries=0;commandMs=performance.now()-commandStart;
   frameMetadata.comando_ms=Math.round(commandMs);frameMetadata.motores_ativos=result.motors_enabled;frameMetadata.comando_confirmado=result.done;
   if(motorTestRunning){motorTestIndex++;
    if(motorTestIndex>=motorTestSteps.length){motorTestRunning=false;motorTestStatus.textContent='Teste concluído: confira em quais PWM cada roda girou nas três tentativas. A etapa final testou as duas juntas em 130.';updateDriveUi();await stopMotors()}
    else motorTestStatus.textContent=`${motorTestSteps[motorTestIndex].action} · ${motorTestIndex}/${motorTestSteps.length} pulsos concluídos`;
   }}}
  else if(controlToken)await stopMotors();
  document.querySelector('#connection').textContent='Conectada';document.querySelector('#action').textContent=armedForNextFrame?'Preparando':cmd.action;
  document.querySelector('#planState').textContent=armedForNextFrame?'Sessão armada; aguardando imagem nova':`Comando: ${decision.state} · ${cmd.action} ${cmd.left}/${cmd.right}`;
  document.querySelector('#visionState').textContent=`Visão: ${line.reason} · confiança ${Math.round(line.confidence*100)}% · limiar ${line.threshold} · ${line.candidates.length} candidatos`;
  document.querySelector('#amount').textContent=`${armedForNextFrame?0:cmd.amount} PWM`;document.querySelector('#left').textContent=`${armedForNextFrame?0:cmd.left} / 255`;document.querySelector('#right').textContent=`${armedForNextFrame?0:cmd.right} / 255`;
  document.querySelector('#motorState').textContent=result.motors_enabled?'Configurados':'Desativados (pinos)';document.querySelector('#frameBytes').textContent=`${blob.size} bytes`;
  document.querySelector('#latency').textContent=`${cameraMs.toFixed(0)} ms`;document.querySelector('#commandLatency').textContent=`${commandMs.toFixed(0)} ms`;
  frames++;let now=performance.now();if(now-lastFpsTime>=1000){currentFps=frames*1000/(now-lastFpsTime);frames=0;lastFpsTime=now}document.querySelector('#fps').textContent=currentFps.toFixed(1);
  if(!lastTransportFault)document.querySelector('#error').textContent='';
 }catch(error){if(frameMetadata)frameMetadata.erro=String(error);else if(recorder&&recorder.state==='recording')recordedFrames.push({instante:new Date().toISOString(),tempo_video_ms:Math.round(performance.now()-recordingStartedAt),erro:String(error)});
  const cancelledTest=!motorTestRunning&&(error.message==='pulso cancelado'||error.message==='início cancelado');
  if(motorTestRunning){motorTestRunning=false;motorTestIndex=0;motorTestStatus.textContent=`Teste encerrado por falha: ${error.message}`;updateDriveUi()}
  if(cancelledTest){document.querySelector('#action').textContent='Teste parado';document.querySelector('#planState').textContent='Fila parada pelo usuário';document.querySelector('#left').textContent='0 / 255';document.querySelector('#right').textContent='0 / 255';document.querySelector('#error').textContent=''}
  else if(error.retryableStepConflict&&stepConflictRetries<1&&controlToken&&driveEnabled){
   // /step devolveu 409 antes de ligar as rodas. Uma imagem nova pode resolver
   // quadro antigo ou intervalo curto; a segunda recusa para o carrinho.
   stepConflictRetries++;stepSequence--;
   document.querySelector('#planState').textContent='Pulso recusado; buscando imagem nova (1 tentativa)';
   document.querySelector('#left').textContent='0 / 255';document.querySelector('#right').textContent='0 / 255';
  }else{const conflict=error.message.includes('HTTP 409');
   const source=error.message.startsWith('ESP32 reiniciou')?'reinício detectado da ESP32':error.message.startsWith('TIMEOUT navegador')?'requisição sem resposta no prazo':error.message.startsWith('FALHA navegador')?'falha entre navegador e servidor local':error.message.includes('HTTP 502')?'servidor local não alcançou a ESP32':error.message.includes('HTTP 503')?'ESP32/câmera indisponível':error.message.includes('HTTP 409')?'ESP32 recusou pulso (sequência, frame ou outro controle)':'resposta inesperada';
   lastTransportFault={at:new Date().toISOString(),source,error:String(error),speedBeforeStop:commandedSpeed(),frame:lastFrame?.metadata?.id_imagem??null};
   document.querySelector('#connection').textContent=conflict?'Comando recusado':'Falha — parado';document.querySelector('#action').textContent='PARADO';document.querySelector('#planState').textContent=`Falha segura: ${source}; rearme manual necessário`;
   document.querySelector('#left').textContent='0 / 255';document.querySelector('#right').textContent='0 / 255';
   motorTestRunning=false;motorTestIndex=0;driveEnabled=false;updateDriveUi();resetVisionMemory();
   document.querySelector('#error').textContent=`${source}: ${error.message}. PWM zerado; clique INICIAR para retomar.`;
   await stopMotors();await new Promise(resolve=>setTimeout(resolve,400))}}
 if(active)setTimeout(loop,30)}
window.addEventListener('pagehide',()=>{active=false;controlEpoch++;controlToken=0;navigator.sendBeacon('/stop','')});
async function startWhenReady(){
 if(!active)return;
 try{
  const response=await requestControl('/status','GET',2300);
  if(!response.ok)throw Error(response.status===404?'Grave o carrinho.ino atual na ESP32.':'Estado da ESP32: HTTP '+response.status);
  const status=await response.json();
  if(status.max_pwm<FOLLOW.maxPwm||
     status.pulse_min_ms>60||status.pulse_max_ms<120)
   throw Error('Firmware sem suporte aos pulsos configurados pelo painel. Grave carrinho.ino atualizado.');
  if(!status.camera_ready||!status.motors_enabled)
   throw Error('ESP32 iniciou sem câmera ou motores. Confira o Monitor Serial.');
  if(active)loop();
 }catch(error){
  if(!active)return;
  document.querySelector('#connection').textContent='Aguardando ESP32';
  document.querySelector('#error').textContent=String(error);
  setTimeout(startWhenReady,1000);
 }
}
updateDriveUi();startWhenReady();

async function refreshDiagnostics(){
 const output=document.querySelector('#diagnosticOutput');output.textContent='Consultando servidor local e ESP32…';
 const parts=[];
 try{const r=await fetch('/diagnostico',{cache:'no-store'});parts.push('SERVIDOR DO NOTEBOOK\n'+(r.ok?JSON.stringify(await r.json(),null,2):`HTTP ${r.status}`))}
 catch(e){parts.push('SERVIDOR DO NOTEBOOK\n'+e.message)}
 try{const r=await fetch('/status',{cache:'no-store',signal:AbortSignal.timeout(1800)});if(r.ok){const state=await r.json(),resetNames={0:'desconhecido',1:'ligação inicial',2:'reset externo',3:'reset por software',4:'panic/exceção',5:'watchdog de interrupção',6:'watchdog de tarefa',7:'watchdog',8:'retorno do deep sleep',9:'brownout/queda de tensão',10:'reset SDIO'};parts.push('ESP32\n'+JSON.stringify({...state,reset_interpretado:state.reset_reason===undefined?'firmware original: motivo do reset não disponível':resetNames[state.reset_reason]||'código '+state.reset_reason},null,2))}else parts.push(`ESP32\nHTTP ${r.status}: ${await r.text()}`)}
 catch(e){parts.push('ESP32\nSem resposta: '+e.message)}
 if(lastTransportFault)parts.push('ÚLTIMA FALHA NO PAINEL\n'+JSON.stringify(lastTransportFault,null,2));
 output.textContent=parts.join('\n\n');
}
document.querySelector('#refreshDiagnostics').addEventListener('click',refreshDiagnostics);
