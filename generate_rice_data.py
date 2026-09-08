import os
import json
import math

out_dir = "rice_obj"
os.makedirs(out_dir, exist_ok=True)

def write_obj(filename, vertices, faces):
    with open(os.path.join(out_dir, filename), "w") as f:
        for v in vertices:
            f.write(f"v {v[0]} {v[1]} {v[2]}\n")
        # simple normals pointing up or out
        for v in vertices:
            # normalized vector
            length = math.sqrt(v[0]**2 + v[1]**2 + v[2]**2)
            if length == 0: length = 1
            f.write(f"vn {v[0]/length} {v[1]/length} {v[2]/length}\n")
        
        for face in faces:
            # obj uses 1-based indexing
            f.write("f " + " ".join([f"{i+1}//{i+1}" for i in face]) + "\n")

# Procedurally generate simple meshes
def generate_cylinder(radius, height, segments, offset_y=0):
    vertices = []
    faces = []
    # bottom center
    vertices.append((0, offset_y, 0))
    # top center
    vertices.append((0, offset_y + height, 0))
    for i in range(segments):
        angle = 2 * math.pi * i / segments
        x = radius * math.cos(angle)
        z = radius * math.sin(angle)
        vertices.append((x, offset_y, z))
        vertices.append((x, offset_y + height, z))
    
    # 0 is bottom center, 1 is top center
    # bottom points are 2, 4, 6...
    # top points are 3, 5, 7...
    for i in range(segments):
        next_i = (i + 1) % segments
        bottom1 = 2 + 2*i
        top1 = 3 + 2*i
        bottom2 = 2 + 2*next_i
        top2 = 3 + 2*next_i
        
        # side faces (triangles)
        faces.append((bottom1, bottom2, top1))
        faces.append((bottom2, top2, top1))
        
        # bottom cap
        faces.append((0, bottom2, bottom1))
        # top cap
        faces.append((1, top1, top2))
        
    return vertices, faces

def generate_leaf(width, length, offset_y=0, angle_deg=0):
    # A simple curved plane
    vertices = []
    faces = []
    angle = math.radians(angle_deg)
    
    segments = 5
    for i in range(segments + 1):
        t = i / segments
        y = offset_y + t * length
        z = t * length * math.sin(angle)
        x = 0
        w = width * (1 - abs(t - 0.5)*2) if t != 0 else width
        
        vertices.append((x - w/2, y, z))
        vertices.append((x + w/2, y, z))
        
    for i in range(segments):
        v1 = i * 2
        v2 = i * 2 + 1
        v3 = (i + 1) * 2
        v4 = (i + 1) * 2 + 1
        faces.append((v1, v2, v3))
        faces.append((v2, v4, v3))
        
    return vertices, faces

print("Generating root...")
# scale models somewhat large because convert-anatomy scales down (* .001)
# actually the converter scales * .001, so we should output in millimeters.
# a rice plant is about 1m tall, so 1000mm.
v, f = generate_cylinder(20, 200, 8, -200) 
write_obj("R01.obj", v, f)

print("Generating stem...")
v, f = generate_cylinder(10, 600, 8, 0)
write_obj("S01.obj", v, f)

print("Generating leaves...")
v, f = generate_leaf(30, 400, 100, 30)
write_obj("L01.obj", v, f)
v, f = generate_leaf(30, 400, 300, -30)
write_obj("L02.obj", v, f)
v, f = generate_leaf(30, 400, 500, 45)
write_obj("L03.obj", v, f)

print("Generating panicle...")
v, f = generate_cylinder(30, 150, 8, 600)
write_obj("P01.obj", v, f)

# Create metadata
elements = [
    {"id": "R01", "name": "Fibrous Root System", "conceptId": "C01"},
    {"id": "S01", "name": "Culm (Stem)", "conceptId": "C02"},
    {"id": "L01", "name": "Lower Leaf", "conceptId": "C03"},
    {"id": "L02", "name": "Middle Leaf", "conceptId": "C03"},
    {"id": "L03", "name": "Flag Leaf", "conceptId": "C03"},
    {"id": "P01", "name": "Panicle", "conceptId": "C04"}
]

concepts = [
    {"id": "C01", "name": "Root System", "elements": ["R01"]},
    {"id": "C02", "name": "Stem System", "elements": ["S01"]},
    {"id": "C03", "name": "Leaves", "elements": ["L01", "L02", "L03"]},
    {"id": "C04", "name": "Inflorescence", "elements": ["P01"]},
]

concept_map = {
    "elements": elements,
    "concepts": concepts
}

with open("concept_map.json", "w") as f:
    json.dump(concept_map, f, indent=2)

system_map = {
    "R01": "Root",
    "S01": "Stem",
    "L01": "Leaves",
    "L02": "Leaves",
    "L03": "Leaves",
    "P01": "Reproductive"
}

with open("system_map.json", "w") as f:
    json.dump(system_map, f, indent=2)

print("Done generating plant data.")
