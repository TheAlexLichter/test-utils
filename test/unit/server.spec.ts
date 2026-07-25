import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const spawned: FakeProcess[] = []

/** Stands in for the tinyexec result: exposes what `waitForServer` inspects. */
class FakeProcess {
  killed = false
  exitCode: number | null = null
  kill = vi.fn(() => {
    this.killed = true
    this.exitCode = 0
    return true
  })

  async* [Symbol.asyncIterator]() {}

  then<T>(onFulfilled?: () => T) {
    return Promise.resolve(onFulfilled?.())
  }

  /** Simulates the process exiting on its own, as `nuxi _dev` does on restart. */
  exitCleanly() {
    this.exitCode = 0
  }
}

vi.mock('tinyexec', () => ({
  x: vi.fn(() => {
    const proc = new FakeProcess()
    spawned.push(proc)
    return proc
  }),
}))

vi.mock('get-port-please', () => ({
  getRandomPort: vi.fn(() => Promise.resolve(31_337)),
  waitForPort: vi.fn(() => Promise.resolve()),
}))

let respond: () => Promise<Response> = () => Promise.reject(new Error('connection refused'))
// `server.ts` binds `globalThis.fetch` at import time, so the stub has to be in
// place before it is imported; the handler stays swappable per test.
vi.stubGlobal('fetch', () => respond())

const { createTestContext, setTestContext } = await import('../../src/e2e/context.ts')
const { startServer } = await import('../../src/e2e/server.ts')

function createContext(dev: boolean) {
  const ctx = createTestContext({
    dev,
    server: true,
    build: false,
    captureServerLogs: false,
    serverStartTimeout: 2000,
    nuxtConfig: { nitro: { output: { dir: '/tmp/nonexistent' } } } as never,
  })
  if (dev) {
    ctx.nuxt = { options: { rootDir: '/tmp/fixture', app: { baseURL: '/' } } } as never
  }
  return ctx
}

describe('startServer', () => {
  beforeEach(() => {
    spawned.length = 0
    respond = () => Promise.reject(new Error('connection refused'))
  })

  afterEach(() => {
    setTestContext(undefined)
  })

  it('respawns a dev server that exits before becoming ready', async () => {
    createContext(true)

    // refuse connections until the second process is up
    respond = () => spawned.length < 2
      ? Promise.reject(new Error('connection refused'))
      : Promise.resolve(new Response('<html>ready</html>', { status: 200 }))

    const started = startServer()
    await vi.waitFor(() => expect(spawned).toHaveLength(1))
    spawned[0]!.exitCleanly()

    await expect(started).resolves.toBeUndefined()
    expect(spawned).toHaveLength(2)
  })

  it('gives up once the restart budget is exhausted', async () => {
    createContext(true)
    const started = startServer()

    // every spawned process exits cleanly without ever serving
    await vi.waitFor(() => expect(spawned.length).toBeGreaterThan(0))
    for (let i = 0; i < 4; i++) {
      const proc = spawned.at(-1)!
      proc.exitCleanly()
      await vi.waitFor(() => expect(spawned.at(-1)).not.toBe(proc)).catch(() => {})
    }

    await expect(started).rejects.toThrow(/exited before becoming ready/)
    // the initial spawn plus MAX_DEV_SERVER_RESTARTS
    expect(spawned).toHaveLength(3)
  })

  it('does not respawn a built server', async () => {
    createContext(false)
    const started = startServer()

    await vi.waitFor(() => expect(spawned).toHaveLength(1))
    spawned[0]!.exitCleanly()

    await expect(started).rejects.toThrow(/exited before becoming ready/)
    expect(spawned).toHaveLength(1)
  })
})
