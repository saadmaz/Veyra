export interface ErrorDetail {
  path: string;
  message: string;
}

/** Standard error body for every non-2xx response (docs/architecture/API_DESIGN.md). */
export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: ErrorDetail[];
    requestId?: string;
  };
}
