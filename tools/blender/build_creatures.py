"""
Procedural creature sculpt + rig + bake pipeline for Vigil.

Builds every creature in Blender from a skeleton graph and anatomical parts
(skull, jaw, brow, ribs, sternum, clavicles, scapulae, spine, pelvis, knees,
fingers, claws, toes), fuses them with a voxel remesh into one organic
surface, sculpts skin detail with layered displacement, then:

  * decimates a game-resolution mesh,
  * bakes the sculpt's procedural skin colour (blotches, bruising, veins,
    cavity dirt) and ambient occlusion into its vertex colours with Cycles,
  * rigs it to a 10-bone armature that matches the engine's limb segments,
  * exports <id>.glb (mesh + skin + colours) and <id>.json (bind-pose joints,
    eye sockets) into public/assets/creatures/.

Fine detail (pores, wrinkles, normal/roughness response) comes from the
engine's seamless triplanar flesh maps, so no UV layout is needed.

Run with Blender's Python module (pip install bpy) or Blender itself:

    python tools/blender/build_creatures.py [ids...]
    blender -b -P tools/blender/build_creatures.py -- [ids...]

Coordinates: the engine's creature space is +Y up, facing +Z, creature's left
on +X. Blender is Z-up; glTF export converts (x, y, z)_blender -> (x, z, -y).
"""

import json
import math
import os
import random
import sys

import bpy  # type: ignore  (must be imported before bmesh/mathutils)
import bmesh  # type: ignore
from mathutils import Vector, noise  # type: ignore

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
OUT = os.path.join(ROOT, "public", "assets", "creatures")
VOXEL = float(os.environ.get("VIGIL_VOXEL", "0.0055"))

# Segment names and their joints, identical to src/game/Body.ts
SEGS = [
    ("torso", "Pelvis", "Chest"),
    ("head", "Chest", "Head"),
    ("l_arm", "LSh", "LEl"),
    ("l_fore", "LEl", "LHa"),
    ("r_arm", "RSh", "REl"),
    ("r_fore", "REl", "RHa"),
    ("l_thigh", "LHip", "LKn"),
    ("l_shin", "LKn", "LFt"),
    ("r_thigh", "RHip", "RKn"),
    ("r_shin", "RKn", "RFt"),
]

# Engine REST pose (x = creature's right, y up, z forward); arm/leg lengths are kept,
# but the bind pose opens the arms into an A-pose so fingers don't fuse with thighs.
REST = {
    "Pelvis": (0, 0.98, 0), "Chest": (0, 1.46, 0.02), "Head": (0, 1.74, 0.05),
    "LSh": (-0.2, 1.42, 0), "LEl": (-0.24, 1.14, -0.02), "LHa": (-0.26, 0.88, 0.04),
    "RSh": (0.2, 1.42, 0), "REl": (0.24, 1.14, -0.02), "RHa": (0.26, 0.88, 0.04),
    "LHip": (-0.1, 0.94, 0), "LKn": (-0.11, 0.52, 0.03), "LFt": (-0.12, 0.08, 0),
    "RHip": (0.1, 0.94, 0), "RKn": (0.11, 0.52, 0.03), "RFt": (0.12, 0.08, 0),
}


def dist(a, b):
    return math.sqrt(sum((a[i] - b[i]) ** 2 for i in range(3)))


def bind_pose():
    """A-pose with the engine's exact bone lengths. Returns rest-space coords."""
    j = {k: v for k, v in REST.items()}
    for side, sx in (("L", -1), ("R", 1)):
        sh = REST[side + "Sh"]
        l1 = dist(REST[side + "Sh"], REST[side + "El"])
        l2 = dist(REST[side + "El"], REST[side + "Ha"])
        a = math.radians(38)
        el = (sh[0] + sx * math.sin(a) * l1, sh[1] - math.cos(a) * l1, sh[2] - 0.01)
        a2 = math.radians(30)
        ha = (el[0] + sx * math.sin(a2) * l2, el[1] - math.cos(a2) * l2, el[2] + 0.04)
        j[side + "El"], j[side + "Ha"] = el, ha
        hip = REST[side + "Hip"]
        t = dist(REST[side + "Hip"], REST[side + "Kn"])
        s = dist(REST[side + "Kn"], REST[side + "Ft"])
        b = math.radians(4)
        kn = (hip[0] + sx * math.sin(b) * t, hip[1] - math.cos(b) * t, 0.02)
        ft = (kn[0] + sx * math.sin(b * 0.5) * s, kn[1] - math.sqrt(max(0.0, s * s - (math.sin(b * 0.5) * s) ** 2 - 0.0004)), 0.0)
        j[side + "Kn"], j[side + "Ft"] = kn, ft
    return j


def to_bl(p):
    """rest/engine space -> Blender space."""
    return Vector((-p[0], -p[2], p[1]))


def to_gltf(p):
    """rest/engine space -> glTF/engine world at yaw 0 (left = +X)."""
    return [-p[0], p[1], p[2]]


CREATURES = {
    "hollow": dict(gaunt=0.75, bulk=1.0, skull=(0.82, 1.08, 1.0), jaw=1.0, belly=0.0, hunch=0.06, seed=11,
                   skin=(0.30, 0.31, 0.29), skin2=(0.17, 0.19, 0.15), bruise=(0.22, 0.08, 0.12)),
    "stalker": dict(gaunt=1.0, bulk=0.82, skull=(0.68, 1.15, 1.42), jaw=1.25, belly=0.0, hunch=0.12, seed=23,
                    skin=(0.24, 0.27, 0.30), skin2=(0.12, 0.14, 0.17), bruise=(0.10, 0.10, 0.18)),
    "weeper": dict(gaunt=0.9, bulk=0.92, skull=(0.85, 1.0, 1.0), jaw=1.35, belly=0.0, hunch=0.14, seed=37, sac=True,
                   skin=(0.28, 0.31, 0.22), skin2=(0.15, 0.18, 0.09), bruise=(0.20, 0.24, 0.05)),
    "brute": dict(gaunt=0.15, bulk=1.45, skull=(0.95, 1.0, 1.0), jaw=1.2, belly=0.5, hunch=0.08, seed=41,
                  skin=(0.34, 0.29, 0.26), skin2=(0.20, 0.15, 0.13), bruise=(0.26, 0.09, 0.09)),
    "warden": dict(gaunt=0.3, bulk=1.35, skull=(0.9, 1.05, 1.0), jaw=1.1, belly=0.2, hunch=0.05, seed=53,
                   skin=(0.22, 0.24, 0.27), skin2=(0.11, 0.12, 0.15), bruise=(0.12, 0.12, 0.2)),
}


# ───────────────────────────────────────────────────────────── helpers

def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def mesh_obj(name, bm):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def apply_modifiers(ob):
    dg = bpy.context.evaluated_depsgraph_get()
    ev = ob.evaluated_get(dg)
    me = bpy.data.meshes.new_from_object(ev)
    old = ob.data
    ob.modifiers.clear()
    ob.data = me
    bpy.data.meshes.remove(old)
    return ob


def join(objs, name):
    bpy.context.view_layer.update()  # make sure late transform edits reach matrix_world
    bm = bmesh.new()
    for o in objs:
        tmp = o.data.copy()
        tmp.transform(o.matrix_world)
        bm.from_mesh(tmp)
        bpy.data.meshes.remove(tmp)
    for o in objs:
        bpy.data.objects.remove(o, do_unlink=True)
    return mesh_obj(name, bm)


def prim(kind, loc, scale=(1, 1, 1), rot=None, **kw):
    bm = bmesh.new()
    if kind == "sphere":
        bmesh.ops.create_uvsphere(bm, u_segments=kw.get("u", 16), v_segments=kw.get("v", 10), radius=1.0)
    elif kind == "cyl":
        bmesh.ops.create_cone(bm, cap_ends=True, segments=kw.get("seg", 10), radius1=kw.get("r1", 1.0), radius2=kw.get("r2", 1.0), depth=1.0)
    elif kind == "cube":
        bmesh.ops.create_cube(bm, size=1.0)
        bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=2, use_grid_fill=True)
    elif kind == "torus":
        R, r, seg, arc = kw["R"], kw["r"], kw.get("seg", 24), kw.get("arc", math.pi * 2)
        verts = []
        rings = kw.get("rings", 6)
        for i in range(seg + 1):
            a = -arc / 2 + arc * i / seg
            ring = []
            for k in range(rings):
                b = 2 * math.pi * k / rings
                x = (R + r * math.cos(b)) * math.cos(a)
                y = (R + r * math.cos(b)) * math.sin(a)
                z = r * math.sin(b)
                ring.append(bm.verts.new((x, y, z)))
            verts.append(ring)
        for i in range(seg):
            for k in range(rings):
                bm.faces.new((verts[i][k], verts[i][(k + 1) % rings], verts[i + 1][(k + 1) % rings], verts[i + 1][k]))
        bm.faces.new(verts[0])
        bm.faces.new(list(reversed(verts[-1])))
    m = bpy.data.meshes.new(kind)
    bm.to_mesh(m)
    bm.free()
    o = bpy.data.objects.new(kind, m)
    bpy.context.scene.collection.objects.link(o)
    o.location = loc
    o.scale = scale
    if rot is not None:
        o.rotation_mode = "QUATERNION"
        o.rotation_quaternion = rot
    bpy.context.view_layer.update()
    return o


def cyl_between(a, b, r1, r2, seg=10):
    a, b = Vector(a), Vector(b)
    d = b - a
    o = prim("cyl", (a + b) / 2, (1, 1, d.length), rot=Vector((0, 0, 1)).rotation_difference(d.normalized()), r1=r1, r2=r2, seg=seg)
    # cylinder primitive radius is in local units; undo the z scale on radius
    return o


# ───────────────────────────────────────────────────────────── sculpt

def build_body(cfg, J):
    rnd = random.Random(cfg["seed"])
    g, bulk = cfg["gaunt"], cfg["bulk"]
    P = {k: to_bl(v) for k, v in J.items()}
    up = Vector((0, 0, 1))
    fwd = Vector((0, -1, 0))  # creature faces -Y in Blender
    parts = []

    # ── skin-modifier skeleton (the continuous body)
    bm = bmesh.new()
    rad = []

    def V(p, rx, ry=None):
        v = bm.verts.new(p)
        rad.append((rx * bulk, (ry if ry is not None else rx) * bulk))
        return v

    def E(a, b):
        bm.edges.new((a, b))

    pel = P["Pelvis"]
    chest = P["Chest"]
    waist = pel.lerp(chest, 0.42) + fwd * (-0.015) * g
    belly = pel.lerp(chest, 0.25) + fwd * (0.03 * cfg["belly"])
    neck0 = chest + up * 0.07
    neck1 = chest + up * 0.15 + fwd * 0.02
    vp = V(pel + up * -0.03, 0.135, 0.10)
    vb = V(belly, 0.12 + 0.05 * cfg["belly"] - 0.015 * g, 0.085 + 0.06 * cfg["belly"] - 0.02 * g)
    vw = V(waist, 0.105 - 0.03 * g, 0.072 - 0.022 * g)
    vc = V(chest + up * -0.06, 0.15, 0.098)
    vu = V(chest + up * 0.0, 0.17, 0.095)
    vn0 = V(neck0, 0.055, 0.055)
    vn1 = V(neck1, 0.048 - 0.006 * g, 0.05)
    for a, b in ((vp, vb), (vb, vw), (vw, vc), (vc, vu), (vu, vn0), (vn0, vn1)):
        E(a, b)
    for s in ("L", "R"):
        sh, el, ha = P[s + "Sh"], P[s + "El"], P[s + "Ha"]
        hip, kn, ft = P[s + "Hip"], P[s + "Kn"], P[s + "Ft"]
        vs = V(sh, 0.06, 0.055)
        E(vu, vs)
        mu = V(sh.lerp(el, 0.45), 0.05 - 0.012 * g, 0.048 - 0.012 * g)
        ve = V(el, 0.038, 0.036)
        mf = V(el.lerp(ha, 0.35), 0.04 - 0.008 * g, 0.034 - 0.008 * g)
        vwr = V(ha + (ha - el).normalized() * -0.015, 0.024, 0.019)
        hd = (ha - el).normalized()
        vh = V(ha + hd * 0.045, 0.036, 0.014)
        for a, b in ((vs, mu), (mu, ve), (ve, mf), (mf, vwr), (vwr, vh)):
            E(a, b)
        vhp = V(hip + up * 0.02, 0.085, 0.08)
        E(vp, vhp)
        mt = V(hip.lerp(kn, 0.35), 0.078 - 0.018 * g, 0.075 - 0.018 * g)
        vk = V(kn, 0.05, 0.05)
        ms = V(kn.lerp(ft, 0.3), 0.052 - 0.012 * g, 0.05 - 0.012 * g)
        va = V(ft + up * 0.02, 0.032, 0.03)
        vt = V(ft + fwd * 0.13 + up * -0.04, 0.04, 0.02)
        for a, b in ((vhp, mt), (mt, vk), (vk, ms), (ms, va), (va, vt)):
            E(a, b)
    body = mesh_obj("body", bm)
    body.modifiers.new("skin", "SKIN")
    sv = body.data.skin_vertices[0].data
    for i, (rx, ry) in enumerate(rad):
        sv[i].radius = (rx, ry)
    sv[0].use_root = True
    sub = body.modifiers.new("sub", "SUBSURF")
    sub.levels = 2
    apply_modifiers(body)
    parts.append(body)

    # ── skull, brow, cheekbones, jaw
    head = P["Head"] + up * -0.02
    sk = cfg["skull"]
    r = 0.098 * (1 + (bulk - 1) * 0.25)
    parts.append(prim("sphere", head + up * 0.01, (r * sk[0], r * sk[2], r * sk[1])))
    parts.append(prim("sphere", head + up * 0.035 + fwd * r * 0.75, (r * 0.75, r * 0.22, r * 0.16)))  # brow ridge
    for sx in (-1, 1):
        parts.append(prim("sphere", head + Vector((sx * r * 0.55, 0, 0)) + fwd * r * 0.65 + up * -0.03, (r * 0.22, r * 0.25, r * 0.16)))
    jw = cfg["jaw"]
    parts.append(prim("cube", head + up * (-r * 0.78) + fwd * r * 0.45, (r * 1.05 * jw, r * 0.95 * jw, r * 0.42)))
    parts.append(prim("sphere", head + up * (-r * 0.5) + fwd * r * 0.55, (r * 0.62, r * 0.55, r * 0.35)))  # maxilla
    if cfg.get("sac"):
        parts.append(prim("sphere", neck0 + fwd * 0.07 + up * -0.01, (0.085, 0.08, 0.07)))

    # ── rib cage, sternum, clavicles, scapulae, spine, pelvis crest
    for i in range(8):
        k = i / 7
        z = chest.z - 0.26 + i * 0.034
        wx = (0.128 + 0.03 * math.sin(k * math.pi * 0.85)) * bulk + 0.014 * g
        wy = (0.084 + 0.016 * math.sin(k * math.pi * 0.85)) * bulk + 0.01 * g
        rr = (0.07 + 0.05 * g) * (1.0 - 0.25 * k)
        o = prim("torus", Vector((0, 0, 0)), (wy, wx, wy * 0.9), R=1.0, r=(0.0075 + 0.006 * g) * (1.0 - 0.25 * k) / wx, arc=math.pi * 1.62, seg=28, rings=6)
        # gap faces the front (-Y): rotate the arc's centre to the back (+Y)
        o.rotation_mode = "ZXY"  # spin the gap to the front first, then slope the rib down towards it
        o.rotation_euler = (math.radians(20), 0, math.radians(90))
        o.location = Vector((0, chest.y + 0.006, z))
        parts.append(o)
    # sunken belly and jutting pelvis on gaunt bodies, slabs of muscle on heavy ones
    if g > 0.5:
        for sx in (-1, 1):
            parts.append(prim("sphere", pel + Vector((sx * 0.105, -0.045, 0.05)), (0.03, 0.035, 0.05)))
    m = 1.0 - g
    if m > 0.2:
        for sx in (-1, 1):
            parts.append(prim("sphere", chest + Vector((sx * 0.075, -0.07, -0.05)), (0.085 * bulk * m + 0.02, 0.04 * bulk * m + 0.01, 0.06 * bulk)))  # pecs
            parts.append(prim("sphere", chest + Vector((sx * 0.13, 0.02, -0.12)), (0.05 * bulk * m, 0.07 * bulk * m, 0.12 * bulk)))  # lats
        for k in range(3 if m > 0.45 else 0):
            for sx in (-1, 1):
                parts.append(prim("sphere", pel.lerp(chest, 0.25 + k * 0.17) + Vector((sx * 0.04, -0.07 * bulk, 0)), (0.035 * bulk, 0.02 * bulk * m + 0.008, 0.04)))
        parts.append(prim("sphere", neck0 + Vector((0, 0.03, -0.01)), (0.12 * bulk * m + 0.02, 0.06 * bulk, 0.06)))  # trapezius
    parts.append(cyl_between(chest + fwd * 0.085 + up * -0.2, chest + fwd * 0.09 + up * 0.0, 0.014, 0.012, 6))
    for sx in (-1, 1):
        sh = P[("L" if sx > 0 else "R") + "Sh"]
        parts.append(cyl_between(chest + fwd * 0.07 + up * 0.02, sh + fwd * 0.02 + up * 0.02, 0.011, 0.009, 6))
        parts.append(prim("sphere", chest + Vector((sx * 0.08, 0.065, -0.05)), (0.06, 0.012, 0.075)))
        parts.append(prim("sphere", pel + Vector((sx * 0.11, -0.02, 0.06)), (0.035, 0.05, 0.025)))  # iliac crest
    for i in range(16):
        t = i / 15
        depth = (0.062 if t < 0.5 else 0.07) * bulk
        p = pel.lerp(neck0, t) + fwd * (-depth - 0.01 * math.sin(t * math.pi))
        parts.append(prim("sphere", p, (0.016, 0.016, 0.013), u=8, v=6))

    # ── knees, elbows, knuckles, fingers + claws, toes
    for s in ("L", "R"):
        sx = 1 if s == "L" else -1
        kn, el, ha, ft = P[s + "Kn"], P[s + "El"], P[s + "Ha"], P[s + "Ft"]
        parts.append(prim("sphere", kn + fwd * 0.045, (0.036, 0.026, 0.04)))
        parts.append(prim("sphere", el + fwd * -0.032, (0.024, 0.024, 0.024)))
        hip, sh = P[s + "Hip"], P[s + "Sh"]
        mm = (1.0 - g * 0.7) * bulk
        parts.append(prim("sphere", hip.lerp(kn, 0.45) + fwd * 0.03, (0.06 * mm, 0.055 * mm, 0.17)))  # quads
        parts.append(prim("sphere", kn.lerp(ft, 0.28) + fwd * -0.035, (0.045 * mm, 0.045 * mm, 0.11)))  # calf
        parts.append(prim("sphere", sh + Vector((sx * 0.03, 0, -0.02)), (0.055 * mm, 0.055 * mm, 0.06)))  # deltoid
        ua = sh.lerp(el, 0.5)
        parts.append(prim("sphere", ua + fwd * 0.02, (0.036 * mm, 0.036 * mm, 0.1), rot=Vector((0, 0, 1)).rotation_difference((el - sh).normalized())))
        fa = el.lerp(ha, 0.32)
        parts.append(prim("sphere", fa, (0.034 * mm, 0.03 * mm, 0.09), rot=Vector((0, 0, 1)).rotation_difference((ha - el).normalized())))
        for kk in (-1, 1):
            parts.append(prim("sphere", ft + Vector((kk * 0.022, 0, 0.015)), (0.016, 0.016, 0.016), u=8, v=6))  # ankle bones
        hd = (ha - P[s + "El"]).normalized()
        side = Vector((sx, 0, 0))
        palm = ha + hd * 0.05
        claw_len = 1.6 if cfg["gaunt"] > 0.85 else 1.0
        # palm-plane axes: fingers fan out along `across`, curl towards the palm (forward)
        across = hd.cross(fwd).normalized()
        for k in range(4):
            off = (k - 1.5) * 0.024
            base = palm + across * off + fwd * 0.004
            fl = (0.08 + (0.014 if k in (1, 2) else 0) - (0.012 if k == 3 else 0)) * claw_len
            spread = across * off * 0.35
            k1 = base + hd * fl * 0.45 + spread
            k2 = k1 + hd * fl * 0.32 + fwd * 0.018 + spread * 0.4
            tip = k2 + hd * fl * 0.25 + fwd * 0.022
            parts.append(cyl_between(base, k1, 0.0105, 0.0095, 8))
            parts.append(prim("sphere", k1, (0.0105, 0.0105, 0.0105), u=8, v=6))
            parts.append(cyl_between(k1, k2, 0.0095, 0.0085, 8))
            parts.append(prim("sphere", k2, (0.009, 0.009, 0.009), u=8, v=6))
            parts.append(cyl_between(k2, tip, 0.0085, 0.006, 8))
            ctip = tip + hd * 0.026 + fwd * 0.016
            parts.append(cyl_between(tip, ctip, 0.007, 0.0015, 8))
        tb = ha + hd * 0.015 + fwd * 0.02 + across * -0.03
        parts.append(cyl_between(tb, tb + hd * 0.035 + fwd * 0.035 - across * 0.02, 0.012, 0.009, 8))
        for k in range(4):
            off = (k - 1.5) * 0.017
            base = ft + fwd * 0.12 + Vector(((k - 1.5) * 0.02 * sx, 0, -0.05))
            parts.append(cyl_between(base, base + fwd * 0.05 + Vector((0, 0, -0.012)), 0.011, 0.008, 8))

    hi = join(parts, "high")
    rem = hi.modifiers.new("remesh", "REMESH")
    rem.mode = "VOXEL"
    rem.voxel_size = VOXEL
    rem.use_smooth_shade = True
    apply_modifiers(hi)
    sm = hi.modifiers.new("smooth", "SMOOTH")
    sm.factor = 0.6
    sm.iterations = 3
    apply_modifiers(hi)

    # ── surface sculpt: eye sockets, mouth slit, wrinkles, veins, lumps
    me = hi.data
    me.calc_loop_triangles()
    eye_c = [head + Vector((sx * r * 0.36, 0, 0)) + fwd * r * 0.9 + up * 0.005 for sx in (-1, 1)]
    mouth_c = head + up * (-r * 0.5) + fwd * r * 0.95
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.normal_update()
    for v in bm.verts:
        p = v.co
        n = v.normal
        d = 0.0
        # wrinkled, lumpy skin
        d += noise.noise(p * 38.0) * 0.0018
        d += (noise.ridged_multi_fractal(p * 14.0, 0.8, 2.0, 3, 1.0, 2.0) - 0.6) * 0.0016 * (0.5 + g)
        d += noise.noise(p * 7.0) * 0.003 * (1 - g * 0.5)
        # veins: thin raised ridges
        vv = 1.0 - abs(noise.noise(p * 22.0 + Vector((3.1, 1.7, 0.3))))
        d += max(0.0, vv - 0.93) * 0.05
        for ec in eye_c:
            de = (p - ec).length
            if de < r * 0.34:
                d -= (1 - de / (r * 0.34)) ** 1.5 * r * 0.33
        dm = Vector(((p.x - mouth_c.x) / (r * 0.55), (p.y - mouth_c.y) / (r * 0.4), (p.z - mouth_c.z) / (r * 0.07))).length
        if dm < 1.0:
            d -= (1 - dm) * r * 0.25
        v.co = p + n * d
    bm.to_mesh(me)
    bm.free()
    me.update()
    return hi, eye_c, head


# ───────────────────────────────────────────────────────────── materials + bake

def skin_material(cfg):
    m = bpy.data.materials.new("skin_hi")
    m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    nt.links.new(bsdf.outputs[0], out.inputs[0])
    tc = nt.nodes.new("ShaderNodeTexCoord")
    # blotches
    n1 = nt.nodes.new("ShaderNodeTexNoise")
    n1.inputs["Scale"].default_value = 9.0
    n1.inputs["Detail"].default_value = 8.0
    nt.links.new(tc.outputs["Object"], n1.inputs["Vector"])
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.35
    ramp.color_ramp.elements[0].color = (*cfg["skin2"], 1)
    ramp.color_ramp.elements[1].position = 0.7
    ramp.color_ramp.elements[1].color = (*cfg["skin"], 1)
    nt.links.new(n1.outputs["Fac"], ramp.inputs["Fac"])
    # bruising / rot patches
    n2 = nt.nodes.new("ShaderNodeTexNoise")
    n2.inputs["Scale"].default_value = 3.5
    n2.inputs["Detail"].default_value = 4.0
    nt.links.new(tc.outputs["Object"], n2.inputs["Vector"])
    r2 = nt.nodes.new("ShaderNodeValToRGB")
    r2.color_ramp.elements[0].position = 0.55
    r2.color_ramp.elements[0].color = (0, 0, 0, 1)
    r2.color_ramp.elements[1].position = 0.75
    r2.color_ramp.elements[1].color = (1, 1, 1, 1)
    nt.links.new(n2.outputs["Fac"], r2.inputs["Fac"])
    mix = nt.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    mix.inputs[7].default_value = (*cfg["bruise"], 1)
    nt.links.new(r2.outputs["Color"], mix.inputs[0])
    nt.links.new(ramp.outputs["Color"], mix.inputs[6])
    # veins (dark) via voronoi edges
    vor = nt.nodes.new("ShaderNodeTexVoronoi")
    vor.feature = "DISTANCE_TO_EDGE"
    vor.inputs["Scale"].default_value = 18.0
    nt.links.new(tc.outputs["Object"], vor.inputs["Vector"])
    vr = nt.nodes.new("ShaderNodeMapRange")
    vr.inputs["From Min"].default_value = 0.0
    vr.inputs["From Max"].default_value = 0.035
    vr.inputs["To Min"].default_value = 0.55
    vr.inputs["To Max"].default_value = 1.0
    nt.links.new(vor.outputs["Distance"], vr.inputs["Value"])
    # cavity darkening from AO (dirt in creases)
    ao = nt.nodes.new("ShaderNodeAmbientOcclusion")
    ao.inputs["Distance"].default_value = 0.04
    aor = nt.nodes.new("ShaderNodeMapRange")
    aor.inputs["To Min"].default_value = 0.35
    nt.links.new(ao.outputs["AO"], aor.inputs["Value"])
    m1 = nt.nodes.new("ShaderNodeMix")
    m1.data_type = "RGBA"
    m1.blend_type = "MULTIPLY"
    m1.inputs[0].default_value = 1.0
    nt.links.new(mix.outputs[2], m1.inputs[6])
    nt.links.new(vr.outputs["Result"], m1.inputs[7])
    m2 = nt.nodes.new("ShaderNodeMix")
    m2.data_type = "RGBA"
    m2.blend_type = "MULTIPLY"
    m2.inputs[0].default_value = 1.0
    nt.links.new(m1.outputs[2], m2.inputs[6])
    nt.links.new(aor.outputs["Result"], m2.inputs[7])
    nt.links.new(m2.outputs[2], bsdf.inputs["Base Color"])
    # roughness: wetter in creases
    rr = nt.nodes.new("ShaderNodeMapRange")
    rr.inputs["To Min"].default_value = 0.32
    rr.inputs["To Max"].default_value = 0.62
    nt.links.new(ao.outputs["AO"], rr.inputs["Value"])
    nt.links.new(rr.outputs["Result"], bsdf.inputs["Roughness"])
    return m


def bake(cfg, hi, lo, cid):
    """Bake the sculpt's colour and ambient occlusion into the game mesh's vertex colours.

    Fine skin detail (pores, wrinkles, normal/roughness) is added in-engine with seamless
    triplanar maps, so the low mesh needs no UV layout and there are no texture seams.
    """
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    sc.cycles.device = "CPU"
    sc.render.bake.target = "VERTEX_COLORS"
    hi.data.materials.append(skin_material(cfg))
    lo_mat = bpy.data.materials.new("bake_lo")
    lo_mat.use_nodes = True
    lo.data.materials.append(lo_mat)
    me = lo.data

    def run(kind, name, samples, **kw):
        attr = me.color_attributes.new(name, "FLOAT_COLOR", "POINT")
        me.color_attributes.active_color = attr
        sc.cycles.samples = samples
        for o in sc.objects:
            o.select_set(False)
        hi.select_set(True)
        lo.select_set(True)
        bpy.context.view_layer.objects.active = lo
        with bpy.context.temp_override(selected_objects=[hi, lo], active_object=lo, object=lo):
            bpy.ops.object.bake(type=kind, use_selected_to_active=True, cage_extrusion=0.012, max_ray_distance=0.04, **kw)
        return [tuple(d.color) for d in attr.data]

    alb = run("DIFFUSE", "alb", 8, pass_filter={"COLOR"})
    ao = run("AO", "ao", 48)
    col = me.color_attributes.new("Col", "FLOAT_COLOR", "POINT")
    for i, d in enumerate(col.data):
        a = alb[i]
        o = 0.3 + 0.7 * ao[i][0]
        # alpha carries raw AO so the shader can also darken roughness in creases
        d.color = (a[0] * o, a[1] * o, a[2] * o, ao[i][0])
    me.color_attributes.remove(me.color_attributes["alb"])
    me.color_attributes.remove(me.color_attributes["ao"])
    me.color_attributes.active_color = me.color_attributes["Col"]
    me.color_attributes.render_color_index = 0
    lo.data.materials.clear()


# ───────────────────────────────────────────────────────────── rig

def rig(lo, J):
    arm_data = bpy.data.armatures.new("rig")
    arm = bpy.data.objects.new("rig", arm_data)
    bpy.context.scene.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    with bpy.context.temp_override(active_object=arm, object=arm):
        bpy.ops.object.mode_set(mode="EDIT")
        for name, a, b in SEGS:
            eb = arm_data.edit_bones.new(name)
            eb.head = to_bl(J[a])
            eb.tail = to_bl(J[b])
        bpy.ops.object.mode_set(mode="OBJECT")
    # distance-to-bone weights with smooth blending at joints
    segs = [(name, to_bl(J[a]), to_bl(J[b])) for name, a, b in SEGS]
    groups = {name: lo.vertex_groups.new(name=name) for name, _, _ in segs}
    head_c = to_bl(J["Head"])

    def seg_d(p, a, b):
        ab = b - a
        t = max(0.0, min(1.0, (p - a).dot(ab) / ab.length_squared))
        return (p - (a + ab * t)).length, t

    for v in lo.data.vertices:
        p = v.co
        ds = []
        for name, a, b in segs:
            d, t = seg_d(p, a, b)
            if name == "head" and (p - head_c).length < 0.16:
                d = min(d, 0.0)
            # the torso owns everything near the spine between hips and shoulders
            if name == "torso":
                d *= 0.85
            ds.append((d, name))
        ds.sort()
        dmin = ds[0][0]
        ws = []
        for d, name in ds[:3]:
            w = math.exp(-(d - dmin) / 0.018)
            if w > 0.02:
                ws.append((w, name))
        tot = sum(w for w, _ in ws)
        for w, name in ws:
            groups[name].add([v.index], w / tot, "REPLACE")
    lo.parent = arm
    mod = lo.modifiers.new("arm", "ARMATURE")
    mod.object = arm
    return arm


def preview(ob, path, mat=None):
    """Quick Cycles renders (front, three-quarter, side) for eyeballing the sculpt."""
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    sc.cycles.device = "CPU"
    sc.cycles.samples = 12
    sc.cycles.use_denoising = False
    sc.render.resolution_x, sc.render.resolution_y = 300, 460
    if mat is None:
        mat = bpy.data.materials.new("clay")
        mat.diffuse_color = (0.6, 0.58, 0.55, 1)
        mat.use_nodes = True
        mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.55, 0.52, 0.48, 1)
        mat.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.55
    had = list(ob.data.materials)
    ob.data.materials.clear()
    ob.data.materials.append(mat)
    world = bpy.data.worlds.new("w")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[1].default_value = 0.35
    sc.world = world
    sun_d = bpy.data.lights.new("sun", "SUN")
    sun_d.energy = 3.5
    sun = bpy.data.objects.new("sun", sun_d)
    sun.rotation_euler = (math.radians(50), math.radians(10), math.radians(-35))
    sc.collection.objects.link(sun)
    cam_d = bpy.data.cameras.new("cam")
    cam_d.lens = 85
    cam = bpy.data.objects.new("cam", cam_d)
    sc.collection.objects.link(cam)
    sc.camera = cam
    target = Vector((0, 0, 0.92))
    for i, ang in enumerate((0, 35, 90)):
        a = math.radians(ang)
        cam.location = target + Vector((math.sin(a) * 5.0, -math.cos(a) * 5.0, 0.3))
        cam.rotation_mode = "QUATERNION"
        cam.rotation_quaternion = (target - cam.location).to_track_quat("-Z", "Y")
        sc.render.filepath = f"{path}_{i}.png"
        bpy.ops.render.render(write_still=True)
    for o in (cam, sun):
        bpy.data.objects.remove(o, do_unlink=True)
    ob.data.materials.clear()
    for m in had:
        ob.data.materials.append(m)


# ───────────────────────────────────────────────────────────── main

def build(cid):
    cfg = CREATURES[cid]
    print(f"[vigil] building {cid}")
    reset_scene()
    J = bind_pose()
    hi, eye_c, head = build_body(cfg, J)
    print(f"[vigil]   high: {len(hi.data.polygons)} faces")
    if os.environ.get("VIGIL_PREVIEW"):
        preview(hi, os.environ["VIGIL_PREVIEW"] + f"/{cid}")
    lo = bpy.data.objects.new("lo", hi.data.copy())
    bpy.context.scene.collection.objects.link(lo)
    dec = lo.modifiers.new("dec", "DECIMATE")
    hi_tris = sum(len(p.vertices) - 2 for p in hi.data.polygons)
    dec.ratio = min(1.0, float(os.environ.get("VIGIL_TRIS", "14000")) / max(1, hi_tris))
    apply_modifiers(lo)
    for p in lo.data.polygons:
        p.use_smooth = True
    print(f"[vigil]   low: {len(lo.data.polygons)} faces")
    if os.environ.get("VIGIL_NOBAKE") != "1":
        bake(cfg, hi, lo, cid)
    bpy.data.objects.remove(hi, do_unlink=True)
    rig(lo, J)
    lo.data.validate()
    for o in bpy.context.scene.objects:
        o.select_set(o.name in ("lo", "rig"))
    bpy.ops.export_scene.gltf(
        filepath=os.path.join(OUT, f"{cid}.glb"), export_format="GLB", use_selection=True,
        export_yup=True, export_skins=True, export_animations=False, export_materials="NONE",
        export_texcoords=False, export_normals=True, export_tangents=False, export_vertex_color="ACTIVE",
    )
    meta = {
        "id": cid,
        "joints": {k: to_gltf(v) for k, v in J.items()},
        "eyes": [[e.x, e.z, -e.y] for e in eye_c],
        "head": [head.x, head.z, -head.y],
        "tris": len(lo.data.polygons),
    }
    with open(os.path.join(OUT, f"{cid}.json"), "w") as f:
        json.dump(meta, f, indent=1)
    print(f"[vigil]   wrote {cid}.glb")


def main():
    args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
    ids = [a for a in args if a in CREATURES] or list(CREATURES)
    os.makedirs(OUT, exist_ok=True)
    for cid in ids:
        build(cid)


if __name__ == "__main__":
    main()
