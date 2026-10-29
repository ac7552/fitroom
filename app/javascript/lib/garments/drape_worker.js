// The drape, run in a Web Worker (see remote_drape.js, which starts it and talks to it): the page sends what
// a garment is sewn from (the body as it's sewn on, what's worn under it, the item) and, later, each step into
// the pose shown; the worker sews and settles the cloth at full speed, off the page's main thread, and sends
// the cloth's points back as it goes. The page keeps its own copy of the garment (dress.js's DrapedTop) for
// drawing, and copies the points into it.
//
// handle(message, post): one message from the page; post(message, transfer) sends one back.
//   { type: "sew", id, item, body, over, egg, measures, arms }
//     → { type: "progress", id, x, frames, phase, frame } now and then, then { type: "sewn", id, x, frames, frame }
//   { type: "pose", id, posed, before, now: { body, over, egg }, bottom, last, long }
//     → { type: "progress", id, x, frame } now and then, then { type: "posed", id, x, frame, field }
//       (field, on the last step: the posed body's collision field, as plain data; see fieldData)
//   { type: "drop", id }: the garment's gone; stop.
import { prepareBody, sewingFor } from "lib/garments/dress"
import { fieldData } from "lib/garments/remote_drape"

const jobs = new Map()
// How often the cloth is sent back while it settles (ms), so the page shows it moving.
const EVERY = 120
// How long the worker works before it looks at its messages again (a "drop" for one being sewn).
const SLICE = 40

export function handle(message, post) {
  // Anything that goes wrong is sent back, so the page can drape that garment itself instead.
  const report = error => post({ type: "error", id: message.id, error: String(error?.stack ?? error) })
  if (message.type === "sew") return sew(message, post).catch(report)
  if (message.type === "pose") return pose(message, post).catch(report)
  if (message.type === "drop") {
    const job = jobs.get(message.id)
    if (job) job.dropped = true
    jobs.delete(message.id)
  }
}

async function sew({ id, item, body, over, egg, measures, arms }, post) {
  const { frame, field } = prepareBody(body, egg, over, { arms })
  const sewing = sewingFor({ item, body, frame, field, measures })
  const job = { drape: sewing.drape, dropped: false }
  jobs.set(id, job)
  let frames = 0, phase = "sewing"
  const done = await run(job, sewing.steps, value => { phase = value; frames++ }, () => post({ type: "progress", id, x: sewing.drape.x.slice(), frames, phase, frame: sewing.drape.frame }))
  if (!done) return
  const x = sewing.drape.x.slice()
  post({ type: "sewn", id, x, frames, frame: sewing.drape.frame }, [x.buffer])
}

async function pose({ id, posed, before, now, bottom, last, long }, post) {
  const job = jobs.get(id)
  if (!job) return
  const { drape } = job
  // As FittingStage#posing does it on the page.
  const { frame, field } = prepareBody(now.body, now.egg, now.over, { arms: !bottom })
  const envelope = drape.hangs ? { table: frame.torso, top: frame.crotch + 0.03, bottom: frame.floor } : null
  if (drape.tuck) drape.tuck = { ...drape.tuck, table: frame.torso }
  const feet = drape.feet ? frame.feet : null
  const arms = drape.arms ? frame.arms : null
  const hands = bottom ? frame.hands : null
  if (!before) drape.repose(posed, field, envelope, feet, arms, hands)
  else {
    for (let i = 0; i < posed.length; i++) drape.x[i] += posed[i] - before[i]
    drape.v.fill(0)
    drape.field = field
    drape.envelope = envelope
    drape.feet = feet
    drape.arms = arms
    drape.hands = hands
  }
  const settle = !last ? drape.settle(14, 6) : long ? drape.settle(180, 50) : drape.settle(70, 25)
  const done = await run(job, settle, () => {}, () => post({ type: "progress", id, x: drape.x.slice(), frame: drape.frame }))
  if (!done) return
  const x = drape.x.slice()
  post({ type: "posed", id, x, frame: drape.frame, field: last ? fieldData(field) : null }, [x.buffer])
}

// Runs a drape generator to its end in slices, sending progress every EVERY ms; false when the garment was
// dropped meanwhile.
async function run(job, steps, each, progress) {
  let sent = performance.now()
  for (;;) {
    const end = performance.now() + SLICE
    while (performance.now() < end) {
      const next = steps.next()
      if (next.done) return !job.dropped
      each(next.value)
    }
    if (job.dropped) return false
    if (performance.now() - sent > EVERY) { progress(); sent = performance.now() }
    await yieldToMessages()
  }
}

// Lets the worker take its messages (a MessageChannel post runs before timers, and isn't throttled).
function yieldToMessages() {
  return new Promise(resolve => {
    const channel = new MessageChannel()
    channel.port1.onmessage = () => resolve()
    channel.port2.postMessage(null)
  })
}
