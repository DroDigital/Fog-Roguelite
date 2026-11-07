"""
Blender → Vigil asset exporter.

Exports every collection whose name starts with ``prop_`` as a GLB into
``public/assets/models/<id>.glb`` and registers it in
``public/assets/manifest.json`` so the game uses it instead of the procedural
fallback for that prop id.

Prop ids understood by the game (see src/world/World.ts):
    tree, rock, grave, menhir, pillar, wall, shrine, lantern

Conventions
-----------
* Units: metres, +Z up in Blender (the exporter converts to glTF +Y up).
* Origin: at the base of the object, where it meets the ground.
* One joined mesh per collection (the loader takes the first mesh it finds and
  bakes its world transform). Apply modifiers before export, or leave
  ``APPLY_MODIFIERS`` on.
* Materials are not used for props: the engine shades them with its own
  procedural PBR sets (bark, triplanar stone). Trees should carry a sensible
  UV layout (U around the trunk, V along it) because bark is UV mapped.
* Keep triangle counts modest; props are instanced hundreds of times.
  Rough budgets: tree 4–8k tris, rock 1–2k, gravestone < 1k.

Usage
-----
    blender my_props.blend --background --python tools/blender/export_fog_assets.py -- /path/to/Fog-Roguelite

or run it from Blender's Scripting tab after setting ``REPO_ROOT`` below.
"""

import json
import os
import sys

import bpy  # type: ignore

APPLY_MODIFIERS = True
REPO_ROOT = None  # set when running inside the Blender UI


def repo_root() -> str:
    if "--" in sys.argv:
        args = sys.argv[sys.argv.index("--") + 1 :]
        if args:
            return os.path.abspath(args[0])
    if REPO_ROOT:
        return os.path.abspath(REPO_ROOT)
    # assume the .blend lives inside the repository
    return os.path.abspath(os.path.join(os.path.dirname(bpy.data.filepath), ".."))


def select_only(objects):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objects:
        o.select_set(True)
    if objects:
        bpy.context.view_layer.objects.active = objects[0]


def export_collection(col, out_path: str) -> bool:
    meshes = [o for o in col.all_objects if o.type == "MESH"]
    if not meshes:
        print(f"[vigil] {col.name}: no meshes, skipped")
        return False
    select_only(meshes)
    bpy.ops.export_scene.gltf(
        filepath=out_path,
        export_format="GLB",
        use_selection=True,
        export_apply=APPLY_MODIFIERS,
        export_yup=True,
        export_texcoords=True,
        export_normals=True,
        export_materials="NONE",
        export_animations=False,
    )
    print(f"[vigil] exported {col.name} -> {out_path}")
    return True


def main():
    root = repo_root()
    assets_dir = os.path.join(root, "public", "assets")
    models_dir = os.path.join(assets_dir, "models")
    os.makedirs(models_dir, exist_ok=True)
    manifest_path = os.path.join(assets_dir, "manifest.json")
    manifest = {"geometry": {}, "audio": {}}
    if os.path.exists(manifest_path):
        with open(manifest_path, "r", encoding="utf-8") as f:
            manifest.update(json.load(f))
    manifest.setdefault("geometry", {})

    exported = 0
    for col in bpy.data.collections:
        if not col.name.startswith("prop_"):
            continue
        prop_id = col.name[len("prop_") :]
        rel = f"models/{prop_id}.glb"
        if export_collection(col, os.path.join(assets_dir, rel)):
            manifest["geometry"][prop_id] = rel
            exported += 1

    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")
    print(f"[vigil] {exported} prop(s) exported, manifest updated: {manifest_path}")


if __name__ == "__main__":
    main()
