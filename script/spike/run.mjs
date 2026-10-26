// The whole AI try-on spike in one command, for free, on a Kaggle GPU. On the Mac, with the app running:
//
//   bin/dev                                   # the app, on http://localhost:3000
//   node script/spike/run.mjs https://kith.com/products/... [more links] [--models fashn|both] [--skip-inputs]
//                                             [--body men|women] [--kaggle-user NAME] [--branch main] [--base URL] [--out tmp/spike]
//
// Steps, each printed as it goes:
//   a. the inputs from the running app (inputs.mjs' makeInputs) -> tmp/spike/spike.zip   (--skip-inputs reuses the last)
//   b. the Kaggle username: --kaggle-user, else KAGGLE_USERNAME, else ~/.kaggle/kaggle.json
//   c. the inputs as a private Kaggle dataset <user>/fitroom-spike-inputs (created once, then a new version each run),
//      waited for until Kaggle says it is ready
//   d. the kernel <user>/fitroom-tryon-spike from script/spike/kaggle/ (spike.py with the run's settings written into
//      its CONFIG line, since `kernels push` uploads only the code file), pushed
//   e. `kaggle kernels status` every 30 s until it is complete or failed (90 minutes at most)
//   f. `kaggle kernels output` into tmp/spike/out: sheet.png, results.json, NAME-fashn.png, NAME-leffa.png, log.txt
//
// Needs the Kaggle CLI (`tmp/venv/bin/pip install kaggle`, or `pip install kaggle`), an API token in
// ~/.kaggle/kaggle.json (kaggle.com/settings -> API -> Create New Token), and a phone-verified Kaggle account
// (GPU and internet in notebooks need it). Nothing of a person is involved: the inputs are the mannequin's
// render and the shop's own photo. The pure parts live in lib.mjs (test/javascript/spike_run.test.mjs).
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { makeInputs } from "./inputs.mjs"
import {
  KAGGLE_DATASET_SLUG, KAGGLE_KERNEL_SLUG, datasetAlreadyExists, datasetMetadata, elapsedWords, embedConfig, kernelDone,
  modelsFor, parseDatasetStatus, parseKernelStatus, parsePushOutput, parseRunArgs, renderKernelMetadata, resolveKaggleUser, resultLines,
} from "./lib.mjs"

const USAGE = "Usage: node script/spike/run.mjs LINK [LINK...] [--models fashn|both] [--skip-inputs] [--body men|women] [--kaggle-user NAME] [--branch main] [--base http://localhost:3000] [--out tmp/spike]"
const HERE = path.dirname(fileURLToPath(import.meta.url))
const KERNEL_TEMPLATE_DIR = path.join(HERE, "kaggle")
const STATUS_POLL_MS = 30000
const DATASET_POLL_MS = 10000
const DATASET_WAIT_MS = 10 * 60000
const RUN_TIMEOUT_MS = 90 * 60000
const KERNEL_TIMEOUT_S = 4 * 3600   // `kernels push -t`: Kaggle stops the session itself after this (its own cap is 12 h)

const sleep = ms => new Promise(r => setTimeout(r, ms))
const say = (...words) => console.log(...words)

function fail(message) {
  console.error(`\n${message}`)
  process.exit(1)
}

// The kaggle CLI: tmp/venv/bin/kaggle when the venv has it, else `kaggle` on PATH.
function kaggleBinary() {
  const venv = path.resolve("tmp/venv/bin/kaggle")
  if (fs.existsSync(venv)) return venv
  const which = spawnSync(process.platform === "win32" ? "where" : "which", ["kaggle"], { encoding: "utf8" })
  if (which.status === 0) return "kaggle"
  fail("The Kaggle CLI isn't installed. Once:  tmp/venv/bin/pip install kaggle   (or: python3 -m venv tmp/venv && tmp/venv/bin/pip install kaggle)")
}

const KAGGLE = kaggleBinary()

// Runs `kaggle ...` and returns { status, stdout, stderr, text }. Never throws; the caller reads the answer.
function kaggle(args, { quiet = false } = {}) {
  const done = spawnSync(KAGGLE, ["-W", ...args], { encoding: "utf8", env: { ...process.env, PYTHONWARNINGS: "ignore" } })
  if (done.error) fail(`Couldn't run ${KAGGLE}: ${done.error.message}`)
  const stdout = done.stdout ?? "", stderr = done.stderr ?? ""
  if (!quiet && process.env.VERBOSE) console.error(`$ kaggle ${args.join(" ")}\n${stdout}${stderr}`)
  return { status: done.status, stdout, stderr, text: `${stdout}\n${stderr}` }
}

// Kaggle's own words for the usual failures, before ours.
function explainKaggleError(text) {
  if (/Max retries exceeded|ProxyError|NewConnectionError|Name or service not known|Connection refused/i.test(text)) {
    return "Couldn't reach kaggle.com from this machine (network or proxy). Check the connection and run again."
  }
  if (/401|Unauthorized|Authentication required|Could not find kaggle.json|KAGGLE_API_TOKEN/i.test(text)) {
    return "Kaggle refused the credentials. Make a token at kaggle.com/settings -> API -> Create New Token and save it as ~/.kaggle/kaggle.json (chmod 600), or set KAGGLE_USERNAME and KAGGLE_KEY."
  }
  if (/403|Forbidden|phone|verif/i.test(text)) {
    return "Kaggle answered 403 (forbidden). The usual cause: the account's phone number isn't verified, which Kaggle requires for GPU and internet in notebooks (kaggle.com/settings -> Phone verification)."
  }
  if (/429|rate limit/i.test(text)) return "Kaggle rate-limited the request; wait a little and run again."
  return null
}

// --- The command line -------------------------------------------------------------------------------------

let options
try { options = parseRunArgs(process.argv.slice(2)) } catch (error) { fail(`${error.message}\n${USAGE}`) }
if (options.links.length === 0 && !options.skipInputs) fail(`Give at least one store link (or --skip-inputs to reuse ${options.out}/spike.zip).\n${USAGE}`)

const zipFile = path.join(options.out, "spike.zip")
const outDir = path.join(options.out, "out")
const began = Date.now()

// a. The inputs ---------------------------------------------------------------------------------------------
say("1/6  Inputs from the running app")
if (options.skipInputs) {
  if (!fs.existsSync(zipFile)) fail(`--skip-inputs, but there is no ${zipFile}. Run without it (with store links) first.`)
  say(`  reusing ${zipFile} (${(fs.statSync(zipFile).size / 1024 / 1024).toFixed(1)} MB)`)
} else {
  try {
    await makeInputs(options.links, options, say)
  } catch (error) {
    fail(error.message)
  }
}

// b. The username -------------------------------------------------------------------------------------------
say("\n2/6  Kaggle account")
const tokenFile = path.join(process.env.KAGGLE_CONFIG_DIR || path.join(os.homedir(), ".kaggle"), "kaggle.json")
let tokenJson = null
try { tokenJson = fs.readFileSync(tokenFile, "utf8") } catch {}
const user = resolveKaggleUser({ flag: options.kaggleUser, env: process.env, json: tokenJson })
if (!user) {
  fail(`No Kaggle username. Either --kaggle-user NAME, or KAGGLE_USERNAME in the env, or a token file at ${tokenFile} (kaggle.com/settings -> API -> Create New Token; it holds {"username": ..., "key": ...}).`)
}
if (!tokenJson && !process.env.KAGGLE_KEY && !process.env.KAGGLE_API_TOKEN && !fs.existsSync(path.join(path.dirname(tokenFile), "access_token"))) {
  fail(`No Kaggle token: ${tokenFile} isn't there and KAGGLE_KEY isn't set. kaggle.com/settings -> API -> Create New Token, save the download as ${tokenFile}, chmod 600.`)
}
say(`  user ${user}, CLI ${KAGGLE}`)
{
  const whoami = kaggle(["datasets", "list", "-m", "--page-size", "1"], { quiet: true })
  if (whoami.status !== 0) fail(`The Kaggle CLI can't reach the account:\n${whoami.text.trim()}\n\n${explainKaggleError(whoami.text) ?? ""}`)
}

// c. The dataset --------------------------------------------------------------------------------------------
say("\n3/6  Inputs dataset on Kaggle")
const datasetId = `${user}/${KAGGLE_DATASET_SLUG}`
const datasetDir = path.join(options.out, "kaggle-dataset")
fs.rmSync(datasetDir, { recursive: true, force: true })
fs.mkdirSync(datasetDir, { recursive: true })
fs.writeFileSync(path.join(datasetDir, "dataset-metadata.json"), JSON.stringify(datasetMetadata(user), null, 2) + "\n")
fs.copyFileSync(zipFile, path.join(datasetDir, "spike.zip"))

const before = parseDatasetStatus(kaggle(["datasets", "status", datasetId, "--format", "json(status,current_version_number)"], { quiet: true }).stdout)
let exists = before.status !== null
if (!exists) {
  say(`  creating ${datasetId} (private)...`)
  const created = kaggle(["datasets", "create", "-p", datasetDir, "-q"])
  if (datasetAlreadyExists(created.text)) {
    exists = true
  } else if (created.status !== 0 || /creation error/i.test(created.text)) {
    fail(`kaggle datasets create failed:\n${created.text.trim()}\n\n${explainKaggleError(created.text) ?? ""}`)
  } else {
    say(`  ${created.stdout.trim().split("\n").pop()}`)
  }
}
if (exists) {
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, "Z")
  say(`  new version of ${datasetId} (${stamp}; it was version ${before.version ?? "?"})...`)
  const versioned = kaggle(["datasets", "version", "-p", datasetDir, "-m", `spike inputs ${stamp}`, "-q"])
  if (versioned.status !== 0 || /creation error/i.test(versioned.text)) {
    fail(`kaggle datasets version failed:\n${versioned.text.trim()}\n\n${explainKaggleError(versioned.text) ?? ""}`)
  }
  say(`  ${versioned.stdout.trim().split("\n").pop()}`)
}

// Kaggle unpacks the upload in the background; the kernel must not start on the old version.
{
  const waitBegan = Date.now()
  let last = null
  for (;;) {
    const now = parseDatasetStatus(kaggle(["datasets", "status", datasetId, "--format", "json(status,current_version_number)"], { quiet: true }).stdout)
    const newVersion = !exists || before.version === null || now.version === null || now.version > before.version
    if (now.status === "ready" && newVersion) { say(`  ready (version ${now.version ?? "?"}) after ${elapsedWords((Date.now() - waitBegan) / 1000)}`); break }
    if (now.status === "failed") fail(`Kaggle couldn't process the dataset (status failed). Look at https://www.kaggle.com/datasets/${datasetId}`)
    const line = `${now.status ?? "no answer yet"}${now.version !== null ? ` v${now.version}` : ""}`
    if (line !== last) { say(`  ${line}...`); last = line }
    if (Date.now() - waitBegan > DATASET_WAIT_MS) fail(`The dataset wasn't ready after ${elapsedWords(DATASET_WAIT_MS / 1000)}. Look at https://www.kaggle.com/datasets/${datasetId}, then run again with --skip-inputs.`)
    await sleep(DATASET_POLL_MS)
  }
}

// d. The kernel ---------------------------------------------------------------------------------------------
say("\n4/6  Kernel")
const kernelId = `${user}/${KAGGLE_KERNEL_SLUG}`
const kernelDir = path.join(options.out, "kaggle-kernel")
fs.rmSync(kernelDir, { recursive: true, force: true })
fs.mkdirSync(kernelDir, { recursive: true })
const metadata = renderKernelMetadata(fs.readFileSync(path.join(KERNEL_TEMPLATE_DIR, "kernel-metadata.json"), "utf8"), user)
fs.writeFileSync(path.join(kernelDir, "kernel-metadata.json"), JSON.stringify(metadata, null, 2) + "\n")
const config = { models: modelsFor(options.models), branch: options.branch, dataset: KAGGLE_DATASET_SLUG, steps: 30, seed: 7 }
fs.writeFileSync(path.join(kernelDir, "config.json"), JSON.stringify(config, null, 2) + "\n")   // for the record; the kernel reads the line below
fs.writeFileSync(path.join(kernelDir, metadata.code_file), embedConfig(fs.readFileSync(path.join(KERNEL_TEMPLATE_DIR, "spike.py"), "utf8"), config))
say(`  ${kernelId}: models ${config.models.join("+")}, engine from github.com/ac7552/fitroom@${config.branch}, GPU + internet`)
const pushed = parsePushOutput(kaggle(["kernels", "push", "-p", kernelDir, "-t", String(KERNEL_TIMEOUT_S)]).stdout)
if (pushed.error) {
  const push = kaggle(["kernels", "push", "-p", kernelDir], { quiet: true })   // once more, in case -t was the problem
  const again = parsePushOutput(push.stdout)
  if (again.error) fail(`kaggle kernels push failed: ${again.error}\n${push.stderr.trim()}\n\n${explainKaggleError(`${again.error} ${push.stderr}`) ?? "If it names the dataset source, the dataset may not be visible yet: run again with --skip-inputs in a minute."}`)
  Object.assign(pushed, again)
}
// `kernels status owner/slug/N` asks about that version (the CLI sends it as "vN"); should Kaggle not know
// the version yet, the plain id (the latest run) stands in.
let versionId = pushed.version ? `${kernelId}/${pushed.version}` : kernelId
say(`  pushed${pushed.version ? ` as version ${pushed.version}` : ""}: ${pushed.url ?? `https://www.kaggle.com/code/${kernelId}`}`)

// e. Waiting ------------------------------------------------------------------------------------------------
say("\n5/6  Running on Kaggle (every 30 s; a first run is 20 to 30 minutes, most of it the weights)")
let final = null
{
  const waitBegan = Date.now()
  let lastStatus = null
  let blanks = 0
  for (;;) {
    const answer = kaggle(["kernels", "status", versionId], { quiet: true })
    const status = parseKernelStatus(answer.text)
    const elapsed = elapsedWords((Date.now() - waitBegan) / 1000)
    if (status.status === null) {
      const why = explainKaggleError(answer.text)
      if (why) fail(`kaggle kernels status: ${answer.text.trim()}\n\n${why}`)
      say(`  ${elapsed}  (no status yet: ${answer.text.trim().split("\n")[0] || "empty answer"})`)
      if (++blanks >= 3 && versionId !== kernelId) { versionId = kernelId; say(`  asking for ${kernelId} (the latest run) instead`) }
    } else if (status.status !== lastStatus) {
      say(`  ${elapsed}  ${status.status}${status.failure ? ` — ${status.failure}` : ""}`)
      lastStatus = status.status
    } else {
      say(`  ${elapsed}  ${status.status}`)
    }
    if (kernelDone(status.status)) { final = status; break }
    if (Date.now() - waitBegan > RUN_TIMEOUT_MS) {
      say(`  still ${status.status ?? "unknown"} after ${elapsed}; giving up on waiting. Kaggle keeps running it: https://www.kaggle.com/code/${kernelId}`)
      final = { status: "timeout", failure: null }
      break
    }
    await sleep(STATUS_POLL_MS)
  }
}

// f. The output ---------------------------------------------------------------------------------------------
say("\n6/6  Output")
fs.rmSync(outDir, { recursive: true, force: true })
fs.mkdirSync(outDir, { recursive: true })
const fetched = kaggle(["kernels", "output", versionId, "-p", outDir, "-o", "-q"])
if (fetched.status !== 0) say(`  (kaggle kernels output: ${fetched.text.trim().split("\n")[0]})`)
// Should the kernel have written into a subfolder, bring the files up beside the log.
for (const sub of ["out", "working"]) {
  const nested = path.join(outDir, sub)
  if (fs.existsSync(nested) && fs.statSync(nested).isDirectory()) {
    for (const f of fs.readdirSync(nested)) fs.renameSync(path.join(nested, f), path.join(outDir, f))
    fs.rmdirSync(nested)
  }
}
const files = fs.existsSync(outDir) ? fs.readdirSync(outDir).sort() : []
say(`  ${outDir}/`)
for (const file of files) {
  const size = fs.statSync(path.join(outDir, file)).size
  say(`    ${file}  ${size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(size / 1024)} KB`}`)
}

const kernelLog = [path.join(outDir, `${KAGGLE_KERNEL_SLUG}.log`), path.join(outDir, "log.txt")].find(f => fs.existsSync(f))
function logTail(lines = 40) {
  if (!kernelLog) return "(no log came down)"
  let text = fs.readFileSync(kernelLog, "utf8")
  // Kaggle's session log is JSON lines ({"stream_name", "time", "data"}); the data is what we want.
  if (text.trimStart().startsWith("[") || text.trimStart().startsWith("{")) {
    try {
      const entries = JSON.parse(text.trimStart().startsWith("[") ? text : `[${text.trim().split("\n").join(",")}]`)
      text = entries.map(e => (typeof e === "string" ? e : e.data ?? JSON.stringify(e))).join("")
    } catch { /* keep the raw text */ }
  }
  return text.trim().split("\n").slice(-lines).join("\n")
}

const results = path.join(outDir, "results.json")
if (final?.status === "complete" && fs.existsSync(results)) {
  say("")
  for (const line of resultLines(JSON.parse(fs.readFileSync(results, "utf8")))) say(`  ${line}`)
  say(`\nDone in ${elapsedWords((Date.now() - began) / 1000)}.  open ${path.join(outDir, "sheet.png")}`)
} else {
  say(`\nThe kernel ended with status "${final?.status ?? "unknown"}"${final?.failure ? `: ${final.failure}` : ""}. The log's tail (${kernelLog ?? "none"}):\n`)
  say(logTail())
  const tail = logTail(400)
  const hints = []
  if (/No GPU|cuda.*False|No internet/i.test(tail)) hints.push("Kaggle ran the kernel without a GPU or without the internet: the account's phone number must be verified (kaggle.com/settings -> Phone verification), and after that, once, open the kernel on kaggle.com and check Settings shows GPU and Internet on.")
  if (/No module named|pip.*exited|ResolutionImpossible/i.test(tail)) hints.push("A library didn't install on Kaggle's image; the pins are in script/spike/kaggle/spike.py (PINS). Compare with what the Colab notebook installs.")
  if (/no inputs under|nothing to run/i.test(tail)) hints.push(`The kernel saw no inputs: look at https://www.kaggle.com/datasets/${datasetId} (it should hold the NAME-*.png files or spike.zip), then run again with --skip-inputs.`)
  if (/isn't in the .* branch/i.test(tail)) hints.push("The engine (script/modal/tryon_engine.py) isn't on that GitHub branch yet: push it, or pass --branch with the branch that has it.")
  for (const hint of hints) say(`\n${hint}`)
  say(`\nThe whole log: ${kernelLog ?? "(none)"}; the kernel: https://www.kaggle.com/code/${kernelId}`)
  process.exit(1)
}
