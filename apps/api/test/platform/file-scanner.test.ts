import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ClamAvFileScanner,
  NoFileScanner,
  parseClamAnswer,
} from '../../src/platform/storage/file-scanner';

let server: Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

/** A fake clamd: reads INSTREAM chunks and flags a harmless marker (not real test malware). */
function fakeClamd(): Promise<number> {
  return new Promise((resolve) => {
    server = createServer((socket) => {
      let buffer = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk as Buffer]);
        const command = 'zINSTREAM\0';
        if (buffer.length < command.length) return;
        let offset = command.length;
        const parts: Buffer[] = [];
        while (offset + 4 <= buffer.length) {
          const size = buffer.readUInt32BE(offset);
          if (size === 0) {
            const found = Buffer.concat(parts).includes('TEST-MALWARE-MARKER');
            socket.end(found ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0');
            return;
          }
          if (offset + 4 + size > buffer.length) return;
          parts.push(buffer.subarray(offset + 4, offset + 4 + size));
          offset += 4 + size;
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server?.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
}

describe('file scanning', () => {
  it('reads clamd answers', () => {
    expect(parseClamAnswer('stream: OK\0')).toBe('clean');
    expect(parseClamAnswer('stream: Win.Test.EICAR_HDB-1 FOUND\0')).toBe('infected');
    expect(parseClamAnswer('INSTREAM size limit exceeded. ERROR\0')).toBe('unavailable');
  });

  it('sends files to clamd in chunks and reports what it finds', async () => {
    const port = await fakeClamd();
    const scanner = new ClamAvFileScanner('127.0.0.1', port);
    expect(await scanner.scan(new Uint8Array(200_000).fill(65))).toBe('clean');
    expect(await scanner.scan(Buffer.from('a file carrying the TEST-MALWARE-MARKER'))).toBe(
      'infected',
    );
  });

  it('fails closed when clamd cannot be reached', async () => {
    expect(await new ClamAvFileScanner('127.0.0.1', 1, 2000).scan(new Uint8Array(10))).toBe(
      'unavailable',
    );
    expect(await new NoFileScanner().scan()).toBe('clean');
  });
});
