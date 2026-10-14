import { once } from "node:events"
import { rename, writeFile } from "node:fs/promises"
import { join } from "node:path"

import {
  InteractionTimeline,
  Recorder,
  RecordingContext,
  clickAt,
  findElementBySelector,
  findElementByText,
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

function recordingClient(session: CDPSession, fps: number): CDPClient {
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
      captureScreenshot: async (params) => {
        const remaining = 1000 / fps - (performance.now() - lastCapture)
        if (remaining > 0) await pause(remaining)
        lastCapture = performance.now()
        return session.send("Page.captureScreenshot", {
          ...params,
          format: "jpeg",
          quality: 95,
          optimizeForSpeed: false,
        })
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
    "Inspect rejected result": 'Rejected "ababaa".',
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
  configHash: string
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
    const client = recordingClient(session, fps)
    const context = new RecordingContext()
    context.setMode("record")
    context.setClickDwell(config.clickDwell ?? 120)
    const timeline = new InteractionTimeline(width, height, {
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
            const box = step.selector
              ? await findElementBySelector(client, step.selector, step.within)
              : await findElementByText(client, step.text!, step.within)
            if (!box)
              throw new Error(`Target not found: ${step.selector ?? step.text}`)
            if (step.action === "click") {
              await clickAt(
                context,
                client,
                box.x + box.width / 2,
                box.y + box.height / 2,
                step.modifiers
              )
            } else {
              await moveCursorTo(
                context,
                client,
                box.x + box.width / 2,
                box.y + box.height / 2
              )
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
    return {
      configHash,
      width,
      height,
      fps,
      frameCount: data.frames.length,
      steps,
    }
  } finally {
    if (recorder) await recorder.stop()
    if (browser) await browser.close()
    if (server) await server.close()
  }
}
