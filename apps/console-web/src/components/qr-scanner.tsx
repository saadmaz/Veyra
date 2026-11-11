'use client';

import { useEffect, useRef, useState } from 'react';
import { Alert, Button } from '@/components/ui';

/*
 * Scans a visitor's QR code with the device camera using the browser's own BarcodeDetector
 * (Chrome on Android and other Chromium browsers): no scanning library is shipped. Where it is
 * missing, guards type the reference code instead.
 */

interface DetectedBarcode {
  rawValue: string;
}
interface BarcodeDetectorLike {
  detect(source: HTMLVideoElement): Promise<DetectedBarcode[]>;
}
type BarcodeDetectorCtor = new (options: { formats: string[] }) => BarcodeDetectorLike;

function barcodeDetector(): BarcodeDetectorCtor | null {
  if (typeof window === 'undefined') return null;
  const ctor = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  // mediaDevices is missing on insecure (http) pages, whatever the types say.
  const camera = typeof navigator.mediaDevices?.getUserMedia === 'function';
  return ctor && camera ? ctor : null;
}

export const canScanQr = () => barcodeDetector() !== null;

/** Only VEYRA pass tokens are accepted: anything else in a QR code is ignored. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function QrScanner({
  onToken,
  onClose,
}: {
  onToken: (token: string) => void;
  onClose: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    const Detector = barcodeDetector();
    if (!Detector) {
      setProblem('This browser cannot scan QR codes. Type the reference code instead.');
      return;
    }
    const detector = new Detector({ formats: ['qr_code'] });
    let stream: MediaStream | null = null;
    let timer: number | undefined;
    let stopped = false;
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then(async (media) => {
        if (stopped) {
          for (const track of media.getTracks()) track.stop();
          return;
        }
        stream = media;
        const element = video.current;
        if (!element) return;
        element.srcObject = media;
        await element.play();
        timer = window.setInterval(() => {
          void detector
            .detect(element)
            .then((codes) => {
              const token = codes.map((c) => c.rawValue).find((value) => TOKEN.test(value));
              if (token && !stopped) {
                stopped = true;
                onToken(token);
              }
            })
            .catch(() => undefined);
        }, 300);
      })
      .catch(() => setProblem('The camera is not available. Type the reference code instead.'));
    return () => {
      stopped = true;
      window.clearInterval(timer);
      for (const track of stream?.getTracks() ?? []) track.stop();
    };
  }, [onToken]);

  return (
    <div className="scanner">
      {problem ? (
        <Alert>{problem}</Alert>
      ) : (
        // A live camera preview has no captions to offer; the result is announced as text.
        <video ref={video} className="scanner__video" muted playsInline aria-label="Camera" />
      )}
      <Button variant="secondary" onClick={onClose}>
        Stop scanning
      </Button>
    </div>
  );
}
