import { Router } from 'express';
import { streamRecording } from '../controllers/recordings.controller';

const router = Router();

// Veřejné (bez authenticate) – chrání je náhodný token v URL. Viz recordings.controller.ts
router.get('/:file', streamRecording);

export default router;