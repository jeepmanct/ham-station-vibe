// License exam "question of the day" -- sourced from the real, current
// FCC Technician (Element 2) question pool, effective 2026-07-01 through
// 2030, via russolsen/ham_radio_question_pool on GitHub (Apache 2.0
// licensed), which itself mirrors NCVEC's official release. Not
// hand-written or reconstructed from memory -- this is genuinely the
// pool a Technician exam is drawn from right now, not a stale or
// approximated version (the prior 2022-2026 pool expired June 30, 2026).
//
// Scope: Technician only, not General/Extra -- matches the beginner-
// friendly tone of this page's existing Morse trainer, and keeps the
// bundled data/figures to one pool's worth rather than three.
import { readFileSync } from 'node:fs';
import path from 'node:path';

type PoolQuestion = {
  id: string;
  correct: number;
  refs: string;
  question: string;
  answers: string[];
  figure: string;
  correct_letter: string;
};

const POOL: PoolQuestion[] = JSON.parse(
  readFileSync(path.join(import.meta.dir, 'data', 'technicianQuestionPool.json'), 'utf-8'),
);

export type QuestionOfTheDay = {
  id: string;
  question: string;
  answers: string[];
  correctIndex: number;
  refs: string;
  figureUrl: string | null;
  poolSize: number;
};

/**
 * Deterministic, not random -- every visitor sees the SAME question on a
 * given UTC day (and it changes at UTC midnight), the same "one puzzle per
 * day, shared" framing as the Morse trainer's quiz mode or a Wordle-style
 * daily. Picked by day-of-epoch modulo pool size, cycling through all 409
 * questions roughly once every 13 months rather than repeating quickly.
 */
export function getQuestionOfTheDay(): QuestionOfTheDay {
  const daysSinceEpoch = Math.floor(Date.now() / 86_400_000);
  const q = POOL[daysSinceEpoch % POOL.length];
  return {
    id: q.id,
    question: q.question,
    answers: q.answers,
    correctIndex: q.correct,
    refs: q.refs,
    figureUrl: q.figure ? `/exam-figures/${q.figure}` : null,
    poolSize: POOL.length,
  };
}
