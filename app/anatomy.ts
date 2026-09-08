export type SystemId = 'Root'|'Stem'|'Sheath'|'Leaves'|'Panicle'|'Grain';
export const SYSTEMS: {id:SystemId;name:string;color:string;description:string}[] = [
 {id:'Grain',name:'Grains',color:'#c78f2c',description:'Each grain is a spikelet: a single floret enclosed by the lemma and palea. After pollination the ovary fills with starch, and the husk turns from green to gold as the grain ripens.'},
 {id:'Panicle',name:'Panicle branches',color:'#97803a',description:'The panicle is the branched inflorescence at the top of each fertile culm. Its arching rachis carries spirally arranged primary branches, each bearing grains on short pedicels.'},
 {id:'Leaves',name:'Leaf blades',color:'#568a37',description:'The long, narrow leaf blades are the photosynthetic engine of the plant. Each blade folds in a shallow V around its midrib, rises steeply, then arches over with a drooping tip.'},
 {id:'Sheath',name:'Leaf sheaths',color:'#699541',description:'Each leaf begins as a sheath that wraps tightly around the culm, stiffening the stem and protecting the younger tissue inside. The blade diverges at the ligule, where the sheath ends.'},
 {id:'Stem',name:'Culms',color:'#93a352',description:'The culm is the jointed stem of the rice plant: hollow internodes separated by solid nodes. A single plant tillers from its base into many culms, each able to carry its own panicle.'},
 {id:'Root',name:'Root system',color:'#a8825b',description:'Rice grows a dense, fibrous mass of adventitious roots from the tillering crown. They anchor the plant in puddled soil and take up the water and nutrients that fill the grain.'}
];
export interface OrganGrowth {birth:number;dur:number;anchor:[number,number,number];culm:number;node:number}
export interface Part {id:string;name:string;conceptId:string;system:SystemId;color?:string;color0?:string;cbirth?:number;cdur?:number;growth?:OrganGrowth;stats?:Record<string,string>;chunk:number;positions:number;normals:number;indices:number;tints:number;vertexCount:number;indexCount:number;bounds:[number[],number[]]}
export interface Concept {id:string;name:string;elements:string[]}
export interface Atlas {version:string;sex?:'male';source?:string;scope?:string;parts:Part[];concepts:Concept[];chunks:{url:string;bytes:number;gzip?:string;gzipBytes?:number}[];triangles:number;growthCulms?:number[][][]}
export type View = 'three-quarter'|'front'|'back'|'side';
export interface Environment {n:number;w:number;t:number;heatwave?:boolean}
export interface SceneState {inspectorOpen?:boolean;explode:number;visible:SystemId[];selected:string[];isolate:boolean;view:View;rotate:boolean;reset:number;labels:boolean;day:number;env:Environment;photo:boolean}
export const SEASON_END=120;
export const DEFAULT_ENV:Environment={n:.85,w:1,t:28};
// Development runs on thermal time: cool seasons stretch it, hot ones compress it.
export const devRate=(t:number)=>Math.max(.5,Math.min(1.35,(t-8)/20));
const sm01=(t:number)=>{const c=Math.max(0,Math.min(1,t));return c*c*(3-2*c);};
// Shared simulation factors, mirrored by the 3D scene's per-organ rules.
export function simFactors(day:number,env:Environment){
 const D=Math.min(SEASON_END,day*devRate(env.t));
 const drought=1-env.w;
 const sterility=sm01((env.t-33)/6);
 const nSat=Math.min(1,env.n/.85);
 const tillersAlive=2+Math.round(6*nSat);
 return {D,drought,sterility,nSat,tillersAlive};
}
// A short heat wave in calendar days. Each spikelet flowers for only an hour or two,
// so sterility depends on whether a panicle's flowering days overlapped the hot spell.
export const FLOWERING_WAVE={start:64,end:72,peak:38.5};
export function waveSterility(env:Environment,headingBirth:number){
 const base=sm01((env.t-33)/6);
 if(!env.heatwave)return base;
 const rate=devRate(env.t);
 const f0=(headingBirth+2)/rate,f1=(headingBirth+8)/rate;   // this panicle's flowering window, calendar days
 const overlap=Math.max(0,Math.min(f1,FLOWERING_WAVE.end)-Math.max(f0,FLOWERING_WAVE.start));
 const wave=(overlap/Math.max(.1,f1-f0))*sm01((FLOWERING_WAVE.peak-33)/6);
 return 1-(1-base)*(1-wave);
}
export interface YieldEstimate {spikelets:number;filled:number;grams:number;tHa:number}
// Yield: filled spikelets on surviving tillers × ~22 mg per grain, scaled to 20 plants/m².
export function yieldEstimate(parts:Part[],day:number,env:Environment):YieldEstimate{
 const {D,drought,tillersAlive}=simFactors(day,env);
 let spikelets=0,filled=0;
 for(const p of parts){
  if(p.system!=='Grain'||!p.stats?.Grains||!p.growth)continue;
  const culm=p.growth.culm;
  if(culm>0&&culm>=tillersAlive)continue;
  const n=parseInt(p.stats.Grains,10)||0;
  const emerged=sm01((D-p.growth.birth)/Math.max(.1,p.growth.dur));
  if(emerged<.05)continue;
  spikelets+=n;
  const fill=sm01((D-(p.growth.birth+6))/28);
  filled+=n*fill*(1-waveSterility(env,p.growth.birth))*(1-.35*drought);
 }
 const grams=filled*.022;
 return {spikelets,filled:Math.round(filled),grams,tHa:grams*.2};
}
export function phenology(day:number){
 if(day<6)return 'Germination';
 if(day<18)return 'Seedling';
 if(day<42)return 'Tillering';
 if(day<60)return 'Stem elongation';
 if(day<68)return 'Booting & heading';
 if(day<76)return 'Flowering';
 if(day<100)return 'Grain filling';
 if(day<115)return 'Ripening';
 return 'Mature';
}
export type StageId = 'seedling'|'tillering'|'heading'|'maturity';
export const STAGES:{id:StageId;name:string;description:string}[] = [
 {id:'seedling',name:'Seedling',description:'A single shoot a few weeks after germination: the first leaves and the beginnings of the root system.'},
 {id:'tillering',name:'Tillering',description:'The plant branches from its crown into multiple tillers and builds leaf area and roots.'},
 {id:'heading',name:'Heading',description:'Panicles emerge from the flag leaf sheaths, still green and semi-erect, as flowering begins.'},
 {id:'maturity',name:'Maturity',description:'Grain filling is complete: panicles nod under the weight of golden, ripened grains.'}
];
export interface TourStep {title:string;text:string;concept:string}
export const TOUR:TourStep[] = [
 {concept:'Roots',title:'Start below ground',text:'Everything a grain of rice will become starts here: a dense fibrous mat of adventitious roots grown from the crown. In a flooded paddy these roots anchor the plant in soft mud and pull in the water and nutrients that will eventually fill the grain.'},
 {concept:'Culms',title:'The culms',text:'From the crown rise the culms — jointed, mostly hollow stems. The lower internodes stay short; the upper ones elongate rapidly before heading, lifting the developing panicle above the canopy. One plant tillers into many culms, and each can carry its own panicle.'},
 {concept:'Sheaths',title:'Wrapped in sheaths',text:'Much of what looks like stem is actually leaf. Every leaf begins as a sheath wrapped tightly around the culm, stiffening it like a sleeve. Where the sheath ends and the blade folds away sits the ligule — a rice-defining detail worth finding in the model.'},
 {concept:'Blades',title:'The engine room',text:'The long, V-folded blades are where sunlight becomes sugar. Their steep rise and arching droop is not accidental: it spreads light capture through the canopy instead of letting the top leaves shade everything below.'},
 {concept:'FlagLeaves',title:'The flag leaf',text:'The last leaf on each culm is special. Short, wide, and held nearly erect beside the panicle, the flag leaf alone supplies most of the photosynthate that fills the grains. Breeders obsess over its angle for good reason.'},
 {concept:'Panicles',title:'The panicle',text:'At heading, the panicle pushes out of the flag leaf sheath on the final internode. Its rachis carries spirally arranged primary branches, each dividing again into branchlets — the scaffold on which every grain hangs.'},
 {concept:'Grains',title:'Grains and awns',text:'Each spikelet flowers for barely an hour or two on a sunny morning, then spends weeks filling with starch. As the grains gain weight the whole panicle nods over — the classic silhouette of a rice crop nearing harvest. The bristle on each husk tip is the awn.'},
 {concept:'GrainCutaway',title:'Inside a grain',text:'Slice a grain open: the husk (lemma and palea) encloses the starchy endosperm — the white rice we eat — and, at the base, the tiny embryo, the germ from which the next plant grows. Milling removes husk, bran, and usually the embryo with it.'}
];
export const DEFAULT_VISIBLE:SystemId[] = ['Root','Stem','Sheath','Leaves','Panicle','Grain'];
export const EXPLANATIONS:Record<string,string> = {
 'fibrous root system':'Unlike a taproot crop, rice builds its root system from scratch after germination: wave after wave of adventitious roots emerge from the buried nodes of the crown. The result is a dense fibrous mat that holds the plant upright in soft, flooded soil.',
 'culms (stems)':'Each culm is a jointed, mostly hollow stem. The lower internodes stay short and stack inside the leaf sheaths; the upper ones elongate rapidly before heading, lifting the panicle above the canopy.',
 'leaf sheaths':'The sheath is the lower half of every rice leaf. It wraps the culm in a tight tube, adding mechanical strength — much of what looks like "stem" on a rice plant is actually layered sheaths.',
 'leaf blades':'Rice blades are linear and parallel-veined, with a prominent midrib that folds the blade into a shallow V. The V opens as the blade matures, and the tip droops as the leaf ages.',
 'flag leaves':'The flag leaf is the last and most important leaf on each culm. Short, wide, and held nearly erect just below the panicle, it supplies most of the photosynthate that fills the grain.',
 'panicles (inflorescences)':'At heading, the panicle pushes out of the flag leaf sheath and arches over as the grains gain weight. A well-filled panicle carries on the order of a hundred spikelets.',
 'grains (spikelets)':'Each rice spikelet holds a single floret. After it flowers — briefly, for an hour or two, on a sunny morning — the ovary swells with starch and the husk ripens to gold.',
 'tillering crown':'The crown is the compressed base of the plant, a stack of unelongated nodes at or below the soil surface. Every tiller and every adventitious root originates here.',
 'main culm':'The main culm is the original shoot of the plant, grown directly from the seed. It is the tallest culm and the first to flower; the surrounding tillers follow its lead by a few days.',
 'ligules & auricles':'At the junction where blade meets sheath, rice carries a pale membranous ligule flanked by two small clasping auricles. This trio is the classic field mark that separates rice from barnyardgrass, which lacks them.',
 'grain in cross-section':'A grain sliced lengthwise: the husk (lemma and palea) encloses the starchy endosperm — the white rice of the table — and the small embryo at the base, from which the next plant would grow.'
};
const KEYWORD_NOTES:[string,string][] = [
 ['endosperm','The starchy body of the grain — about nine-tenths of its weight. Milled and polished, this is white rice. It exists to feed the embryo during germination.'],
 ['embryo','The germ of the grain, tucked against the husk at the base. It holds the miniature root and shoot of the next plant, plus the scutellum that digests endosperm starch during germination.'],
 ['husk)','The lemma and palea: two stiff, silica-hardened bracts that interlock around the floret. They protect the filling grain and stay on as the inedible hull removed at milling.'],
 ['flag leaf','The flag leaf is the topmost blade on the culm, held nearly erect beside the panicle. It is the main source of the sugars that fill the grains below it.'],
 ['ligule','The pale collar at the top of the sheath is the ligule, flanked by two clasping auricles. Together they seal the sheath against the culm and mark rice apart from look-alike grasses.'],
 ['sheath','This sheath wraps the culm in a stiff tube and supports the stem. The blade separates from it at the ligule.'],
 ['blade','A photosynthetic leaf blade: linear, parallel-veined, folded in a shallow V along its midrib, arching over with a drooping tip.'],
 ['internode','A single hollow segment of the culm between two solid nodes. The slight bulge at its base is the node, where a leaf and a bud attach.'],
 ['rachis','The main axis of the panicle. It emerges upright from the flag leaf sheath and nods over as the developing grains gain weight.'],
 ['grain','Ripening spikelets, each a single floret whose ovary is filling with starch inside the lemma and palea. The bristle extending from each husk tip is the awn.'],
 ['branch','A primary branch of the panicle, bearing grains on short pedicels. Branches are arranged spirally around the rachis.'],
 ['senescent','A fully senesced lower leaf. As the plant ripens it withdraws nitrogen and sugars from its oldest leaves and moves them into the filling grain, leaving the leaf brown but still attached.'],
 ['spent seed','The seed the plant grew from, still clinging to the crown. Its endosperm fed the seedling until the leaves could photosynthesize; only the empty husk and bran remain.'],
 ['root','An adventitious root, one of the dense fibrous mass grown from the crown. It anchors the plant and absorbs water and nutrients.'],
 ['crown','The compressed stem base from which every tiller and root arises.']
];
export function explanation(name:string,system:SystemId){
 const key=name.toLowerCase();
 if(EXPLANATIONS[key])return EXPLANATIONS[key];
 for(const [k,text] of KEYWORD_NOTES)if(key.includes(k))return text;
 return SYSTEMS.find(s=>s.id===system)?.description ?? '';
}
