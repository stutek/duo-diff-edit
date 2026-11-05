import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'duo-diff-edit',
  component: 'AbovePrompt',
  requestId: 'band',
  props: { hasSurvey: false, isWorking: false },
} as const

const M = (role: 'user' | 'assistant', text: string, toolResult = false) =>
  ({ role, text, toolUses: [], ...(toolResult && { toolResults: [{}] }) })

const setup = (
  on: Parameters<Parameters<typeof test>[1]>[1],
  env: Record<string, string>,
  exists: string[],
  written: unknown[],
  messages: () => unknown[],
) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('session.root', () => ({ value: '/home/me/project' }))
  on('env.get', (_, e) => ({ value: env[(e as { name: string }).name] }))
  on('fs.stat', (_, e) => {
    if (!exists.includes((e as { path: string }).path)) throw new Error('ENOENT')
    return { value: { kind: 'file', size: 1, mtimeMs: 1, isLink: false } }
  })
  on('clock.now', () => ({ value: 42 }))
  on('fs.write', (_, e) => {
    written.push(e)
    return { value: undefined }
  })
  on('session.messages', () => ({ value: messages() }))
  on('turn.complete', () => ({ text: '' }) as never)
  on('session.start', (_, e) => ({ cwd: (e as { cwd: string }).cwd }))
}

const complete = ($: Parameters<Parameters<typeof test>[1]>[0]) =>
  $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'completed' } as never)

const buttons = async ($: Parameters<Parameters<typeof test>[1]>[0]) => {
  const band = await $.ui.mount({ ...BAND, surface: 'vscode' })
  const labels = (await band.findAll({ type: 'Button' })).map((x) => x.text)
  return { band, labels }
}

test('band: files of the last answer with files; kept on an answer without files; rebuilt at session start', async ($, on) => {
  const written: unknown[] = []
  let messages = [
    M('user', 'before'),
    M('assistant', 'Old [x.md](x.md).'),
    M('user', 'next'),
    M('assistant', 'First [SKILL.md](plugin/skills/duo-diff-edit/SKILL.md).'),
    M('user', '', true),
    M('assistant', 'Done [README.md](README.md#L9), `~/notes/todo.md`, `missing.md`, `$XDG_RUNTIME_DIR/duo-diff-edit/`.'),
  ]
  setup(on, { HOME: '/home/me', XDG_RUNTIME_DIR: '/run/user/1000' },
    ['/home/me/project/plugin/skills/duo-diff-edit/SKILL.md', '/home/me/project/README.md', '/home/me/notes/todo.md', '/home/me/project/x.md'],
    written, () => messages)

  await complete($)
  let { band, labels } = await buttons($)
  expect(labels).toEqual(['📖 SKILL.md', '📖 README.md', '📖 todo.md'])
  await band.press({ key: 'diff:/home/me/project/README.md' })
  expect(written).toEqual([{ path: '/run/user/1000/duo-diff-edit/42', text: 'git /home/me/project/README.md\n' }])
  await band.unmount()

  messages = [...messages, M('user', 'thanks'), M('assistant', 'You are welcome.')]   // an answer without files
  await complete($)
  ;({ band, labels } = await buttons($))
  expect(labels).toEqual(['📖 SKILL.md', '📖 README.md', '📖 todo.md'])
  await band.unmount()

  await $.session.start({ cwd: '/home/me/project', surface: 'vscode', isInteractive: true } as never)
  ;({ band, labels } = await buttons($))
  expect(labels).toEqual(['📖 SKILL.md', '📖 README.md', '📖 todo.md'])
  await band.unmount()
})

// The test engine resolves paths on POSIX, so Windows paths (C:\…) are not testable here; the macOS temp dir is.
test('band: the macOS temp dir (TMPDIR) when XDG_RUNTIME_DIR is not set', async ($, on) => {
  const written: unknown[] = []
  const messages = [M('user', 'go'), M('assistant', 'See [a.md](a.md).')]
  setup(on, { HOME: '/Users/me', TMPDIR: '/var/folders/ab/xyz/T/', TEMP: '/never' },
    ['/home/me/project/a.md'], written, () => messages)

  await complete($)
  const { band, labels } = await buttons($)
  expect(labels).toEqual(['📖 a.md'])
  await band.press({ key: 'diff:/home/me/project/a.md' })
  expect(written).toEqual([{ path: '/var/folders/ab/xyz/T/duo-diff-edit/42', text: 'git /home/me/project/a.md\n' }])
  await band.unmount()
})
