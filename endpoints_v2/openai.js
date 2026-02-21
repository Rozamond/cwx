import {
    MODELS, CORS, DEFAULT_SYSTEM_PROMPT,
    TRUNCATION_CONTINUE,
    CursorWebError,
    emptyRetryWrapper, truncationContinueWrapper, errorRetryWrapper
} from '../server_v2.js'
import crypto from 'crypto'

// ============ OPENAI UTILITIES ============

function generateChatId() {
    return `chatcmpl-${crypto.randomUUID().replace(/-/g, '').slice(0, 29)}`
}

// Map upstream finishReason to OpenAI finish_reason
function mapFinishReason(reason) {
    const map = { stop: 'stop', length: 'length', tool_use: 'tool_calls' }
    return map[reason] || 'stop'
}

// ============ MESSAGE CONVERSION (OpenAI → Cursor) ============

function toCursorMessages(messages) {
    if (!messages) messages = []

    const result = []
    let hasSystemMessage = false

    for (const m of messages) {
        if (!m) continue

        let text = ''
        if (typeof m.content === 'string') {
            text = m.content
        } else if (Array.isArray(m.content)) {
            for (const content of m.content) {
                if (content.type === 'text' && content.text) {
                    text += content.text
                }
            }
        }

        const role = m.role === 'developer' ? 'system' : m.role

        // Append default system prompt to existing system message
        if (role === 'system') {
            hasSystemMessage = true
            text = text ? `${text}\n\n${DEFAULT_SYSTEM_PROMPT}` : DEFAULT_SYSTEM_PROMPT
        }

        result.push({
            role: role,
            parts: [{ type: 'text', text: text }]
        })
    }

    // If no system message exists, prepend one with the default prompt
    if (!hasSystemMessage) {
        result.unshift({
            role: 'system',
            parts: [{ type: 'text', text: DEFAULT_SYSTEM_PROMPT }]
        })
    }

    // Remove empty system message at start (safety check)
    if (result.length > 0 && result[0].role === 'system' && !result[0].parts[0].text) {
        result.shift()
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
        id: generateChatId(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: request.model,
        choices: [{
            index: 0,
            message: {
                role: 'assistant',
                content: fullContent
            },
            finish_reason: mapFinishReason(usage.finishReason)
        }],
        usage: {
            prompt_tokens: usage.promptTokens,
            completion_tokens: usage.completionTokens,
            total_tokens: usage.totalTokens,
            prompt_tokens_details: {
                cached_tokens: usage.cacheReadTokens || 0
            }
        }
    }
}

async function* streamResponse(request, generator) {
    const chatId = generateChatId()
    const createdTime = Math.floor(Date.now() / 1000)
    let usage = null
    let isInitSent = false

    const initialResponse = {
        id: chatId,
        object: 'chat.completion.chunk',
        created: createdTime,
        model: request.model,
        choices: [{
            index: 0,
            delta: { role: 'assistant', content: '' },
            finish_reason: null
        }]
    }

    for await (const chunk of generator) {
        if (!isInitSent) {
            yield `data: ${JSON.stringify(initialResponse)}\n\n`
            isInitSent = true
        }

        if (chunk.type === 'usage') {
            usage = chunk
            continue
        }

        if (chunk.type === 'delta') {
            const chunkResponse = {
                id: chatId,
                object: 'chat.completion.chunk',
                created: createdTime,
                model: request.model,
                choices: [{
                    index: 0,
                    delta: { content: chunk.content },
                    finish_reason: null
                }]
            }
            yield `data: ${JSON.stringify(chunkResponse)}\n\n`
        }
    }

    // Send finish
    const finalResponse = {
        id: chatId,
        object: 'chat.completion.chunk',
        created: createdTime,
        model: request.model,
        choices: [{
            index: 0,
            delta: {},
            finish_reason: usage ? mapFinishReason(usage.finishReason) : 'stop'
        }]
    }
    yield `data: ${JSON.stringify(finalResponse)}\n\n`

    // Send usage if available
    if (usage) {
        const usageData = {
            id: chatId,
            object: 'chat.completion.chunk',
            created: createdTime,
            model: request.model,
            choices: [],
            usage: {
                prompt_tokens: usage.promptTokens,
                completion_tokens: usage.completionTokens,
                total_tokens: usage.totalTokens,
                prompt_tokens_details: {
                    cached_tokens: usage.cacheReadTokens || 0
                }
            }
        }
        yield `data: ${JSON.stringify(usageData)}\n\n`
    }

    yield 'data: [DONE]\n\n'
}

// ============ RESPONSE FORMAT CONVERSION ============

function convertOpenAIResponseFormat(rf) {
    if (!rf || rf.type === 'text') return null
    if (rf.type === 'json_object') {
        return { type: 'json' }
    }
    if (rf.type === 'json_schema' && rf.json_schema) {
        return {
            type: 'json',
            schema: rf.json_schema.schema,
            ...(rf.json_schema.name && { name: rf.json_schema.name }),
            ...(rf.json_schema.description && { description: rf.json_schema.description })
        }
    }
    return null
}

// ============ REQUEST HANDLER ============

async function handleChatCompletions(request) {
    // Validate model
    if (!MODELS.includes(request.model)) {
        request.model = MODELS[0]
    }

    // Convert OpenAI messages to cursor format
    request.messages = toCursorMessages(request.messages)

    // Convert response_format to Cursor responseFormat
    if (request.response_format) {
        const converted = convertOpenAIResponseFormat(request.response_format)
        if (converted) {
            request.responseFormat = converted
        }
    }

    const isStream = request.stream !== false

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
                    console.error('[STREAM ERROR]', error)
                    const errorChunk = `data: ${JSON.stringify({
                        error: {
                            message: error.message,
                            type: 'stream_error',
                            code: 'stream_error'
                        }
                    })}\n\n`
                    controller.enqueue(new TextEncoder().encode(errorChunk))
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
    const authErr = checkAuth()
    if (authErr) return authErr

    // List models
    if (url.pathname.endsWith('/v1/models') && req.method === 'GET') {
        const modelList = MODELS.map(id => ({
            id,
            object: 'model',
            created: Math.floor(Date.now() / 1000),
            owned_by: 'mino'
        }))

        return new Response(JSON.stringify({ object: 'list', data: modelList }), {
            status: 200,
            headers: { ...CORS, 'Content-Type': 'application/json' }
        })
    }

    // Chat completions
    if (url.pathname.endsWith('/v1/chat/completions') && req.method === 'POST') {
        return req.json().then(body => handleChatCompletions(body))
    }

    // 404 for unknown sub-routes
    return new Response(JSON.stringify({
        error: { message: 'Not found', type: 'not_found', code: 'not_found' }
    }), {
        status: 404,
        headers: { ...CORS, 'Content-Type': 'application/json' }
    })
}
