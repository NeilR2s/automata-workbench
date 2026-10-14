import type { Step } from "webreel"

export type Box = { x: number; y: number; width: number; height: number }
export type Pose = { zoom: number; x: number; y: number }
export type RecordedStep = {
  action: Step["action"]
  label?: string
  startFrame: number
  endFrame: number
  boxes: Record<string, Box>
}
export type Capture = {
  configHash: string
  width: number
  height: number
  fps: number
  frameCount: number
  steps: RecordedStep[]
}
export type Shot = {
  id: string
  chapter: string
  caption: string
  startFrame: number
  endFrame: number
  duration: number
  freeze?: boolean
  isolate?: Box
  camera: { at: number; pose: Pose }[]
}

export const WIDE: Pose = { zoom: 1, x: 0, y: 0 }
export const STAGE = { width: 2560, height: 1440, inset: 128, top: 32 }
export const PICTURE = { width: 2304, height: 1296 }

// Coordinates are fractions of the capture, not hard-coded browser pixels.
export function frameBox(
  box: Box,
  width: number,
  height: number,
  maxZoom = 1.7
): Pose {
  if (
    ![box.x, box.y, box.width, box.height, width, height, maxZoom].every(
      Number.isFinite
    ) ||
    width <= 0 ||
    height <= 0 ||
    box.width <= 0 ||
    box.height <= 0 ||
    maxZoom < 1
  ) {
    throw new Error("Invalid camera framing geometry")
  }
  const padding = width * 0.018
  const cropWidth = Math.min(
    width,
    Math.max(
      width / maxZoom,
      box.width + padding * 2,
      (box.height + padding * 2) * (width / height)
    )
  )
  const cropHeight = cropWidth * (height / width)
  const left = Math.max(
    0,
    Math.min(width - cropWidth, box.x + box.width / 2 - cropWidth / 2)
  )
  const top = Math.max(
    0,
    Math.min(height - cropHeight, box.y + box.height / 2 - cropHeight / 2)
  )
  return { zoom: width / cropWidth, x: left / width, y: top / height }
}

export function direct(capture: Capture): Shot[] {
  const cue = (label: string) => {
    const matches = capture.steps.filter((step) => step.label === label)
    if (matches.length !== 1) {
      throw new Error(`Expected exactly one recorded cue: "${label}"`)
    }
    return matches[0]
  }
  const boxAt = (label: string, target: string) => {
    const box = cue(label).boxes[target]
    if (!box) throw new Error(`Missing "${target}" framing at "${label}"`)
    return box
  }
  const focus = (label: string, target: string, zoom = 1.7) =>
    frameBox(boxAt(label, target), capture.width, capture.height, zoom)
  const opening = cue("Overview workbench")
  const workbench = focus("Inspect accepted DFA result", "workbench", 1.25)
  const controls = focus("Inspect input", "input", 1.7)
  const trace = focus("Inspect paused trace", "trace", 1.65)
  const graph = focus("Inspect accepted DFA result", "graph", 1.45)
  const rejection = focus("Inspect rejected result", "graph", 1.45)
  const grammar = focus("Inspect CFG rules", "grammar", 1.5)
  const formWide = focus("Inspect derived input string", "form", 1.6)
  const form = focus("Inspect derived input string", "form", 1.8)
  const pda = focus("Inspect PDA model", "graph", 1.45)
  const stack = focus("Inspect accepted PDA result", "stack", 1.75)
  const stars = focus("Inspect STARS", "workbench", 1.25)
  const bookend = focus("Overview workbench", "workbench", 1.12)
  const pdaGraph = boxAt("Inspect PDA model", "graph")
  const pdaStack = boxAt("Inspect PDA model", "stack")
  const pdaStage: Box = {
    x: Math.min(pdaGraph.x, pdaStack.x),
    y: Math.min(pdaGraph.y, pdaStack.y),
    width:
      Math.max(pdaGraph.x + pdaGraph.width, pdaStack.x + pdaStack.width) -
      Math.min(pdaGraph.x, pdaStack.x),
    height:
      Math.max(pdaGraph.y + pdaGraph.height, pdaStack.y + pdaStack.height) -
      Math.min(pdaGraph.y, pdaStack.y),
  }
  const range = (from: string, to: string) => ({
    startFrame: cue(from).startFrame,
    endFrame: cue(to).endFrame,
  })

  const shots: Shot[] = [
    {
      id: "opening",
      chapter: "AUTOMATA WORKBENCH",
      caption: "Three views. One language.",
      ...range("Overview workbench", "Overview workbench"),
      duration: 3,
      camera: [
        { at: 0, pose: WIDE },
        { at: 2.8, pose: bookend },
      ],
    },
    {
      id: "input",
      chapter: "01 / DFA",
      caption: "Give a machine an input string.",
      isolate: boxAt("Inspect input", "workbench"),
      ...range("Enter input", "Inspect input"),
      duration: 3,
      camera: [
        { at: 0, pose: controls },
        { at: 3, pose: controls },
      ],
    },
    {
      id: "trace",
      chapter: "01 / DFA",
      caption: "Pause. Inspect. Step in either direction.",
      isolate: boxAt("Inspect paused trace", "workbench"),
      startFrame: cue("Run DFA simulation").startFrame,
      endFrame: cue("Resume DFA playback").endFrame,
      duration: 6.5,
      camera: [
        { at: 0, pose: controls },
        { at: 0.9, pose: trace },
        { at: 5.4, pose: trace },
        { at: 6.5, pose: workbench },
      ],
    },
    {
      id: "accepted",
      chapter: "01 / DFA",
      caption: "aaabaa is accepted at q12.",
      isolate: boxAt("Inspect accepted DFA result", "graph"),
      startFrame: cue("Resume DFA playback").endFrame,
      endFrame: cue("Inspect accepted DFA result").endFrame,
      duration: 4,
      camera: [
        { at: 0, pose: workbench },
        { at: 1.4, pose: graph },
        { at: 4, pose: graph },
      ],
    },
    {
      id: "rejected",
      chapter: "02 / REJECTION",
      caption: "ababaa is rejected at trap state q7.",
      isolate: boxAt("Inspect rejected result", "graph"),
      ...range("Run rejected DFA", "Inspect rejected result"),
      duration: 4.5,
      camera: [
        { at: 0, pose: workbench },
        { at: 1.1, pose: rejection },
        { at: 4.5, pose: rejection },
      ],
    },
    {
      id: "grammar-rules",
      chapter: "03 / CFG",
      caption: "Derive the same language from grammar rules.",
      isolate: boxAt("Inspect CFG rules", "grammar"),
      startFrame: cue("Inspect CFG rules").startFrame,
      endFrame: cue("Run CFG derivation").startFrame,
      duration: 2,
      camera: [
        { at: 0, pose: grammar },
        { at: 2, pose: grammar },
      ],
    },
    {
      id: "grammar",
      chapter: "03 / CFG",
      caption: "Watch aaabaa emerge, rule by rule.",
      isolate: boxAt("Inspect derived input string", "form"),
      ...range("Run CFG derivation", "Inspect derived input string"),
      duration: 4.5,
      camera: [
        { at: 0, pose: formWide },
        { at: 1.2, pose: form },
        { at: 4.5, pose: form },
      ],
    },
    {
      id: "stack",
      chapter: "04 / PDA",
      caption: "Follow state, input, and stack together.",
      isolate: pdaStage,
      ...range("Inspect PDA model", "Inspect accepted PDA result"),
      duration: 7,
      camera: [
        { at: 0, pose: pda },
        { at: 1.4, pose: pda },
        { at: 2.6, pose: stack },
        { at: 7, pose: stack },
      ],
    },
    {
      id: "presets",
      chapter: "05 / PRESETS",
      caption: "From 13 states to a 24-state binary machine.",
      isolate: boxAt("Inspect STARS", "workbench"),
      ...range("Reveal STARS", "Inspect STARS"),
      duration: 4.5,
      camera: [
        { at: 0, pose: stars },
        { at: 4.5, pose: stars },
      ],
    },
    {
      id: "closing",
      chapter: "AUTOMATA WORKBENCH",
      caption: "Three views. One language.",
      startFrame: opening.startFrame,
      endFrame: opening.startFrame + 1,
      duration: 3,
      freeze: true,
      camera: [
        { at: 0, pose: bookend },
        { at: 2.8, pose: WIDE },
      ],
    },
  ]
  for (const shot of shots) {
    if (
      shot.startFrame < 0 ||
      shot.endFrame <= shot.startFrame ||
      shot.endFrame > capture.frameCount
    ) {
      throw new Error(`Incomplete capture for shot "${shot.id}"`)
    }
  }
  return shots
}

function cameraExpression(shot: Shot, axis: keyof Pose, fps: number): string {
  const frames = shot.camera
  let expression = String(frames.at(-1)!.pose[axis])
  for (let index = frames.length - 2; index >= 0; index--) {
    const from = frames[index]
    const to = frames[index + 1]
    const end = Math.min(to.at, shot.duration - 1 / fps)
    const p = `clip((on/${fps}-${from.at})/${end - from.at},0,1)`
    const ease = `((${p})*(${p})*(3-2*(${p})))`
    const value = `${from.pose[axis]}+(${to.pose[axis] - from.pose[axis]})*${ease}`
    expression = `if(lt(on/${fps},${end}),${value},${expression})`
  }
  return expression
}

export function pictureFilter(
  shot: Shot,
  fps: number,
  source = { width: STAGE.width, height: STAGE.height }
): string {
  const sourceFrames = shot.endFrame - shot.startFrame
  const retime = (shot.duration * fps) / sourceFrames
  const timing = shot.freeze
    ? `tpad=stop_mode=clone:stop_duration=${shot.duration}`
    : `setpts=${retime}*PTS,fps=${fps},tpad=stop_mode=clone:stop_duration=1`
  const isolation: string[] = []
  if (shot.isolate) {
    const box = shot.isolate
    const x = Math.max(0, Math.floor(box.x / 2) * 2)
    const y = Math.max(0, Math.floor(box.y / 2) * 2)
    const width = Math.min(
      source.width - x,
      Math.ceil((box.x + box.width - x) / 2) * 2
    )
    const height = Math.min(
      source.height - y,
      Math.ceil((box.y + box.height - y) / 2) * 2
    )
    // Detail shots use the real panel pixels on a quiet matte, rather than
    // leaving slivers of clipped sidebar text and unrelated cards in frame.
    isolation.push(
      `crop=${width}:${height}:${x}:${y}`,
      `pad=${source.width}:${source.height}:${x}:${y}:color=0xf7f7f2`
    )
  }
  return [
    `trim=start_frame=${shot.startFrame}:end_frame=${shot.endFrame}`,
    "setpts=PTS-STARTPTS",
    timing,
    `trim=duration=${shot.duration}`,
    ...isolation,
    // Oversampling reduces integer crop-position jitter on thin SVG edges.
    "scale=iw*2:ih*2:flags=bicubic",
    `zoompan=z='${cameraExpression(shot, "zoom", fps)}':x='iw*(${cameraExpression(shot, "x", fps)})':y='ih*(${cameraExpression(shot, "y", fps)})':d=1:s=${PICTURE.width}x${PICTURE.height}:fps=${fps}`,
    "setsar=1",
    `pad=${STAGE.width}:${STAGE.height}:${STAGE.inset}:${STAGE.top}:color=0xf7f7f2`,
  ].join(",")
}
