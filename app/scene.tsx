import {useEffect,useRef} from 'react';
import * as T from 'three';
import {OrbitControls} from 'three/examples/jsm/controls/OrbitControls.js';
import {RoomEnvironment} from 'three/examples/jsm/environments/RoomEnvironment.js';
import {mergeGeometries} from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {createExplosionLayout} from './explosion-layout';
import {decodeModelResponse} from './model-download';
import {PointerTap} from './pointer-tap';
import {SYSTEMS,devRate,waveSterility,type Atlas,type SceneState} from './anatomy';
interface Props {atlas:Atlas;state:SceneState;onSelect:(id:string)=>void;onProgress:(n:number)=>void;onError:(s:string)=>void}
export default function AnatomyScene({atlas,state,onSelect,onProgress,onError}:Props){
 const host=useRef<HTMLDivElement>(null),latest=useRef(state),select=useRef(onSelect);
 latest.current=state;select.current=onSelect;
 useEffect(()=>{
  const el=host.current!;let disposed=false,frame=0,dirty=true,ready=false,lastView='',lastReset=-1,lastIsolate='',layoutKey='',amount=0;
  let lastState:SceneState|null=null;
  const abort=new AbortController();
  let renderer:T.WebGLRenderer;
  try{renderer=new T.WebGLRenderer({antialias:true,alpha:false,powerPreference:'high-performance'});}catch{onError('This browser could not start the 3D viewer. Please try a browser with WebGL enabled.');return;}
  renderer.setPixelRatio(Math.min(devicePixelRatio,innerWidth<768?1.5:2));renderer.setClearColor('#f2f3f3');renderer.outputColorSpace=T.SRGBColorSpace;renderer.toneMapping=T.ACESFilmicToneMapping;renderer.toneMappingExposure=1.12;renderer.shadowMap.enabled=true;renderer.shadowMap.type=T.PCFSoftShadowMap;el.appendChild(renderer.domElement);
  renderer.domElement.setAttribute('aria-label','Interactive rice plant anatomy. Drag to orbit, pinch or scroll to zoom, and tap an organ to inspect it.');
  const scene=new T.Scene(),camera=new T.PerspectiveCamera(34,1,.005,100),controls=new OrbitControls(camera,renderer.domElement);
  camera.position.set(1.4,1.05,3.6);controls.target.set(0,.85,0);controls.enableDamping=true;controls.dampingFactor=.085;controls.minDistance=.07;controls.maxDistance=40;controls.maxPolarAngle=Math.PI*.96;controls.addEventListener('change',()=>{dirty=true;});
  const pmrem=new T.PMREMGenerator(renderer),room=new RoomEnvironment(),env=pmrem.fromScene(room,.04);scene.environment=env.texture;room.dispose();pmrem.dispose();
  scene.add(new T.HemisphereLight(0xffffff,0xd6d3c4,1.3));
  scene.add(new T.AmbientLight(0xf6f2e6,.5));
  const key=new T.DirectionalLight(0xfffaf4,1.1);key.position.set(-2,4,3);scene.add(key);
  key.castShadow=true;key.shadow.mapSize.set(2048,2048);key.shadow.bias=-.0002;key.shadow.normalBias=.02;
  key.shadow.camera.left=key.shadow.camera.bottom=-2.2;key.shadow.camera.right=key.shadow.camera.top=2.2;key.shadow.camera.near=.5;key.shadow.camera.far=12;
  const rim=new T.DirectionalLight(0xe9f0ff,.6);rim.position.set(2,2,-3);scene.add(rim);
  const fill=new T.DirectionalLight(0xfff3dd,.55);fill.position.set(3,1.2,1.5);scene.add(fill);
  const ground=new T.Mesh(new T.CircleGeometry(30,96),new T.MeshStandardMaterial({color:0xd5d9dc,roughness:1}));ground.rotation.x=-Math.PI/2;ground.position.y=-.019;ground.receiveShadow=true;scene.add(ground);
  const platform=new T.Mesh(new T.CylinderGeometry(.68,.7,.028,100),new T.MeshStandardMaterial({color:0xeeeeec,metalness:.12,roughness:.67}));platform.position.y=-.016;platform.receiveShadow=true;scene.add(platform);
  const ring=new T.Mesh(new T.RingGeometry(.63,.632,128),new T.MeshBasicMaterial({color:0x8c969f,transparent:true,opacity:.4,side:T.DoubleSide}));ring.rotation.x=-Math.PI/2;ring.position.y=.001;scene.add(ring);
  const innerRing=new T.Mesh(new T.RingGeometry(.55,.551,128),new T.MeshBasicMaterial({color:0xa4aeb8,transparent:true,opacity:.16,side:T.DoubleSide}));innerRing.rotation.x=-Math.PI/2;innerRing.position.y=.001;scene.add(innerRing);
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
  const panicleAxis=culmVecs.map((_,ci)=>{const pi=atlas.parts.findIndex(p=>p.system==='Panicle'&&p.growth?.culm===ci&&p.name.includes('rachis'));if(pi<0)return null;const dir=centers[pi].clone().sub(anchors[pi]);dir.y=0;if(dir.lengthSq()<1e-8)dir.set(1,0,0);dir.normalize();return new T.Vector3(-dir.z,0,dir.x);});
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
  // Shared time/sway uniforms drive a gentle wind in both the beauty and shadow passes.
  const timeU={value:0},swayU={value:0},reduceMotion=matchMedia('(prefers-reduced-motion: reduce)').matches;
  const SWAY_VERTEX='float swayGate = smoothstep(0.25, 1.6, transformed.y); float swayPhase = time*1.35 + position.y*2.1 + position.x*1.6 + partIndex*0.13; transformed += vec3(sin(swayPhase), 0.0, 0.8*cos(swayPhase*0.77)) * (sway * 0.009 * swayGate);';
  const GROW_VERTEX='vec4 grow = texture2D(growthState, stateUv); vec3 gpv = (transformed - grow.xyz) * grow.w; gpv += 2.0 * cross(rq.xyz, cross(rq.xyz, gpv) + rq.w * gpv); transformed = grow.xyz + gpv;';
  const FINISH:Record<string,{rough:number;env:number}>={Leaves:{rough:.48,env:.5},Sheath:{rough:.55,env:.4},Stem:{rough:.62,env:.35},Grain:{rough:.42,env:.6},Panicle:{rough:.6,env:.35},Root:{rough:.85,env:.15}};
  const materialFor=(system:string)=>{
   const finish=FINISH[system]??{rough:.62,env:.35};
   const m=new T.MeshStandardMaterial({color:SYSTEMS.find(s=>s.id===system)?.color??'#aebbb8',metalness:.05,roughness:finish.rough,side:T.DoubleSide});m.envMapIntensity=finish.env;
   m.onBeforeCompile=shader=>{
    shader.uniforms.partState={value:partTexture};shader.uniforms.selectionState={value:selectionTexture};shader.uniforms.colorState={value:colorTexture};shader.uniforms.growthState={value:growthTexture};shader.uniforms.rotState={value:rotTexture};shader.uniforms.stateWidth={value:width};shader.uniforms.time=timeU;shader.uniforms.sway=swayU;
    shader.vertexShader='attribute float partIndex; attribute vec3 tint; uniform sampler2D partState; uniform sampler2D selectionState; uniform sampler2D colorState; uniform sampler2D growthState; uniform sampler2D rotState; uniform float stateWidth; uniform float time; uniform float sway; varying float partVisible; varying float partSelected; varying vec3 partColor; varying vec3 vTint;\n'+shader.vertexShader;
    shader.vertexShader=shader.vertexShader.replace('#include <beginnormal_vertex>','#include <beginnormal_vertex>\nvec2 stateUv = vec2((partIndex + 0.5) / stateWidth, 0.5); vec4 rq = texture2D(rotState, stateUv); objectNormal = objectNormal + 2.0 * cross(rq.xyz, cross(rq.xyz, objectNormal) + rq.w * objectNormal);');
    shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\n'+GROW_VERTEX+' '+SWAY_VERTEX+'\nvec4 state = texture2D(partState, stateUv); transformed += state.xyz; partVisible = state.w; partSelected = texture2D(selectionState, stateUv).r; partColor = texture2D(colorState, stateUv).rgb; vTint = tint * 2.0;');
    shader.fragmentShader='varying float partVisible; varying float partSelected; varying vec3 partColor; varying vec3 vTint;\n'+shader.fragmentShader;
    // Thin organs are single-surface sheets; light whichever side faces the camera.
    if(system==='Leaves')shader.fragmentShader=shader.fragmentShader.replace('#include <normal_fragment_begin>','#include <normal_fragment_begin>\nif (dot(normal, normalize(vViewPosition)) < 0.0) normal = -normal;');
    shader.fragmentShader=shader.fragmentShader.replace('#include <clipping_planes_fragment>','#include <clipping_planes_fragment>\nif (partVisible < 0.5) discard;');
    shader.fragmentShader=shader.fragmentShader.replace('#include <color_fragment>','#include <color_fragment>\ndiffuseColor.rgb = partColor * vTint;\ndiffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.42, 0.85, 0.78), partSelected * 0.5);');
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
    g.boundingBox=bounds[i].clone();g.computeBoundingSphere();const pick=new T.Mesh(g);pick.matrixAutoUpdate=false;pickers[i]=pick;geometries.push(g);
    g.setAttribute('partIndex',new T.BufferAttribute(new Float32Array(p.vertexCount).fill(i),1));
    const list=groups.get(p.system)??[];list.push(g);groups.set(p.system,list);
   });
   groups.forEach((gs,system)=>{const geometry=mergeGeometries(gs,false);if(!geometry)throw new Error('Could not assemble anatomy geometry.');geometries.push(geometry);const mesh=new T.Mesh(geometry,mats.get(system as never));mesh.frustumCulled=false;mesh.castShadow=true;mesh.receiveShadow=true;mesh.customDepthMaterial=depthMaterial;scene.add(mesh);});
   lastState=null;loaded++;onProgress(Math.round(loaded/atlas.chunks.length*100));dirty=true;
  };
  (async()=>{try{let cursor=0;await Promise.all(Array.from({length:3},async()=>{while(cursor<atlas.chunks.length){const i=cursor++;await loadChunk(i);}}));if(!disposed){ready=true;dirty=true;}}catch(e){if(!disposed)onError(e instanceof Error?e.message:'Could not load the anatomy.');}})();
  const fit=(view:string,extent=0)=>{
   // Frame tighter and lower while the plant is young, pulling back as it grows.
   const dayT=T.MathUtils.smoothstep(latest.current.day??120,5,70);
   const dayScale=T.MathUtils.lerp(.42,1,dayT);
   const aspect=camera.aspect,mobile=el.clientWidth<768,normalDistance=(mobile?Math.max(4.5,1.8*el.clientHeight/Math.max(160,el.clientHeight-350)/(2*Math.tan(T.MathUtils.degToRad(camera.fov/2)))):4)*hscale*(extent>.1?1:dayScale);
   const reservedHeight=mobile?350:270;const availableAspect=Math.max(.35,(el.clientWidth-(mobile?40:340))/Math.max(160,el.clientHeight-reservedHeight));const atlasDistance=Math.max(packingHeight,packingWidth/availableAspect)/(2*Math.tan(T.MathUtils.degToRad(camera.fov/2)))*(el.clientHeight/Math.max(160,el.clientHeight-reservedHeight))*1.08;
   const distance=T.MathUtils.lerp(normalDistance,Math.max(.2,atlasDistance),extent);if(extent>.8)view='front';
   const direction=view==='front'?new T.Vector3(0,.02,1):view==='back'?new T.Vector3(0,.02,-1):view==='side'?new T.Vector3(1,.02,0):new T.Vector3(.35,.06,1).normalize();
   controls.target.set(extent>.1&&el.clientWidth>767?-packingWidth*.12:0,extent>.1?.85:(mobile?midY*1.05:midY*.82)*T.MathUtils.lerp(.62,1,dayT),0);camera.position.copy(controls.target).addScaledVector(direction,distance);controls.update();dirty=true;
  };
  const resize=()=>{layoutKey='';lastState=null;renderer.setPixelRatio(Math.min(devicePixelRatio,el.clientWidth<768||el.clientHeight<600?1.5:2));camera.aspect=el.clientWidth/el.clientHeight;camera.updateProjectionMatrix();renderer.setSize(el.clientWidth,el.clientHeight);fit(latest.current.view,amount);};const observer=new ResizeObserver(resize);observer.observe(el);
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
  const clock=new T.Clock();let lastExtent=-1,lastLabels=false,lastDayFitted=-1;
  const animate=()=>{
   if(disposed)return;frame=requestAnimationFrame(animate);const dt=Math.min(clock.getDelta(),.05),s=latest.current;
   const changed=lastState?.visible!==s.visible||lastState?.selected!==s.selected||lastState?.isolate!==s.isolate||lastState?.day!==s.day||lastState?.env!==s.env;
   const moving=Math.abs(amount-s.explode)>.0001;
   if(moving){amount=T.MathUtils.damp(amount,s.explode,8,dt);dirty=true;}
   if(s.labels!==lastLabels){lastLabels=s.labels;dirty=true;}
   // idle wind: only while the plant is assembled and not being inspected
   timeU.value+=dt;
   const swayTarget=(reduceMotion||s.isolate)?0:Math.max(0,1-amount*2.2);
   swayU.value=T.MathUtils.damp(swayU.value,swayTarget,4,dt);
   if(swayU.value>.004)dirty=true;
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
     if(!inspecting&&isPanicleOrgan&&culm>=0&&panicleAxis[culm]){
      const fill=smooth01((eday-(p.growth!.birth+6))/28)*(1-.55*st)*(1-.35*drought);
      const nod=T.MathUtils.degToRad(58)*(1-fill);
      if(nod>.01){nodQ.setFromAxisAngle(panicleAxis[culm]!,-nod);rotated=true;}else nodQ.identity();
     }else nodQ.identity();
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
   if(s.view!==lastView||s.reset!==lastReset){fit(s.view,amount);lastView=s.view;lastReset=s.reset;lastDayFitted=s.day;}
   if(Math.abs(lastDayFitted-s.day)>.4&&amount<.1&&!s.isolate){fit(s.view,amount);lastDayFitted=s.day;}
   if(moving&&!s.isolate)fit(amount>.5?'front':s.view,Math.max(0,(amount-.3)/.7));
   const isolateKey=s.isolate?s.selected.join(',')+':'+s.reset+':'+s.inspectorOpen+':'+camera.aspect:'';
   if(isolateKey!==lastIsolate||(s.isolate&&moving)){
    if(s.isolate){const box=new T.Box3();atlas.parts.forEach((p,i)=>{if(s.selected.includes(p.id))box.union(bounds[i].clone().translate(new T.Vector3(data[i*4],data[i*4+1],data[i*4+2])));});
     if(!box.isEmpty()){const center=box.getCenter(new T.Vector3()),size=box.getSize(new T.Vector3());const w=el.clientWidth,h=el.clientHeight,mobile=w<768,landscape=w>h&&h<=600;let left=20,right=w-20,top=mobile?175:110,bottom=h-170;const tourRect=document.querySelector('.tour-card')?.getBoundingClientRect();if(tourRect)bottom=Math.min(bottom,tourRect.top-16);if(s.inspectorOpen){if(landscape){right=w-335;top=100;bottom=h-125;}else if(mobile){const sheet=document.querySelector('.detail-sheet')?.getBoundingClientRect(),header=document.querySelector('.identity')?.getBoundingClientRect();top=(header?.bottom??94)+16;bottom=(sheet?.top??h*.58-139)-16;}else{right=w-370;left=w>1100?285:25;}}const availableWidth=Math.max(150,right-left),availableHeight=Math.max(40,bottom-top);camera.setViewOffset(w,h,w/2-(left+right)/2,h/2-(top+bottom)/2,w,h);const distance=Math.max(.07,Math.max(size.y*h/availableHeight,size.x*w/availableWidth/camera.aspect,size.z)/(2*Math.tan(T.MathUtils.degToRad(camera.fov/2)))*1.35);controls.maxDistance=Math.max(40,distance*2);controls.target.copy(center);camera.position.copy(center).add(new T.Vector3(.2,.1,1).normalize().multiplyScalar(distance));controls.update();dirty=true;}
    }else if(lastIsolate){camera.clearViewOffset();fit(s.view,amount);}
    lastIsolate=isolateKey;
   }
   controls.enableRotate=amount<.8;controls.mouseButtons.LEFT=amount<.8?T.MOUSE.ROTATE:T.MOUSE.PAN;controls.touches.ONE=amount<.8?T.TOUCH.ROTATE:T.TOUCH.PAN;ground.visible=platform.visible=ring.visible=innerRing.visible=amount<.5&&!s.isolate;markers.visible=amount>.75;controls.autoRotate=s.rotate&&!s.isolate&&amount<.4;controls.autoRotateSpeed=.65;controls.update();if(controls.autoRotate)dirty=true;
   if(dirty){renderer.render(scene,camera);targets=[];if(amount>.45){atlas.parts.forEach((p,i)=>{if(data[i*4+3]<.5)return;let left=Infinity,right=-Infinity,top=Infinity,bottom=-Infinity;for(let corner=0;corner<8;corner++){projected.set(p.bounds[(corner&1)?1:0][0]+data[i*4],p.bounds[(corner&2)?1:0][1]+data[i*4+1],p.bounds[(corner&4)?1:0][2]+data[i*4+2]).project(camera);const x=(projected.x+1)*el.clientWidth/2,y=(1-projected.y)*el.clientHeight/2;left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);}projected.copy(centers[i]).add(new T.Vector3(data[i*4],data[i*4+1],data[i*4+2])).project(camera);if(projected.z< -1||projected.z>1)return;targets.push({index:i,x:(projected.x+1)*el.clientWidth/2,y:(1-projected.y)*el.clientHeight/2,left,right,top,bottom});});}
    const showLabels=!!s.labels&&amount<.05&&!s.isolate&&ready;
    labelLayer.hidden=!showLabels;if(showLabels)layoutLabels();
    dirty=false;}

  };animate();
  const contextLost=(e:Event)=>{e.preventDefault();onError('The 3D session was paused by your device. Reload to continue.');};renderer.domElement.addEventListener('webglcontextlost',contextLost);
  return()=>{disposed=true;abort.abort();cancelAnimationFrame(frame);observer.disconnect();controls.dispose();geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());scene.traverse(o=>{if(o instanceof T.Mesh&&!geometries.includes(o.geometry)){o.geometry.dispose();const ms=Array.isArray(o.material)?o.material:[o.material];ms.forEach(m=>m.dispose());}});env.dispose();partTexture.dispose();selectionTexture.dispose();colorTexture.dispose();growthTexture.dispose();markerGeometry.dispose();markerMaterial.dispose();hover.remove();labelLayer.remove();renderer.dispose();renderer.domElement.remove();};
 },[atlas]);
 return <div className="scene" ref={host}/>;
}
