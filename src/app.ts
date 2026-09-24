import express, { type Express, type Request, type Response } from 'express';

/**
 * Builds the Express application. Kept separate from the server bootstrap so
 * tests can exercise the routes without binding a port.
 */
export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');

  app.get('/', (_req: Request, res: Response) => {
    res.type('text/plain').send('hello, world!');
  });

  return app;
}
