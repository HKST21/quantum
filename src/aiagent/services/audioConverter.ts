// ============================================
// AUDIO CONVERTER
// Twilio ↔ Gemini Live audio format bridge
//
// Twilio: G.711 µ-law, 8kHz mono
// Gemini input: 16-bit PCM, 16kHz mono
// Gemini output: 16-bit PCM, 24kHz mono
//
// Resampling probíhá ve dvou krocích:
// Input:  µ-law 8kHz → PCM16 8kHz → PCM16 16kHz
// Output: PCM16 24kHz → PCM16 16kHz → PCM16 8kHz → µ-law 8kHz
//
// Převzato 1:1 z ověřené VF-CRM implementace — čistě kodek matematika,
// nemá v sobě žádnou obchodní/produktovou logiku.
// ============================================

export const MULAW_FRAME_SIZE = 160;

// ============================================
// µ-LAW DEKÓDOVACÍ TABULKA (256 hodnot)
// ============================================

const MULAW_DECODE_TABLE: Int16Array = (() => {
    const table = new Int16Array(256);
    for (let i = 0; i < 256; i++) {
        let val = ~i & 0xFF;
        const sign = val & 0x80 ? -1 : 1;
        const exponent = (val >> 4) & 0x07;
        const mantissa = val & 0x0F;
        const magnitude = ((mantissa << 1) + 33) << exponent;
        table[i] = sign * (magnitude - 33);
    }
    return table;
})();

// ============================================
// µ-LAW ENKÓDOVACÍ TABULKA (generovaná z dekódovací)
// ============================================

const MULAW_ENCODE_TABLE: Uint8Array = (() => {
    const table = new Uint8Array(65536);
    for (let pcm = -32768; pcm <= 32767; pcm++) {
        const index = pcm < 0 ? pcm + 65536 : pcm;
        let best = 0;
        let bestDist = Infinity;
        for (let mu = 0; mu < 256; mu++) {
            const dist = Math.abs(MULAW_DECODE_TABLE[mu] - pcm);
            if (dist < bestDist) {
                bestDist = dist;
                best = mu;
            }
        }
        table[index] = best;
    }
    return table;
})();

function mulawToLinear(mulawByte: number): number {
    return MULAW_DECODE_TABLE[mulawByte & 0xFF];
}

function linearToMulaw(sample: number): number {
    sample = Math.max(-32768, Math.min(32767, Math.round(sample)));
    const index = sample < 0 ? sample + 65536 : sample;
    return MULAW_ENCODE_TABLE[index];
}

function upsample8to16(pcm8k: Int16Array): Int16Array {
    const pcm16k = new Int16Array(pcm8k.length * 2);
    for (let i = 0; i < pcm8k.length; i++) {
        pcm16k[i * 2] = pcm8k[i];
        const next = i + 1 < pcm8k.length ? pcm8k[i + 1] : pcm8k[i];
        pcm16k[i * 2 + 1] = Math.round((pcm8k[i] + next) / 2);
    }
    return pcm16k;
}

function downsample24to16(pcm24k: Int16Array): Int16Array {
    const outputLength = Math.floor(pcm24k.length * 2 / 3);
    const pcm16k = new Int16Array(outputLength);
    for (let i = 0; i < outputLength; i++) {
        const srcIdx = i * 3 / 2;
        const lo = Math.floor(srcIdx);
        const hi = Math.min(lo + 1, pcm24k.length - 1);
        const frac = srcIdx - lo;
        pcm16k[i] = Math.round(pcm24k[lo] * (1 - frac) + pcm24k[hi] * frac);
    }
    return pcm16k;
}

function downsample16to8(pcm16k: Int16Array): Int16Array {
    const pcm8k = new Int16Array(Math.floor(pcm16k.length / 2));
    for (let i = 0; i < pcm8k.length; i++) {
        pcm8k[i] = Math.round((pcm16k[i * 2] + pcm16k[i * 2 + 1]) / 2);
    }
    return pcm8k;
}

/**
 * Twilio → Gemini
 * Input:  Buffer (µ-law 8kHz base64 decoded)
 * Output: Buffer (PCM16 16kHz, little-endian)
 */
export function twilioToGemini(mulawBuffer: Buffer): Buffer {
    const pcm8k = new Int16Array(mulawBuffer.length);
    for (let i = 0; i < mulawBuffer.length; i++) {
        pcm8k[i] = mulawToLinear(mulawBuffer[i]);
    }

    const pcm16k = upsample8to16(pcm8k);

    const output = Buffer.alloc(pcm16k.length * 2);
    for (let i = 0; i < pcm16k.length; i++) {
        output.writeInt16LE(pcm16k[i], i * 2);
    }
    return output;
}

/**
 * Gemini → Twilio
 * Input:  Buffer (PCM16 24kHz, little-endian)
 * Output: Buffer (µ-law 8kHz, ready for Twilio)
 */
export function geminiToTwilio(pcm24kBuffer: Buffer): Buffer {
    const pcm24k = new Int16Array(Math.floor(pcm24kBuffer.length / 2));
    for (let i = 0; i < pcm24k.length; i++) {
        pcm24k[i] = pcm24kBuffer.readInt16LE(i * 2);
    }

    const pcm16k = downsample24to16(pcm24k);
    const pcm8k = downsample16to8(pcm16k);

    const output = Buffer.alloc(pcm8k.length);
    for (let i = 0; i < pcm8k.length; i++) {
        output[i] = linearToMulaw(pcm8k[i]);
    }
    return output;
}

/**
 * Rozdělí buffer na 160-byte frames (20ms při 8kHz)
 */
export function splitIntoFrames(buffer: Buffer): Buffer[] {
    const frames: Buffer[] = [];
    let offset = 0;
    while (offset + MULAW_FRAME_SIZE <= buffer.length) {
        frames.push(buffer.slice(offset, offset + MULAW_FRAME_SIZE));
        offset += MULAW_FRAME_SIZE;
    }
    return frames;
}