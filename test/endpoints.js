import OpenAI from 'openai'
import Anthropic from '@anthropic-ai/sdk'

const BASE_URL = process.env.BASE_URL || 'http://localhost:10000'
const API_KEY = process.env.API_KEY || 'rea'

const openai = new OpenAI({
    baseURL: `${BASE_URL}/v1`,
    apiKey: API_KEY,
})

const openaiPrefixed = new OpenAI({
    baseURL: `${BASE_URL}/openai/v1`,
    apiKey: API_KEY,
})

const anthropic = new Anthropic({
    baseURL: `${BASE_URL}/anthropic`,
    apiKey: API_KEY,
})

// ============ HELPERS ============

function header(label) {
    console.log(`\n${'='.repeat(60)}`)
    console.log(`  ${label}`)
    console.log('='.repeat(60))
}

function pass(label) { console.log(`  ✅ ${label}`) }
function fail(label, err) { console.log(`  ❌ ${label}: ${err}`) }

// ============ OPENAI TESTS ============

async function testOpenAIModels() {
    header('OpenAI — List Models (/v1/models)')
    try {
        const models = await openai.models.list()
        const list = []
        for await (const model of models) {
            list.push(model.id)
        }
        console.log(`  Models: ${list.join(', ')}`)
        pass(`Found ${list.length} model(s)`)
    } catch (e) {
        fail('List models', e.message)
    }
}

async function testOpenAIModelsPrefix() {
    header('OpenAI — List Models (/openai/v1/models)')
    try {
        const models = await openaiPrefixed.models.list()
        const list = []
        for await (const model of models) {
            list.push(model.id)
        }
        console.log(`  Models: ${list.join(', ')}`)
        pass(`Found ${list.length} model(s) via /openai prefix`)
    } catch (e) {
        fail('List models (prefixed)', e.message)
    }
}

async function testOpenAINonStream() {
    header('OpenAI — Chat Completions (non-stream)')
    try {
        const response = await openai.chat.completions.create({
            model: 'anthropic/claude-sonnet-4.6',
            messages: [{ role: 'user', content: 'Say "hello world" and nothing else.' }],
            stream: false,
        })
        console.log(`  ID: ${response.id}`)
        console.log(`  Model: ${response.model}`)
        console.log(`  Content: ${response.choices[0].message.content}`)
        console.log(`  Finish: ${response.choices[0].finish_reason}`)
        console.log(`  Usage: prompt=${response.usage?.prompt_tokens}, completion=${response.usage?.completion_tokens}`)
        pass('Non-stream response received')
    } catch (e) {
        fail('Non-stream', e.message)
    }
}

async function testOpenAIStream() {
    header('OpenAI — Chat Completions (stream)')
    try {
        const stream = await openai.chat.completions.create({
            model: 'anthropic/claude-sonnet-4.6',
            messages: [{ role: 'user', content: 'Say "hello world" and nothing else.' }],
            stream: true,
        })

        let content = ''
        let chunkCount = 0
        process.stdout.write('  Chunks: ')
        for await (const chunk of stream) {
            const delta = chunk.choices?.[0]?.delta?.content || ''
            content += delta
            if (delta) {
                process.stdout.write(delta)
                chunkCount++
            }
        }
        console.log('')
        console.log(`  Total chunks: ${chunkCount}, content length: ${content.length}`)
        pass('Stream response received')
    } catch (e) {
        fail('Stream', e.message)
    }
}

// ============ ANTHROPIC TESTS ============

async function testAnthropicNonStream() {
    header('Anthropic — Messages (non-stream)')
    try {
        const response = await anthropic.messages.create({
            model: 'anthropic/claude-sonnet-4.6',
            max_tokens: 100,
            messages: [{ role: 'user', content: 'Say "hello world" and nothing else.' }],
        })
        console.log(`  ID: ${response.id}`)
        console.log(`  Type: ${response.type}`)
        console.log(`  Role: ${response.role}`)
        console.log(`  Model: ${response.model}`)
        console.log(`  Content: ${response.content[0]?.text}`)
        console.log(`  Stop reason: ${response.stop_reason}`)
        console.log(`  Usage: input=${response.usage?.input_tokens}, output=${response.usage?.output_tokens}`)
        pass('Non-stream response received')
    } catch (e) {
        fail('Non-stream', e.message)
    }
}

async function testAnthropicStream() {
    header('Anthropic — Messages (stream)')
    try {
        const stream = await anthropic.messages.stream({
            model: 'anthropic/claude-sonnet-4.6',
            max_tokens: 100,
            messages: [{ role: 'user', content: 'Say "hello world" and nothing else.' }],
        })

        let content = ''
        let eventCount = 0
        process.stdout.write('  Text: ')
        for await (const event of stream) {
            if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
                content += event.delta.text
                process.stdout.write(event.delta.text)
                eventCount++
            }
        }
        console.log('')
        console.log(`  Total delta events: ${eventCount}, content length: ${content.length}`)

        const finalMessage = await stream.finalMessage()
        console.log(`  Final stop_reason: ${finalMessage.stop_reason}`)
        pass('Stream response received')
    } catch (e) {
        fail('Stream', e.message)
    }
}

// ============ RUN ============

async function main() {
    console.log(`\n🧪 Testing server at ${BASE_URL}\n`)

    // OpenAI tests
    await testOpenAIModels()
    await testOpenAIModelsPrefix()
    await testOpenAINonStream()
    await testOpenAIStream()

    // Anthropic tests
    await testAnthropicNonStream()
    await testAnthropicStream()

    console.log(`\n${'='.repeat(60)}`)
    console.log('  Done!')
    console.log('='.repeat(60) + '\n')
}

main().catch(console.error)
