const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:8765');
const fs = require('fs');

ws.on('open', () => {
    ws.send(JSON.stringify({
        type: 'session_init',
        session_id: 'test-123',
        audio_format: { sample_rate: 16000, channels: 1, bit_depth: 16, encoding: 'pcm_s16le' },
        client_capabilities: { supports_barge_in: true, vad_library: 'silero-v5', browser: 'test' }
    }));
});

ws.on('message', (msg, isBinary) => {
    if (!isBinary) {
        let msgJson = JSON.parse(msg);
        console.log('<-', msgJson);
        if (msgJson.type === 'session_ack') {
            setTimeout(runTest, 1000);
        }
    } else {
        console.log('<- [binary]', msg.length, 'bytes');
    }
});

function runTest() {
    console.log('-> speech_start');
    ws.send(JSON.stringify({ type: 'speech_start', session_id: 'test-123', timestamp_ms: Date.now() }));
    
    // Send 10 chunks of dummy PCM audio
    const pcm = fs.readFileSync('dummy.pcm'); 
    // dummy.pcm has 16000 * 2 = 32000 bytes padded with length and 0 at the end. 
    // Let's just generate raw PCM here.
    const chunk = Buffer.alloc(1024, 0); // silent speech chunk
    for(let i=0; i<10; i++) {
        ws.send(chunk);
    }
    
    console.log('-> speech_end');
    ws.send(JSON.stringify({ type: 'speech_end', session_id: 'test-123', duration_ms: 320, timestamp_ms: Date.now() }));
}
