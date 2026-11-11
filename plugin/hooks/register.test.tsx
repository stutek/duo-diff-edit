import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  plugin: 'duo-diff-edit',
  component: 'AbovePrompt',
  requestId: 'band',
  props: { hasSurvey: false, isWorking: false },
} as const

const M = (role: 'user' | 'assistant', text: string, toolResult = false) =>
  ({ role, text, toolUses: [], ...(toolResult && { toolResults: [{}] }) })

type On = Parameters<Parameters<typeof test>[1]>[1]
type Engine = Parameters<Parameters<typeof test>[1]>[0]

// The world beneath the mod: env, existing files, the mailbox (a written request stays until a window takes it).
const setup = (on: On, env: Record<string, string>, exists: string[], messages: () => unknown[]) => {
  const w = { written: [] as { path: string, text: string }[], present: new Set<string>(), toasts: [] as string[], prompts: [] as string[] }
  const clock = mock.clock(on, { now: 42 })
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
  on('fs.write', (_, e) => {
    const x = e as { path: string, text: string }
    w.written.push(x)
    w.present.add(x.path)
    return { value: undefined }
  })
  on('fs.exists', (_, e) => {
    const p = (e as { path: string }).path
    return { value: w.present.has(p) || exists.includes(p) }
  })
  on('ui.toast', (_, e) => {
    w.toasts.push((e as { text: string }).text)
    return { value: undefined }
  })
  on('command.run', (_, e) => {   // the command a click runs, as the person would type it
    const x = e as { command: string, args: string }
    w.prompts.push(`/${x.command} ${x.args}`)
    return { text: '' }
  })
  on('session.messages', () => ({ value: messages() }))
  on('turn.complete', () => ({ text: '' }) as never)
  on('session.start', (_, e) => ({ cwd: (e as { cwd: string }).cwd }))
  return { ...w, clock }
}

const complete = ($: Engine) =>
  $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'completed' } as never)

const buttons = async ($: Engine) => {
  const band = await $.ui.mount({ ...BAND, surface: 'vscode' })
  const labels = (await band.findAll({ type: 'Button' })).map((x) => x.text)
  return { band, labels }
}

test('band: files of the last answer with files; kept on an answer without files; rebuilt at session start', async ($, on) => {
  let messages = [
    M('user', 'before'),
    M('assistant', 'Old [x.md](x.md).'),
    M('user', 'next'),
    M('assistant', 'First [SKILL.md](plugin/skills/duo-diff-edit/SKILL.md).'),
    M('user', '', true),
    M('assistant', 'Done [README.md](README.md#L9), `~/notes/todo.md`, `missing.md`, `$XDG_RUNTIME_DIR/duo-diff-edit/`.'),
  ]
  const w = setup(on, { HOME: '/home/me', XDG_RUNTIME_DIR: '/run/user/1000' },
    ['/home/me/project/plugin/skills/duo-diff-edit/SKILL.md', '/home/me/project/README.md', '/home/me/notes/todo.md', '/home/me/project/x.md'],
    () => messages)

  await complete($)
  let { band, labels } = await buttons($)
  expect(labels).toEqual(['📖 SKILL.md', '📖 README.md', '📖 todo.md (notes)'])   // outside the root: no repository, its folder
  await band.press({ key: 'diff:/home/me/project/README.md' })
  expect(w.written).toEqual([{ path: '/run/user/1000/duo-diff-edit/42', text: 'git /home/me/project/README.md\n' }])
  await band.unmount()

  messages = [...messages, M('user', 'thanks'), M('assistant', 'You are welcome.')]   // an answer without files
  await complete($)
  ;({ band, labels } = await buttons($))
  expect(labels).toEqual(['📖 SKILL.md', '📖 README.md', '📖 todo.md (notes)'])
  await band.unmount()

  await $.session.start({ cwd: '/home/me/project', surface: 'vscode', isInteractive: true } as never)
  ;({ band, labels } = await buttons($))
  expect(labels).toEqual(['📖 SKILL.md', '📖 README.md', '📖 todo.md (notes)'])
  await band.unmount()
})

test('band: a file of another project names that project', async ($, on) => {
  const messages = [M('user', 'go'), M('assistant', 'See [a.md](a.md) and `/home/me/Projects/Other/docs/b.md`.')]
  setup(on, { XDG_RUNTIME_DIR: '/run/user/1000' },
    ['/home/me/project/a.md', '/home/me/Projects/Other/docs/b.md', '/home/me/Projects/Other/.git'], () => messages)
  await complete($)
  const { band, labels } = await buttons($)
  expect(labels).toEqual(['📖 a.md', '📖 b.md (Other)'])   // the repository's folder, not docs/
  await band.unmount()
})

// The test engine resolves paths on POSIX, so Windows paths (C:\…) are not testable here.
test('band: without XDG_RUNTIME_DIR the mailbox is in the home directory, never the shared temp directory', async ($, on) => {
  const messages = [M('user', 'go'), M('assistant', 'See [a.md](a.md).')]
  const w = setup(on, { HOME: '/Users/me/', TMPDIR: '/tmp', TEMP: '/never' }, ['/home/me/project/a.md'], () => messages)

  await complete($)
  const { band, labels } = await buttons($)
  expect(labels).toEqual(['📖 a.md'])
  await band.press({ key: 'diff:/home/me/project/a.md' })
  expect(w.written).toEqual([{ path: '/Users/me/.cache/duo-diff-edit/42', text: 'git /home/me/project/a.md\n' }])
  await band.unmount()
})

test('band: a request no window takes within 3 s raises a toast; a taken one does not', async ($, on) => {
  const messages = [M('user', 'go'), M('assistant', 'See [a.md](a.md).')]
  const w = setup(on, { XDG_RUNTIME_DIR: '/run/user/1000' }, ['/home/me/project/a.md'], () => messages)
  await complete($)
  const { band } = await buttons($)

  await band.press({ key: 'diff:/home/me/project/a.md' })
  await w.clock.advance(2999)
  expect(w.toasts).toEqual([])
  await w.clock.advance(1)
  expect(w.toasts.length).toBe(1)
  expect(w.toasts[0]).toContain('no Visual Studio Code window took the request')

  await band.press({ key: 'diff:/home/me/project/a.md' })
  w.present.clear()   // a window took it
  await w.clock.advance(30000)
  expect(w.toasts.length).toBe(1)

  await band.press({ key: 'diff:/home/me/project/a.md' })
  const sent = w.written[w.written.length - 1].path
  w.present.delete(sent)   // the focused window forwarded it; the project's window never takes it
  w.present.add(sent.replace(/[^/]+$/, (n) => `open-${n}`))
  await w.clock.advance(3000)
  expect(w.toasts.length).toBe(1)
  await w.clock.advance(27000)
  expect(w.toasts.length).toBe(2)
  expect(w.toasts[1]).toContain("the project's window did not take the request")
  await band.unmount()
})

test('band: no button for a link that decodes to control characters or does not decode', async ($, on) => {
  const messages = [M('user', 'go'), M('assistant', 'See [x](a.md%0Agit%20/etc/passwd), [y](b%E0%A4%A.md) and [z](c.md).')]
  setup(on, { XDG_RUNTIME_DIR: '/run/user/1000' },
    ['/home/me/project/a.md\ngit /etc/passwd', '/home/me/project/b%E0%A4%A.md', '/home/me/project/c.md'], () => messages)
  await complete($)
  const { band, labels } = await buttons($)
  expect(labels).toEqual(['📖 c.md'])
  await band.unmount()
})

test('band: without the skill option a click only opens the diff', async ($, on) => {
  const messages = [M('user', 'go'), M('assistant', 'See [a.md](a.md).')]
  const w = setup(on, { XDG_RUNTIME_DIR: '/run/user/1000' }, ['/home/me/project/a.md'], () => messages)
  await complete($)
  const { band } = await buttons($)
  await band.press({ key: 'diff:/home/me/project/a.md' })
  expect(w.written.length).toBe(1)
  expect(w.prompts).toEqual([])
  await band.unmount()
})

test('band: with the skill option a click also starts that skill for the file', { options: { skill: 'turbo-pregled' } }, async ($, on) => {
  const messages = [M('user', 'go'), M('assistant', 'See [a.md](a.md) and [b c.md](b%20c.md).')]
  const w = setup(on, { XDG_RUNTIME_DIR: '/run/user/1000' }, ['/home/me/project/a.md', '/home/me/project/b c.md'], () => messages)
  await complete($)
  const { band } = await buttons($)
  await band.press({ key: 'diff:/home/me/project/a.md' })
  expect(w.written).toEqual([{ path: '/run/user/1000/duo-diff-edit/42', text: 'git /home/me/project/a.md\n' }])
  expect(w.prompts).toEqual(['/turbo-pregled /home/me/project/a.md'])

  await band.press({ key: 'diff:/home/me/project/b c.md' })   // a decoded link may carry words: no prompt for it
  expect(w.prompts.length).toBe(1)
  expect(w.toasts.at(-1)).toContain('the path has spaces or quotes')
  await band.unmount()
})

test('band: a skill option that is no skill name starts nothing', { options: { skill: 'do this now' } }, async ($, on) => {
  const messages = [M('user', 'go'), M('assistant', 'See [a.md](a.md).')]
  const w = setup(on, { XDG_RUNTIME_DIR: '/run/user/1000' }, ['/home/me/project/a.md'], () => messages)
  await complete($)
  const { band } = await buttons($)
  await band.press({ key: 'diff:/home/me/project/a.md' })
  expect(w.prompts).toEqual([])
  expect(w.toasts.at(-1)).toContain('is not a skill name')
  await band.unmount()
})
