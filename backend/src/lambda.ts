import serverlessHttp from 'serverless-http';
import { app } from './app.js';

export const handler = serverlessHttp(app);
