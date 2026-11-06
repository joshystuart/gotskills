import {
  AGENT_HOME_VARS,
  PRIMARY_PORT,
  instancePaths,
  isolatedEnvironment,
  preferredPort,
  tauriDevArgs,
} from './dev.mjs'

describe('worktree dev instances', () => {
  it('gives each worktree a stable port that is not the primary port', () => {
    const port = preferredPort('/work/gotskills-a')

    expect(preferredPort('/work/gotskills-a')).toBe(port)
    expect(port).not.toBe(PRIMARY_PORT)
    expect(port).toBeGreaterThanOrEqual(1421)
    expect(port).toBeLessThanOrEqual(1920)
  })

  it('spreads worktrees across ports', () => {
    const ports = new Set(
      Array.from({ length: 20 }, (_, index) => preferredPort(`/work/tree-${index}`))
    )

    expect(ports.size).toBeGreaterThan(15)
  })

  it('keeps instance state inside the worktree', () => {
    expect(instancePaths('/work/tree')).toEqual({
      root: '/work/tree/.gotskills-dev',
      data: '/work/tree/.gotskills-dev/data',
      home: '/work/tree/.gotskills-dev/home',
    })
  })

  it('confines the app to the instance data and home', () => {
    const env = isolatedEnvironment(
      { PATH: '/bin', CLAUDE_CONFIG_DIR: '/real/.claude', CODEX_HOME: '/real/.codex' },
      { data: '/w/data', home: '/w/home', port: 1500 }
    )

    expect(env).toEqual({
      PATH: '/bin',
      GOTSKILLS_DATA_DIR: '/w/data',
      GOTSKILLS_HOME: '/w/home',
      GOTSKILLS_DEV_PORT: '1500',
    })
  })

  it('strips every agent home variable', () => {
    const env = isolatedEnvironment(
      Object.fromEntries(AGENT_HOME_VARS.map((name) => [name, '/real'])),
      { data: '/w/data', home: '/w/home', port: 1500 }
    )

    expect(AGENT_HOME_VARS.filter((name) => name in env)).toEqual([])
  })

  it('keeps explicit data and home overrides', () => {
    const env = isolatedEnvironment(
      { GOTSKILLS_DATA_DIR: '/fixtures/data', GOTSKILLS_HOME: '/fixtures/home' },
      { data: '/w/data', home: '/w/home', port: 1500 }
    )

    expect(env.GOTSKILLS_DATA_DIR).toBe('/fixtures/data')
    expect(env.GOTSKILLS_HOME).toBe('/fixtures/home')
  })

  it('points tauri at the instance port', () => {
    expect(tauriDevArgs(1500, ['--release'])).toEqual([
      'dev',
      '--config',
      '{"build":{"devUrl":"http://localhost:1500"}}',
      '--release',
    ])
  })
})
