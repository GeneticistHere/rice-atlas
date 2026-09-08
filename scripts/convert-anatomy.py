"""Convert official BodyParts3D 4.0 OBJ meshes without altering topology.
Usage: python3 scripts/convert-anatomy.py OBJ_DIRECTORY CONCEPT_MAP SYSTEM_MAP
Source and attribution: public/ATTRIBUTION.md. Geometry positions change mm/Z-up
into meters/Y-up; normals become signed 16-bit and parts are grouped into chunks.
"""
import sys,json,re,struct,math
from pathlib import Path
from array import array
root=Path(__file__).resolve().parents[1]
source=Path(sys.argv[1]); metadata=json.loads(Path(sys.argv[2]).read_text()); systemdata=json.loads(Path(sys.argv[3]).read_text()) if len(sys.argv)>3 else {}
base=sys.argv[4] if len(sys.argv)>4 else 'atlas'
out=root/'public/models';out.mkdir(parents=True,exist_ok=True)
# Accept the research map's element records or a direct id -> system mapping.
systems=systemdata.get('systems',systemdata.get('mapping',systemdata.get('elements',systemdata.get('meshes',systemdata))))
if isinstance(systems,list): systems={x['id']:x for x in systems}
parts=[];chunks=[];blob=bytearray();chunk=0;total_triangles=0
for element in metadata['elements']:
    mesh=source/(element['id']+'.obj')
    record=systemdata.get('parts',{}).get(element['id'],{})
    # General OBJ parsing: v lines may carry tint colors, and faces may index
    # position/uv/normal streams independently (Blender-refined organs do).
    positions=[];cols=[];vts=[];vns=[];corner_map={}
    vertices=[];normals=[];indices=[];tints=[];uvs=[];name=element['name']
    for line in mesh.read_text().splitlines():
        if line.startswith('# English name : '):name=line.split(' : ',1)[1].strip() or element['name']
        elif line.startswith('v '):
            fields=line.split()[1:]
            positions.append((float(fields[0]),float(fields[1]),float(fields[2])))
            cols.append((float(fields[3]),float(fields[4]),float(fields[5])) if len(fields)>=6 else (1.0,1.0,1.0))
        elif line.startswith('vt '):
            u,vv=map(float,line.split()[1:3]);vts.append((u,vv))
        elif line.startswith('vn '):
            x,y,z=map(float,line.split()[1:4]);vns.append((x,y,z))
        elif line.startswith('f '):
            corner_idx=[]
            for token in line.split()[1:]:
                comp=token.split('/')
                vi=int(comp[0])-1
                ti=int(comp[1])-1 if len(comp)>1 and comp[1] else -1
                ni=int(comp[2])-1 if len(comp)>2 and comp[2] else -1
                key=(vi,ti,ni)
                idx=corner_map.get(key)
                if idx is None:
                    idx=len(corner_map);corner_map[key]=idx
                    x,y,z=positions[vi];vertices.extend([x*.001,y*.001,z*.001])
                    tints.extend(min(255,max(0,round(c*127.5))) for c in cols[vi])
                    u,vv=vts[ti] if ti>=0 else (0.0,0.0);uvs.extend([u,vv])
                    nx,ny,nz=vns[ni] if ni>=0 else (0.0,1.0,0.0);normals.extend([round(nx*32767),round(ny*32767),round(nz*32767)])
                corner_idx.append(idx)
            for j in range(1,len(corner_idx)-1):indices.extend([corner_idx[0],corner_idx[j],corner_idx[j+1]])
    assert len(normals)==len(vertices),element['id']
    assert len(vertices) and max(indices)<len(vertices)//3
    if len(blob)>7_000_000:
        (out/f'{base}-{chunk}.bin').write_bytes(blob);chunks.append({'url':f'/models/{base}-{chunk}.bin','bytes':len(blob)});blob=bytearray();chunk+=1
    def append(values,fmt):
        while len(blob)%4:blob.append(0)
        offset=len(blob);blob.extend(array(fmt,values).tobytes());return offset
    po=append(vertices,'f');no=append(normals,'h');io=append(indices,'I');to=append(tints,'B');uo=append(uvs,'f')
    bounds=[[min(vertices[i::3]) for i in range(3)],[max(vertices[i::3]) for i in range(3)]]
    system=systems.get(element['id'],'connective')
    if isinstance(system,dict):system=system.get('system',system.get('category','connective'))
    part={'id':element['id'],'name':record.get('name',name),'conceptId':record.get('conceptId',element['conceptId']),'system':system,'chunk':chunk,'positions':po,'normals':no,'indices':io,'tints':to,'uvs':uo,'vertexCount':len(vertices)//3,'indexCount':len(indices),'bounds':bounds}
    if element.get('color'):part['color']=element['color']
    if element.get('stats'):part['stats']=element['stats']
    if element.get('color0'):part['color0']=element['color0']
    if element.get('cbirth') is not None:part['cbirth']=element['cbirth'];part['cdur']=element['cdur']
    g=element.get('growth')
    if g:part['growth']={'birth':g['birth'],'dur':g['dur'],'anchor':[round(v*.001,5) for v in g['anchor']],'culm':g.get('culm',-1),'node':g.get('node',-1)}
    parts.append(part)
    total_triangles+=len(indices)//3
(out/f'{base}-{chunk}.bin').write_bytes(blob);chunks.append({'url':f'/models/{base}-{chunk}.bin','bytes':len(blob)})
manifest={'version':'Oryza sativa FSPM 1.0','parts':parts,'chunks':chunks,'triangles':total_triangles,'concepts':[{k:v for k,v in c.items() if k in ['id','name','elements']} for c in metadata['concepts']],'growthCulms':[[[round(v*.001,5) for v in vec] for vec in culm] for culm in metadata.get('growthCulms',[])]}
(out/f'{base}.json').write_text(json.dumps(manifest,separators=(',',':')))
print(json.dumps({'parts':len(parts),'concepts':len(manifest['concepts']),'triangles':total_triangles,'bytes':sum(c['bytes'] for c in chunks),'chunks':len(chunks),'systems':sorted(set(p['system'] for p in parts))},indent=2))
