#!/usr/bin/env python3
"""Fixed UClaw Blender runner.

This program deliberately exposes no eval/exec/import-string surface. The host
validates SceneSpec before launch; this runner only maps the small declarative
format to Blender's built-in data API and writes known output paths.
"""

import argparse
import json
import math
import os
import sys
import traceback

import bpy
from mathutils import Vector


def emit(stage, completed, total, message):
    print(json.dumps({
        "type": "uclaw.blender.progress",
        "stage": stage,
        "completed": completed,
        "total": total,
        "message": message,
    }), flush=True)


def parse_args():
    if "--" not in sys.argv:
        raise RuntimeError("Expected UClaw runner arguments after --")
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--spec", required=True)
    parser.add_argument("--job-dir", required=True)
    return parser.parse_args(sys.argv[sys.argv.index("--") + 1:])


def safe_output(job_dir, name):
    outputs = os.path.realpath(os.path.join(job_dir, "outputs"))
    target = os.path.realpath(os.path.join(outputs, name))
    if not target.startswith(outputs + os.sep):
        raise RuntimeError("Refused output outside Blender job directory")
    return target


def vec3(value, fallback):
    if not isinstance(value, list) or len(value) != 3:
        return fallback
    return tuple(float(item) for item in value)


def rgba(value, fallback):
    if not isinstance(value, list) or len(value) != 4:
        return fallback
    return tuple(float(item) for item in value)


def apply_transform(obj, transform):
    transform = transform or {}
    obj.location = vec3(transform.get("location"), (0.0, 0.0, 0.0))
    obj.rotation_euler = vec3(transform.get("rotation"), (0.0, 0.0, 0.0))
    obj.scale = vec3(transform.get("scale"), (1.0, 1.0, 1.0))


def make_material(spec, asset_paths):
    material = bpy.data.materials.new(spec.get("name") or spec["id"])
    material.use_nodes = True
    nodes = material.node_tree.nodes
    principled = nodes.get("Principled BSDF")
    principled.inputs["Base Color"].default_value = rgba(spec.get("baseColor"), (0.8, 0.8, 0.8, 1.0))
    principled.inputs["Metallic"].default_value = float(spec.get("metallic", 0.0))
    principled.inputs["Roughness"].default_value = float(spec.get("roughness", 0.45))
    if "Emission Color" in principled.inputs and spec.get("emissionColor"):
        principled.inputs["Emission Color"].default_value = rgba(spec["emissionColor"], (0, 0, 0, 1))
        principled.inputs["Emission Strength"].default_value = float(spec.get("emissionStrength", 0.0))
    texture_asset = spec.get("textureAssetId")
    texture_path = asset_paths.get(texture_asset)
    if texture_path:
        image = bpy.data.images.load(texture_path, check_existing=True)
        texture = nodes.new("ShaderNodeTexImage")
        texture.image = image
        material.node_tree.links.new(texture.outputs["Color"], principled.inputs["Base Color"])
    return material


def create_primitive(spec):
    primitive = spec["primitive"]
    if primitive == "cube":
        bpy.ops.mesh.primitive_cube_add(size=1)
    elif primitive == "sphere":
        bpy.ops.mesh.primitive_uv_sphere_add(segments=48, ring_count=24, radius=1)
    elif primitive == "cylinder":
        bpy.ops.mesh.primitive_cylinder_add(vertices=48, radius=1, depth=2)
    elif primitive == "cone":
        bpy.ops.mesh.primitive_cone_add(vertices=48, radius1=1, radius2=0, depth=2)
    elif primitive == "torus":
        bpy.ops.mesh.primitive_torus_add(major_radius=1.1, minor_radius=0.34, major_segments=64, minor_segments=24)
    elif primitive == "plane":
        bpy.ops.mesh.primitive_plane_add(size=2)
    elif primitive == "text":
        bpy.ops.object.text_add()
        bpy.context.object.data.body = str(spec.get("text", "UClaw"))
        bpy.context.object.data.align_x = "CENTER"
        bpy.context.object.data.align_y = "CENTER"
        bpy.context.object.data.extrude = max(0.0, float(spec.get("bevelDepth", 0.02)))
        bpy.context.object.data.bevel_depth = max(0.0, float(spec.get("bevelDepth", 0.02)))
    else:
        raise RuntimeError("Unsupported primitive")
    return bpy.context.object


def point_at(obj, target=(0.0, 0.0, 0.0)):
    direction = Vector(target) - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def should_auto_aim(spec):
    rotation = (spec.get("transform") or {}).get("rotation")
    return rotation is None or (isinstance(rotation, list) and len(rotation) == 3 and all(abs(float(value)) < 0.000001 for value in rotation))


def build_scene(spec):
    emit("building_scene", 1, 5, "Resetting Blender scene")
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for datablocks in (bpy.data.materials, bpy.data.cameras, bpy.data.lights):
        for item in list(datablocks):
            if item.users == 0:
                datablocks.remove(item)
    scene = bpy.context.scene
    units = spec.get("units", "METERS")
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.length_unit = units
    project = spec.get("project") or {}
    scene.frame_start = int(project.get("frameStart", 1))
    scene.frame_end = int(project.get("frameEnd", 120))
    scene.render.fps = int(project.get("fps", 24))
    asset_paths = {asset["id"]: asset["path"] for asset in spec.get("assets", [])}
    materials = {item["id"]: make_material(item, asset_paths) for item in spec.get("materials", [])}
    objects = {}
    emit("building_scene", 2, 5, "Creating geometry and materials")
    for item in spec.get("objects", []):
        obj = create_primitive(item)
        obj.name = item.get("name") or item["id"]
        apply_transform(obj, item.get("transform"))
        if item.get("dimensions"):
            obj.dimensions = vec3(item["dimensions"], (1.0, 1.0, 1.0))
        material = materials.get(item.get("materialId"))
        if material:
            obj.data.materials.append(material)
        objects[item["id"]] = obj
    world = scene.world or bpy.data.worlds.new("World")
    scene.world = world
    world.use_nodes = True
    background = world.node_tree.nodes.get("Background")
    world_spec = spec.get("world") or {}
    background.inputs["Color"].default_value = rgba(world_spec.get("color"), (0.035, 0.035, 0.05, 1.0))
    background.inputs["Strength"].default_value = float(world_spec.get("strength", 0.25))
    emit("building_scene", 3, 5, "Placing lights and camera")
    for item in spec.get("lights", []):
        light_data = bpy.data.lights.new(item["id"], item["type"])
        light_data.energy = float(item.get("energy", 800))
        light_data.color = rgba(item.get("color"), (1, 1, 1, 1))[:3]
        if hasattr(light_data, "shape"):
            light_data.shape = "DISK"
        if hasattr(light_data, "size"):
            light_data.size = float(item.get("size", 2))
        light_object = bpy.data.objects.new(item["id"], light_data)
        bpy.context.collection.objects.link(light_object)
        apply_transform(light_object, item.get("transform"))
        if should_auto_aim(item):
            point_at(light_object)
    cameras = {}
    for item in spec.get("cameras", []):
        camera_data = bpy.data.cameras.new(item["id"])
        camera_data.lens = float(item.get("lensMm", 50))
        camera_object = bpy.data.objects.new(item["id"], camera_data)
        bpy.context.collection.objects.link(camera_object)
        apply_transform(camera_object, item.get("transform"))
        if should_auto_aim(item):
            point_at(camera_object)
        cameras[item["id"]] = camera_object
    if not cameras:
        camera_data = bpy.data.cameras.new("UClaw Camera")
        camera_object = bpy.data.objects.new("UClaw Camera", camera_data)
        bpy.context.collection.objects.link(camera_object)
        camera_object.location = (5.0, -5.0, 3.5)
        point_at(camera_object)
        cameras["UClaw Camera"] = camera_object
    scene.camera = cameras.get(spec.get("activeCameraId")) or next(iter(cameras.values()))
    for track in spec.get("animation", []):
        obj = objects.get(track.get("objectId"))
        if not obj:
            continue
        prop = track.get("property")
        if prop not in ("location", "rotation", "scale"):
            continue
        data_path = "rotation_euler" if prop == "rotation" else prop
        for keyframe in track.get("keyframes", []):
            setattr(obj, data_path, vec3(keyframe.get("value"), (0, 0, 0)))
            obj.keyframe_insert(data_path=data_path, frame=int(keyframe.get("frame", 1)))
    render = spec.get("render") or {}
    requested_engine = render.get("engine", "BLENDER_EEVEE_NEXT")
    scene.render.engine = "BLENDER_EEVEE" if requested_engine == "BLENDER_EEVEE_NEXT" else requested_engine
    scene.render.resolution_x = int(render.get("width", 1024))
    scene.render.resolution_y = int(render.get("height", 1024))
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = bool(render.get("transparent", False))
    if scene.render.engine == "CYCLES":
        scene.cycles.samples = int(render.get("samples", 32))
    else:
        scene.render.image_settings.color_mode = "RGBA" if scene.render.film_transparent else "RGB"
    emit("building_scene", 5, 5, "Scene construction complete")


def produce_outputs(spec, job_dir):
    outputs = os.path.join(job_dir, "outputs")
    os.makedirs(outputs, exist_ok=True)
    deliverables = spec.get("deliverables") or {}
    scene = bpy.context.scene
    emit("exporting", 1, 4, "Saving editable Blender source")
    if deliverables.get("blend", True):
        bpy.ops.wm.save_as_mainfile(filepath=safe_output(job_dir, "scene.blend"), check_existing=False)
    emit("exporting", 2, 4, "Exporting portable GLB")
    if deliverables.get("glb", True):
        bpy.ops.export_scene.gltf(filepath=safe_output(job_dir, "scene.glb"), export_format="GLB", export_materials="EXPORT")
    emit("rendering", 3, 4, "Rendering hero image")
    if deliverables.get("heroImage", True):
        scene.render.filepath = safe_output(job_dir, "hero.png")
        bpy.ops.render.render(write_still=True)
    if deliverables.get("turntable", False):
        emit("rendering", 4, 4, "Rendering turntable video")
        scene.render.image_settings.file_format = "FFMPEG"
        scene.render.ffmpeg.format = "MPEG4"
        scene.render.filepath = safe_output(job_dir, "turntable.mp4")
        bpy.ops.render.render(animation=True)
    manifest = {
        "schema": "uclaw.blender.output/v1",
        "title": spec.get("title"),
        "deliverables": deliverables,
        "objectCount": len(spec.get("objects", [])),
        "frameStart": scene.frame_start,
        "frameEnd": scene.frame_end,
        "fps": scene.render.fps,
    }
    with open(safe_output(job_dir, "manifest.json"), "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)


def main():
    args = parse_args()
    spec_path = os.path.realpath(args.spec)
    job_dir = os.path.realpath(args.job_dir)
    if not spec_path.startswith(job_dir + os.sep):
        raise RuntimeError("SceneSpec must be inside Blender job directory")
    with open(spec_path, "r", encoding="utf-8") as handle:
        spec = json.load(handle)
    if spec.get("schema") != "uclaw.blender.scene/v1":
        raise RuntimeError("Unsupported SceneSpec schema")
    if not isinstance(spec.get("objects"), list) or not spec["objects"]:
        raise RuntimeError("SceneSpec has no objects")
    build_scene(spec)
    produce_outputs(spec, job_dir)
    emit("validating", 4, 4, "Blender outputs complete")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("UCLAW_BLENDER_RUNNER_ERROR: %s" % error, file=sys.stderr, flush=True)
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)
