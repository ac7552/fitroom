// For render.mjs --script zoom.mjs: the camera three times closer to a point at the chest (a close look).
export default function (stage) {
  // (Any framing move still going would take the camera back.)
  stage.cameraMove = null
  const t = stage.controls.target, p = stage.camera.position
  const aim = { x: t.x, y: t.y + 0.25, z: t.z }
  p.set(aim.x + (p.x - aim.x) / 3.5, aim.y + (p.y - aim.y) / 3.5, aim.z + (p.z - aim.z) / 3.5)
  t.set(aim.x, aim.y, aim.z)
  stage.controls.update()
}
