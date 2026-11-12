import { Inject, Injectable } from '@nestjs/common';
import { databaseErrorCode } from '@veyra/db';
import { Money } from '@veyra/domain';
import { ApiError } from '../../../platform/errors/api-error';
import type { RequestMeta } from '../../../platform/request-meta';
import { AccessControlService, type OrganisationAccess } from '../../access-control';
import { NotificationsService } from '../../communications/application/notifications.service';
import {
  type ApprovalRequestInput,
  DEFAULT_RULE,
  type DecisionInput,
  type PolicyInput,
  policyFor,
  type UpdatePolicyInput,
} from '../domain/approval-rules';
import {
  APPROVAL_REPOSITORY,
  type ApprovalRepository,
  type ApprovalRequestRecord,
  type ApprovalUnitOfWork,
} from './approval-ports';

const notFound = (what: string) => new ApiError(404, 'NOT_FOUND', `${what} not found`);
const invalidState = (message: string) => new ApiError(409, 'INVALID_STATE_TRANSITION', message);

/** A request as the caller sees it, with whether they may decide it now. */
export interface RequestView {
  request: ApprovalRequestRecord;
  canDecide: boolean;
}

/**
 * Approvals (Phase 11 Part 3). Staff (property.approval.request) ask for approval of an expense,
 * a purchase, a policy change or the like. The property's policies (kept by governance managers)
 * say, by type and amount, how many approvals it needs and from whom: managers
 * (property.approval.decide) or the current members of one committee. The policy is copied onto
 * the request; nobody decides their own; one rejection settles it. Approvers are told when a
 * request arrives, the requester when it is settled.
 */
@Injectable()
export class ApprovalsService {
  constructor(
    @Inject(APPROVAL_REPOSITORY) private readonly repository: ApprovalRepository,
    private readonly accessControl: AccessControlService,
    private readonly notifications: NotificationsService,
  ) {}

  policies(access: OrganisationAccess, meta: RequestMeta) {
    return this.run(access, meta, async (uow) => ({
      policies: await uow.policies(),
      currency: await uow.currency(),
    }));
  }

  createPolicy(access: OrganisationAccess, input: PolicyInput, meta: RequestMeta) {
    return this.run(access, meta, async (uow) => {
      const currency = await uow.currency();
      const minAmountMinor = Money.parse(input.minAmount, currency).amountMinor;
      const id = await uow.createPolicy({
        requestType: input.requestType,
        minAmountMinor,
        requiredApprovals: input.requiredApprovals,
        approvers: input.approvers,
        committeeId: input.committeeId ?? null,
      });
      await uow.audit({ action: 'approval_policy.created', resourceId: id });
      return { policy: await this.mustFindPolicy(uow, id), currency };
    });
  }

  updatePolicy(
    access: OrganisationAccess,
    id: string,
    patch: UpdatePolicyInput,
    meta: RequestMeta,
  ) {
    return this.run(access, meta, async (uow) => {
      await this.mustFindPolicy(uow, id);
      await uow.updatePolicy(id, patch);
      await uow.audit({
        action: 'approval_policy.updated',
        resourceId: id,
        metadata: { fields: Object.keys(patch).sort().join(',') },
      });
      return { policy: await this.mustFindPolicy(uow, id), currency: await uow.currency() };
    });
  }

  list(access: OrganisationAccess, pending: boolean, meta: RequestMeta) {
    return this.run(access, meta, async (uow) => {
      const today = await uow.today();
      const rows = await uow.requests({ pending });
      return Promise.all(rows.map(async (request) => this.view(uow, access, request, today)));
    });
  }

  detail(access: OrganisationAccess, id: string, meta: RequestMeta) {
    return this.run(access, meta, async (uow) => this.load(uow, access, id));
  }

  create(access: OrganisationAccess, input: ApprovalRequestInput, meta: RequestMeta) {
    return this.run(access, meta, async (uow) => {
      const currency = await uow.currency();
      const amountMinor = input.amount ? Money.parse(input.amount, currency).amountMinor : null;
      if (amountMinor !== null && amountMinor <= 0n) {
        throw new ApiError(422, 'INVALID_MONEY', 'The amount must be more than zero');
      }
      const policy = policyFor(await uow.policies(), input.requestType, amountMinor);
      const rule = policy ?? DEFAULT_RULE;
      const id = await uow.createRequest({
        requestType: input.requestType,
        title: input.title,
        description: input.description,
        amountMinor,
        currency: amountMinor === null ? null : currency,
        documentId: input.documentId ?? null,
        policyId: policy?.id ?? null,
        requiredApprovals: rule.requiredApprovals,
        approvers: rule.approvers,
        committeeId: rule.committeeId,
      });
      await uow.audit({
        action: 'approval_request.created',
        resourceId: id,
        metadata: {
          type: input.requestType,
          required: rule.requiredApprovals,
          approvers: rule.approvers,
        },
      });
      const view = await this.load(uow, access, id);
      await this.tellApprovers(uow, access, view.request);
      return view;
    });
  }

  withdraw(access: OrganisationAccess, id: string, meta: RequestMeta) {
    return this.run(access, meta, async (uow) => {
      const request = await this.mustFind(uow, id);
      if (request.requestedByUserId !== access.userId) throw notFound('Request');
      if (request.status !== 'PENDING') throw invalidState('This request is already settled');
      await uow.withdraw(id);
      await uow.audit({ action: 'approval_request.withdrawn', resourceId: id });
      return this.load(uow, access, id);
    });
  }

  decide(access: OrganisationAccess, id: string, input: DecisionInput, meta: RequestMeta) {
    return this.run(access, meta, async (uow) => {
      const before = await this.load(uow, access, id);
      const r = before.request;
      if (r.status !== 'PENDING') throw invalidState('This request is already settled');
      if (r.requestedByUserId === access.userId) {
        throw new ApiError(403, 'OWN_REQUEST', 'Nobody decides their own request');
      }
      if (r.decisions.some((d) => d.userId === access.userId)) {
        throw invalidState('You have already decided this request');
      }
      if (!before.canDecide) {
        throw new ApiError(
          403,
          'NOT_AN_APPROVER',
          'You are not one of the approvers of this request',
        );
      }
      await uow.decide(id, input.decision, input.note ?? null);
      await uow.audit({
        action: `approval_request.${input.decision.toLowerCase()}`,
        resourceId: id,
      });
      const after = await this.load(uow, access, id);
      if (after.request.status !== 'PENDING') await this.tellRequester(uow, access, after.request);
      return after;
    });
  }

  private async load(uow: ApprovalUnitOfWork, access: OrganisationAccess, id: string) {
    return this.view(uow, access, await this.mustFind(uow, id), await uow.today());
  }

  private async view(
    uow: ApprovalUnitOfWork,
    access: OrganisationAccess,
    request: ApprovalRequestRecord,
    today: string,
  ): Promise<RequestView> {
    const open =
      request.status === 'PENDING' &&
      request.requestedByUserId !== access.userId &&
      !request.decisions.some((d) => d.userId === access.userId);
    return { request, canDecide: open && (await this.isApprover(uow, access, request, today)) };
  }

  private async isApprover(
    uow: ApprovalUnitOfWork,
    access: OrganisationAccess,
    request: ApprovalRequestRecord,
    today: string,
  ) {
    if (request.approvers === 'MANAGERS') return access.permissions.has('property.approval.decide');
    if (!request.committee) return false;
    return (await uow.committeeMembers(request.committee.id, today)).includes(access.userId);
  }

  private async approverIds(
    uow: ApprovalUnitOfWork,
    access: OrganisationAccess,
    request: ApprovalRequestRecord,
  ) {
    if (request.approvers === 'COMMITTEE' && request.committee) {
      return uow.committeeMembers(request.committee.id, await uow.today());
    }
    const holders = await this.accessControl.usersWithPropertyPermission(
      access.organisationId,
      this.propertyOf(access),
      'property.approval.decide',
    );
    return holders.map((h) => h.userId);
  }

  private link(access: OrganisationAccess, id: string) {
    return `/organisations/${access.organisationId}/properties/${this.propertyOf(access)}/approvals/${id}`;
  }

  private async tellApprovers(
    uow: ApprovalUnitOfWork,
    access: OrganisationAccess,
    r: ApprovalRequestRecord,
  ) {
    const people = (await this.approverIds(uow, access, r)).filter(
      (u) => u !== r.requestedByUserId,
    );
    await this.notifications.notifyWithin(
      uow.transaction(),
      access.organisationId,
      people.map((userId) => ({
        userId,
        propertyId: this.propertyOf(access),
        kind: 'approval.requested',
        title: 'An approval is waiting for you',
        body: `${r.requestedByName} asks: "${r.title}".`,
        link: this.link(access, r.id),
        urgent: false,
        email: true,
      })),
    );
  }

  private async tellRequester(
    uow: ApprovalUnitOfWork,
    access: OrganisationAccess,
    r: ApprovalRequestRecord,
  ) {
    const approved = r.status === 'APPROVED';
    await this.notifications.notifyWithin(uow.transaction(), access.organisationId, [
      {
        userId: r.requestedByUserId,
        propertyId: this.propertyOf(access),
        kind: approved ? 'approval.approved' : 'approval.rejected',
        title: approved ? 'Your request was approved' : 'Your request was rejected',
        body: `"${r.title}" was ${approved ? 'approved' : 'rejected'}.`,
        link: this.link(access, r.id),
        urgent: false,
        email: true,
      },
    ]);
  }

  private async mustFind(uow: ApprovalUnitOfWork, id: string) {
    const request = await uow.request(id);
    if (!request) throw notFound('Request');
    return request;
  }

  private async mustFindPolicy(uow: ApprovalUnitOfWork, id: string) {
    const policy = await uow.policy(id);
    if (!policy) throw notFound('Policy');
    return policy;
  }

  private propertyOf(access: OrganisationAccess) {
    if (!access.propertyId) throw new Error('Property route without a resolved property');
    return access.propertyId;
  }

  private async run<T>(
    access: OrganisationAccess,
    meta: RequestMeta,
    work: (uow: ApprovalUnitOfWork) => Promise<T>,
  ) {
    try {
      return await this.repository.inProperty(
        access.organisationId,
        this.propertyOf(access),
        access.userId,
        meta,
        work,
      );
    } catch (error) {
      const code = databaseErrorCode(error);
      if (code === '23505') {
        throw new ApiError(409, 'POLICY_EXISTS', 'An active policy already starts at this amount');
      }
      if (code === '23503') {
        throw new ApiError(
          422,
          'UNKNOWN_REFERENCE',
          'That committee or document is not at this property',
        );
      }
      if (code === '23514')
        throw invalidState('This change is not possible. Reload and try again.');
      throw error;
    }
  }
}
