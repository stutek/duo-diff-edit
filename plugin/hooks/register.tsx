// A band of "📖" buttons above the prompt box in Visual Studio Code: one per local file the last answer mentions
// (a markdown link or a path in inline code that exists). An answer is all assistant text since the user's last
// message, read at turn.complete (its `answer` carries only the last block). The band stays until an answer brings
// new files and is rebuilt at session start (window reload). A click writes the request "git <absolute path>" to the
// mailbox of the Duo Diff Edit extension for Visual Studio Code: <XDG_RUNTIME_DIR or OS temp dir>/duo-diff-edit/.
// A band, not a decoration of the answer: Visual Studio Code renders the answer without mod changes
// (anthropics/claude-code#107335).
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { Paths } from '../types'

const LINK = /\]\(([^)\s]+)\)/g
const CODE = /`((?:~|\.|[A-Za-z]:)?[\\/]?[\w.@+-]+(?:[\\/][\w.@+-]+)*\.[A-Za-z0-9]+)`/g   // path with an extension in inline code
const ABSOLUTE = /^([A-Za-z]:[\\/]|\/)/
const paths = atom({ plugin: 'duo-diff-edit', key: 'paths' } as const, [] as Paths)

const candidates = (text: string, root: string, home: string): string[] =>
  [
    ...[...text.matchAll(LINK)].map((m) => decodeURI(m[1].replace(/#.*$/, ''))),
    ...[...text.matchAll(CODE)].map((m) => m[1]),
  ]
    .filter((p) => p && !p.includes('://') && !/[\\/]$/.test(p))
    .map((p) => (/^~[\\/]/.test(p) ? `${home}${p.slice(1)}` : p))
    .map((p) => (ABSOLUTE.test(p) ? p : `${root}/${p.replace(/^\.[\\/]/, '')}`))

// Files of the last answer that mentions any (up to 20 answers back): an answer is the assistant text between two
// user messages (tool results do not count as user messages).
const lastFiles = async ($: EngineInterface): Promise<string[]> => {
  const messages = await $.session.messages()
  const root = await $.session.root()
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
  let end = messages.length
  for (let i = 0; i < 20 && end > 0; i++) {
    const start = messages.slice(0, end).findLastIndex((m) => m.role === 'user' && !m.toolResults?.length)
    const text = messages.slice(start + 1, end).filter((m) => m.role === 'assistant').map((m) => m.text).join('\n')
    const found: string[] = []
    for (const p of new Set(candidates(text, root, home))) {
      const s = await $.fs.stat(p).catch(() => undefined)
      if (s?.kind === 'file') found.push(p)
    }
    if (found.length) return found
    end = start
  }
  return []
}

// The extension uses XDG_RUNTIME_DIR, else Node's os.tmpdir(): TMPDIR on macOS, TEMP or TMP on Windows, /tmp.
const mailbox = async ($: EngineInterface): Promise<string> => {
  const dir = (await $.env.get('XDG_RUNTIME_DIR')) || (await $.env.get('TMPDIR')) || (await $.env.get('TEMP'))
    || (await $.env.get('TMP')) || '/tmp'
  return `${dir.replace(/[\\/]+$/, '')}/duo-diff-edit`
}

export const register: Register = (on) => {
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
    const list = await read($, paths)
    if (e.props.hasSurvey || !list.length) return next(e)

    const { Box, Button } = $.ui.resolve(e)
    const open = async (abs: string) => {
      await $.fs.write(`${await mailbox($)}/${await $.clock.now()}`, `git ${abs}\n`)
    }

    return (
      <Box flexDirection="row" flexWrap="wrap">
        {list.map((a) => (
          <Button key={`diff:${a}`} label={`📖 ${a.split(/[\\/]/).pop()}`} onPress={() => open(a)} />
        ))}
      </Box>
    )
  })
}
