# 3D model credits

Everything here is CC0 1.0 (public domain) at its source:

- `mannequin.glb`, `textures/suit.webp`, `textures/suit_ao.webp`: built by `script/mannequin/build.py` from
  [MakeHuman](http://www.makehumancommunity.org)'s system assets (the base body and its measurement targets via
  the MPFB extension for Blender, and the clothes `male_elegantsuit01`), released as CC0 by Data Collection AB,
  Joel Palmius and Jonas Hauquier.
- `studio.hdr`: [Studio Small 09](https://polyhaven.com/a/studio_small_09) by Sergej Majboroda, Poly Haven.
- `textures/wool_normal.jpg`, `textures/wool_roughness.jpg`: [Fabric 019](https://ambientcg.com/view?id=Fabric019)
  from ambientCG, scaled to 512 px.

The build's changes (the jacket and trousers split apart, marks for where each covers the body, smoothing, the tintable
cloth texture, baked ambient occlusion and Fitroom's shape keys) are MIT like the rest of the project.
- `women.bin`: the women's body, MakeHuman's female macro targets (CC0, from
  [makehumancommunity/makehuman](https://github.com/makehumancommunity/makehuman)) at the same settings as the base body,
  scaled to its height and stored as an offset for each of the body mesh's vertices.
