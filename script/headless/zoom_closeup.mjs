// A close-up render: camera dollied in to 0.7 m from the chest.
export default async function (stage) {
  const run = (await import("/harness/top_photo.mjs?front=/kith/armani-1-front.jpg&style=sweatshirt&fabric=cotton&redrape=off&closeup=/kith/armani-4-closeup.jpg&deadline=400000")).default
  const details = await run(stage)
  const t = stage.controls.target, p = stage.camera.position
  const dir = p.clone().sub(t).normalize()
  t.y = 1.25
  p.copy(t).addScaledVector(dir, 0.7)
  stage.controls.update()
  stage.still?.reset()
  return details
}
