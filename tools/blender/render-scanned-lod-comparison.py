import bpy, json
from mathutils import Vector, Quaternion
from pathlib import Path

root = Path(__file__).resolve().parents[2]
out = Path('/var/tmp/elsemesh-scanned-lod-review')
out.mkdir(exist_ok=True)
source = json.loads((root / 'worlds/island/world-source.json').read_text())
assets = {}
for obj in source['objects']:
    if obj.get('kind') == 'asset-instance' and obj.get('lods') and obj.get('label') in ('dead quiver trunk','dead quiver branch 02','dead quiver branch 01','lambis shell'):
        assets.setdefault(obj['label'], (obj['assetId'].split(':',1)[1], obj['lods'][0]['assetId'].split(':',1)[1], obj['transform'].get('rotation',[0,0,0,1])))
expected = {'dead quiver trunk', 'dead quiver branch 02', 'dead quiver branch 01', 'lambis shell'}
if set(assets) != expected:
    raise RuntimeError(f'Expected LOD pairs for {sorted(expected)}, found {sorted(assets)}')

bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete(use_global=False)
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = 32
scene.cycles.seed = 0
scene.cycles.use_denoising = False
scene.render.resolution_x = 512
scene.render.resolution_y = 512
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.render.film_transparent = False
scene.view_settings.view_transform = 'Standard'
scene.view_settings.look = 'Medium High Contrast'
scene.world.color = (0.18,0.18,0.18)
scene.render.image_settings.color_mode = 'RGBA'

# Neutral floor-less studio illumination so the source UV texture and silhouette dominate.
world = scene.world
world.use_nodes = True
world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.18,0.18,0.18,1)
world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.25
light_data = bpy.data.lights.new('Key', 'AREA'); light_data.energy = 35; light_data.shape = 'DISK'; light_data.size = 5
light_obj = bpy.data.objects.new('Key', light_data); scene.collection.objects.link(light_obj); light_obj.location=(3,-4,5)
light_obj.rotation_euler=(Vector((0,0,0))-light_obj.location).to_track_quat('-Z','Y').to_euler()
fill_data = bpy.data.lights.new('Fill', 'AREA'); fill_data.energy = 12; fill_data.size = 4
fill_obj = bpy.data.objects.new('Fill', fill_data); scene.collection.objects.link(fill_obj); fill_obj.location=(-4,-2,1)
fill_obj.rotation_euler=(Vector((0,0,0))-fill_obj.location).to_track_quat('-Z','Y').to_euler()
cam_data = bpy.data.cameras.new('Camera'); cam_data.type='ORTHO'; cam_obj=bpy.data.objects.new('Camera',cam_data); scene.collection.objects.link(cam_obj); scene.camera=cam_obj
cam_obj.data.lens=50

for index,(label,(base_id,lod_id,rot)) in enumerate(sorted(assets.items())):
    q=Quaternion((rot[3],rot[0],rot[1],rot[2]))
    groups={}
    for tag,asset_id in [('near',base_id),('far',lod_id)]:
        before=set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=str(root/'worlds/island/assets'/asset_id))
        created=[o for o in bpy.data.objects if o not in before and o.type=='MESH']
        for o in created:
            o.rotation_mode='QUATERNION'; o.rotation_quaternion=q
        groups[tag]=created
    bpy.context.view_layer.update()
    all_corners=[o.matrix_world @ Vector(corner) for group in groups.values() for o in group for corner in o.bound_box]
    minimum=Vector(tuple(min(v[a] for v in all_corners) for a in range(3)))
    maximum=Vector(tuple(max(v[a] for v in all_corners) for a in range(3)))
    center=(minimum+maximum)*0.5
    for group in groups.values():
        for o in group: o.location -= center
    bpy.context.view_layer.update()
    all_corners=[o.matrix_world @ Vector(corner) for group in groups.values() for o in group for corner in o.bound_box]
    radius=max(v.length for v in all_corners)
    direction=Vector((3,-6,2.2)).normalized()
    cam_obj.location=direction*(radius*4+2)
    cam_obj.rotation_euler=(-cam_obj.location).to_track_quat('-Z','Y').to_euler()
    cam_obj.data.ortho_scale=radius*2.8
    light_obj.location=Vector((radius*2,-radius*2,radius*3)); light_obj.data.size=radius*2
    light_obj.rotation_euler=(-light_obj.location).to_track_quat('-Z','Y').to_euler()
    fill_obj.location=Vector((-radius*2,-radius,radius)); fill_obj.data.size=radius*2
    fill_obj.rotation_euler=(-fill_obj.location).to_track_quat('-Z','Y').to_euler()
    for tag,group in groups.items():
        for o in groups['near']: o.hide_render = tag != 'near'
        for o in groups['far']: o.hide_render = tag != 'far'
        scene.render.filepath=str(out/f'{index}-{label.replace(" ","-")}-{tag}.png')
        bpy.ops.render.render(write_still=True)
    print('RENDERED',label,flush=True)
    for group in groups.values():
        for o in group: bpy.data.objects.remove(o, do_unlink=True)
