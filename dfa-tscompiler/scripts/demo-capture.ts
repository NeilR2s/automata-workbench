import { once } from "node:events"
import { rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import {
  InteractionTimeline,
  Recorder,
  RecordingContext,
  launchChrome,
  moveCursorTo,
  pause,
  pressKey,
  typeText,
  type CDPClient,
} from "@webreel/core"
import { chromium, type CDPSession, type Page } from "playwright"
import { createServer } from "vite"
import type { VideoConfig } from "webreel"

import type { Box, Capture, RecordedStep } from "./demo-director"

class SmoothCursorTimeline extends InteractionTimeline {
  override tickDuplicate() {
    // GUI frames may repeat, but the composited cursor still advances at 60fps.
    super.tick()
  }
}

function clickModifiers(modifiers: string[] = []) {
  const names = {
    alt: "Alt",
    ctrl: "Control",
    control: "Control",
    cmd: "Meta",
    meta: "Meta",
    shift: "Shift",
    mod: "ControlOrMeta",
  } as const
  return modifiers.map((modifier) => {
    const name = names[modifier.toLowerCase() as keyof typeof names]
    if (!name) throw new Error(`Unknown click modifier: ${modifier}`)
    return name
  })
}

// Keep Webreel's downloaded Chrome and recording engine. Its 0.1.4 launcher
// enables begin-frame control, which stalls Page.captureScreenshot in newer
// headless shells. Playwright launches that same binary with normal rendering.
async function managedChromePath() {
  if (process.env.CHROME_HEADLESS_PATH) return process.env.CHROME_HEADLESS_PATH
  const chrome = await launchChrome({ headless: true })
  const executable = chrome.process.spawnfile
  const exited = once(chrome.process, "exit")
  chrome.kill()
  await exited
  return executable
}

function recordingClient(
  session: CDPSession,
  page: Page,
  fps: number
): CDPClient {
  let lastCapture = 0
  return {
    close: () => session.detach(),
    Page: {
      enable: async () => {
        await session.send("Page.enable")
      },
      navigate: async (params) => {
        await session.send("Page.navigate", params)
      },
      loadEventFired: () =>
        new Promise<void>((resolve) => {
          session.once("Page.loadEventFired", () => resolve())
        }),
      captureScreenshot: async () => {
        const remaining = 1000 / fps - (performance.now() - lastCapture)
        if (remaining > 0) await pause(remaining)
        lastCapture = performance.now()
        // Playwright owns the viewport's CDP session. Its screenshot API keeps
        // physical-pixel capture and trusted pointer coordinates in sync.
        const image = await page.screenshot({
          type: "jpeg",
          quality: 95,
          scale: "device",
          caret: "initial",
          timeout: 10000,
        })
        return { data: image.toString("base64") }
      },
    },
    Runtime: {
      enable: async () => {
        await session.send("Runtime.enable")
      },
      evaluate: (params) => session.send("Runtime.evaluate", params),
    },
    Input: {
      dispatchMouseEvent: async (params) => {
        if (params.type === "mouseMoved") {
          await page.mouse.move(params.x, params.y)
          return
        }
        await session.send("Input.dispatchMouseEvent", {
          ...params,
          type: params.type as
            | "mousePressed"
            | "mouseReleased"
            | "mouseMoved"
            | "mouseWheel",
          button: params.button as
            | "left"
            | "right"
            | "middle"
            | "none"
            | undefined,
        })
      },
      dispatchKeyEvent: async (params) => {
        await session.send("Input.dispatchKeyEvent", {
          ...params,
          type: params.type as "keyDown" | "keyUp" | "rawKeyDown" | "char",
        })
      },
    },
    Emulation: {
      setDeviceMetricsOverride: async (params) => {
        await session.send("Emulation.setDeviceMetricsOverride", params)
      },
    },
    DOM: {
      enable: async () => {
        await session.send("DOM.enable")
      },
    },
  }
}

async function ensureWorkbench(root: string, baseUrl: string) {
  try {
    const response = await fetch(baseUrl, { signal: AbortSignal.timeout(2000) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return undefined
  } catch {
    const url = new URL(baseUrl)
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
      throw new Error(`Workbench is unavailable at ${baseUrl}`)
    }
    const server = await createServer({
      root,
      logLevel: "error",
      server: {
        host: url.hostname,
        port: Number(url.port || 80),
        strictPort: true,
      },
    })
    try {
      await server.listen()
    } catch (error) {
      await server.close()
      throw error
    }
    return server
  }
}

const TARGETS = {
  workbench: "main > section",
  control: "main > section > aside",
  input: "#input-string",
  graph: "svg.graph-canvas",
  grammar: "main > section > section > div > div:first-child",
  form: "main > section > section > div > div:last-child",
  stack: "main > section > section aside",
}

async function measure(page: Page, zoom: number): Promise<Record<string, Box>> {
  const boxes: Record<string, Box> = {}
  for (const [name, selector] of Object.entries(TARGETS)) {
    const locator = page.locator(selector).first()
    if (!(await locator.count())) continue
    const box = await locator.boundingBox()
    if (box) {
      boxes[name] = {
        x: box.x * zoom,
        y: box.y * zoom,
        width: box.width * zoom,
        height: box.height * zoom,
      }
    }
  }
  if (boxes.control) {
    boxes.trace = {
      ...boxes.control,
      height: Math.min(520 * zoom, boxes.control.height),
    }
  }
  return boxes
}

async function verifyShowcase(page: Page, label?: string) {
  const expectations: Record<string, string> = {
    "Inspect accepted DFA result": 'Accepted "aaabaa".',
    "Inspect rejected result":
      "Simulation stopped: transition reached trap state q7.",
    "Inspect derived input string": 'Accepted "aaabaa".',
    "Inspect accepted PDA result": 'Accepted "aaabaa".',
  }
  if (label && expectations[label]) {
    const status = await page
      .locator("main > section > aside [aria-live]")
      .innerText()
    if (status !== expectations[label]) {
      throw new Error(
        `${label}: expected ${expectations[label]}, got ${status}`
      )
    }
    await page
      .locator(
        'aside [data-step-active="true"]:not(:has(~ [data-step-active]))'
      )
      .waitFor()
    const badge = await page
      .locator("main > section > section > div:first-child > span:last-child")
      .innerText()
    const expectedBadge =
      label === "Inspect rejected result" ? "Rejected" : "Accepted"
    if (badge.toLowerCase() !== expectedBadge.toLowerCase())
      throw new Error(`${label}: expected ${expectedBadge} badge, got ${badge}`)
  }
  if (label === "Inspect derived input string") {
    const form = await page
      .locator("main > section > section strong")
      .innerText()
    if (form.replace(/\s/g, "") !== "aaabaa")
      throw new Error(`Unexpected CFG form: ${form}`)
  }
  if (label === "Inspect accepted PDA result") {
    const symbols = await page
      .locator("main > section > section aside .flex-col-reverse > div")
      .count()
    if (symbols !== 7)
      throw new Error(`Expected Z0 plus six stack symbols, got ${symbols}`)
  }
  if (label === "Inspect STARS") {
    const nodes = await page
      .locator('svg[aria-label="STARS DFA graph"] .graph-node')
      .count()
    if (nodes !== 24) throw new Error(`Expected 24 STARS states, got ${nodes}`)
  }
}

export async function captureDemo(
  root: string,
  work: string,
  config: VideoConfig,
  configHash: string,
  verifyFrame: (path: string) => Promise<void>
): Promise<Capture> {
  const baseUrl = config.baseUrl ?? "http://localhost:5173"
  const server = await ensureWorkbench(root, baseUrl)
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  let recorder: Recorder | undefined
  try {
    browser = await chromium.launch({
      executablePath: await managedChromePath(),
      headless: true,
      args: ["--no-sandbox", "--hide-scrollbars"],
    })
    const width = config.viewport!.width
    const height = config.viewport!.height
    const zoom = config.zoom ?? 1
    const fps = config.fps ?? 60
    const page = await browser.newPage({
      viewport: {
        width: Math.round(width / zoom),
        height: Math.round(height / zoom),
      },
      deviceScaleFactor: zoom,
    })
    await page.goto(new URL(config.url, baseUrl).href, {
      waitUntil: "networkidle",
    })
    await page.locator("#input-string").waitFor()
    await page.getByRole("heading", { name: "Automata", exact: true }).waitFor()
    // Let web fonts and the initial SVG layout settle before the opening frame.
    await page.evaluate("document.fonts.ready")
    await pause(300)
    const session = await page.context().newCDPSession(page)
    const client = recordingClient(session, page, fps)
    let timeout: ReturnType<typeof setTimeout> | undefined
    const screenshot = await Promise.race([
      client.Page.captureScreenshot({ format: "jpeg" }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error("Chrome did not produce a frame within 10 seconds")
            ),
          10000
        )
      }),
    ]).finally(() => clearTimeout(timeout))
    const preflight = join(work, "preflight.jpg")
    await writeFile(preflight, Buffer.from(screenshot.data, "base64"))
    await verifyFrame(preflight)
    const context = new RecordingContext()
    context.setMode("record")
    context.setClickDwell(config.clickDwell ?? 120)
    const timeline = new SmoothCursorTimeline(width, height, {
      fps,
      zoom,
      initialCursor: { x: -40, y: -40 },
      cursorSize: config.theme?.cursor?.size ?? 22,
      hud: config.theme?.hud,
    })
    context.setTimeline(timeline)
    recorder = new Recorder(width, height, { fps, crf: 12 })
    recorder.setTimeline(timeline)
    await recorder.start(client, join(work, "raw.mp4"), context)
    const steps: RecordedStep[] = []
    for (const [index, step] of config.steps.entries()) {
      const startFrame = timeline.getFrameCount()
      console.log(
        `  ${index + 1}/${config.steps.length} ${step.label ?? step.action}`
      )
      try {
        switch (step.action) {
          case "pause":
            await pause(step.ms)
            break
          case "click":
          case "moveTo": {
            const scope = page.locator(step.within ?? "body")
            const target = step.selector
              ? scope.locator(step.selector).first()
              : scope.getByText(step.text!, { exact: true }).first()
            const box = await target.boundingBox()
            if (!box)
              throw new Error(`Target not found: ${step.selector ?? step.text}`)
            await moveCursorTo(
              context,
              client,
              box.x + box.width / 2,
              box.y + box.height / 2
            )
            if (step.action === "click") {
              if (!(await target.isEnabled()))
                throw new Error(
                  `Click target is disabled: ${step.selector ?? step.text}`
                )
              await pause(context.getClickDwellMs())
              timeline.setCursorScale(0.75)
              context.markEvent("click")
              // Radix selects require a trusted pointer event chain. Webreel's
              // synthetic JS click fallback can leave the menu open instead.
              await target.click({ modifiers: clickModifiers(step.modifiers) })
              await pause(120)
              timeline.setCursorScale(1)
            }
            break
          }
          case "key":
            if (step.target) {
              if (typeof step.target !== "string")
                throw new Error("Demo key targets must be CSS selectors")
              await page.locator(step.target).focus()
            }
            await pressKey(context, client, step.key, step.label)
            break
          case "type":
            if (step.selector) await page.locator(step.selector).focus()
            await typeText(context, client, step.text, step.charDelay)
            break
          case "wait":
            if (step.selector) {
              await page
                .locator(
                  step.within
                    ? `${step.within} ${step.selector}`
                    : step.selector
                )
                .first()
                .waitFor({ timeout: step.timeout ?? 15000 })
            } else {
              await page
                .locator(step.within ?? "body")
                .getByText(step.text!, { exact: true })
                .first()
                .waitFor({ timeout: step.timeout ?? 15000 })
            }
            break
          default:
            throw new Error(`Unsupported cinematic demo action: ${step.action}`)
        }
        await pause(
          ("delay" in step ? step.delay : undefined) ??
            config.defaultDelay ??
            100
        )
        await verifyShowcase(page, step.label)
        steps.push({
          action: step.action,
          label: step.label,
          startFrame,
          endFrame: timeline.getFrameCount(),
          boxes: await measure(page, zoom),
        })
      } catch (error) {
        throw new Error(
          `Demo step ${index + 1} (${step.label ?? step.action}) failed`,
          { cause: error }
        )
      }
    }
    await recorder.stop()
    await rename(recorder.getTempVideoPath(), join(work, "raw.mp4"))
    recorder = undefined
    const data = timeline.toJSON()
    await writeFile(join(work, "timeline.json"), JSON.stringify(data))
    const capture: Capture = {
      configHash,
      width,
      height,
      fps,
      frameCount: data.frames.length,
      steps,
    }
    await writeFile(
      join(work, "capture.json"),
      JSON.stringify(capture, null, 2)
    )
    return capture
  } finally {
    try {
      if (recorder) {
        await recorder.stop()
        await rm(recorder.getTempVideoPath(), { force: true })
      }
    } finally {
      try {
        if (browser) await browser.close()
      } finally {
        if (server) await server.close()
      }
    }
  }
}
