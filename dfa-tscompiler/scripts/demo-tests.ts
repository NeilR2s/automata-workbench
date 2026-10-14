import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

import type { InputWebreelConfig } from "webreel"

import { simulateCfg, formatSententialForm } from "../src/lib/automata/cfg"
import { simulateDfa } from "../src/lib/automata/dfa"
import { AUTOMATA_PRESETS } from "../src/lib/automata/examples"
import { simulatePda } from "../src/lib/automata/pda"
import {
  direct,
  frameBox,
  pictureFilter,
  WIDE,
  type Capture,
} from "./demo-director"

const [bets, stars] = AUTOMATA_PRESETS
const accepted = simulateDfa(bets.dfa, "aaabaa")
assert.equal(accepted.accepted, true)
const rejected = simulateDfa(bets.dfa, "ababaa")
assert.equal(rejected.accepted, false)
assert.equal(
  rejected.steps.at(-1)?.state,
  7,
  "The rejection shot must actually reach a trap"
)
const cfg = simulateCfg(bets.cfg, "aaabaa")
assert.equal(cfg.accepted, true)
assert.equal(
  formatSententialForm(cfg.steps.at(-1)!.form).replace(/\s/g, ""),
  "aaabaa"
)
const pda = simulatePda(bets.pda, "aaabaa")
assert.equal(pda.accepted, true)
assert.deepEqual(pda.sequence.at(-1)!.stack, ["Z0", ..."aaabaa"])
assert.equal(stars.dfa.states.length, 24)

const width = 2560
const height = 1440
const full = frameBox({ x: 0, y: 0, width, height }, width, height)
assert.deepEqual(full, WIDE)
for (const x of [0, 600, 2100]) {
  for (const y of [0, 650, 1100]) {
    const box = { x, y, width: 400, height: 300 }
    const pose = frameBox(box, width, height, 1.8)
    assert.ok(pose.zoom >= 1 && pose.zoom <= 1.8)
    assert.ok(pose.x >= 0 && pose.x + 1 / pose.zoom <= 1 + 1e-9)
    assert.ok(pose.y >= 0 && pose.y + 1 / pose.zoom <= 1 + 1e-9)
    assert.ok(pose.x * width <= box.x)
    assert.ok(pose.y * height <= box.y)
    assert.ok((pose.x + 1 / pose.zoom) * width >= box.x + box.width)
    assert.ok((pose.y + 1 / pose.zoom) * height >= box.y + box.height)
  }
}
assert.throws(() =>
  frameBox({ x: 0, y: 0, width: 0, height: 10 }, width, height)
)
assert.throws(() => frameBox({ x: 0, y: 0, width: 10, height: 10 }, width, 0))

const config = JSON.parse(
  readFileSync(new URL("../webreel.config.json", import.meta.url), "utf8")
) as InputWebreelConfig
const steps = config.videos["automata-workbench-demo"].steps
const boxes = Object.fromEntries(
  ["workbench", "input", "trace", "graph", "grammar", "form", "stack"].map(
    (target) => [target, { x: 340, y: 375, width: 1880, height: 1020 }]
  )
)
const capture: Capture = {
  configHash: "fixture",
  width,
  height,
  fps: 60,
  frameCount: steps.length * 120 + 1,
  steps: steps.map((step, index) => ({
    action: step.action,
    label: step.label,
    startFrame: index * 120,
    endFrame: (index + 1) * 120,
    boxes,
  })),
}
const shots = direct(capture)
assert.equal(
  shots.reduce((sum, shot) => sum + shot.duration, 0),
  42
)
assert.equal(new Set(shots.map((shot) => shot.id)).size, shots.length)
assert.deepEqual(shots[0].camera[0].pose, shots.at(-1)!.camera.at(-1)!.pose)
assert.equal(
  shots.at(-1)!.startFrame,
  shots[0].startFrame,
  "Loop bookends use the same source frame"
)
assert.equal(shots.at(-1)!.endFrame - shots.at(-1)!.startFrame, 1)
assert.equal(shots.at(-1)!.freeze, true)
for (const shot of shots) {
  const filter = pictureFilter(shot, capture.fps)
  assert.ok(filter.includes("zoompan="))
  assert.ok(
    filter.includes("d=1:"),
    "Camera must output one frame per input frame"
  )
  assert.ok(
    filter.includes("pad=2560:1440:"),
    "Captions must have a separate safe area"
  )
  assert.ok(!filter.includes("NaN") && !filter.includes("Infinity"))
  assert.equal(shot.camera[0].at, 0)
  for (let index = 1; index < shot.camera.length; index++) {
    assert.ok(shot.camera[index].at > shot.camera[index - 1].at)
  }
}
assert.throws(() => direct({ ...capture, steps: [] }), /recorded cue/)
assert.throws(() => direct({ ...capture, frameCount: 1 }), /Incomplete capture/)
assert.throws(
  () => direct({ ...capture, steps: [...capture.steps, capture.steps[0]] }),
  /exactly one/
)
assert.throws(
  () =>
    direct({
      ...capture,
      steps: capture.steps.map((step) => ({ ...step, boxes: {} })),
    }),
  /framing/
)
console.log(
  "Demo checks passed: showcase samples, camera bounds, shot cues, 42-second pacing, and loop continuity."
)
