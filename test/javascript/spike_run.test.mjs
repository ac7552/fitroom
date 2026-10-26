// Run with: node --test test/javascript/*.test.mjs
// The pure parts of script/spike/run.mjs (in lib.mjs): the Kaggle metadata, the username, the CLI's output
// lines, the results summary. The strings are the Kaggle CLI's own (kaggle 2.2.5, kaggle_api_extended.py).
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  datasetAlreadyExists, datasetMetadata, elapsedWords, embedConfig, kernelDone, modelsFor, parseDatasetStatus, parseKernelStatus,
  parsePushOutput, parseRunArgs, renderKernelMetadata, resolveKaggleUser, resultLines,
} from "../../script/spike/lib.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const KAGGLE_DIR = path.join(HERE, "../../script/spike/kaggle")

test("run.mjs' arguments: models, --skip-inputs, --kaggle-user, and inputs.mjs' own", () => {
  const options = parseRunArgs(["https://kith.com/products/a", "--models", "both", "--skip-inputs", "--kaggle-user", "aaron", "--body", "women"])
  assert.deepEqual(options.links, ["https://kith.com/products/a"])
  assert.equal(options.models, "both")
  assert.equal(options.skipInputs, true)
  assert.equal(options.kaggleUser, "aaron")
  assert.equal(options.body, "women")
  assert.equal(options.branch, "main")
  assert.equal(options.out, "tmp/spike")
  const plain = parseRunArgs(["https://x.com/a"])
  assert.equal(plain.models, "fashn")
  assert.equal(plain.skipInputs, false)
  assert.throws(() => parseRunArgs(["--models", "sdxl"]), /fashn, leffa or both/)
  assert.throws(() => parseRunArgs(["--nope", "x"]), /unknown option --nope/)
})

test("the models for the kernel", () => {
  assert.deepEqual(modelsFor("fashn"), ["fashn"])
  assert.deepEqual(modelsFor("both"), ["fashn", "leffa"])
})

test("the Kaggle username: flag, then env, then kaggle.json", () => {
  const json = JSON.stringify({ username: "aaron", key: "secret" })
  assert.equal(resolveKaggleUser({ flag: "flagged", env: { KAGGLE_USERNAME: "envy" }, json }), "flagged")
  assert.equal(resolveKaggleUser({ env: { KAGGLE_USERNAME: "envy" }, json }), "envy")
  assert.equal(resolveKaggleUser({ env: {}, json }), "aaron")
  assert.equal(resolveKaggleUser({ env: {}, json: "not json" }), null)
  assert.equal(resolveKaggleUser({ env: {}, json: JSON.stringify({ key: "only" }) }), null)
  assert.equal(resolveKaggleUser({}), null)
})

test("kernel-metadata.json: the template filled for a user, as kernels push wants it", () => {
  const template = fs.readFileSync(path.join(KAGGLE_DIR, "kernel-metadata.json"), "utf8")
  const metadata = renderKernelMetadata(template, "aaron")
  assert.equal(metadata.id, "aaron/fitroom-tryon-spike")
  assert.equal(metadata.title, "fitroom-tryon-spike")   // slugifies to the id's slug, or the CLI warns
  assert.equal(metadata.code_file, "spike.py")
  assert.equal(metadata.language, "python")
  assert.equal(metadata.kernel_type, "script")
  assert.equal(metadata.is_private, true)
  assert.equal(metadata.enable_gpu, true)
  assert.equal(metadata.enable_internet, true)
  assert.deepEqual(metadata.dataset_sources, ["aaron/fitroom-spike-inputs"])
  assert.deepEqual(metadata.kernel_sources, [])
  assert.deepEqual(metadata.competition_sources, [])
  assert.ok(!JSON.stringify(metadata).includes("<KAGGLE_USERNAME>"))
  assert.throws(() => renderKernelMetadata(template, ""), /username/)
  assert.throws(() => renderKernelMetadata('{"id": "a/b"}', "a"), /needs title/)
  assert.throws(() => renderKernelMetadata('{"id": "a/b/3", "title": "t", "code_file": "c", "language": "python", "kernel_type": "script"}', "a"), /owner\/slug/)
})

test("dataset-metadata.json: title 6-50 characters, one licence", () => {
  const metadata = datasetMetadata("aaron")
  assert.deepEqual(metadata, { title: "fitroom-spike-inputs", id: "aaron/fitroom-spike-inputs", licenses: [{ name: "CC0-1.0" }] })
  assert.ok(metadata.title.length >= 6 && metadata.title.length <= 50)
  assert.throws(() => datasetMetadata(null), /username/)
})

test("spike.py carries the run's settings in its CONFIG line", () => {
  const source = fs.readFileSync(path.join(KAGGLE_DIR, "spike.py"), "utf8")
  const filled = embedConfig(source, { models: ["fashn", "leffa"], branch: "kaggle-runner", dataset: "fitroom-spike-inputs", steps: 30, seed: 7 })
  const lines = filled.split("\n").filter(l => l.startsWith("CONFIG = "))
  assert.equal(lines.length, 1)
  assert.equal(lines[0], 'CONFIG = {"models":["fashn","leffa"],"branch":"kaggle-runner","dataset":"fitroom-spike-inputs","steps":30,"seed":7}  # @config')
  assert.equal(filled.split("\n").length, source.split("\n").length)
  assert.throws(() => embedConfig("print(1)\n", {}), /@config/)
})

test("kernels status lines: CLI 2.x's enum, the old plain word, a failure message", () => {
  assert.deepEqual(parseKernelStatus('aaron/fitroom-tryon-spike has status "KernelWorkerStatus.COMPLETE"\n'), { status: "complete", failure: null, raw: 'aaron/fitroom-tryon-spike has status "KernelWorkerStatus.COMPLETE"' })
  assert.equal(parseKernelStatus('aaron/fitroom-tryon-spike has status "running"').status, "running")
  assert.equal(parseKernelStatus('aaron/fitroom-tryon-spike has status "KernelWorkerStatus.QUEUED"').status, "queued")
  const failed = parseKernelStatus('aaron/fitroom-tryon-spike has status "KernelWorkerStatus.ERROR"\nFailure message: "Exit code 1"\n')
  assert.equal(failed.status, "error")
  assert.equal(failed.failure, "Exit code 1")
  assert.equal(parseKernelStatus("404 Client Error: Not Found for url: ...").status, null)
  assert.equal(parseKernelStatus("").status, null)
  assert.equal(kernelDone("complete"), true)
  assert.equal(kernelDone("error"), true)
  assert.equal(kernelDone("cancel_acknowledged"), true)
  assert.equal(kernelDone("running"), false)
  assert.equal(kernelDone(null), false)
})

test("datasets status: the plain word (no newline) and the json form", () => {
  assert.deepEqual(parseDatasetStatus("ready"), { status: "ready", version: null })
  assert.deepEqual(parseDatasetStatus("blobs_received\n"), { status: "blobs_received", version: null })
  assert.deepEqual(parseDatasetStatus('{"status": "ready", "current_version_number": 3}'), { status: "ready", version: 3 })
  assert.deepEqual(parseDatasetStatus('{"status": "failed"}'), { status: "failed", version: null })
  assert.deepEqual(parseDatasetStatus(""), { status: null, version: null })
  assert.equal(parseDatasetStatus("404 Client Error: Not Found for url: https://x").status, null)
})

test("kernels push: the version and url, or the error", () => {
  const ok = parsePushOutput("Kernel version 4 successfully pushed.  Please check progress at https://www.kaggle.com/code/aaron/fitroom-tryon-spike\n")
  assert.deepEqual(ok, { version: 4, url: "https://www.kaggle.com/code/aaron/fitroom-tryon-spike", error: null })
  const bad = parsePushOutput("Kernel push error: The dataset source 'aaron/fitroom-spike-inputs' was not found\n")
  assert.equal(bad.version, null)
  assert.match(bad.error, /dataset source/)
  assert.equal(parsePushOutput("Kernel version successfully pushed.  Please check progress at https://k/x").version, null)
  assert.equal(parsePushOutput("Kernel version successfully pushed.  Please check progress at https://k/x").url, "https://k/x")
  assert.match(parsePushOutput("").error, /no answer/)
})

test("datasets create on a taken slug means: make a version", () => {
  assert.equal(datasetAlreadyExists('Dataset creation error: The requested slug "fitroom-spike-inputs" is already in use by a dataset. Please choose another slug.'), true)
  assert.equal(datasetAlreadyExists("409 Client Error: Conflict for url: ..."), true)
  assert.equal(datasetAlreadyExists("Your private Dataset is being created. Please check progress at https://..."), false)
})

test("results.json becomes one line per picture", () => {
  const results = {
    hoodie: {
      wall_seconds: 70.2, category: "tops",
      fashn: { ok: true, seconds: 66.1, check_seconds: 3.9, checks: { ok: true, shape: { score: 0.951, pass: true }, identity: { score: 0.43, colour: 6.49, pass: true }, print: { skipped: true } } },
      leffa: { ok: false, error: "leffa_failed:RuntimeError", seconds: 12.0 },
    },
    jeans: {
      category: "bottoms",
      fashn: { ok: false, seconds: 60, checks: { ok: false, shape: { score: 0.8, pass: false }, identity: { score: 0.5, colour: null, pass: true }, print: { skipped: false, score: 0.3, pass: false } } },
    },
  }
  assert.deepEqual(resultLines(results), [
    "hoodie fashn: PASS · shape 0.95 ok · look 0.43 colour 6.5 ok · print skipped · 66.1 s",
    "hoodie leffa: FAILED leffa_failed:RuntimeError · 12 s",
    "jeans fashn: REFUSED · shape 0.80 OFF · look 0.50 colour - ok · print 0.30 OFF · 60 s",
  ])
  assert.deepEqual(resultLines({}), [])
})

test("elapsed time in words", () => {
  assert.equal(elapsedWords(5), "5 s")
  assert.equal(elapsedWords(65), "1 m 05 s")
  assert.equal(elapsedWords(1800), "30 m 00 s")
})

test("the username can come from `kaggle config view` (an access-token login)", () => {
  assert.equal(resolveKaggleUser({ configView: "Configuration values from /x\n- username: acampbe2\n- auth_method: ACCESS_TOKEN\n" }), "acampbe2")
  assert.equal(resolveKaggleUser({ configView: "- username: None\n" }), null)
})
