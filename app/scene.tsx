import {useEffect,useRef} from 'react';
import * as T from 'three';
import {OrbitControls} from 'three/examples/jsm/controls/OrbitControls.js';
import {RoomEnvironment} from 'three/examples/jsm/environments/RoomEnvironment.js';
import {Water} from 'three/examples/jsm/objects/Water.js';
import {EffectComposer} from 'three/examples/jsm/postprocessing/EffectComposer.js';
import {RenderPass} from 'three/examples/jsm/postprocessing/RenderPass.js';
import {UnrealBloomPass} from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import {OutputPass} from 'three/examples/jsm/postprocessing/OutputPass.js';
import {mergeGeometries} from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {WebGLPathTracer,GradientEquirectTexture} from 'three-gpu-pathtracer';
// three r159 lacks the Scene rotation/intensity fields that three-gpu-pathtracer reads; shim them.
{
 const sp=T.Scene.prototype as unknown as Record<string,unknown>;
 for(const k of ['environmentRotation','backgroundRotation'])if(!(k in sp))Object.defineProperty(T.Scene.prototype,k,{get(){const self=this as unknown as Record<string,T.Euler|undefined>;return self['_'+k]??(self['_'+k]=new T.Euler());}});
 for(const k of ['environmentIntensity','backgroundIntensity'])if(!(k in sp))Object.defineProperty(T.Scene.prototype,k,{get(){return (this as unknown as Record<string,number|undefined>)['_'+k]??1;},set(v:number){(this as unknown as Record<string,number>)['_'+k]=v;}});
}
import {createExplosionLayout} from './explosion-layout';
import {decodeModelResponse} from './model-download';
import {PointerTap} from './pointer-tap';
import {SYSTEMS,devRate,waveSterility,type Atlas,type SceneState} from './anatomy';
interface Props {atlas:Atlas;state:SceneState;onSelect:(id:string)=>void;onProgress:(n:number)=>void;onError:(s:string)=>void;onPhoto?:(p:number)=>void}
export default function AnatomyScene({atlas,state,onSelect,onProgress,onError,onPhoto}:Props){
 const host=useRef<HTMLDivElement>(null),latest=useRef(state),select=useRef(onSelect),photoCb=useRef(onPhoto);
 latest.current=state;select.current=onSelect;photoCb.current=onPhoto;
 useEffect(()=>{
  const el=host.current!;let disposed=false,frame=0,dirty=true,ready=false,lastView='',lastReset=-1,lastIsolate='',layoutKey='',amount=0;
  let lastState:SceneState|null=null;
  const abort=new AbortController();
  let renderer:T.WebGLRenderer;
  try{renderer=new T.WebGLRenderer({antialias:true,alpha:false,powerPreference:'high-performance'});}catch{onError('This browser could not start the 3D viewer. Please try a browser with WebGL enabled.');return;}
  renderer.setPixelRatio(Math.min(devicePixelRatio,innerWidth<768?1.5:2));renderer.setClearColor('#f2f3f3');renderer.outputColorSpace=T.SRGBColorSpace;renderer.toneMapping=T.ACESFilmicToneMapping;renderer.toneMappingExposure=1.12;renderer.shadowMap.enabled=true;renderer.shadowMap.type=T.PCFSoftShadowMap;el.appendChild(renderer.domElement);
  renderer.domElement.setAttribute('aria-label','Interactive rice plant anatomy. Drag to orbit, pinch or scroll to zoom, and tap an organ to inspect it.');
  const scene=new T.Scene(),camera=new T.PerspectiveCamera(34,1,.005,100),controls=new OrbitControls(camera,renderer.domElement);
  camera.position.set(1.4,1.05,3.6);controls.target.set(0,.85,0);controls.enableDamping=true;controls.dampingFactor=.085;controls.minDistance=.07;controls.maxDistance=40;controls.maxPolarAngle=Math.PI*.55;controls.addEventListener('change',()=>{dirty=true;});
  const pmrem=new T.PMREMGenerator(renderer),room=new RoomEnvironment(),env=pmrem.fromScene(room,.04);scene.environment=env.texture;room.dispose();pmrem.dispose();
  // Paddy world: warm outdoor rig, distance fog blending water into the sky at the horizon.
  const fog=new T.Fog(0xdfe7ea,15,52);scene.fog=fog;
  scene.add(new T.HemisphereLight(0xe8f1fa,0xb9c0ae,1.15));
  scene.add(new T.AmbientLight(0xf6f2e6,.45));
  const key=new T.DirectionalLight(0xfff3df,1.2);key.position.set(-2,4,3);scene.add(key);
  key.castShadow=true;key.shadow.mapSize.set(2048,2048);key.shadow.bias=-.0002;key.shadow.normalBias=.02;
  key.shadow.camera.left=key.shadow.camera.bottom=-2.2;key.shadow.camera.right=key.shadow.camera.top=2.2;key.shadow.camera.near=.5;key.shadow.camera.far=12;
  const rim=new T.DirectionalLight(0xdfe9ff,.55);rim.position.set(2,2,-3);scene.add(rim);
  const fill=new T.DirectionalLight(0xffedd2,.5);fill.position.set(3,1.2,1.5);scene.add(fill);
  // Gradient sky dome with a faint halo around the key-light direction. The horizon stop
  // matches the fog color exactly so fogged water dissolves into the sky seamlessly.
  const sunDir=key.position.clone().normalize();
  const skyMat=new T.ShaderMaterial({side:T.BackSide,depthWrite:false,fog:false,
   uniforms:{horizon:{value:new T.Color(0xdfe7ea)},mid:{value:new T.Color(0xaecadd)},zenith:{value:new T.Color(0x84a9cf)},sunTint:{value:new T.Color(0xffe9c4)},sunDir:{value:sunDir}},
   vertexShader:'varying vec3 vDir;void main(){vDir=normalize(position);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
   fragmentShader:'varying vec3 vDir;uniform vec3 horizon;uniform vec3 mid;uniform vec3 zenith;uniform vec3 sunTint;uniform vec3 sunDir;void main(){float h=max(vDir.y,0.0);vec3 col=mix(horizon,mid,smoothstep(0.0,0.3,h));col=mix(col,zenith,smoothstep(0.3,0.85,h));col+=sunTint*pow(max(dot(vDir,sunDir),0.0),18.0)*0.16;gl_FragColor=vec4(col,1.0);}'});
  const sky=new T.Mesh(new T.SphereGeometry(58,48,24),skyMat);sky.frustumCulled=false;scene.add(sky);
  // Post: render into a multisampled HDR target, bloom the highlights, then tone-map.
  const composerTarget=new T.WebGLRenderTarget(1,1,{type:T.HalfFloatType,samples:4});
  const composer=new EffectComposer(renderer,composerTarget);
  composer.addPass(new RenderPass(scene,camera));
  const bloomPass=new UnrealBloomPass(new T.Vector2(1,1),.22,.5,.92);
  composer.addPass(bloomPass);composer.addPass(new OutputPass());
  const width=T.MathUtils.ceilPowerOfTwo(atlas.parts.length),data=new Float32Array(width*4),partTexture=new T.DataTexture(data,width,1,T.RGBAFormat,T.FloatType);partTexture.needsUpdate=true;
  const selectedData=new Uint8Array(width*4),selectionTexture=new T.DataTexture(selectedData,width,1);selectionTexture.needsUpdate=true;
  // Per-organ tint (linear RGB), falling back to the system color.
  const colorData=new Float32Array(width*4),colorTexture=new T.DataTexture(colorData,width,1,T.RGBAFormat,T.FloatType);
  atlas.parts.forEach((p,i)=>{const c=new T.Color(p.color??SYSTEMS.find(s=>s.id===p.system)?.color??'#aebbb8');colorData.set([c.r,c.g,c.b,1],i*4);});colorTexture.needsUpdate=true;
  const materials:T.Material[]=[],geometries:T.BufferGeometry[]=[],pickers:(T.Mesh|undefined)[]=[],centers=atlas.parts.map(p=>new T.Vector3().fromArray(p.bounds[0]).add(new T.Vector3().fromArray(p.bounds[1])).multiplyScalar(.5));
  // Frame the camera on this stage's actual plant height rather than a fixed adult size.
  const plantHeight=atlas.parts.reduce((m,p)=>Math.max(m,p.bounds[1][1]),.3),midY=Math.min(.9,Math.max(.16,plantHeight*.5)),hscale=Math.min(1.1,Math.max(.22,plantHeight/1.7));
  // Growth simulation: per-organ anchor + growth factor texture, young→ripe color pairs,
  // and per-culm internode vectors so organs ride downward while internodes are unelongated.
  const growthData=new Float32Array(width*4),growthTexture=new T.DataTexture(growthData,width,1,T.RGBAFormat,T.FloatType);
  const anchors=atlas.parts.map((p,i)=>p.growth?new T.Vector3().fromArray(p.growth.anchor):centers[i].clone());
  atlas.parts.forEach((p,i)=>growthData.set([anchors[i].x,anchors[i].y,anchors[i].z,1],i*4));growthTexture.needsUpdate=true;
  const ripeColors=atlas.parts.map(p=>new T.Color(p.color??SYSTEMS.find(s=>s.id===p.system)?.color??'#aebbb8'));
  const youngColors=atlas.parts.map((p,i)=>p.color0?new T.Color(p.color0):ripeColors[i].clone());
  const culmVecs=(atlas.growthCulms??[]).map(c=>c.map(v=>new T.Vector3().fromArray(v)));
  const culmIndex:number[][]=culmVecs.map(c=>c.map(()=>-1));
  atlas.parts.forEach((p,i)=>{const g=p.growth;if(g&&p.system==='Stem'&&g.culm>=0&&g.node>=0&&g.node<(culmIndex[g.culm]?.length??0))culmIndex[g.culm][g.node]=i;});
  const smooth01=(t:number)=>{const c=Math.max(0,Math.min(1,t));return c*c*(3-2*c);};
  const organGrow=(p:(typeof atlas.parts)[number],day:number)=>p.growth?smooth01((day-p.growth.birth)/Math.max(.1,p.growth.dur)):1;
  const tmpColor=new T.Color();
  // Mechanics: a per-organ rotation quaternion drives panicle nodding and lodging.
  const rotData=new Float32Array(width*4),rotTexture=new T.DataTexture(rotData,width,1,T.RGBAFormat,T.FloatType);
  for(let i=0;i<width;i++)rotData[i*4+3]=1;rotTexture.needsUpdate=true;
  const culmBase=culmVecs.map((_,ci)=>{const pi=culmIndex[ci]?.[0];return pi!=null&&pi>=0&&atlas.parts[pi].growth?new T.Vector3().fromArray(atlas.parts[pi].growth!.anchor):new T.Vector3(0,.33,0);});
  // one nod axis per culm, horizontal and perpendicular to that panicle's outward direction
  const rachisIndex=culmVecs.map((_,ci)=>atlas.parts.findIndex(p=>p.system==='Panicle'&&p.growth?.culm===ci&&p.name.includes('rachis')));
  const panicleAxis=rachisIndex.map(pi=>{if(pi<0)return null;const dir=centers[pi].clone().sub(anchors[pi]);dir.y=0;if(dir.lengthSq()<1e-8)dir.set(1,0,0);dir.normalize();return new T.Vector3(-dir.z,0,dir.x);});
  const lodgeAxis=culmVecs.map(()=>{const a=Math.random()*Math.PI*2;return new T.Vector3(Math.cos(a),0,Math.sin(a));});
  const lodgeSeverity=culmVecs.map(()=>.4+Math.random()*.6);
  const nodQ=new T.Quaternion(),lodgeQ=new T.Quaternion(),tmpV=new T.Vector3();
  const N_PALE=new T.Color('#a9ab63'),DRY_DULL=new T.Color('#8b9070'),STERILE_PALE=new T.Color('#d8d2b0');
  const offsets:T.Vector3[]=[],bounds=atlas.parts.map(p=>new T.Box3(new T.Vector3().fromArray(p.bounds[0]),new T.Vector3().fromArray(p.bounds[1])));
  let packingWidth=1,packingHeight=1;
  const markerPositions=new Float32Array(atlas.parts.length*3),markerGeometry=new T.BufferGeometry();markerGeometry.setAttribute('position',new T.BufferAttribute(markerPositions,3));
  const markerMaterial=new T.PointsMaterial({color:0x64748b,size:5,sizeAttenuation:false,transparent:true,opacity:.72,depthTest:false});
  markerMaterial.onBeforeCompile=shader=>{shader.fragmentShader=shader.fragmentShader.replace('#include <clipping_planes_fragment>','#include <clipping_planes_fragment>\nif (distance(gl_PointCoord, vec2(0.5)) > 0.5) discard;');};
  const markers=new T.Points(markerGeometry,markerMaterial);markers.frustumCulled=false;markers.renderOrder=10;markers.visible=false;scene.add(markers);
  // Pollen motes: a faint ambient dust that thickens around anthesis (each spikelet
  // flowers for an hour or two around heading) and drifts on the same clock as the wind.
  const hasPanicles=atlas.parts.some(p=>p.system==='Panicle');
  const MOTES=260,motePos=new Float32Array(MOTES*3),moteSeed=new Float32Array(MOTES);
  for(let i=0;i<MOTES;i++){const a=Math.random()*Math.PI*2,r=.18+Math.random()*(.35+plantHeight*.75);motePos.set([Math.cos(a)*r,.08+Math.random()*plantHeight*1.15,Math.sin(a)*r],i*3);moteSeed[i]=Math.random()*100;}
  const moteGeometry=new T.BufferGeometry();moteGeometry.setAttribute('position',new T.BufferAttribute(motePos,3));moteGeometry.setAttribute('seed',new T.BufferAttribute(moteSeed,1));
  const moteMaterial=new T.PointsMaterial({color:0xfaf0d8,size:4.5,sizeAttenuation:false,transparent:true,opacity:0,depthWrite:false});
  const moteDrift={value:0};
  moteMaterial.onBeforeCompile=shader=>{
   shader.uniforms.time=timeU;shader.uniforms.drift=moteDrift;
   shader.vertexShader='attribute float seed; uniform float time; uniform float drift;\n'+shader.vertexShader;
   shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\ntransformed+=drift*vec3(sin(time*.31+seed*1.7)*.1+sin(time*.83+seed*3.1)*.03,sin(time*.23+seed*2.3)*.06,cos(time*.27+seed*2.9)*.1);');
   shader.fragmentShader=shader.fragmentShader.replace('#include <color_fragment>','#include <color_fragment>\ndiffuseColor.a*=smoothstep(0.5,0.15,distance(gl_PointCoord,vec2(0.5)));');
  };
  const motes=new T.Points(moteGeometry,moteMaterial);motes.frustumCulled=false;motes.visible=false;scene.add(motes);
  const hover=document.createElement('div');hover.className='part-hover';hover.setAttribute('role','tooltip');hover.hidden=true;el.appendChild(hover);
  // Textbook-figure labels: canonical organs called out with leader lines, resolved by name
  // so stages that lack an organ simply skip its label.
  const labelDefs:[string,string,number][]=[
   ['Panicle','Main culm · Panicle rachis',1],
   ['Grains & awns','Main culm · Grains, branch 6',1],
   ['Flag leaf','Main culm · Flag leaf blade',-1],
   ['Leaf blade','Tiller 2 · Leaf blade 3',-1],
   ['Ligule & auricles','Main culm · Ligule & auricles 4',1],
   ['Leaf sheath','Main culm · Leaf sheath 3',-1],
   ['Culm internode','Main culm · Internode 4',1],
   ['Tiller','Tiller 3 · Internode 2',-1],
   ['Tillering crown','Tillering crown',1],
   ['Adventitious roots','Adventitious root 5',-1],
  ];
  const labelLayer=document.createElement('div');labelLayer.className='figure-labels';labelLayer.hidden=true;el.appendChild(labelLayer);
  const labelSvg=document.createElementNS('http://www.w3.org/2000/svg','svg');labelSvg.setAttribute('class','figure-lines');labelLayer.appendChild(labelSvg);
  const labelItems=labelDefs.flatMap(([text,partName,side])=>{
   const index=atlas.parts.findIndex(p=>p.name===partName);if(index<0)return[];
   const button=document.createElement('button');button.className='figure-label';button.type='button';button.textContent=text;
   button.addEventListener('click',()=>select.current(atlas.parts[index].id));labelLayer.appendChild(button);
   const line=document.createElementNS('http://www.w3.org/2000/svg','line');labelSvg.appendChild(line);
   return [{index,side,button,line,w:0}];
  });
  const layoutLabels=()=>{
   const w=el.clientWidth,h=el.clientHeight,mobile=w<768;
   labelSvg.setAttribute('viewBox',`0 0 ${w} ${h}`);labelSvg.setAttribute('width',String(w));labelSvg.setAttribute('height',String(h));
   labelItems.forEach(i=>{i.button.hidden=true;i.line.setAttribute('visibility','hidden');});
   const columns:{item:typeof labelItems[number];ax:number;ay:number}[][]=[[],[]];
   labelItems.forEach(item=>{
    const i=item.index,g=growthData[i*4+3];
    if(g<.05||data[i*4+3]<.5)return;
    projected.copy(centers[i]).sub(anchors[i]).multiplyScalar(g).add(anchors[i]);
    projected.x+=data[i*4];projected.y+=data[i*4+1];projected.z+=data[i*4+2];
    projected.project(camera);
    if(projected.z>1||projected.z<-1)return;
    columns[item.side>0?1:0].push({item,ax:(projected.x+1)*w/2,ay:(1-projected.y)*h/2});
   });
   columns.forEach((list,si)=>{
    list.sort((a,b)=>a.ay-b.ay);
    const lx=si?Math.min(w-20,w/2+(mobile?w*.42:340)):Math.max(20,w/2-(mobile?w*.42:340));
    let prev=mobile?150:96;
    list.forEach(({item,ax,ay})=>{
     const ly=Math.min(h-(mobile?210:170),Math.max(prev,ay-12));prev=ly+(mobile?26:30);
     item.button.style.left=`${lx}px`;item.button.style.top=`${ly}px`;item.button.style.transform=si?'translateX(-100%)':'';item.button.hidden=false;
     if(!item.w)item.w=item.button.offsetWidth;
     const edge=si?lx-item.w-6:lx+item.w+6;
     item.line.setAttribute('x1',String(edge));item.line.setAttribute('y1',String(ly+11));
     item.line.setAttribute('x2',String(ax));item.line.setAttribute('y2',String(ay));
     item.line.setAttribute('visibility','visible');
    });
   });
  };
  type Target={index:number;x:number;y:number;left:number;right:number;top:number;bottom:number};let targets:Target[]=[];
  const projected=new T.Vector3();
  const findTarget=(x:number,y:number,radius:number)=>{
   let best=-1,score=Infinity;
   for(const t of targets){const dx=Math.max(t.left-x,0,x-t.right),dy=Math.max(t.top-y,0,y-t.bottom),distance=Math.hypot(dx,dy);if(distance>radius)continue;const candidate=distance+Math.hypot(t.x-x,t.y-y)*.025;if(candidate<score){score=candidate;best=t.index;}}
   return best;
  };
  // Procedural surface detail: albedo maps authored around 1.0 (they multiply the
  // per-organ color and tint) plus normal maps derived from the same height fields.
  const maxAniso=renderer.capabilities.getMaxAnisotropy();
  const detailTextures:T.Texture[]=[];
  const rand2=(x:number,y:number)=>{const s=Math.sin(x*127.1+y*311.7)*43758.5453;return s-Math.floor(s);};
  const makeDetail=(w:number,h:number,fn:(u:number,v:number)=>[number,number,number,number])=>{
   const albedo=new Uint8Array(w*h*4),heightField=new Float32Array(w*h);
   for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const [r,g,b,ht]=fn(x/w,y/h);const i=(y*w+x);
    albedo[i*4]=Math.max(0,Math.min(255,Math.round(r*127.5)));
    albedo[i*4+1]=Math.max(0,Math.min(255,Math.round(g*127.5)));
    albedo[i*4+2]=Math.max(0,Math.min(255,Math.round(b*127.5)));
    albedo[i*4+3]=255;heightField[i]=ht;
   }
   const normal=new Uint8Array(w*h*4);
   for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const l=heightField[y*w+((x-1+w)%w)],r=heightField[y*w+((x+1)%w)];
    const u=heightField[((y-1+h)%h)*w+x],d=heightField[((y+1)%h)*w+x];
    let nx=(l-r)*w*.004,ny=(u-d)*h*.004,nz=1;
    const len=Math.sqrt(nx*nx+ny*ny+nz*nz);nx/=len;ny/=len;nz/=len;
    const i=(y*w+x)*4;normal[i]=Math.round((nx*.5+.5)*255);normal[i+1]=Math.round((ny*.5+.5)*255);normal[i+2]=Math.round((nz*.5+.5)*255);normal[i+3]=255;
   }
   const wrap=(t:T.DataTexture)=>{t.wrapS=t.wrapT=T.RepeatWrapping;t.anisotropy=maxAniso;t.generateMipmaps=true;t.minFilter=T.LinearMipmapLinearFilter;t.magFilter=T.LinearFilter;t.needsUpdate=true;detailTextures.push(t);return t;};
   const map=wrap(new T.DataTexture(albedo,w,h,T.RGBAFormat));map.colorSpace=T.NoColorSpace;
   const nmap=wrap(new T.DataTexture(normal,w,h,T.RGBAFormat));
   return {map,nmap};
  };
  // leaf blade: dense parallel veins with a bright midrib and speckle (u across the blade)
  const leafTex=makeDetail(256,256,(u,v)=>{
   const vein=Math.sin(u*Math.PI*2*24)*.5+.5;
   const major=Math.sin(u*Math.PI*2*6+1.3)*.5+.5;
   const mid=Math.exp(-(((u-.5)/.045)**2));
   const speck=(rand2(Math.floor(u*256),Math.floor(v*256))-.5)*.07;
   const shade=.94+.10*vein+.04*major+speck;
   return [shade*(1+.10*mid),shade*(1+.12*mid),shade*(.97+.06*mid),.5*vein+.25*major+1.4*mid];
  });
  // sheath / culm: fine longitudinal striation
  const striaTex=makeDetail(128,128,(u,v)=>{
   const s=Math.sin(u*Math.PI*2*18)*.5+.5;
   const speck=(rand2(Math.floor(u*128),Math.floor(v*128))-.5)*.05;
   const shade=.97+.05*s+speck;
   return [shade,shade,shade*.99,.6*s];
  });
  // grain husk: papillae dimples over faint lengthwise ribs
  const grainTex=makeDetail(128,128,(u,v)=>{
   const cellX=Math.floor(u*24),cellY=Math.floor(v*24);
   const jx=rand2(cellX,cellY)-.5,jy=rand2(cellX+7,cellY+3)-.5;
   const du=u*24-cellX-.5-jx*.6,dv=v*24-cellY-.5-jy*.6;
   const pap=Math.exp(-((du*du+dv*dv)/.09));
   const rib=Math.sin(u*Math.PI*2*10)*.5+.5;
   const shade=.96+.06*pap+.03*rib;
   return [shade,shade,shade*.97,1.2*pap+.3*rib];
  });
  // roots: soft irregular blotch
  const rootTex=makeDetail(128,128,(u,v)=>{
   const n=(rand2(Math.floor(u*40),Math.floor(v*40))+rand2(Math.floor(u*11),Math.floor(v*11)))*.5;
   const shade=.95+.10*n;
   return [shade,shade*.99,shade*.96,.5*n];
  });
  const DETAIL:Record<string,{map:T.Texture;nmap:T.Texture;bump:number}>={
   Leaves:{...leafTex,bump:.5},
   Sheath:{...striaTex,bump:.3},
   Stem:{...striaTex,bump:.25},
   Panicle:{...striaTex,bump:.2},
   Grain:{...grainTex,bump:.55},
   Root:{...rootTex,bump:.3},
  };
  // Paddy water to the horizon: gentle tiling ripples (integer frequencies keep the wrap
  // seamless) drive the reflection distortion; fog dissolves the far edge into the sky.
  const rippleTex=makeDetail(256,256,(u,v)=>{
   const h=.5*Math.sin((3*u+2*v)*Math.PI*2)+.3*Math.sin((-2*u+4*v)*Math.PI*2+1.3)+.14*Math.sin((7*u+5*v)*Math.PI*2+4.1)+.06*Math.sin((5*u-7*v)*Math.PI*2+2.2);
   return [1,1,1,h*2];
  });
  const water=new Water(new T.CircleGeometry(60,72),{textureWidth:512,textureHeight:512,waterNormals:rippleTex.nmap,sunDirection:sunDir.clone(),sunColor:0xfff0dd,waterColor:0x26332b,distortionScale:.7,fog:true});
  water.rotation.x=-Math.PI/2;water.position.y=-.012;scene.add(water);
  const waterUniforms=(water.material as T.ShaderMaterial).uniforms;waterUniforms.size.value=4;
  // Mud mound: a low organic hummock cresting just above the waterline, so the crown and
  // exposed roots rest on wet soil instead of a podium.
  const islandMat=new T.MeshStandardMaterial({roughness:.96,metalness:0,map:rootTex.map,normalMap:rootTex.nmap,normalScale:new T.Vector2(.4,.4)});
  islandMat.color.set(0x3f3122).multiplyScalar(2);// detail albedo is authored around 0.5; restore headroom
  const island=new T.Mesh(new T.SphereGeometry(1,72,36),islandMat);
  // a compact, lumpy hummock: crest just above the crown base so the roots enter the soil,
  // rim undulation so the silhouette never reads as a machined disc
  const islandVerts=island.geometry.attributes.position;
  for(let i=0;i<islandVerts.count;i++){
   const x=islandVerts.getX(i),z=islandVerts.getZ(i),a=Math.atan2(z,x);
   const f=1+.07*Math.sin(a*3+1.2)+.05*Math.sin(a*7+2.6);
   islandVerts.setX(i,x*f);islandVerts.setZ(i,z*f);islandVerts.setY(i,islandVerts.getY(i)*(1+.06*Math.sin(a*5+.7)));
  }
  island.geometry.computeVertexNormals();
  island.scale.set(.5,.06,.5);island.position.y=-.05;island.receiveShadow=true;scene.add(island);
  // Season-following light: cool clear morning light while the crop is vegetative, a high
  // neutral sun mid-season, low amber light as the grain ripens. Sun elevation, key color,
  // sky tints, fog and the water's specular sun all lerp between these keyframes.
  const seasonKey=(k:{day:number;alt:number;int:number;key:number;horizon:number;mid:number;zenith:number;sunTint:number;waterSun:number})=>({day:k.day,alt:k.alt,int:k.int,key:new T.Color(k.key),horizon:new T.Color(k.horizon),mid:new T.Color(k.mid),zenith:new T.Color(k.zenith),sunTint:new T.Color(k.sunTint),waterSun:new T.Color(k.waterSun)});
  const SEASON=[
   seasonKey({day:10,alt:38,int:1.1,key:0xeef4ff,horizon:0xe2e9ec,mid:0xb7d0e0,zenith:0x8ab0d4,sunTint:0xfff2d8,waterSun:0xf4f6ff}),
   seasonKey({day:60,alt:62,int:1.25,key:0xfff3df,horizon:0xdfe7ea,mid:0xaecadd,zenith:0x84a9cf,sunTint:0xffe9c4,waterSun:0xfff0dd}),
   seasonKey({day:120,alt:24,int:1.12,key:0xffd9a4,horizon:0xece2cf,mid:0xd6c9b4,zenith:0x8fa3bd,sunTint:0xffcf9a,waterSun:0xffdfae},
  )];
  const sunAzimuth=new T.Vector3(-2,0,3).normalize();
  const applySeasonLight=(day:number)=>{
   const b=SEASON[day<=SEASON[1].day?1:2],a=SEASON[day<=SEASON[1].day?0:1];
   const t=T.MathUtils.clamp((day-a.day)/(b.day-a.day),0,1);
   const alt=T.MathUtils.degToRad(T.MathUtils.lerp(a.alt,b.alt,t));
   sunDir.copy(sunAzimuth).multiplyScalar(Math.cos(alt));sunDir.y=Math.sin(alt);
   key.position.copy(sunDir).multiplyScalar(5.4);
   key.color.lerpColors(a.key,b.key,t);key.intensity=T.MathUtils.lerp(a.int,b.int,t);
   (skyMat.uniforms.horizon.value as T.Color).lerpColors(a.horizon,b.horizon,t);
   (skyMat.uniforms.mid.value as T.Color).lerpColors(a.mid,b.mid,t);
   (skyMat.uniforms.zenith.value as T.Color).lerpColors(a.zenith,b.zenith,t);
   (skyMat.uniforms.sunTint.value as T.Color).lerpColors(a.sunTint,b.sunTint,t);
   fog.color.copy(skyMat.uniforms.horizon.value as T.Color);
   (waterUniforms.sunDirection.value as T.Vector3).copy(sunDir);
   (waterUniforms.sunColor.value as T.Color).lerpColors(a.waterSun,b.waterSun,t);
  };
  // Shared time/sway uniforms drive a gentle wind in both the beauty and shadow passes.
  const timeU={value:0},swayU={value:0},reduceMotion=matchMedia('(prefers-reduced-motion: reduce)').matches;
  moteDrift.value=reduceMotion?0:1;
  // The phase depends only on rest position so touching organs sway as one piece —
  // a per-part phase term detaches panicles from culm tips and grains from branches.
  const SWAY_VERTEX='float swayGate = smoothstep(0.25, 1.6, transformed.y); float swayPhase = time*1.35 + position.y*2.1 + position.x*1.6; transformed += vec3(sin(swayPhase), 0.0, 0.8*cos(swayPhase*0.77)) * (sway * 0.009 * swayGate);';
  const GROW_VERTEX='vec4 grow = texture2D(growthState, stateUv); vec3 gpv = (transformed - grow.xyz) * grow.w; gpv += 2.0 * cross(rq.xyz, cross(rq.xyz, gpv) + rq.w * gpv); transformed = grow.xyz + gpv;';
  const FINISH:Record<string,{rough:number;env:number}>={Leaves:{rough:.48,env:.5},Sheath:{rough:.55,env:.4},Stem:{rough:.62,env:.35},Grain:{rough:.42,env:.6},Panicle:{rough:.6,env:.35},Root:{rough:.85,env:.15}};
  const materialFor=(system:string)=>{
   const finish=FINISH[system]??{rough:.62,env:.35};
   const detail=DETAIL[system];
   const m=new T.MeshStandardMaterial({color:0xffffff,metalness:.05,roughness:finish.rough,side:T.DoubleSide,map:detail?.map,normalMap:detail?.nmap,normalScale:detail?new T.Vector2(detail.bump,detail.bump):undefined});m.envMapIntensity=finish.env;
   m.onBeforeCompile=shader=>{
    shader.uniforms.partState={value:partTexture};shader.uniforms.selectionState={value:selectionTexture};shader.uniforms.colorState={value:colorTexture};shader.uniforms.growthState={value:growthTexture};shader.uniforms.rotState={value:rotTexture};shader.uniforms.stateWidth={value:width};shader.uniforms.time=timeU;shader.uniforms.sway=swayU;
    shader.vertexShader='attribute float partIndex; attribute vec3 tint; uniform sampler2D partState; uniform sampler2D selectionState; uniform sampler2D colorState; uniform sampler2D growthState; uniform sampler2D rotState; uniform float stateWidth; uniform float time; uniform float sway; varying float partVisible; varying float partSelected; varying vec3 partColor; varying vec3 vTint;\n'+shader.vertexShader;
    shader.vertexShader=shader.vertexShader.replace('#include <beginnormal_vertex>','#include <beginnormal_vertex>\nvec2 stateUv = vec2((partIndex + 0.5) / stateWidth, 0.5); vec4 rq = texture2D(rotState, stateUv); objectNormal = objectNormal + 2.0 * cross(rq.xyz, cross(rq.xyz, objectNormal) + rq.w * objectNormal);');
    shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\n'+GROW_VERTEX+' '+SWAY_VERTEX+'\nvec4 state = texture2D(partState, stateUv); transformed += state.xyz; partVisible = state.w; partSelected = texture2D(selectionState, stateUv).r; partColor = texture2D(colorState, stateUv).rgb; vTint = tint * 2.0;');
    shader.fragmentShader='varying float partVisible; varying float partSelected; varying vec3 partColor; varying vec3 vTint;\n'+shader.fragmentShader;
    // Thin organs are single-surface sheets; light whichever side faces the camera.
    if(system==='Leaves')shader.fragmentShader=shader.fragmentShader.replace('#include <normal_fragment_begin>','#include <normal_fragment_begin>\nif (dot(normal, normalize(vViewPosition)) < 0.0) normal = -normal;');
    shader.fragmentShader=shader.fragmentShader.replace('#include <clipping_planes_fragment>','#include <clipping_planes_fragment>\nif (partVisible < 0.5) discard;');
    shader.fragmentShader=shader.fragmentShader.replace('#include <color_fragment>','#include <color_fragment>\ndiffuseColor.rgb *= partColor * vTint * 2.0;\ndiffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.42, 0.85, 0.78), partSelected * 0.5);');
    // Cheap translucency: thin blades glow softly toward their silhouette, like backlit foliage.
    if(system==='Leaves')shader.fragmentShader=shader.fragmentShader.replace('#include <lights_fragment_end>','#include <lights_fragment_end>\nreflectedLight.indirectDiffuse += diffuseColor.rgb * vec3(0.9, 1.0, 0.55) * (pow(1.0 - abs(dot(normal, normalize(vViewPosition))), 2.0) * 0.35);');
   };materials.push(m);return m;
  };
  const mats=new Map(SYSTEMS.map(s=>[s.id,materialFor(s.id)]));
  // Shadow pass: replicate the wind and per-part offsets, and skip hidden organs.
  const depthMaterial=new T.MeshDepthMaterial({depthPacking:T.RGBADepthPacking});
  depthMaterial.onBeforeCompile=shader=>{
   shader.uniforms.partState={value:partTexture};shader.uniforms.growthState={value:growthTexture};shader.uniforms.rotState={value:rotTexture};shader.uniforms.stateWidth={value:width};shader.uniforms.time=timeU;shader.uniforms.sway=swayU;
   shader.vertexShader='attribute float partIndex; uniform sampler2D partState; uniform sampler2D growthState; uniform sampler2D rotState; uniform float stateWidth; uniform float time; uniform float sway; varying float partVisible;\n'+shader.vertexShader;
   shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\nvec2 stateUv = vec2((partIndex + 0.5) / stateWidth, 0.5); vec4 rq = texture2D(rotState, stateUv); '+GROW_VERTEX+' '+SWAY_VERTEX+'\nvec4 state = texture2D(partState, stateUv); transformed += state.xyz; partVisible = state.w;');
   shader.fragmentShader='varying float partVisible;\n'+shader.fragmentShader;
   shader.fragmentShader=shader.fragmentShader.replace('#include <clipping_planes_fragment>','#include <clipping_planes_fragment>\nif (partVisible < 0.5) discard;');
  };
  materials.push(depthMaterial);
  // Eased camera moves: a pose request glides toward its destination with the same
  // exponential damping the rest of the scene uses. Grabbing the controls cancels the
  // glide, and prefers-reduced-motion (or lambda 0) snaps instantly.
  const desiredPos=new T.Vector3(),desiredTgt=new T.Vector3(),fitPos=new T.Vector3(),fitTgt=new T.Vector3();
  let gliding=false,glideLambda=4;
  const setPose=(pos:T.Vector3,tgt:T.Vector3,lambda=0)=>{
   desiredPos.copy(pos);desiredTgt.copy(tgt);
   if(!lambda||reduceMotion){camera.position.copy(pos);controls.target.copy(tgt);gliding=false;controls.update();}
   else{glideLambda=lambda;gliding=true;}
   dirty=true;
  };
  controls.addEventListener('start',()=>{gliding=false;});
  let loaded=0;
  const loadChunk=async(ci:number)=>{
   const chunk=atlas.chunks[ci],compressed=!!chunk.gzip&&typeof DecompressionStream!=='undefined';const response=await fetch(compressed?chunk.gzip!:chunk.url,{signal:abort.signal});const buffer=await decodeModelResponse(response,chunk.bytes,compressed);if(disposed)return;
   const groups=new Map<string,T.BufferGeometry[]>();
   atlas.parts.forEach((p,i)=>{
    if(p.chunk!==ci)return;
    const g=new T.BufferGeometry();g.setAttribute('position',new T.BufferAttribute(new Float32Array(buffer,p.positions,p.vertexCount*3),3));
    // GPU normalized signed-short normals keep the complete atlas compact in memory.
    g.setAttribute('normal',new T.BufferAttribute(new Int16Array(buffer,p.normals,p.vertexCount*3),3,true));g.setIndex(new T.BufferAttribute(new Uint32Array(buffer,p.indices,p.indexCount),1));
    // Per-vertex tint multiplier ([0,2], byte-packed) for gradients, node rings, and browned tips.
    g.setAttribute('tint',new T.BufferAttribute(new Uint8Array(buffer,p.tints,p.vertexCount*3),3,true));
    g.setAttribute('uv',new T.BufferAttribute(new Float32Array(buffer,p.uvs,p.vertexCount*2),2));
    g.boundingBox=bounds[i].clone();g.computeBoundingSphere();const pick=new T.Mesh(g);pick.matrixAutoUpdate=false;pickers[i]=pick;geometries.push(g);
    g.setAttribute('partIndex',new T.BufferAttribute(new Float32Array(p.vertexCount).fill(i),1));
    const list=groups.get(p.system)??[];list.push(g);groups.set(p.system,list);
   });
   groups.forEach((gs,system)=>{const geometry=mergeGeometries(gs,false);if(!geometry)throw new Error('Could not assemble anatomy geometry.');geometries.push(geometry);const mesh=new T.Mesh(geometry,mats.get(system as never));mesh.frustumCulled=false;mesh.castShadow=true;mesh.receiveShadow=true;mesh.customDepthMaterial=depthMaterial;scene.add(mesh);});
   lastState=null;loaded++;onProgress(Math.round(loaded/atlas.chunks.length*100));dirty=true;
  };
  (async()=>{try{let cursor=0;await Promise.all(Array.from({length:3},async()=>{while(cursor<atlas.chunks.length){const i=cursor++;await loadChunk(i);}}));if(!disposed){ready=true;dirty=true;
   // cinematic reveal: drift in from a pulled-back, slightly rotated vantage
   if(!reduceMotion&&!latest.current.isolate&&latest.current.explode<.05){
    fitPos.copy(camera.position);fitTgt.copy(controls.target);
    const off=camera.position.clone().sub(controls.target).applyAxisAngle(new T.Vector3(0,1,0),.55).multiplyScalar(1.5);off.y+=.4;
    camera.position.copy(controls.target).add(off);controls.update();
    setPose(fitPos,fitTgt,1.7);
   }
  }}catch(e){if(!disposed)onError(e instanceof Error?e.message:'Could not load the anatomy.');}})();
  const fit=(view:string,extent=0,lambda=0)=>{
   // Frame tighter and lower while the plant is young, pulling back as it grows.
   const dayT=T.MathUtils.smoothstep(latest.current.day??120,5,70);
   const dayScale=T.MathUtils.lerp(.42,1,dayT);
   const aspect=camera.aspect,mobile=el.clientWidth<768,normalDistance=(mobile?Math.max(4.5,1.8*el.clientHeight/Math.max(160,el.clientHeight-350)/(2*Math.tan(T.MathUtils.degToRad(camera.fov/2)))):4)*hscale*(extent>.1?1:dayScale);
   const reservedHeight=mobile?350:270;const availableAspect=Math.max(.35,(el.clientWidth-(mobile?40:340))/Math.max(160,el.clientHeight-reservedHeight));const atlasDistance=Math.max(packingHeight,packingWidth/availableAspect)/(2*Math.tan(T.MathUtils.degToRad(camera.fov/2)))*(el.clientHeight/Math.max(160,el.clientHeight-reservedHeight))*1.08;
   const distance=T.MathUtils.lerp(normalDistance,Math.max(.2,atlasDistance),extent);if(extent>.8)view='front';
   const direction=view==='front'?new T.Vector3(0,.02,1):view==='back'?new T.Vector3(0,.02,-1):view==='side'?new T.Vector3(1,.02,0):new T.Vector3(.35,.06,1).normalize();
   fitTgt.set(extent>.1&&el.clientWidth>767?-packingWidth*.12:0,extent>.1?.85:(mobile?midY*1.05:midY*.82)*T.MathUtils.lerp(.62,1,dayT),0);fitPos.copy(fitTgt).addScaledVector(direction,distance);setPose(fitPos,fitTgt,lambda);
  };
  const resize=()=>{layoutKey='';lastState=null;const ratio=Math.min(devicePixelRatio,el.clientWidth<768||el.clientHeight<600?1.5:2);renderer.setPixelRatio(ratio);camera.aspect=el.clientWidth/el.clientHeight;camera.updateProjectionMatrix();renderer.setSize(el.clientWidth,el.clientHeight);composer.setPixelRatio(ratio);composer.setSize(el.clientWidth,el.clientHeight);fit(latest.current.view,amount);};const observer=new ResizeObserver(resize);observer.observe(el);
  const raycaster=new T.Raycaster(),pointer=new T.Vector2(),tap=new PointerTap(),worldBox=new T.Box3(),hitPoint=new T.Vector3();
  const down=(e:PointerEvent)=>{hover.hidden=true;tap.down(e.pointerId,e.clientX,e.clientY,e.pointerType==='touch'?12:5);};
  const move=(e:PointerEvent)=>{tap.move(e.pointerId,e.clientX,e.clientY);if(e.buttons||amount<.5||e.pointerType==='touch'){hover.hidden=true;return;}const rect=el.getBoundingClientRect(),x=e.clientX-rect.left,y=e.clientY-rect.top,index=findTarget(x,y,12);hover.hidden=index<0;renderer.domElement.style.cursor=index<0?'grab':'pointer';if(index>=0){hover.textContent=atlas.parts[index].name;hover.style.left=`${Math.max(8,Math.min(x+14,el.clientWidth-260))}px`;hover.style.top=`${Math.max(8,Math.min(y+18,el.clientHeight-55))}px`;}};
  const cancel=(e:PointerEvent)=>tap.cancel(e.pointerId);
  const up=(e:PointerEvent)=>{
   const validTap=tap.up(e.pointerId,e.clientX,e.clientY);if(!validTap||!ready)return;const rect=renderer.domElement.getBoundingClientRect();pointer.set((e.clientX-rect.left)/rect.width*2-1,-(e.clientY-rect.top)/rect.height*2+1);raycaster.setFromCamera(pointer,camera);
   let nearest=Infinity,found=-1;
   pickers.forEach((mesh,i)=>{if(!mesh||data[i*4+3]<.5)return;worldBox.copy(bounds[i]).translate(mesh.position);if(!raycaster.ray.intersectBox(worldBox,hitPoint))return;const hits=raycaster.intersectObject(mesh,false);if(hits[0]&&hits[0].distance<nearest){nearest=hits[0].distance;found=i;}});
   if(found<0&&amount>.45)found=findTarget(e.clientX-rect.left,e.clientY-rect.top,e.pointerType==='touch'?24:16);if(found>=0){hover.hidden=true;select.current(atlas.parts[found].id);}
  };
  renderer.domElement.addEventListener('pointerdown',down);renderer.domElement.addEventListener('pointermove',move);renderer.domElement.addEventListener('pointerup',up);renderer.domElement.addEventListener('pointercancel',cancel);
  const clock=new T.Clock();let lastExtent=-1,lastLabels=false,lastDayFitted=-1,lastLightDay=-1,moteOpacity=0;
  // Photo mode: bake the current per-organ state into static geometry and path-trace it.
  let photoTracer:WebGLPathTracer|null=null,photoScene:T.Scene|null=null,photoSave=false;
  const requestSave=()=>{photoSave=true;};
  window.addEventListener('atlas-photo-save',requestSave);
  const buildPhoto=()=>{
   const snap=new T.Scene();
   const env=new GradientEquirectTexture();
   env.topColor.copy(skyMat.uniforms.zenith.value as T.Color).convertLinearToSRGB();
   env.bottomColor.copy(skyMat.uniforms.horizon.value as T.Color).convertLinearToSRGB();
   env.update();
   snap.environment=env;snap.background=env;
   const snapMats=new Map<string,T.MeshStandardMaterial>();
   SYSTEMS.forEach(sys=>{const f=FINISH[sys.id]??{rough:.62,env:.35};const d=DETAIL[sys.id];const m=new T.MeshStandardMaterial({vertexColors:true,roughness:f.rough,metalness:.03,side:T.DoubleSide,map:d?.map,normalMap:d?.nmap,normalScale:d?new T.Vector2(d.bump,d.bump):undefined});m.color.setRGB(2,2,2);snapMats.set(sys.id,m);});
   const bySystem:Record<string,T.BufferGeometry[]>={};
   const q=new T.Quaternion(),v=new T.Vector3();
   atlas.parts.forEach((p,i)=>{
    if(data[i*4+3]<.5)return;
    const src=pickers[i]?.geometry;if(!src)return;
    const pos=src.attributes.position,tint=src.attributes.tint;
    const g=new T.BufferGeometry();
    const arr=new Float32Array(pos.count*3),col=new Float32Array(pos.count*3);
    const gs=growthData[i*4+3],off=new T.Vector3(data[i*4],data[i*4+1],data[i*4+2]);
    q.set(rotData[i*4],rotData[i*4+1],rotData[i*4+2],rotData[i*4+3]);
    const pr=colorData[i*4],pg=colorData[i*4+1],pb=colorData[i*4+2];
    for(let k=0;k<pos.count;k++){
     v.fromBufferAttribute(pos,k).sub(anchors[i]).multiplyScalar(gs).applyQuaternion(q).add(anchors[i]).add(off);
     arr[k*3]=v.x;arr[k*3+1]=v.y;arr[k*3+2]=v.z;
     col[k*3]=Math.min(1,pr*tint.getX(k)*2);col[k*3+1]=Math.min(1,pg*tint.getY(k)*2);col[k*3+2]=Math.min(1,pb*tint.getZ(k)*2);
    }
    g.setAttribute('position',new T.BufferAttribute(arr,3));
    g.setAttribute('color',new T.BufferAttribute(col,3));
    g.setAttribute('uv',src.attributes.uv);
    g.setIndex(src.index);
    g.computeVertexNormals();
    (bySystem[p.system]??=[]).push(g);
   });
   Object.entries(bySystem).forEach(([sys,list])=>{const merged=mergeGeometries(list,false);list.forEach(g=>g.dispose());if(!merged)return;snap.add(new T.Mesh(merged,snapMats.get(sys)));});
   // every mesh must share the same attribute set for the tracer's internal merge
   const prepFlat=(g:T.BufferGeometry,hex:number)=>{const c=new T.Color(hex);const n=g.attributes.position.count;const col=new Float32Array(n*3);for(let k=0;k<n;k++){col[k*3]=c.r;col[k*3+1]=c.g;col[k*3+2]=c.b;}g.setAttribute('color',new T.BufferAttribute(col,3));return g;};
   // glossy water disc: the path tracer renders the paddy reflection physically
   const snapWater=new T.Mesh(prepFlat(new T.CircleGeometry(60,64),0x25332b),new T.MeshStandardMaterial({vertexColors:true,roughness:.06,metalness:0}));snapWater.rotation.x=-Math.PI/2;snapWater.position.y=-.012;snap.add(snapWater);
   const snapIsland=new T.Mesh(prepFlat(new T.SphereGeometry(1,48,24),0x3f3122),new T.MeshStandardMaterial({vertexColors:true,roughness:.96}));snapIsland.scale.set(.5,.06,.5);snapIsland.position.y=-.05;snap.add(snapIsland);
   const sun=new T.DirectionalLight(key.color,2.4);sun.position.copy(key.position);snap.add(sun);
   photoScene=snap;
   photoTracer=new WebGLPathTracer(renderer);
   photoTracer.filterGlossyFactor=.5;photoTracer.tiles.set(2,2);photoTracer.bounces=6;
   try{photoTracer.setScene(snap,camera);}catch{sun.removeFromParent();photoTracer.setScene(snap,camera);}
  };
  const teardownPhoto=()=>{
   try{
    photoScene?.traverse(o=>{if(o instanceof T.Mesh){o.geometry.dispose();(Array.isArray(o.material)?o.material:[o.material]).forEach(m=>m?.dispose?.());}});
    (photoScene?.environment as T.Texture|null)?.dispose?.();
    photoTracer?.dispose?.();
   }catch(e){console.warn('photo teardown:',e);}
   photoTracer=null;photoScene=null;
  };
  const animate=()=>{
   if(disposed)return;frame=requestAnimationFrame(animate);const dt=Math.min(clock.getDelta(),.05),s=latest.current;
   if(s.photo&&ready){
    labelLayer.hidden=true;hover.hidden=true;controls.enabled=false;
    if(!photoTracer){photoCb.current?.(0);try{buildPhoto();}catch(e){console.error('photo build failed:',(e as Error).stack??e);throw e;}}
    else{
     try{photoTracer.renderSample();}catch(e){console.error('photo sample failed:',(e as Error).stack??e);teardownPhoto();return;}
     photoCb.current?.(Math.min(1,photoTracer.samples/300));
     if(photoSave){photoSave=false;const a=document.createElement('a');a.href=renderer.domElement.toDataURL('image/png');a.download=`rice-atlas-day-${Math.round(s.day)}.png`;a.click();}
    }
    return;
   }
   if(photoTracer&&!s.photo){teardownPhoto();controls.enabled=true;lastState=null;dirty=true;}
   const changed=lastState?.visible!==s.visible||lastState?.selected!==s.selected||lastState?.isolate!==s.isolate||lastState?.day!==s.day||lastState?.env!==s.env;
   const moving=Math.abs(amount-s.explode)>.0001;
   if(moving){amount=T.MathUtils.damp(amount,s.explode,8,dt);dirty=true;}
   if(s.labels!==lastLabels){lastLabels=s.labels;dirty=true;}
   // idle wind: only while the plant is assembled and not being inspected
   timeU.value+=dt;
   const swayTarget=(reduceMotion||s.isolate)?0:Math.max(0,1-amount*2.2);
   swayU.value=T.MathUtils.damp(swayU.value,swayTarget,4,dt);
   if(swayU.value>.004)dirty=true;
   // drifting water needs continuous frames; hold it still under prefers-reduced-motion
   if(water.visible&&!reduceMotion){waterUniforms.time.value+=dt*.55;dirty=true;}
   // bloom flatters the assembled plant but smears the thin organs of the atlas grid
   // and the close-up isolate/tour views
   bloomPass.strength=s.isolate?0:.22*Math.max(0,1-amount*2.2);bloomPass.enabled=bloomPass.strength>.005;
   // inspection views get steady mid-season light; the assembled view follows the timeline
   const lightDay=amount>.05||s.isolate?60:s.day;
   if(Math.abs(lightDay-lastLightDay)>.25){applySeasonLight(lightDay);lastLightDay=lightDay;dirty=true;}
   // pollen density peaks at anthesis; ambient dust otherwise, none while inspecting
   const anthesis=hasPanicles?Math.exp(-(((s.day-67)/7)**2)):0;
   const moteTarget=amount<.05&&!s.isolate&&ready?.1+.4*anthesis:0;
   moteOpacity=T.MathUtils.damp(moteOpacity,moteTarget,3,dt);
   moteMaterial.opacity=moteOpacity;motes.visible=moteOpacity>.012;
   motes.scale.setScalar(T.MathUtils.lerp(.45,1,T.MathUtils.smoothstep(s.day,5,70)));
   if(motes.visible&&moteDrift.value>0)dirty=true;
   if(changed||moving||lastExtent<0){
    const visible=new Set(s.visible),selection=new Set(s.selected);
    const visibleParts=atlas.parts.filter(p=>s.isolate?selection.has(p.id):visible.has(p.system)||selection.has(p.id));
    const nextLayoutKey=visibleParts.map(p=>p.id).join(',')+':'+camera.aspect.toFixed(3);
    if(nextLayoutKey!==layoutKey){const layout=createExplosionLayout(visibleParts,camera.aspect);packingWidth=layout.width;packingHeight=layout.height;atlas.parts.forEach((p,i)=>{const cell=layout.cells.get(p.id);offsets[i]=cell?new T.Vector3(cell.x,cell.y+.85,0):centers[i].clone();});layoutKey=nextLayoutKey;if(amount>.05&&!s.isolate)fit(s.view,Math.max(0,(amount-.3)/.7));}

    // In explode or isolate views the plant is shown fully grown under optimal conditions;
    // the timeline and environment drive the assembled view. Development runs on thermal time.
    const inspecting=amount>.05||s.isolate;
    const env=inspecting?{n:.85,w:1,t:28}:s.env;
    const eday=inspecting?120:Math.min(120,s.day*devRate(env.t));
    const drought=1-env.w;
    const baseSterility=smooth01((env.t-33)/6);
    const nSat=Math.min(1,env.n/.85);
    const tillersAlive=2+Math.round(6*nSat);
    // lodging: only over-fertilized, heavy, well-watered canopies go down late in the season
    const lodgeRisk=env.n>.9&&eday>95?smooth01((env.n-.9)/.1)*smooth01((eday-95)/15)*smooth01((env.w-.3)/.4)*(1-.7*baseSterility):0;
    const prefixes=culmVecs.map((vecs,ci)=>{const arr=[new T.Vector3()];const acc=new T.Vector3();vecs.forEach((v,ni)=>{const pi=culmIndex[ci][ni];acc.addScaledVector(v,1-(pi>=0?(eday>=119.5?1:organGrow(atlas.parts[pi],eday)):1));arr.push(acc.clone());});return arr;});
    // one nod angle per panicle, taken from its rachis, so branches and grains (born a
    // couple of days later) rotate as a unit instead of lagging and pulling apart
    const nodAngles=rachisIndex.map(pi=>{
     if(pi<0)return 0;
     const rg=atlas.parts[pi].growth!;
     const rst=waveSterility(env,rg.birth);
     const fill=smooth01((eday-(rg.birth+6))/28)*(1-.55*rst)*(1-.35*drought);
     return T.MathUtils.degToRad(58)*(1-fill);
    });
    atlas.parts.forEach((p,i)=>{
     const c=centers[i],destination=offsets[i];let dx=0,dy=0,dz=0;
     if(amount<=.45){const t=amount/.45;const group=SYSTEMS.findIndex(sys=>sys.id===p.system);const angle=group/SYSTEMS.length*Math.PI*2;dx=Math.sin(angle)*t*.48*hscale;dy=(c.y-midY)*t*.28;dz=Math.cos(angle)*t*.48*hscale;}
     else {const t=(amount-.45)/.55,group=SYSTEMS.findIndex(sys=>sys.id===p.system),angle=group/SYSTEMS.length*Math.PI*2;dx=T.MathUtils.lerp(Math.sin(angle)*.48*hscale,destination.x-c.x,t);dy=T.MathUtils.lerp((c.y-midY)*.28,destination.y-c.y,t);dz=T.MathUtils.lerp(Math.cos(angle)*.48*hscale,-c.z,t);}
     let g=eday>=119.5?1:organGrow(p,eday);
     const culm=p.growth?.culm??-1;
     if(eday<119.5&&p.growth&&culm>=0){const pre=prefixes[culm];if(pre){const d=pre[Math.min(Math.max(p.growth.node,0),pre.length-1)];dx-=d.x;dy-=d.y;dz-=d.z;}}
     // source-sink responses: low N shrinks panicles, drought shrinks blades, heat sterilizes grains.
     // Sterility is per panicle: a heat wave only harms panicles that flowered during it.
     const st=(p.system==='Panicle'||p.system==='Grain')&&p.growth?waveSterility(env,p.growth.birth):baseSterility;
     if(p.system==='Panicle'||p.system==='Grain')g*=(.78+.22*nSat)*(1-.12*drought);
     if(p.system==='Grain')g*=1-.3*st;
     if(p.system==='Leaves')g*=1-.12*drought;
     // mechanics: panicles emerge erect and nod as they fill; overloaded culms lodge late season
     let qx=0,qy=0,qz=0,qw=1;
     const isPanicleOrgan=(p.system==='Panicle'||p.system==='Grain')&&p.growth&&p.growth.node>=culmVecs[culm]?.length;
     let rotated=false;
     if(!inspecting&&isPanicleOrgan&&culm>=0&&panicleAxis[culm]&&nodAngles[culm]>.01){nodQ.setFromAxisAngle(panicleAxis[culm]!,-nodAngles[culm]);rotated=true;}else nodQ.identity();
     const la=!inspecting&&lodgeRisk>0&&culm>=0?lodgeRisk*lodgeSeverity[culm]*T.MathUtils.degToRad(55):0;
     if(la>.01){
      lodgeQ.setFromAxisAngle(lodgeAxis[culm],la);
      // the lodge rotation pivots at the culm base, not the organ's own anchor
      tmpV.copy(anchors[i]).sub(culmBase[culm]).applyQuaternion(lodgeQ).add(culmBase[culm]).sub(anchors[i]);
      dx+=tmpV.x;dy+=tmpV.y;dz+=tmpV.z;
      lodgeQ.multiply(nodQ);
      qx=lodgeQ.x;qy=lodgeQ.y;qz=lodgeQ.z;qw=lodgeQ.w;
     }else if(rotated){qx=nodQ.x;qy=nodQ.y;qz=nodQ.z;qw=nodQ.w;}
     rotData.set([qx,qy,qz,qw],i*4);
     growthData.set([anchors[i].x,anchors[i].y,anchors[i].z,g],i*4);
     const cb=p.cbirth??-1;
     const ct=cb<0?1:smooth01((eday-cb)/Math.max(.1,p.cdur??1));
     tmpColor.copy(youngColors[i]).lerp(ripeColors[i],ct);
     if(p.system==='Leaves'||p.system==='Sheath'){tmpColor.lerp(N_PALE,(1-nSat)*.5);tmpColor.lerp(DRY_DULL,drought*.32);}
     if(p.system==='Grain')tmpColor.lerp(STERILE_PALE,st*.65);
     colorData.set([tmpColor.r,tmpColor.g,tmpColor.b,1],i*4);
     const suppressed=!inspecting&&culm>=tillersAlive&&culm>0;
     const selected=selection.has(p.id);data.set([dx,dy,dz,(s.isolate?selected:visible.has(p.system)||selected)&&g>.02&&!suppressed?1:0],i*4);selectedData[i*4]=selected&&!s.isolate?255:0;
     markerPositions.set(data[i*4+3]>.5?[c.x+dx,c.y+dy,c.z+dz]:[10000,10000,10000],i*3);const mesh=pickers[i];if(mesh){mesh.position.set(dx,dy,dz);mesh.updateMatrix();mesh.updateMatrixWorld(true);}
    });partTexture.needsUpdate=true;selectionTexture.needsUpdate=true;growthTexture.needsUpdate=true;colorTexture.needsUpdate=true;rotTexture.needsUpdate=true;markerGeometry.attributes.position.needsUpdate=true;lastState=s;lastExtent=amount;dirty=true;
   }
   if(s.view!==lastView||s.reset!==lastReset){fit(s.view,amount,lastView?4:0);lastView=s.view;lastReset=s.reset;lastDayFitted=s.day;}
   if(Math.abs(lastDayFitted-s.day)>.4&&amount<.1&&!s.isolate){fit(s.view,amount,6);lastDayFitted=s.day;}
   if(moving&&!s.isolate)fit(amount>.5?'front':s.view,Math.max(0,(amount-.3)/.7));
   const isolateKey=s.isolate?s.selected.join(',')+':'+s.reset+':'+s.inspectorOpen+':'+camera.aspect:'';
   if(isolateKey!==lastIsolate||(s.isolate&&moving)){
    if(s.isolate){const box=new T.Box3();atlas.parts.forEach((p,i)=>{if(s.selected.includes(p.id))box.union(bounds[i].clone().translate(new T.Vector3(data[i*4],data[i*4+1],data[i*4+2])));});
     if(!box.isEmpty()){const center=box.getCenter(new T.Vector3()),size=box.getSize(new T.Vector3());const w=el.clientWidth,h=el.clientHeight,mobile=w<768,landscape=w>h&&h<=600;let left=20,right=w-20,top=mobile?175:110,bottom=h-170;const tourRect=document.querySelector('.tour-card')?.getBoundingClientRect();if(tourRect)bottom=Math.min(bottom,tourRect.top-16);if(s.inspectorOpen){if(landscape){right=w-335;top=100;bottom=h-125;}else if(mobile){const sheet=document.querySelector('.detail-sheet')?.getBoundingClientRect(),header=document.querySelector('.identity')?.getBoundingClientRect();top=(header?.bottom??94)+16;bottom=(sheet?.top??h*.58-139)-16;}else{right=w-370;left=w>1100?285:25;}}const availableWidth=Math.max(150,right-left),availableHeight=Math.max(40,bottom-top);camera.setViewOffset(w,h,w/2-(left+right)/2,h/2-(top+bottom)/2,w,h);const distance=Math.max(.07,Math.max(size.y*h/availableHeight,size.x*w/availableWidth/camera.aspect,size.z)/(2*Math.tan(T.MathUtils.degToRad(camera.fov/2)))*1.35);controls.maxDistance=Math.max(40,distance*2);setPose(fitPos.copy(center).addScaledVector(new T.Vector3(.2,.1,1).normalize(),distance),center,5);}
    }else if(lastIsolate){camera.clearViewOffset();fit(s.view,amount,4);}
    lastIsolate=isolateKey;
   }
   if(gliding){
    const k=1-Math.exp(-glideLambda*dt);
    camera.position.lerp(desiredPos,k);controls.target.lerp(desiredTgt,k);
    // auto-rotate takes over near the destination instead of fighting the pursuit
    const eps=controls.autoRotate?.01:1e-7;
    if(camera.position.distanceToSquared(desiredPos)<eps&&controls.target.distanceToSquared(desiredTgt)<eps){if(!controls.autoRotate){camera.position.copy(desiredPos);controls.target.copy(desiredTgt);}gliding=false;}
    controls.update();dirty=true;
   }
   controls.enableRotate=amount<.8;controls.mouseButtons.LEFT=amount<.8?T.MOUSE.ROTATE:T.MOUSE.PAN;controls.touches.ONE=amount<.8?T.TOUCH.ROTATE:T.TOUCH.PAN;water.visible=island.visible=sky.visible=amount<.5&&!s.isolate;const foggy=water.visible;fog.near=foggy?15:1e4;fog.far=foggy?52:2e4;markers.visible=amount>.75;controls.autoRotate=s.rotate&&!s.isolate&&amount<.4;controls.autoRotateSpeed=.65;controls.update();if(controls.autoRotate)dirty=true;
   if(dirty){composer.render();targets=[];if(amount>.45){atlas.parts.forEach((p,i)=>{if(data[i*4+3]<.5)return;let left=Infinity,right=-Infinity,top=Infinity,bottom=-Infinity;for(let corner=0;corner<8;corner++){projected.set(p.bounds[(corner&1)?1:0][0]+data[i*4],p.bounds[(corner&2)?1:0][1]+data[i*4+1],p.bounds[(corner&4)?1:0][2]+data[i*4+2]).project(camera);const x=(projected.x+1)*el.clientWidth/2,y=(1-projected.y)*el.clientHeight/2;left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);}projected.copy(centers[i]).add(new T.Vector3(data[i*4],data[i*4+1],data[i*4+2])).project(camera);if(projected.z< -1||projected.z>1)return;targets.push({index:i,x:(projected.x+1)*el.clientWidth/2,y:(1-projected.y)*el.clientHeight/2,left,right,top,bottom});});}
    const showLabels=!!s.labels&&amount<.05&&!s.isolate&&ready;
    labelLayer.hidden=!showLabels;if(showLabels)layoutLabels();
    dirty=false;}

  };animate();
  const contextLost=(e:Event)=>{e.preventDefault();onError('The 3D session was paused by your device. Reload to continue.');};renderer.domElement.addEventListener('webglcontextlost',contextLost);
  return()=>{disposed=true;abort.abort();cancelAnimationFrame(frame);observer.disconnect();window.removeEventListener('atlas-photo-save',requestSave);teardownPhoto();controls.dispose();geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());scene.traverse(o=>{if(o instanceof T.Mesh&&!geometries.includes(o.geometry)){o.geometry.dispose();const ms=Array.isArray(o.material)?o.material:[o.material];ms.forEach(m=>m.dispose());}});env.dispose();partTexture.dispose();selectionTexture.dispose();colorTexture.dispose();growthTexture.dispose();rotTexture.dispose();detailTextures.forEach(t=>t.dispose());markerGeometry.dispose();markerMaterial.dispose();moteGeometry.dispose();moteMaterial.dispose();bloomPass.dispose();composerTarget.dispose();hover.remove();labelLayer.remove();renderer.dispose();renderer.domElement.remove();};
 },[atlas]);
 return <div className="scene" ref={host}/>;
}
