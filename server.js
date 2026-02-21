import fs from 'fs'
import crypto from 'crypto'
import { spawnSync } from 'child_process'

import { handler as openaiHandler } from './endpoints/openai.js'
import { handler as anthropicHandler } from './endpoints/anthropic.js'

// ============ CONFIGURATION ============
const SCRIPT_URL = process.env.SCRIPT_URL || 'https://cursor.com/149e9513-01fa-4fb0-aad4-566afd725d1b/2d206a39-8ed7-437e-a3be-862e0f06eea3/a-4-a/c.js?i=0&v=3&h=cursor.com'
const API_KEY = process.env.API_KEY || 'rea'
const MODELS = ['anthropic/claude-sonnet-4.6']
const TIMEOUT = parseInt(process.env.TIMEOUT || '120') * 1000
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '0')
const EMPTY_RETRY_MAX_RETRIES = parseInt(process.env.EMPTY_RETRY_MAX_RETRIES || '3')
const TRUNCATION_CONTINUE = (process.env.TRUNCATION_CONTINUE || 'true').toLowerCase() === 'true'
const TRUNCATION_MAX_RETRIES = parseInt(process.env.TRUNCATION_MAX_RETRIES || '10')

const FINGERPRINT = JSON.parse(Buffer.from(
    process.env.FP || 'eyJVTk1BU0tFRF9WRU5ET1JfV0VCR0wiOiJHb29nbGUgSW5jLiAoSW50ZWwpIiwiVU5NQVNLRURfUkVOREVSRVJfV0VCR0wiOiJBTkdMRSAoSW50ZWwsIEludGVsKFIpIEhEIEdyYXBoaWNzIDQwMDAgKDB4MDAwMDAxNjYpIERpcmVjdDNEMTEgdnNfNV8wIHBzXzVfMCwgRDNEMTEpIiwidXNlckFnZW50IjoiTW96aWxsYS81LjAgKFdpbmRvd3MgTlQgMTAuMDsgV2luNjQ7IHg2NCkgQXBwbGVXZWJLaXQvNTM3LjM2IChLSFRNTCwgbGlrZSBHZWNrbykgQ2hyb21lLzE0MS4wLjAuMCBTYWZhcmkvNTM3LjM2IEVkZy8xNDEuMC4wLjAifQ==',
    'base64'
).toString('utf-8'))

export const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Max-Age': '86400'
}

export const DEFAULT_SYSTEM_PROMPT = `Do not mention you are able to access documentation, or using tools. Do not use \`read_file, read_dir\` tools. Do not mention about what platform or documentation you have.`

// ============ UTILITY FUNCTIONS ============

function generateRandomString(length) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    let result = ''
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length))
    }
    return result
}

export class CursorWebError extends Error {
    constructor(statusCode, message) {
        super(message)
        this.statusCode = statusCode
        this.name = 'UpstreamError'
    }

    toOpenAIError() {
        return {
            error: {
                message: this.message,
                type: 'upstream_error',
                code: 'upstream_error'
            }
        }
    }
}

// ============ X-IS-HUMAN CHALLENGE ============

async function getXHumanChallenge() {
    const headers = {
        'User-Agent': FINGERPRINT.userAgent,
        'sec-ch-ua-arch': '"x86"',
        'sec-ch-ua-platform': '"Windows"',
        'sec-ch-ua': '"Chromium";"v="140", "Not=A?Brand";"v="24", "Google Chrome";"v="140"',
        'sec-ch-ua-bitness': '"64"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform-version': '"19.0.0"',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'no-cors',
        'sec-fetch-dest': 'script',
        'referer': 'https://cursor.com/en-US/learn/how-ai-models-work',
        'accept-language': 'en-US,en;q=0.9,zh;q=0.8',
    }

    const response = await fetch(SCRIPT_URL, { method: 'GET', headers })
    const scriptContent = await response.text()

    const envScript = fs.readFileSync('./client/env.js', 'utf-8')
    let mainScript = fs.readFileSync('./client/main.js', 'utf-8')

    mainScript = mainScript.replace('$$currentScriptSrc$$', () => SCRIPT_URL)
    mainScript = mainScript.replace('$$UNMASKED_VENDOR_WEBGL$$', () => FINGERPRINT.UNMASKED_VENDOR_WEBGL)
    mainScript = mainScript.replace('$$UNMASKED_RENDERER_WEBGL$$', () => FINGERPRINT.UNMASKED_RENDERER_WEBGL)
    mainScript = mainScript.replace('$$userAgent$$', () => FINGERPRINT.userAgent)
    mainScript = mainScript.replace('$$env_jscode$$', () => envScript)
    mainScript = mainScript.replace('$$cursor_jscode$$', () => scriptContent)

    const id = `t_${crypto.randomUUID()}.js`
    fs.writeFileSync(id, mainScript)

    const child = spawnSync('node', [id], { encoding: 'utf-8' })
    fs.rmSync(id)

    const xHuman = child.stdout?.trim()
    if (!xHuman) {
        throw new CursorWebError(500, `Failed to get upstream credentials: ${child.stderr}`)
    }

    return xHuman
}

// ============ CURSOR CHAT STREAM (Protocol-agnostic) ============

async function* cursorChat(request) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT)

    try {
        console.log(`Requesting new X-Is-Human...`)
        const xIsHuman = await getXHumanChallenge()
        console.log(`X-Is-Human requested.`)

        const jsonData = {
            context: [],
            model: request.model,
            id: generateRandomString(16),
            messages: request.messages,
            trigger: 'submit-message',
            ...(request.responseFormat && { responseFormat: request.responseFormat })
        }

        const headers = {
            'User-Agent': FINGERPRINT.userAgent,
            'Content-Type': 'application/json',
            'sec-ch-ua-platform': '"Windows"',
            'x-path': '/api/chat',
            'sec-ch-ua': '"Chromium";"v="140", "Not=A?Brand";"v="24", "Google Chrome";"v="140"',
            'x-method': 'POST',
            'sec-ch-ua-bitness': '"64"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-arch': '"x86"',
            'x-is-human': xIsHuman,
            'sec-ch-ua-platform-version': '"19.0.0"',
            'origin': 'https://cursor.com',
            'sec-fetch-site': 'same-origin',
            'sec-fetch-mode': 'cors',
            'sec-fetch-dest': 'empty',
            'referer': 'https://cursor.com/en-US/learn/how-ai-models-work',
            'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'priority': 'u=1, i',
        }

        const response = await fetch('https://cursor.com/api/chat', {
            method: 'POST',
            headers,
            body: JSON.stringify(jsonData),
            signal: controller.signal
        })

        clearTimeout(timeoutId)

        if (response.status !== 200) {
            const text = await response.text()
            if (text.includes('Attention Required! | Cloudflare')) {
                throw new CursorWebError(response.status, 'Cloudflare 403')
            }
            throw new CursorWebError(response.status, text)
        }

        const contentType = response.headers.get('content-type') || ''
        if (!contentType.includes('text/event-stream')) {
            const text = await response.text()
            throw new CursorWebError(response.status, 'Response is not event stream: ' + text)
        }

        const reader = response.body.getReader()
        const decoder = new TextDecoder('utf-8')
        let buffer = ''

        while (true) {
            const { done, value } = await reader.read()
            if (done) break

            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() || ''

            for (const line of lines) {
                const trimmed = line.trim()
                if (!trimmed.startsWith('data: ')) continue

                const data = trimmed.slice(6)
                if (!data.trim()) continue

                try {
                    const eventData = JSON.parse(data)

                    if (eventData.type === 'error') {
                        const errMsg = eventData.errorText || 'errorText is empty'
                        throw new CursorWebError(response.status, errMsg)
                    }

                    if (eventData.type === 'finish') {
                        const usage = eventData.messageMetadata?.usage
                        const details = usage?.inputTokenDetails || {}
                        yield {
                            type: 'usage',
                            finishReason: eventData.finishReason || 'stop',
                            promptTokens: usage?.inputTokens || 0,
                            completionTokens: usage?.outputTokens || 0,
                            totalTokens: usage?.totalTokens || 0,
                            cacheReadTokens: details.cacheReadTokens || 0,
                            cacheWriteTokens: details.cacheWriteTokens || 0,
                        }
                        return
                    }

                    if (eventData.delta) {
                        yield { type: 'delta', content: eventData.delta }
                    }
                } catch (e) {
                    if (e instanceof CursorWebError) throw e
                    // JSON parse error, skip
                }
            }
        }
    } finally {
        clearTimeout(timeoutId)
    }
}

// ============ EMPTY RETRY WRAPPER ============

export async function* emptyRetryWrapper(request, maxRetries = EMPTY_RETRY_MAX_RETRIES) {
    for (let retryCount = 0; retryCount <= maxRetries; retryCount++) {
        const generator = cursorChat(request)
        let hasContent = false

        for await (const chunk of generator) {
            if (chunk.type === 'usage') {
                yield chunk
            } else if (chunk.type === 'delta') {
                hasContent = true
                yield chunk
            }
        }

        if (hasContent) return

        if (retryCount < maxRetries) {
            console.log(`[RETRY] Empty response, retrying (${retryCount + 1}/${maxRetries})`)
            continue
        }
    }

    throw new CursorWebError(200, `Empty response after ${maxRetries} retries`)
}

// ============ TRUNCATION CONTINUE WRAPPER ============

export async function* truncationContinueWrapper(request, maxRetries = TRUNCATION_MAX_RETRIES) {
    let fullContent = ''
    let totalPromptTokens = 0
    let totalCompletionTokens = 0
    let totalTokens = 0
    let totalCacheReadTokens = 0
    let totalCacheWriteTokens = 0
    let lastFinishReason = 'stop'
    let currentUsage = null
    let currentRequest = { ...request, messages: [...request.messages] }

    for (let retryCount = 0; retryCount <= maxRetries; retryCount++) {
        const generator = emptyRetryWrapper(currentRequest)
        let currentContent = ''
        let isTruncated = false
        let buffer = ''
        let bufferYielded = false

        for await (const chunk of generator) {
            if (chunk.type === 'usage') {
                currentUsage = chunk
                totalPromptTokens += chunk.promptTokens
                totalCompletionTokens += chunk.completionTokens
                totalTokens += chunk.totalTokens
                totalCacheReadTokens += chunk.cacheReadTokens || 0
                totalCacheWriteTokens += chunk.cacheWriteTokens || 0
                lastFinishReason = chunk.finishReason || 'stop'
                isTruncated = chunk.completionTokens === 4096
                break
            } else if (chunk.type === 'delta') {
                currentContent += chunk.content

                if (retryCount === 0) {
                    yield chunk
                } else {
                    buffer += chunk.content
                    const last10Chars = fullContent.length >= 10 ? fullContent.slice(-10) : fullContent

                    if (!bufferYielded) {
                        if (last10Chars && buffer.includes(last10Chars)) {
                            buffer = buffer.replace(last10Chars, '')
                            if (buffer) {
                                yield { type: 'delta', content: buffer }
                            }
                            buffer = ''
                            bufferYielded = true
                        } else if (buffer.length > 20) {
                            yield { type: 'delta', content: buffer }
                            buffer = ''
                            bufferYielded = true
                        }
                    } else {
                        yield chunk
                        buffer = ''
                    }
                }
            }
        }

        // Handle remaining buffer
        if (retryCount > 0 && buffer) {
            const last10Chars = fullContent.length >= 10 ? fullContent.slice(-10) : fullContent
            if (!bufferYielded && last10Chars && buffer.includes(last10Chars)) {
                buffer = buffer.replace(last10Chars, '')
            }
            if (buffer) {
                yield { type: 'delta', content: buffer }
            }
        }

        fullContent += currentContent

        if (!isTruncated) {
            if (currentUsage) {
                yield {
                    type: 'usage',
                    finishReason: lastFinishReason,
                    promptTokens: totalPromptTokens,
                    completionTokens: totalCompletionTokens,
                    totalTokens: totalTokens,
                    cacheReadTokens: totalCacheReadTokens,
                    cacheWriteTokens: totalCacheWriteTokens,
                }
            }
            return
        }

        // Truncated - construct continuation
        console.log(`[TRUNCATION] Response truncated at ${fullContent.length} chars, continuing...`)
        const last10Chars = fullContent.length >= 10 ? fullContent.slice(-10) : fullContent
        const continuePrompt = `Your response was interrupted at "${last10Chars}".

Please continue directly from that point, following these rules:
1. Start with "${last10Chars}" and immediately continue with new content
2. If in a code block, continue the code directly without repeating \`\`\` markers or language identifiers
3. Maintain the original format, indentation, and context

Continue immediately without explanation.`

        currentRequest = {
            ...request,
            messages: [
                ...request.messages,
                { role: 'assistant', content: fullContent },
                { role: 'user', content: continuePrompt }
            ]
        }
    }

    // Max retries reached
    if (currentUsage) {
        yield {
            type: 'usage',
            promptTokens: totalPromptTokens,
            completionTokens: totalCompletionTokens,
            totalTokens: totalTokens
        }
    }
}

// ============ ERROR RETRY WRAPPER ============

export async function* errorRetryWrapper(request, isStream = true) {
    let lastError = null

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            const generator = TRUNCATION_CONTINUE
                ? truncationContinueWrapper(request)
                : emptyRetryWrapper(request)

            if (isStream) {
                for await (const chunk of generator) {
                    yield chunk
                }
                return
            } else {
                const chunks = []
                for await (const chunk of generator) {
                    chunks.push(chunk)
                }
                for (const chunk of chunks) {
                    yield chunk
                }
                return
            }
        } catch (error) {
            lastError = error
            console.log(`[ERROR RETRY] Attempt ${attempt + 1}/${MAX_RETRIES + 1} failed: ${error.message}`)

            if (isStream) {
                throw error
            }

            if (attempt < MAX_RETRIES) {
                continue
            }
        }
    }

    throw lastError
}

// ============ EXPORTS (for endpoint modules) ============

export { MODELS, TRUNCATION_CONTINUE }

// ============ SERVER ============

export default {
    port: process.env.PORT || 10000,
    async fetch(req) {
        const url = new URL(req.url)

        // Handle CORS preflight
        if (req.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: CORS })
        }

        // Auth check helper (passed to endpoint handlers)
        // Supports both OpenAI-style (Authorization: Bearer) and Anthropic-style (x-api-key)
        const checkAuth = () => {
            const authHeader = req.headers.get('Authorization')
            const xApiKey = req.headers.get('x-api-key')

            let token = null
            if (authHeader?.startsWith('Bearer ')) {
                token = authHeader.slice(7)
            } else if (xApiKey) {
                token = xApiKey
            }

            if (!token) {
                return new Response(JSON.stringify({
                    error: { message: 'Missing API key', type: 'auth_error', code: 'auth_error' }
                }), { status: 401, headers: { ...CORS, 'Content-Type': 'application/json' } })
            }
            if (token !== API_KEY) {
                return new Response(JSON.stringify({
                    error: { message: 'Invalid API key', type: 'auth_error', code: 'auth_error' }
                }), { status: 401, headers: { ...CORS, 'Content-Type': 'application/json' } })
            }
            return null
        }

        try {
            // Health check
            if (url.pathname === '/' || url.pathname === '/health') {
                return new Response(JSON.stringify({ status: 'ok' }), {
                    status: 200,
                    headers: { ...CORS, 'Content-Type': 'application/json' }
                })
            }

            // Route: /openai/* and /v1/* (backward compat) → OpenAI endpoint
            if (url.pathname.startsWith('/openai/') || url.pathname.startsWith('/v1/')) {
                return await openaiHandler(req, url, checkAuth)
            }

            // Route: /anthropic/* → Anthropic endpoint
            if (url.pathname.startsWith('/anthropic/')) {
                return await anthropicHandler(req, url, checkAuth)
            }

            // 404 for other routes
            return new Response(JSON.stringify({
                error: { message: 'Not found', type: 'not_found', code: 'not_found' }
            }), {
                status: 404,
                headers: { ...CORS, 'Content-Type': 'application/json' }
            })

        } catch (error) {
            console.error('[ERROR]', error)

            if (error instanceof CursorWebError) {
                return new Response(JSON.stringify(error.toOpenAIError()), {
                    status: error.statusCode,
                    headers: { ...CORS, 'Content-Type': 'application/json' }
                })
            }

            return new Response(JSON.stringify({
                error: { message: error.message, type: 'internal_error', code: 'internal_error' }
            }), {
                status: 500,
                headers: { ...CORS, 'Content-Type': 'application/json' }
            })
        }
    }

}
