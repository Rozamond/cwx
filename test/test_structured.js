import OpenAI from 'openai'

const client = new OpenAI({
    apiKey: 'rea',
    baseURL: 'http://localhost:10000/openai/v1'
})

// ============ TEST 1: json_schema mode ============
async function testJsonSchema() {
    console.log('=== TEST 1: json_schema mode ===')
    console.log('Requesting structured output with json_schema...\n')

    try {
        const response = await client.chat.completions.create({
            model: 'anthropic/claude-sonnet-4.6',
            messages: [
                { role: 'user', content: 'Give me info about 3 planets in our solar system.' }
            ],
            response_format: {
                type: 'json_schema',
                json_schema: {
                    name: 'planets',
                    description: 'A list of planets with their details',
                    schema: {
                        type: 'object',
                        properties: {
                            planets: {
                                type: 'array',
                                items: {
                                    type: 'object',
                                    properties: {
                                        name: { type: 'string' },
                                        distance_from_sun_km: { type: 'number' },
                                        has_rings: { type: 'boolean' }
                                    },
                                    required: ['name', 'distance_from_sun_km', 'has_rings']
                                }
                            }
                        },
                        required: ['planets'],
                        additionalProperties: false
                    }
                }
            },
            stream: false
        })

        const content = response.choices[0].message.content
        console.log('Raw response:')
        console.log(content)
        console.log()

        // Try to parse as JSON
        try {
            const parsed = JSON.parse(content)
            console.log('✅ Valid JSON! Parsed:')
            console.log(JSON.stringify(parsed, null, 2))

            // Validate structure
            if (parsed.planets && Array.isArray(parsed.planets)) {
                console.log(`✅ Has "planets" array with ${parsed.planets.length} items`)
                for (const p of parsed.planets) {
                    if (p.name && typeof p.distance_from_sun_km === 'number' && typeof p.has_rings === 'boolean') {
                        console.log(`  ✅ ${p.name}: distance=${p.distance_from_sun_km}, rings=${p.has_rings}`)
                    } else {
                        console.log(`  ❌ Planet missing required fields:`, p)
                    }
                }
            } else {
                console.log('❌ Missing "planets" array in response')
            }
        } catch (e) {
            console.log('❌ Response is NOT valid JSON:', e.message)
        }
    } catch (e) {
        console.log('❌ Request failed:', e.message)
    }

    console.log()
}

// ============ TEST 2: json_object mode ============
async function testJsonObject() {
    console.log('=== TEST 2: json_object mode ===')
    console.log('Requesting structured output with json_object...\n')

    try {
        const response = await client.chat.completions.create({
            model: 'anthropic/claude-sonnet-4.6',
            messages: [
                { role: 'user', content: 'Return a JSON object with keys "greeting" (string) and "lucky_number" (number). Only respond with JSON.' }
            ],
            response_format: { type: 'json_object' },
            stream: false
        })

        const content = response.choices[0].message.content
        console.log('Raw response:')
        console.log(content)
        console.log()

        try {
            const parsed = JSON.parse(content)
            console.log('✅ Valid JSON! Parsed:')
            console.log(JSON.stringify(parsed, null, 2))
        } catch (e) {
            console.log('❌ Response is NOT valid JSON:', e.message)
        }
    } catch (e) {
        console.log('❌ Request failed:', e.message)
    }

    console.log()
}

// ============ TEST 3: json_schema streaming mode ============
async function testJsonSchemaStream() {
    console.log('=== TEST 3: json_schema streaming mode ===')
    console.log('Requesting structured output with json_schema + streaming...\n')

    try {
        const stream = await client.chat.completions.create({
            model: 'anthropic/claude-sonnet-4.6',
            messages: [
                { role: 'user', content: 'Give me info about 2 colors with their hex codes.' }
            ],
            response_format: {
                type: 'json_schema',
                json_schema: {
                    name: 'colors',
                    schema: {
                        type: 'object',
                        properties: {
                            colors: {
                                type: 'array',
                                items: {
                                    type: 'object',
                                    properties: {
                                        name: { type: 'string' },
                                        hex: { type: 'string' }
                                    },
                                    required: ['name', 'hex']
                                }
                            }
                        },
                        required: ['colors'],
                        additionalProperties: false
                    }
                }
            },
            stream: true
        })

        let fullContent = ''
        process.stdout.write('Stream: ')
        for await (const chunk of stream) {
            const delta = chunk.choices[0]?.delta?.content || ''
            fullContent += delta
            process.stdout.write(delta)
        }
        console.log('\n')

        try {
            const parsed = JSON.parse(fullContent)
            console.log('✅ Valid JSON from stream! Parsed:')
            console.log(JSON.stringify(parsed, null, 2))
        } catch (e) {
            console.log('❌ Streamed response is NOT valid JSON:', e.message)
        }
    } catch (e) {
        console.log('❌ Stream request failed:', e.message)
    }
}

// Run tests
console.log('Structured Output Tests')
console.log('=======================\n')

await testJsonSchema()
await testJsonObject()
await testJsonSchemaStream()

console.log('\n=== ALL TESTS COMPLETE ===')
