# Stock avatar LODs

The checked-in full stock GLBs are the inputs. Blender 4.3.2 generates each
level independently with the collapse decimator at 0.5 and 0.25, retaining
vertex weights, UVs, armatures and NLA animation tracks. Import and export use
30 Hz to preserve the source baked animation endpoints.

```sh
blender --background --factory-startup --python tools/blender/export-avatar-lods.py \
  -- --source public/models/characters --out /var/tmp/tidewater-avatar-lods
cp /var/tmp/tidewater-avatar-lods/*.glb public/models/characters/
node test/avatar-lod-assets.mjs
```

| Asset | Full triangles | Medium | Low |
| --- | ---: | ---: | ---: |
| stock-player | 7364 | 3682 | 1841 |
| stock-female | 8732 | 4366 | 2183 |

The test reads the actual generated GLBs through the runtime parser and checks
triangle reduction, all 80 joint names, inverse-bind count, normalized skin
weights, valid joint indices, all four clips and durations, channel counts,
finite animation values, UVs and the textured body/head/opacity materials used
by appearance tinting. Embedded textures retain their full resolution, so file
size and texture memory do not decrease proportionally to triangles.

These checks establish structural compatibility. They do not establish visual
quality during motion, correct tint rendering or live remote-client behavior;
those require rendering the levels and exercising the connected application.

## Matched-pose visual check

The headless character renderer can compare each mesh at the same viewport,
camera, lighting and animation time. On Linux it uses ImageMagick to decode
embedded GLB textures; macOS uses `sips`. The captures and montages belong in
`/var/tmp`, outside the source tree:

```sh
for avatar in stock-player stock-female; do
  for level in full medium low; do
    model="public/models/characters/$avatar.glb"
    [ "$level" = full ] || model="public/models/characters/$avatar-$level.glb"
    FRAMES=2 STEP=0.45 node test/character-smoke.mjs \
      "$model" "/var/tmp/$avatar-$level.png" walk
  done
  magick montage \
    "/var/tmp/$avatar-full_1.png" \
    "/var/tmp/$avatar-medium_1.png" \
    "/var/tmp/$avatar-low_1.png" \
    -set label '%f' -tile 3x1 -geometry 360x450+8+20 \
    "/var/tmp/$avatar-lod-walk-comparison.png"
done
```

Linux headless captures of both stock avatars were visually reviewed at the
same 0.45 second walk pose. Silhouettes, major garment folds, hair, texture
color and the pose remain consistent across levels. ImageMagick SSIM against
the full mesh was 0.991 (male) and 0.990 (female) for medium, and 0.977 (male)
and 0.970 (female) for low. The comparison supports using the low meshes at
distance; it does not replace near/far in-game checks, tint checks, animation
transition checks, or the required live browser and Flip7 checks.
