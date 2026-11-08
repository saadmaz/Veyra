import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'veyra:isPublic';

/**
 * Marks a route as reachable without authentication. Every other route requires a valid
 * session (the AuthGuard is global and denies by default). Use sparingly: health checks,
 * sign-up, sign-in.
 */
export const Public = () => SetMetadata(IS_PUBLIC, true);
