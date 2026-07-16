import type { Server } from 'node:http';

export async function listenHttpServer(
  server: Server,
  port: number,
  host = '127.0.0.1',
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const handleStartupError = (error: NodeJS.ErrnoException): void => {
      server.off('listening', handleListening);
      reject(error);
    };
    const handleListening = (): void => {
      server.off('error', handleStartupError);
      resolve();
    };

    server.once('error', handleStartupError);
    server.once('listening', handleListening);
    server.listen(port, host);
  });
}
