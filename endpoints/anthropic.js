import {
    MODELS, CORS, DEFAULT_SYSTEM_PROMPT,
    CursorWebError,
    errorRetryWrapper
} from '../server.js'
import crypto from 'crypto'

// ============ ANTHROPIC UTILITIES ============

function generateMessageId() {
    return `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`
}

// Map upstream finishReason to Anthropic stop_reason
function mapStopReason(reason) {
    const map = { stop: 'end_turn', length: 'max_tokens', tool_use: 'tool_use' }
    return map[reason] || 'end_turn'
}

// ============ MESSAGE CONVERSION (Anthropic → Cursor) ============

function toCursorMessages(body) {
    const result = []

    // Handle system prompt (top-level field in Anthropic API)
    let systemText = ''
    if (typeof body.system === 'string') {
        systemText = body.system
    } else if (Array.isArray(body.system)) {
        for (const block of body.system) {
            if (block.type === 'text' && block.text) {
                systemText += block.text
            }
        }
    }

    // Append default system prompt
    systemText = systemText
        ? `${systemText}\n\n${DEFAULT_SYSTEM_PROMPT}`
        : DEFAULT_SYSTEM_PROMPT

    result.push({
        role: 'system',
        parts: [{ type: 'text', text: systemText }]
    })

    // Convert messages (user/assistant only in Anthropic)
    const messages = body.messages || []
    for (const m of messages) {
        if (!m) continue

        let text = ''
        if (typeof m.content === 'string') {
            text = m.content
        } else if (Array.isArray(m.content)) {
            for (const block of m.content) {
                if (block.type === 'text' && block.text) {
                    text += block.text
                }
            }
        }

        result.push({
            role: m.role,
            parts: [{ type: 'text', text }]
        })
    }

    return result
}

// ============ RESPONSE FORMATTERS ============

async function nonStreamResponse(request, generator) {
    let fullContent = ''
    let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }

    for await (const chunk of generator) {
        if (chunk.type === 'usage') {
            usage = chunk
        } else if (chunk.type === 'delta') {
            fullContent += chunk.content
        }
    }

    return {
        id: generateMessageId(),
        type: 'message',
        role: 'assistant',
        model: request.model,
        content: [
            {
                type: 'text',
                text: fullContent
            }
        ],
        stop_reason: mapStopReason(usage.finishReason),
        stop_sequence: null,
        usage: {
            input_tokens: usage.promptTokens,
            output_tokens: usage.completionTokens,
            cache_creation_input_tokens: usage.cacheWriteTokens || 0,
            cache_read_input_tokens: usage.cacheReadTokens || 0
        }
    }
}

async function* streamResponse(request, generator) {
    const messageId = generateMessageId()
    let usage = null

    // 1. message_start
    yield `event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: {
            id: messageId,
            type: 'message',
            role: 'assistant',
            content: [],
            model: request.model,
            stop_reason: null,
            stop_sequence: null,
            usage: {
                input_tokens: 0,
                output_tokens: 0
            }
        }
    })}\n\n`

    // 2. content_block_start
    yield `event: content_block_start\ndata: ${JSON.stringify({
        type: 'content_block_start',
        index: 0,
        content_block: {
            type: 'text',
            text: ''
        }
    })}\n\n`

    // 3. ping
    yield `event: ping\ndata: ${JSON.stringify({ type: 'ping' })}\n\n`

    // 4. content_block_delta events
    for await (const chunk of generator) {
        if (chunk.type === 'usage') {
            usage = chunk
            continue
        }

        if (chunk.type === 'delta') {
            yield `event: content_block_delta\ndata: ${JSON.stringify({
                type: 'content_block_delta',
                index: 0,
                delta: {
                    type: 'text_delta',
                    text: chunk.content
                }
            })}\n\n`
        }
    }

    // 5. content_block_stop
    yield `event: content_block_stop\ndata: ${JSON.stringify({
        type: 'content_block_stop',
        index: 0
    })}\n\n`

    // 6. message_delta (with stop_reason and usage)
    yield `event: message_delta\ndata: ${JSON.stringify({
        type: 'message_delta',
        delta: {
            stop_reason: usage ? mapStopReason(usage.finishReason) : 'end_turn',
            stop_sequence: null
        },
        usage: {
            output_tokens: usage ? usage.completionTokens : 0
        }
    })}\n\n`

    // 7. message_stop
    yield `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`
}

// ============ REQUEST HANDLER ============

async function handleMessages(request, body) {
    // Validate model
    if (!MODELS.includes(request.model)) {
        request.model = MODELS[0]
    }

    // Convert Anthropic messages to cursor format
    request.messages = toCursorMessages(body)

    const isStream = body.stream === true

    if (isStream) {
        const generator = errorRetryWrapper(request, true)
        const stream = new ReadableStream({
            async start(controller) {
                try {
                    for await (const chunk of streamResponse(request, generator)) {
                        controller.enqueue(new TextEncoder().encode(chunk))
                    }
                    controller.close()
                } catch (error) {
                    console.error('[ANTHROPIC STREAM ERROR]', error)
                    const errorEvent = `event: error\ndata: ${JSON.stringify({
                        type: 'error',
                        error: {
                            type: 'api_error',
                            message: error.message
                        }
                    })}\n\n`
                    controller.enqueue(new TextEncoder().encode(errorEvent))
                    controller.close()
                }
            }
        })

        return new Response(stream, {
            status: 200,
            headers: {
                ...CORS,
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no'
            }
        })
    } else {
        const generator = errorRetryWrapper(request, false)
        const result = await nonStreamResponse(request, generator)
        return new Response(JSON.stringify(result), {
            status: 200,
            headers: {
                ...CORS,
                'Content-Type': 'application/json'
            }
        })
    }
}

// ============ ENDPOINT HANDLER ============

export function handler(req, url, checkAuth) {
    // Anthropic uses x-api-key header instead of Authorization: Bearer
    const authErr = checkAuth()
    if (authErr) return authErr

    // POST /v1/messages — Create a message
    if (url.pathname.endsWith('/v1/messages') && req.method === 'POST') {
        return req.json().then(body => {
            const request = {
                model: body.model,
                stream: body.stream || false
            }
            return handleMessages(request, body)
        })
    }

    // 404 for unknown sub-routes
    return new Response(JSON.stringify({
        type: 'error',
        error: {
            type: 'not_found_error',
            message: 'Not found'
        }
    }), {
        status: 404,
        headers: { ...CORS, 'Content-Type': 'application/json' }
    })
}
