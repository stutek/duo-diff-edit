// A band of "📖" buttons above the prompt box in Visual Studio Code: one per local file the last answer mentions
// (a markdown link or a path in inline code that exists). An answer is all assistant text since the user's last
// message, read at turn.complete (its `answer` carries only the last block). The band stays until an answer brings
// new files and is rebuilt at session start (window reload). A click writes the request "git <absolute path>" to the
// mailbox of the Duo Diff Edit extension for Visual Studio Code: $XDG_RUNTIME_DIR/duo-diff-edit/, else
// <home>/.cache/duo-diff-edit/ (vscode/mailbox.js); a request still there after TAKEN_WITHIN means no window took it.
// A band, not a decoration of the answer: Visual Studio Code renders the answer without mod changes
// (anthropics/claude-code#107335).
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { Paths } from '../types'

const LINK = /\]\(([^)\s]+)\)/g
const CODE = /`((?:~|\.|[A-Za-z]:)?[\\/]?[\w.@+-]+(?:[\\/][\w.@+-]+)*\.[A-Za-z0-9]+)`/g   // path with an extension in inline code
const ABSOLUTE = /^([A-Za-z]:[\\/]|\/)/
const CONTROL = /[\u0000-\u001f\u007f]/   // a decoded %0A would add a second request line
const TAKEN_WITHIN = 3000   // ms: the project's window takes a request at once, the focused window an orphan after 1.5 s
const OPENED_WITHIN = 30000   // ms: a forwarded request ("open-<name>") waits for the project's new window to start
const paths = atom({ plugin: 'duo-diff-edit', key: 'paths' } as const, [] as Paths)

const decode = (p: string): string => { try { return decodeURI(p) } catch { return '' } }   // a stray % is no link
const candidates = (text: string, root: string, home: string): string[] =>
  [
    ...[...text.matchAll(LINK)].map((m) => decode(m[1].replace(/#.*$/, ''))),
    ...[...text.matchAll(CODE)].map((m) => m[1]),
  ]
    .filter((p) => p && !CONTROL.test(p) && !p.includes('://') && !/[\\/]$/.test(p))
    .map((p) => (/^~[\\/]/.test(p) ? `${home}${p.slice(1)}` : p))
    .map((p) => (ABSOLUTE.test(p) ? p : `${root}/${p.replace(/^\.[\\/]/, '')}`))

const slash = (p: string) => p.replace(/\\/g, '/')
// The project of a file outside the session's root: the folder of the nearest repository above it, else its parent
// folder; '' inside the root. Shown on the button, because a click opens the diff in that project's window.
const projectOf = async ($: EngineInterface, file: string, root: string): Promise<string> => {
  const f = slash(file)
  if (f.startsWith(`${slash(root).replace(/\/+$/, '')}/`)) return ''
  const dirs = f.split('/').slice(0, -1)
  for (let n = dirs.length; n > 1; n--) {
    const d = dirs.slice(0, n).join('/')
    if (await $.fs.exists(`${d}/.git`).catch(() => false)) return dirs[n - 1]
  }
  return dirs[dirs.length - 1] ?? ''
}

// Files of the last answer that mentions any (up to 20 answers back): an answer is the assistant text between two
// user messages (tool results do not count as user messages).
const lastFiles = async ($: EngineInterface): Promise<Paths> => {
  const messages = await $.session.messages()
  const root = await $.session.root()
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
  let end = messages.length
  for (let i = 0; i < 20 && end > 0; i++) {
    const start = messages.slice(0, end).findLastIndex((m) => m.role === 'user' && !m.toolResults?.length)
    const text = messages.slice(start + 1, end).filter((m) => m.role === 'assistant').map((m) => m.text).join('\n')
    const found: Paths = []
    for (const p of new Set(candidates(text, root, home))) {
      const s = await $.fs.stat(p).catch(() => undefined)
      if (s?.kind === 'file') found.push({ path: p, project: await projectOf($, p, root) })
    }
    if (found.length) return found
    end = start
  }
  return []
}

// As the extension's location(): XDG_RUNTIME_DIR, else the home directory's .cache (Node's os.homedir(): USERPROFILE
// on Windows, HOME elsewhere); never a shared temp directory, where another user could plant a link.
const mailbox = async ($: EngineInterface): Promise<string> => {
  const xdg = await $.env.get('XDG_RUNTIME_DIR')
  const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME'))
  if (!xdg && !home) throw new Error('neither XDG_RUNTIME_DIR nor a home directory is set')
  return `${(xdg || `${home!.replace(/[\\/]+$/, '')}/.cache`).replace(/[\\/]+$/, '')}/duo-diff-edit`
}

// The skill a click starts (userConfig "skill", set in /config), run as "/<skill> <path>"; only a plain path goes with
// it (no whitespace or quotes, which a decoded link could carry as instructions to the skill).
const SKILL = /^[\w.-]+(:[\w.-]+)?$/
const PLAIN = /^[^\s"'`]+$/

export const register: Register = (on, options) => {
  const skill = String(options?.skill ?? '').trim().replace(/^\//, '')
  on('session.start', async ($, e, next) => {   // also after a window reload
    const r = await next(e)
    const files = await lastFiles($)
    await update($, paths, () => files)
    return r
  })

  on('turn.complete', async ($, e, next) => {   // the band stays until a new answer brings files
    if (!e.agentId) {   // main loop only, not subagents
      const files = await lastFiles($)
      if (files.length) await update($, paths, () => files)
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = (await read($, paths)).filter((f) => typeof f === 'object')   // a value an older version stored: strings
    if (e.props.hasSurvey || !list.length) return next(e)

    const { Box, Button } = $.ui.resolve(e)
    const open = async (abs: string) => {
      try {
        const dir = await mailbox($), name = String(await $.clock.now())
        await $.fs.write(`${dir}/${name}`, `git ${abs}\n`)
        // a window of an old version, or one not reloaded, stays silent; so does a project window in Restricted Mode
        $.clock.after(TAKEN_WITHIN, async () => {
          if (await $.fs.exists(`${dir}/${name}`)) {
            await $.ui.toast('Duo Diff Edit: no Visual Studio Code window took the request. Is the extension installed and enabled, and the window reloaded (Developer: Reload Window)?', { timeoutMs: 10000 })
          }
        })
        $.clock.after(OPENED_WITHIN, async () => {
          if (await $.fs.exists(`${dir}/open-${name}`)) {
            await $.ui.toast("Duo Diff Edit: the project's window did not take the request. Is the folder trusted (not Restricted Mode) and the window reloaded?", { timeoutMs: 10000 })
          }
        })
      } catch (err) {
        await $.ui.toast(`Duo Diff Edit: ${err instanceof Error ? err.message : String(err)}`)
      }
      if (!skill) return
      if (!SKILL.test(skill)) return void await $.ui.toast(`Duo Diff Edit: "${skill}" is not a skill name; set it in /config`)
      if (!PLAIN.test(abs)) return void await $.ui.toast('Duo Diff Edit: the skill was not started: the path has spaces or quotes')
      await $.command.run({ command: skill, args: abs })   // as the person typing "/<skill> <path>"
    }

    // No full path on hover: the Visual Studio Code surface (Claude Code 2.1.318) ignores a Box's hover and position,
    // and a Button has no tooltip. A file of another project carries that project's name instead.
    return (
      <Box flexDirection="row" flexWrap="wrap">
        {list.map((f) => (
          <Button key={`diff:${f.path}`} label={`📖 ${f.path.split(/[\\/]/).pop()}${f.project ? ` (${f.project})` : ''}`}
            onPress={() => open(f.path)} />
        ))}
      </Box>
    )
  })
}
