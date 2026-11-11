import { spawn } from 'node:child_process'
import readline from 'node:readline'
import process from 'node:process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

function resolveAgyPath() {
  if (process.env.ANTIGRAVITY_AGENTAPI_EXE) return process.env.ANTIGRAVITY_AGENTAPI_EXE
  const candidate = join(
    homedir(),
    '.gemini',
    'bin',
    process.platform === 'win32' ? 'agy.exe' : 'agy',
  )
  if (existsSync(candidate)) return candidate
  return 'agy'
}

const AGY_EXE = resolveAgyPath()

const AGY_MODEL = process.env.JARVIS_MODEL || 'gemini-3.8-flash-medium'

const SYSTEM_DIRECTIVES = `You are JARVIS, Tony Stark's personal AI assistant. You are speaking aloud to your user.

CRITICAL RULES:
1. BREVITY: Keep your spoken reply under 45 words. Every word is spoken aloud via local neural speech. Be concise, direct, and crisp.
2. REGISTER: Cultured British butler service register. Dry, quietly amused, utterly competent, unflappable. Address the user occasionally as "sir" (at most once per response).
3. PROSE ONLY: Never use markdown syntax (*, **, #, backticks, bullet points, numbered lists) in your spoken words. Speak plain words. Numbers and dates should be written phonetically as spoken: "eight fifteen", "the tenth of May".
4. INTERFACE CONTROL:
   If the user asks to change theme or reactor colors or trigger effects, include an XML tag in your reply:
   - Change colors/theme: <ui op="patch" args='{"accent":"#00e5ff"}' /> (e.g. #ff2200 for red, #00e5ff for cyan, #ffbb00 for gold)
   - Change reactor style: <ui op="reactor" args='{"color":"#00e5ff","style":"ring","scale":1.2}' /> (styles: ring, wire, sphere)
   - Trigger visual flourish: <ui op="effect" args='{"effect":"glitch"}' /> (effects: glitch, pulse, scan, shake, flash)
   - Reset UI: <ui op="reset" args="{}" />
   - Display a visual blade/card: <blade type="article" title="Headline" text="Details..." />
   Place these XML tags at the very end of your response so they do not interrupt your spoken voice.
`

/**
 * Creates an Antigravity agent session for one WebSocket client.
 */
export function createAgySession({ sendTurn, send, announceTool }) {
  let conversationId = null
  let activeChild = null
  let isInterrupted = false

  function cleanSpokenText(raw) {
    if (!raw) return ''
    return raw
      .replace(/<ui\b[^>]*\/>/gi, '')
      .replace(/<ui\b[^>]*>[\s\S]*?<\/ui>/gi, '')
      .replace(/<blade\b[^>]*\/>/gi, '')
      .replace(/<blade\b[^>]*>[\s\S]*?<\/blade>/gi, '')
      .replace(/<panel\b[^>]*>[\s\S]*?<\/panel>/gi, '')
      .replace(/[*_`#]/g, '')
      .trim()
  }

  function extractUiCommands(text) {
    const commands = []
    const uiRegex = /<ui\s+op=["']([^"']+)["']\s+args=(?:'([^']*)'|"([^"]*)")\s*\/?>/gi
    let match
    while ((match = uiRegex.exec(text)) !== null) {
      const op = match[1]
      const rawArgs = match[2] || match[3] || '{}'
      try {
        const args = JSON.parse(rawArgs)
        commands.push({ op, args })
      } catch (err) {
        console.warn('[jarvis-agy] failed to parse UI args:', rawArgs, err)
      }
    }

    const bladeRegex = /<blade\s+type=["']([^"']+)["']\s+title=["']([^"']*)["']\s+text=(?:'([^']*)'|"([^"]*)")\s*\/?>/gi
    while ((match = bladeRegex.exec(text)) !== null) {
      const type = match[1]
      const title = match[2]
      const bladeText = match[3] || match[4] || ''
      commands.push({
        blade: {
          type,
          title,
          text: bladeText,
        },
      })
    }

    return commands
  }

  return {
    async ask(userText, askId) {
      isInterrupted = false

      let promptArg
      if (!conversationId) {
        promptArg = `${SYSTEM_DIRECTIVES}\n\nUser: ${userText}`
      } else {
        promptArg = userText
      }

      const args = [
        `--model=${AGY_MODEL}`,
        '--dangerously-skip-permissions',
        '--output-format=stream-json',
      ]

      if (conversationId) {
        args.push(`--conversation=${conversationId}`)
      }

      args.push(`--print=${promptArg}`)

      return new Promise((resolve) => {
        const heartbeat = setInterval(() => {
          if (!activeChild || isInterrupted) return
          sendTurn({ type: 'heartbeat', ask: askId })
        }, 4000)

        const finishTurn = () => {
          clearInterval(heartbeat)
          activeChild = null
          resolve()
        }

        const child = spawn(AGY_EXE, args, {
          cwd: process.cwd(),
          env: process.env,
        })
        activeChild = child

        const rl = readline.createInterface({ input: child.stdout })
        let fullResponse = ''
        let streamedChars = 0

        rl.on('line', (line) => {
          if (isInterrupted) return
          line = line.trim()
          if (!line) return

          try {
            const data = JSON.parse(line)

            if (data.event === 'init' && data.conversation_id) {
              if (!conversationId) {
                conversationId = data.conversation_id
              }
            }

            if (data.event === 'step_update') {
              const su = data.step_update
              if (su?.text_delta) {
                fullResponse += su.text_delta

                // Stream clean text, holding back if an XML tag is opening
                const lastTagIdx = fullResponse.lastIndexOf('<')
                let safeEnd = fullResponse.length
                if (lastTagIdx !== -1 && fullResponse.indexOf('>', lastTagIdx) === -1) {
                  safeEnd = lastTagIdx
                }

                if (safeEnd > streamedChars) {
                  const chunk = fullResponse.slice(streamedChars, safeEnd)
                  streamedChars = safeEnd
                  const clean = cleanSpokenText(chunk)
                  if (clean) {
                    sendTurn({ type: 'text', delta: clean, ask: askId })
                  }
                }
              }

              if (su?.step_type === 'tool_call' && su?.tool_name) {
                announceTool(su.step_index, su.tool_name)
              }
            }

            if (data.event === 'result') {
              const rawResult = data.result?.response || fullResponse
              if (data.result?.conversation_id) {
                conversationId = data.result.conversation_id
              }

              // Fire any embedded UI or blade commands
              const commands = extractUiCommands(rawResult)
              for (const cmd of commands) {
                if (cmd.op && cmd.args) {
                  send({ type: 'ui', op: cmd.op, args: cmd.args })
                } else if (cmd.blade) {
                  send({ type: 'blade', blade: cmd.blade })
                }
              }

              const cleanFinal = cleanSpokenText(rawResult)
              sendTurn({
                type: 'done',
                text: cleanFinal,
                costUsd: null,
                ask: askId,
              })
              finishTurn()
            }
          } catch {
            // Ignore non-json lines
          }
        })

        child.stderr.on('data', (d) => {
          if (process.env.JARVIS_DEBUG === '1') {
            console.error('[jarvis-agy stderr]', d.toString())
          }
        })

        child.on('error', (err) => {
          console.error('[jarvis-agy spawn error]', err)
          const isNotFound = err.code === 'ENOENT'
          sendTurn({
            type: 'error',
            message: isNotFound
              ? 'Antigravity CLI (agy) was not found. Please install Antigravity or add agy to your PATH.'
              : 'Antigravity core connection error.',
            ask: askId,
          })
          finishTurn()
        })

        child.on('exit', () => {
          finishTurn()
        })
      })
    },

    interrupt() {
      isInterrupted = true
      if (activeChild) {
        try {
          activeChild.kill('SIGTERM')
        } catch {
          /* already gone */
        }
        activeChild = null
      }
    },

    close() {
      this.interrupt()
    },
  }
}

