import { Hono } from 'hono';
import { getQuestionOfTheDay } from '../examQuestion';

export const examQuestionRoutes = new Hono();

examQuestionRoutes.get('/question-of-the-day', (c) => c.json(getQuestionOfTheDay()));
