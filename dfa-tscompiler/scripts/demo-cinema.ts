import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { compose, ensureFfmpeg, type TimelineData } from "@webreel/core"
import {
  VIEWPORT_PRESETS,
  type InputWebreelConfig,
  type VideoConfig,
} from "webreel"

import { captureDemo } from "./demo-capture"
import { direct, pictureFilter, type Capture, type Shot } from "./demo-director"

const root = fileURLToPath(new URL("../", import.meta.url))
const work = join(root, ".webreel", "cinema")
const name = "automata-workbench-demo"

async function run(
  command: string,
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-24000)
    })
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${command} exited with ${code}:\n${stderr}`))
    })
  })
}

// Use Webreel's ffmpeg, not an additional system ffprobe installation.
async function probe(ffmpeg: string, path: string) {
  const { stdout, stderr } = await run(ffmpeg, [
    "-hide_banner",
    "-nostats",
    "-i",
    path,
    "-map",
    "0:v:0",
    "-c",
    "copy",
    "-f",
    "null",
    "-",
    "-progress",
    "pipe:1",
  ])
  const frames = [...stdout.matchAll(/^frame=(\d+)$/gm)].at(-1)
  const dimensions = stderr.match(/Video:.*?\b(\d{3,5})x(\d{3,5})\b/)
  if (!frames || !dimensions) throw new Error(`Could not verify video: ${path}`)
  return {
    frames: Number(frames[1]),
    width: Number(dimensions[1]),
    height: Number(dimensions[2]),
  }
}

function captionFilter(shot: Shot) {
  const quote = (text: string) =>
    text.replace(/\\/g, "\\\\").replace(/'/g, "’").replace(/:/g, "\\:")
  const font = "font='DejaVu Sans Mono'"
  return [
    `drawtext=${font}:text='${quote(shot.chapter)}':expansion=none:fontsize=30:fontcolor=0x1f2228:x=128:y=1370`,
    `drawtext=${font}:text='${quote(shot.caption)}':expansion=none:fontsize=30:fontcolor=0x1f2228@0.7:x=760:y=1370`,
  ].join(",")
}

async function main() {
  const flags = process.argv.slice(2)
  if (flags.some((flag) => flag !== "--render-only"))
    throw new Error("Usage: npm run demo:record [-- --render-only]")
  const configText = await readFile(join(root, "webreel.config.json"), "utf8")
  const configHash = createHash("sha256").update(configText).digest("hex")
  const config = JSON.parse(configText) as InputWebreelConfig
  const body = config.videos[name]
  if (!body) throw new Error(`Missing Webreel video: ${name}`)
  const viewport = body.viewport ?? config.viewport ?? "desktop-hd"
  const dimensions =
    typeof viewport === "string" ? VIEWPORT_PRESETS[viewport] : viewport
  if (!dimensions) throw new Error(`Unknown viewport: ${viewport}`)
  const video: VideoConfig = {
    ...body,
    name,
    viewport: dimensions,
    baseUrl: config.baseUrl,
    theme: body.theme ?? config.theme,
    clickDwell: body.clickDwell ?? config.clickDwell,
    defaultDelay: body.defaultDelay ?? config.defaultDelay,
  }
  const cli = join(
    dirname(fileURLToPath(import.meta.resolve("webreel"))),
    "index.js"
  )
  await run(process.execPath, [cli, "validate"])
  const ffmpeg = await ensureFfmpeg()
  await mkdir(work, { recursive: true })
  let capture: Capture
  if (flags.includes("--render-only")) {
    capture = JSON.parse(
      await readFile(join(work, "capture.json"), "utf8")
    ) as Capture
    if (capture.configHash !== configHash)
      throw new Error(
        "Interaction config changed; run npm run demo:record for a fresh capture"
      )
  } else {
    console.log(
      "Recording cinematic showcase (using Webreel's managed Chrome)…"
    )
    capture = await captureDemo(root, work, video, configHash, async (path) => {
      const frame = await probe(ffmpeg, path)
      if (
        frame.width !== dimensions.width ||
        frame.height !== dimensions.height
      ) {
        throw new Error(
          `Chrome frame size is ${frame.width}×${frame.height}; expected ${dimensions.width}×${dimensions.height}`
        )
      }
    })
  }
  const raw = await probe(ffmpeg, join(work, "raw.mp4"))
  if (
    raw.frames < capture.fps * 3 ||
    raw.width !== capture.width ||
    raw.height !== capture.height
  ) {
    throw new Error(
      "Capture health check failed: missing frames or incorrect dimensions"
    )
  }
  if (Math.abs(raw.frames - capture.frameCount) > 1)
    throw new Error("Video and cursor timeline are out of sync")
  capture.frameCount = raw.frames
  const timeline = JSON.parse(
    await readFile(join(work, "timeline.json"), "utf8")
  ) as TimelineData
  if (
    Math.abs(timeline.frames.length - raw.frames) > 1 ||
    timeline.width !== capture.width ||
    timeline.height !== capture.height ||
    timeline.fps !== capture.fps
  ) {
    throw new Error("Cached cursor timeline does not match the capture")
  }
  timeline.frames = timeline.frames.slice(0, raw.frames)
  await writeFile(join(work, "capture.json"), JSON.stringify(capture, null, 2))
  const shots = direct(capture)
  await writeFile(join(work, "shots.json"), JSON.stringify(shots, null, 2))
  let reuseCursor = false
  if (flags.includes("--render-only")) {
    try {
      const [source, cursor, overlay] = await Promise.all([
        stat(join(work, "raw.mp4")),
        stat(join(work, "cursor.mp4")),
        stat(join(work, "timeline.json")),
      ])
      if (cursor.mtimeMs >= Math.max(source.mtimeMs, overlay.mtimeMs)) {
        const cached = await probe(ffmpeg, join(work, "cursor.mp4"))
        reuseCursor =
          cached.frames === raw.frames &&
          cached.width === raw.width &&
          cached.height === raw.height
      }
    } catch {
      // Missing or incomplete intermediates are safe to regenerate.
    }
  }
  console.log(
    `Capture verified: ${raw.width}×${raw.height}, ${raw.frames} frames. ${reuseCursor ? "Reusing cursor composite." : "Compositing cursor…"}`
  )
  if (!reuseCursor) {
    await compose(join(work, "raw.mp4"), timeline, join(work, "cursor.mp4"), {
      crf: 12,
    })
  }
  const rendered = join(work, "rendered")
  await mkdir(rendered, { recursive: true })
  for (const shot of shots) {
    console.log(`  Framing ${shot.id} (${shot.duration}s)`)
    await run(ffmpeg, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-threads",
      "2",
      "-i",
      join(work, "cursor.mp4"),
      "-an",
      "-vf",
      `${pictureFilter(shot, capture.fps, capture)},${captionFilter(shot)}`,
      "-frames:v",
      String(Math.round(shot.duration * capture.fps)),
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-crf",
      "16",
      "-pix_fmt",
      "yuv420p",
      "-r",
      String(capture.fps),
      join(rendered, `${shot.id}.mp4`),
    ])
  }
  const concatPath = join(rendered, "concat.txt")
  await writeFile(
    concatPath,
    shots.map((shot) => `file '${shot.id}.mp4'`).join("\n")
  )
  const finalMp4 = join(rendered, `${name}.mp4`)
  await run(ffmpeg, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    concatPath,
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    finalMp4,
  ])
  const final = await probe(ffmpeg, finalMp4)
  const expectedFrames = shots.reduce(
    (sum, shot) => sum + Math.round(shot.duration * capture.fps),
    0
  )
  if (
    final.frames !== expectedFrames ||
    final.width !== 2560 ||
    final.height !== 1440
  ) {
    throw new Error(
      `Final video failed verification: expected ${expectedFrames} frames at 2560×1440, got ${JSON.stringify(final)}`
    )
  }
  console.log("Generating looping README preview and poster…")
  await run(ffmpeg, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    finalMp4,
    "-vf",
    "fps=10,scale=1280:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle",
    "-loop",
    "0",
    join(rendered, `${name}.gif`),
  ])
  const accepted = shots.find((shot) => shot.id === "accepted")!
  const poster: Shot = {
    ...accepted,
    startFrame: accepted.endFrame - 1,
    endFrame: accepted.endFrame,
    duration: 1,
    freeze: true,
    isolate: capture.steps.find(
      (step) => step.label === "Inspect accepted DFA result"
    )!.boxes.workbench,
    camera: [{ at: 0, pose: accepted.camera[0].pose }],
  }
  await run(ffmpeg, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    join(work, "cursor.mp4"),
    "-vf",
    `${pictureFilter(poster, capture.fps, capture)},${captionFilter(poster)}`,
    "-frames:v",
    "1",
    join(rendered, `${name}.png`),
  ])
  const outDir = join(root, config.outDir ?? "videos")
  await mkdir(outDir, { recursive: true })
  // Don't replace the previous showcase until every new artifact is ready.
  for (const extension of ["mp4", "gif", "png"]) {
    await rename(
      join(rendered, `${name}.${extension}`),
      join(outDir, `${name}.${extension}`)
    )
  }
  console.log(
    `Done: ${outDir}/${name}.{mp4,gif,png} — ${expectedFrames / capture.fps}s, 1440p/${capture.fps} FPS`
  )
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
