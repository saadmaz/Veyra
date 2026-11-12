import { connect } from 'node:net';

/*
 * Malware scanning of uploads (Phase 14 Part 3). Every uploaded file is scanned before anyone can
 * see it; an infected file is rejected and deleted like a file that is not what it claims. When
 * the scanner cannot be reached the upload stays pending (fail closed) and the client may retry.
 */

export type ScanResult = 'clean' | 'infected' | 'unavailable';

export interface FileScanner {
  readonly name: string;
  scan(bytes: Uint8Array): Promise<ScanResult>;
}

export const FILE_SCANNER = Symbol('FILE_SCANNER');

/** Development default: scans nothing. Production should configure ClamAV (CLAMAV_HOST). */
export class NoFileScanner implements FileScanner {
  readonly name = 'none';
  async scan(): Promise<ScanResult> {
    return 'clean';
  }
}

/**
 * ClamAV's clamd over TCP with the INSTREAM command: the file is sent in length-prefixed chunks
 * and clamd answers "stream: OK" or "stream: <signature> FOUND".
 */
export class ClamAvFileScanner implements FileScanner {
  readonly name = 'clamav';

  constructor(
    private readonly host: string,
    private readonly port = 3310,
    private readonly timeoutMs = 30_000,
  ) {}

  scan(bytes: Uint8Array): Promise<ScanResult> {
    return new Promise((resolve) => {
      const socket = connect({ host: this.host, port: this.port });
      let answer = '';
      let settled = false;
      const finish = (result: ScanResult) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(result);
      };
      socket.setTimeout(this.timeoutMs, () => finish('unavailable'));
      socket.on('error', () => finish('unavailable'));
      socket.on('data', (chunk) => {
        answer += chunk.toString('utf8');
        if (answer.includes('\0')) finish(parseClamAnswer(answer));
      });
      socket.on('end', () => finish(parseClamAnswer(answer)));
      socket.on('connect', () => {
        socket.write('zINSTREAM\0');
        const CHUNK = 64 * 1024;
        for (let offset = 0; offset < bytes.length; offset += CHUNK) {
          const part = bytes.subarray(offset, offset + CHUNK);
          const size = Buffer.alloc(4);
          size.writeUInt32BE(part.length);
          socket.write(size);
          socket.write(part);
        }
        socket.write(Buffer.alloc(4));
      });
    });
  }
}

export function parseClamAnswer(answer: string): ScanResult {
  const text = answer.replace(/\0/g, '').trim();
  if (/\bOK$/.test(text)) return 'clean';
  if (/FOUND$/.test(text)) return 'infected';
  return 'unavailable';
}
