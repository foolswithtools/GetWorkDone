import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';

// A local SMTP sink for outputs.spec.ts (GWP#70): the e2e API runs in production mode, where the delivery
// worker sends, and EMAIL_TRANSPORT=memory starts only under NODE_ENV=test, which stops the worker. So the
// spec points EMAIL_TRANSPORT=smtp and SMTP_URL here. It answers plain SMTP (no STARTTLS, no AUTH), accepts
// every recipient and keeps each message's envelope and data.

export interface SunkMail {
  from: string;
  to: string[];
  data: string;
}

export interface SmtpSink {
  /** smtp://127.0.0.1:<port>, for SMTP_URL. */
  url: string;
  received: SunkMail[];
  close(): Promise<void>;
}

export async function startSmtpSink(): Promise<SmtpSink> {
  const received: SunkMail[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    // A client that drops the connection (the API stopped mid-session) ends that session, not the run.
    socket.on('error', () => socket.destroy());
    let buffer = '';
    let mail: SunkMail = { from: '', to: [], data: '' };
    let inData = false;
    const reply = (line: string) => socket.write(`${line}\r\n`);
    reply('220 smtp-sink ESMTP');
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let end: number;
      while ((end = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            received.push(mail);
            mail = { from: '', to: [], data: '' };
            reply('250 OK: queued');
          } else mail.data += `${line.startsWith('..') ? line.slice(1) : line}\r\n`;
          continue;
        }
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO') reply('250 smtp-sink');
        else if (verb === 'HELO') reply('250 smtp-sink');
        else if (verb === 'MAIL') {
          mail.from = /<([^>]*)>/.exec(line)?.[1] ?? '';
          reply('250 OK');
        } else if (verb === 'RCPT') {
          mail.to.push(/<([^>]*)>/.exec(line)?.[1] ?? '');
          reply('250 OK');
        } else if (verb === 'DATA') {
          inData = true;
          reply('354 End data with <CR><LF>.<CR><LF>');
        } else if (verb === 'RSET') {
          mail = { from: '', to: [], data: '' };
          reply('250 OK');
        } else if (verb === 'NOOP') reply('250 OK');
        else if (verb === 'QUIT') {
          reply('221 Bye');
          socket.end();
        } else reply('502 Command not implemented');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `smtp://127.0.0.1:${port}`,
    received,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
