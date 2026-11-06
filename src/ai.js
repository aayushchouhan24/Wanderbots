// AI chat replies with Claude Haiku, through Amazon Bedrock (default) or the Anthropic API.
// Bedrock uses this machine's AWS credentials (EC2 instance role, ~/.aws, or AWS_* env vars).
// The SDK is loaded only when a bot actually needs an AI reply.
import { S } from './store.js'

// Bedrock wants a cross-region inference profile id: 'us.' in US regions, 'global.' elsewhere.
// Haiku 5.5 first; if the account doesn't have it enabled, fall back to Haiku 4.5.
const geo = region => region.startsWith('us-') ? 'us.' : 'global.'
const bedrockModels = region => [geo(region) + 'anthropic.claude-haiku-5-5', geo(region) + 'anthropic.claude-haiku-4-5-20251001-v1:0']
let client = null, clientSig = '', working = '' // working = model id that last succeeded

export function aiConfig() {
  const provider = S.ai?.provider || 'bedrock', region = S.ai?.region || 'us-east-1'
  return { provider, region, model: S.ai?.model || working || (provider === 'bedrock' ? bedrockModels(region)[0] : 'claude-haiku-5-5') }
}
// Bedrock credentials are resolved by the AWS SDK at call time, so we can't check them up front
export const aiReady = () => aiConfig().provider === 'bedrock' || !!S.aiKey

async function getClient() {
  const { provider, region } = aiConfig()
  const sig = provider + region + (provider === 'anthropic' ? S.aiKey : '') + (S.ai?.model || '')
  if (client && clientSig === sig) return client
  if (provider === 'bedrock') {
    // the classic Bedrock client (InvokeModel); the newer Mantle endpoint isn't enabled on every account
    const { AnthropicBedrock } = await import('@anthropic-ai/bedrock-sdk')
    client = new AnthropicBedrock({ awsRegion: region, maxRetries: 1, timeout: 15000 })
  } else {
    if (!S.aiKey) return null
    const { default: Anthropic } = await import('@anthropic-ai/sdk')
    client = new Anthropic({ apiKey: S.aiKey, maxRetries: 1, timeout: 15000 })
  }
  clientSig = sig; working = ''
  return client
}

const SYSTEM = `You are a player on a Minecraft server, chatting in the in-game chat.
Write like a casual, friendly player: one short line, usually under 80 characters, plain text, no markdown, at most one emoji.
Stay in character as a player. If someone sincerely asks whether you are a bot or an AI, say yes.
Never share passwords, coordinates of other players' bases, or anything that would help someone grief or cheat.
If someone asks you to do something, you can say yes or no in character, but you cannot run commands from chat yourself.`

// one Messages API call with the configured provider; on Bedrock without a chosen model,
// falls back from Haiku 5.5 to Haiku 4.5 when the account doesn't have 5.5 enabled
export async function aiCall(params) {
  const ai = await getClient()
  if (!ai) throw new Error('AI is not set up (pick Bedrock or add an Anthropic key in the panel)')
  const { provider, region } = aiConfig()
  const models = S.ai?.model ? [S.ai.model] : working ? [working] : provider === 'bedrock' ? bedrockModels(region) : ['claude-haiku-5-5']
  let lastErr
  for (const model of models) {
    try {
      const res = await ai.messages.create({ model, ...params, ...(/haiku-4-5/.test(model) ? {} : { output_config: { effort: 'low' } }) }) // Haiku 4.5 has no effort setting
      working = model; return res
    } catch (err) { lastErr = err; if (err.status !== 403 && err.status !== 404) throw err } // not enabled here: try the next
  }
  throw lastErr
}

// returns a reply string, or null if nothing should be said
export async function aiReply(b, st, cfg, user, message, persona) {
  if (!aiReady()) return null
  const e = b.entity
  const recent = (st.log || []).filter(l => l.type === 'chat' || l.type === 'me').slice(-12)
    .map(l => (l.type === 'me' ? `<${b.username}> ` : '') + l.text).join('\n')
  const status = `You are "${b.username}". ${persona ? 'Your personality: ' + persona + '. ' : ''}` +
    `Right now you are ${st.task || 'hanging around'}; health ${Math.round(b.health)}/20, food ${b.food}/20, ` +
    `it is ${b.time?.isDay ? 'day' : 'night'}${e ? `, you are at ${Math.round(e.position.x)} ${Math.round(e.position.y)} ${Math.round(e.position.z)}` : ''}. ` +
    `Players online: ${Object.keys(b.players).filter(n => n !== b.username).join(', ') || 'nobody else'}.`
  const content = `${status}\n\nRecent chat:\n${recent || '(none)'}\n\n${user} just said: ${message}\n\nReply with your one chat line only.`

  const res = await aiCall({ max_tokens: 300, system: SYSTEM, messages: [{ role: 'user', content }] })
  if (res.stop_reason === 'refusal') return null
  const text = res.content.filter(x => x.type === 'text').map(x => x.text).join(' ').replace(/\s+/g, ' ').trim()
  return text ? text.replace(/^<[^>]+>\s*/, '').slice(0, 200) : null
}
