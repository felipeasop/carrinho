// Detecção e planejamento do movimento. O estado da linha fica isolado do painel.
export const LINE_NEAR_ROW=108,LINE_FAR_ROW=24;
// A direcao calculada precisa ser invertida para corresponder aos motores reais.
export const SWAP_STEERING_OUTPUTS=true;
export const FOLLOW=Object.freeze({minPwm:130,maxPwm:200,centerTolerance:5,
 lookWeightStraight:.20,lookWeightCurve:.40,curveSpan:35,
 gentleDifference:20,sharpNearError:28,sharpMinPwm:160,edgeX:24});
const VISION=Object.freeze({minLocalContrast:18,minConfidence:.62,maxResidual:8,lookAhead:.88});
let targetNearX=80,lastNearX=null;
export function setTargetNearX(x){targetNearX=x}
export function resetVisionMemory(){lastNearX=null}

const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
function median(values){const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.floor(sorted.length/2)]}

// O limiar acompanha a luz da area da pista; o contraste local valida a fita.
function adaptiveBlackThreshold(image,top,bottom){const hist=new Uint32Array(256),data=image.data,w=image.width;
 let total=0,sum=0;
 for(let y=top;y<=bottom;y+=2)for(let x=2;x<w-2;x+=2){const p=(y*w+x)*4,g=(77*data[p]+150*data[p+1]+29*data[p+2])>>8;hist[g]++;total++;sum+=g}
 let darkCount=0,darkSum=0,best=-1,level=120,darkMean=0,lightMean=0;
 for(let t=0;t<255;t++){darkCount+=hist[t];darkSum+=t*hist[t];const lightCount=total-darkCount;
  if(!darkCount||!lightCount)continue;
  const a=darkSum/darkCount,b=(sum-darkSum)/lightCount,score=darkCount*lightCount*(a-b)*(a-b);
  if(score>best){best=score;level=t;darkMean=a;lightMean=b}}
 const contrast=Math.max(0,lightMean-darkMean);
 return{level:clamp(Math.round(level+clamp(contrast*.15,10,25)),0,230),contrast}}

// A fita no interior pede piso claro dos dois lados; na borda so ha um lado visivel.
function rowCandidates(image,y,threshold){const w=image.width,data=image.data,profile=new Float32Array(w),depth=new Float32Array(w),radius=Math.round(w*.19);
 for(let x=0;x<w;x++){let sum=0;for(let dy=-1;dy<=1;dy++){const p=((y+dy)*w+x)*4;sum+=(77*data[p]+150*data[p+1]+29*data[p+2])>>8}profile[x]=sum/3}
 for(let x=0;x<w;x++){let left=profile[x],right=profile[x];
  for(let k=Math.max(0,x-radius);k<x;k++)left=Math.max(left,profile[k]);
  for(let k=x+1;k<=Math.min(w-1,x+radius);k++)right=Math.max(right,profile[k]);
  depth[x]=Math.min(left,right)-profile[x]}
 const runs=[];let start=-1;
 for(let x=0;x<=w;x++){const dark=x<w&&profile[x]<=threshold&&depth[x]>=VISION.minLocalContrast;
  if(dark&&start<0)start=x;
  if(!dark&&start>=0){let begin=start,end=x-1,contrast=0;
   for(let k=begin;k<=end;k++)contrast=Math.max(contrast,depth[k]);
   const edge=Math.max(VISION.minLocalContrast,contrast*.45);
   while(begin<=end&&depth[begin]<edge)begin++;
   while(end>=begin&&depth[end]<edge)end--;
   const width=end-begin+1;
   if(width>=4&&width<=w*.30&&begin>1&&end<w-2)
    runs.push({x:(begin+end)/2,y,width,contrast});
   start=-1}}
 for(const side of ['left','right']){
  const edgeX=side==='left'?0:w-1;
  if(profile[edgeX]>threshold)continue;
  let width=0;
  while(width<w*.36&&profile[side==='left'?width:w-1-width]<=threshold)width++;
  if(width<4||width>=w*.36)continue;
  const floorStart=side==='left'?width:Math.max(0,w-width-radius),floorEnd=side==='left'?Math.min(w,width+radius):w-width;
  let floor=0;for(let k=floorStart;k<floorEnd;k++)floor=Math.max(floor,profile[k]);
  const dark=profile[side==='left'?Math.floor(width/2):w-1-Math.floor(width/2)];
  const contrast=floor-dark;
  if(contrast>=Math.max(35,VISION.minLocalContrast*1.8)){
   const x=side==='left'?(width-1)/2:w-(width+1)/2;
   if(!runs.some(run=>Math.abs(run.x-x)<width*.6))runs.push({x,y,width,contrast,edge:side});
  }
 }
 return runs}

// Regressao quadratica com uma segunda passada que reduz o peso de pontos isolados.
function fitPath(points){const nearY=points[0].y,span=nearY-points.at(-1).y,degree=points.length>=7?2:1;
 const samples=points.map((p,i)=>({t:(nearY-p.y)/span,x:p.x,base:1.5-i/(points.length*2),weight:1.5-i/(points.length*2)}));
 let coefficients=null;
 for(let pass=0;pass<2;pass++){
  const n=degree+1,matrix=Array.from({length:n},()=>Array(n+1).fill(0));
  for(const p of samples){const terms=[1,p.t,p.t*p.t];
   for(let i=0;i<n;i++){for(let j=0;j<n;j++)matrix[i][j]+=p.weight*terms[i]*terms[j];matrix[i][n]+=p.weight*terms[i]*p.x}}
  for(let i=0;i<n;i++){let pivot=i;for(let j=i+1;j<n;j++)if(Math.abs(matrix[j][i])>Math.abs(matrix[pivot][i]))pivot=j;
   [matrix[i],matrix[pivot]]=[matrix[pivot],matrix[i]];
   if(Math.abs(matrix[i][i])<1e-7)return null;
   const divisor=matrix[i][i];for(let k=i;k<=n;k++)matrix[i][k]/=divisor;
   for(let j=0;j<n;j++)if(j!==i){const factor=matrix[j][i];for(let k=i;k<=n;k++)matrix[j][k]-=factor*matrix[i][k]}}
  coefficients=matrix.map(row=>row[n]);
  if(pass===0)for(const p of samples){const predicted=coefficients[0]+coefficients[1]*p.t+(coefficients[2]??0)*p.t*p.t;
   p.weight=p.base*Math.min(1,4/Math.max(1,Math.abs(p.x-predicted)))}}
 const at=t=>coefficients[0]+coefficients[1]*t+(coefficients[2]??0)*t*t;
 const residual=Math.sqrt(samples.reduce((sum,p)=>sum+(p.x-at(p.t))**2,0)/samples.length);
 return{nearX:at(0),farX:at(1),lookX:at(VISION.lookAhead),residual,coefficients,nearY,farY:points.at(-1).y}}

function findLine(image){const w=image.width,h=image.height,rows=[],states=[],completed=[],candidates=[];
 const bottom=Math.min(LINE_NEAR_ROW,h-3),top=Math.min(LINE_FAR_ROW,bottom-24);
 for(let y=bottom;y>=top;y-=6)rows.push(y);
 const lighting=adaptiveBlackThreshold(image,top,bottom);
 const fail=(reason,points=[],partial=false,ambiguous=false,confidence=0)=>({found:false,partial,ambiguous,reason,confidence,
  threshold:lighting.level,lightingContrast:lighting.contrast,y:bottom,points,candidates});
 for(let i=0;i<rows.length;i++){
  const row=rowCandidates(image,rows[i],lighting.level),current=[];candidates.push(...row);
  for(const p of row){const quality=Math.min(5,p.contrast/18)+Math.min(2,p.width/14);
   let best=i<=8?{score:quality-Math.abs(p.x-(lastNearX??w/2))*.07-i*3,points:[p]}:null;
   for(const old of states){const prev=old.points[old.points.length-1],gap=prev.y-p.y,dx=Math.abs(prev.x-p.x);
    if(gap<6||gap>12||dx>Math.min(w*.2,gap*2.5))continue;
    const score=old.score+quality-dx*.16-Math.abs(prev.width-p.width)*.035-(gap>6?2:0);
    if(!best||score>best.score)best={score,points:[...old.points,p]}}
   if(best)current.push(best)}
  states.push(...current);completed.push(...current);
  for(let j=states.length-1;j>=0;j--)if(rows[i]<states[j].points.at(-1).y-12)states.splice(j,1);
 }
 const valid=completed.filter(s=>s.points.length>=5&&s.points[0].y>=bottom-12&&s.points[0].y-s.points.at(-1).y>=30);
 const partialPaths=completed.filter(s=>s.points.length>=5&&s.points[0].y<bottom-12&&
  s.points[0].y-s.points.at(-1).y>=24&&(s.points[0].x<w*.27||s.points[0].x>w*.73));
 const paths=valid.length?valid:partialPaths;
 if(!paths.length)return fail('Fita não encontrada perto do carrinho nem na lateral');
 paths.sort((a,b)=>b.score-a.score);const best=paths[0],points=best.points,fit=fitPath(points),partial=!valid.length;
 if(!fit)return fail('Trajetória insuficiente',points);
 const alternative=paths.find(s=>s!==best&&s.points.length>=best.points.length-2&&
  (Math.abs(s.points[0].x-points[0].x)>w*.09||Math.abs(s.points.at(-1).x-points.at(-1).x)>w*.12));
 if(alternative&&best.score-alternative.score<Math.max(3,Math.abs(best.score)*.08))
  return fail('Mais de uma trajetória possível',points,partial,true);
 const widths=points.map(p=>p.width),nominalWidth=median(widths);
 const widthSpread=median(widths.map(width=>Math.abs(width-nominalWidth)));
 const localContrast=median(points.map(p=>p.contrast));
 const confidence=clamp(.15*Math.min(1,points.length/9)+
  .35*clamp((localContrast-18)/45,0,1)+
  .35*clamp(1-fit.residual/10,0,1)+
  .15*clamp(1-widthSpread/Math.max(8,nominalWidth),0,1),0,1);
 if(fit.residual>VISION.maxResidual||confidence<VISION.minConfidence)
  return fail('Trajetória irregular ou pouco confiável',points,partial,false,confidence);
 const nearX=clamp(fit.nearX,0,w-1),farX=clamp(fit.farX,0,w-1),lookX=clamp(fit.lookX,0,w-1);
 const error=nearX-targetNearX,heading=clamp(lookX-nearX,-60,60);
 const edgeClipped=points[0].width<12&&(nearX<12||nearX>w-13);
 if(!partial)lastNearX=nearX;
 return{found:true,partial,ambiguous:false,reason:partial?'Fita lateral visível: recuperação curta':'Fita encontrada',confidence,threshold:lighting.level,
  lightingContrast:lighting.contrast,localContrast,residual:fit.residual,candidates,
  x:nearX,y:fit.nearY,nearWidth:points[0].width,edgeClipped,lookX,farX,farY:fit.farY,error,heading,offset:error/(w/2),points,curve:fit.coefficients}}

function stopCommand(action){return{action,amount:0,left:0,right:0,duration:0,controlError:null,sourceFrame:null}}

// Cada pulso usa a imagem mais recente, depois que o pulso anterior foi confirmado.
class FollowPlanner {
 makePlan(line,base,frameId){
  const nearError=line.x-targetNearX,heading=line.heading;
  const curve=clamp(Math.abs(heading)/FOLLOW.curveSpan,0,1);
  const lookWeight=line.partial?0:FOLLOW.lookWeightStraight+
   (FOLLOW.lookWeightCurve-FOLLOW.lookWeightStraight)*curve;
  const targetX=line.x+(line.lookX-line.x)*lookWeight;
  const nearEdge=line.partial||line.edgeClipped||line.x<FOLLOW.edgeX||line.x>159-FOLLOW.edgeX;
  let error=clamp(targetX-targetNearX,-80,80);
  if(nearEdge&&Math.abs(nearError)>FOLLOW.centerTolerance)error=nearError;
 const requested=clamp(base,FOLLOW.minPwm,FOLLOW.maxPwm);
  const action=Math.abs(error)<FOLLOW.centerTolerance?'frente':error<0?'esquerda':'direita';
  // A fita distante nunca dispara sozinha um giro com uma roda parada.
  const sharp=action!=='frente'&&Math.abs(nearError)>=FOLLOW.sharpNearError&&
   Math.sign(nearError)===Math.sign(error);
  let left=requested,right=requested,duration=95,mode='reta';
  if(sharp){
   const outer=Math.min(FOLLOW.maxPwm,Math.max(FOLLOW.sharpMinPwm,requested+10));
   left=action==='direita'?outer:0;right=action==='esquerda'?outer:0;
   duration=nearEdge?70:80;mode='curva_fechada';
  }else if(action!=='frente'){
   const difference=Math.min(FOLLOW.gentleDifference,Math.max(10,Math.round(Math.abs(error)*.7)));
   if(action==='direita'){
    const reduce=Math.min(difference,right-FOLLOW.minPwm);right-=reduce;left+=difference-reduce;
   }else{
    const reduce=Math.min(difference,left-FOLLOW.minPwm);left-=reduce;right+=difference-reduce;
   }
   duration=85;mode='curva_suave';
  }
  // 'action' e a direcao desejada na imagem; left/right sao os PWM enviados
  // aos pinos ENA/ENB. O teste de motores permanece sem inversao.
  if(SWAP_STEERING_OUTPUTS)[left,right]=[right,left];
  return{action,
   amount:Math.round(Math.abs(left-right)/2),left,right,duration,mode,controlError:Number(error.toFixed(2)),
   sourceFrame:frameId,nearTolerance:FOLLOW.centerTolerance,
   targetX:Number(targetX.toFixed(2)),lookWeight:Number(lookWeight.toFixed(2)),cruise:requested}
 }
 observe(line,base,frameId){
  if(base===0||!line.found)return{command:stopCommand(base===0?'parar':'sem_linha'),state:'parado'};
  const proposal=this.makePlan(line,base,frameId);
  return{command:proposal,state:line.partial?'recuperacao_lateral':'imagem_atual'}
 }
}

export {findLine,FollowPlanner};
