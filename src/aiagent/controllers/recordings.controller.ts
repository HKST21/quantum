import { Request, Response } from 'express';
import pool from '../../db/pool';

// ============================================
// NAHRÁVKY HOVORŮ (Asterisk + Odorik)
// Nahrávky zapisuje ústředna (Hetzner) do tabulky call_recordings jako MP3.
// Tady se jen přehrávají: GET /api/recordings/<token>.mp3
// Bez přihlášení (přehrávač v prohlížeči neposílá JWT) – přístup chrání
// náhodný 48znakový token. Podporuje Range (přetáčení v přehrávači).
// ============================================

const TOKEN_RE = /^[a-f0-9]{48}$/;

export const streamRecording = async (req: Request, res: Response): Promise<void> => {
    const token = String(req.params.file ?? '').replace(/\.mp3$/i, '');
    if (!TOKEN_RE.test(token)) {
        res.status(404).json({ error: 'Nahrávka nenalezena' });
        return;
    }

    try {
        const result = await pool.query(
            `SELECT audio, size_bytes, content_type FROM call_recordings WHERE token = $1`,
            [token]
        );
        if (result.rows.length === 0) {
            res.status(404).json({ error: 'Nahrávka nenalezena nebo již byla smazána' });
            return;
        }

        const audio: Buffer = result.rows[0].audio;
        const total = audio.length;
        const contentType: string = result.rows[0].content_type || 'audio/mpeg';

        res.setHeader('Content-Type', contentType);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Cache-Control', 'private, max-age=3600');
        res.setHeader('Content-Disposition', 'inline; filename="hovor.mp3"');

        const range = req.headers.range;
        if (range) {
            const m = /^bytes=(\d*)-(\d*)$/.exec(range);
            if (m && (m[1] !== '' || m[2] !== '')) {
                let start: number;
                let end: number;
                if (m[1] === '') {
                    // "bytes=-N" = posledních N bajtů
                    start = Math.max(0, total - Number(m[2]));
                    end = total - 1;
                } else {
                    start = Number(m[1]);
                    end = m[2] === '' ? total - 1 : Math.min(Number(m[2]), total - 1);
                }
                if (start > end || start >= total) {
                    res.status(416).setHeader('Content-Range', `bytes */${total}`);
                    res.end();
                    return;
                }
                res.status(206);
                res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
                res.setHeader('Content-Length', String(end - start + 1));
                res.end(audio.subarray(start, end + 1));
                return;
            }
        }

        res.status(200);
        res.setHeader('Content-Length', String(total));
        res.end(audio);
    } catch (e) {
        console.error('❌ [Recordings] Chyba při přehrávání:', (e as Error).message);
        res.status(500).json({ error: 'Chyba serveru' });
    }
};