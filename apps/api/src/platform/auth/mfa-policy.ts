import { Inject, Injectable } from '@nestjs/common';
import { API_ENV, type ApiEnv } from '../config/env';
import { ApiError } from '../errors/api-error';

/** What the policy needs to know about the caller's session. */
export interface MfaSubject {
  mfaEnabled: boolean;
  mfaVerified: boolean;
}

/**
 * ACCESS_CONTROL rule 7 (Phase 14): privileged people (organisation admins, finance officers,
 * platform administrators) need a session verified with a second factor before they change
 * anything. MFA_ENFORCEMENT turns it on ("privileged", the default in production) or off
 * ("off", the default elsewhere, so development and most tests are not blocked).
 */
@Injectable()
export class MfaPolicy {
  readonly enforced: boolean;

  constructor(@Inject(API_ENV) env: ApiEnv) {
    this.enforced =
      (env.MFA_ENFORCEMENT ?? (env.NODE_ENV === 'production' ? 'privileged' : 'off')) ===
      'privileged';
  }

  /** Throws 403 when a privileged change is attempted without a verified session. */
  requireForPrivilegedChange(subject: MfaSubject | undefined) {
    if (!this.enforced || subject?.mfaVerified) return;
    if (!subject?.mfaEnabled) {
      throw new ApiError(
        403,
        'MFA_SETUP_REQUIRED',
        'Your role needs two-step sign-in. Turn it on in your account before making changes.',
      );
    }
    throw new ApiError(
      403,
      'MFA_REQUIRED',
      'Confirm it is you with the code from your authenticator app before making changes.',
    );
  }
}
