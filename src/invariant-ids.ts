export const MINIMUM_INVARIANT_IDS = [
  "production.authoritative_records",
  "offline.durable_local_operations",
  "offline.sync_protocol",
  "offline.conflict_handling",
  "offline.idempotent_server_application",
  "multi_org.data_owner_boundary",
  "multi_org.server_side_isolation",
  "payments.callback_authenticity",
  "payments.idempotent_processing",
  "payments.reconciliation",
  "payments.failure_recovery",
  "sensitive.server_side_authorization",
  "sensitive.auditability",
  "sensitive.retention_deletion",
  "sensitive.storage_transit_protection",
] as const;

export type MinimumInvariantId = (typeof MINIMUM_INVARIANT_IDS)[number];

export const MINIMUM_INVARIANT_ID_SET: ReadonlySet<MinimumInvariantId> =
  new Set(MINIMUM_INVARIANT_IDS);

export const MINIMUM_INVARIANTS_BY_FAMILY = Object.freeze({
  production: Object.freeze([
    "production.authoritative_records",
  ] satisfies readonly MinimumInvariantId[]),
  offline: Object.freeze([
    "offline.durable_local_operations",
    "offline.sync_protocol",
    "offline.conflict_handling",
    "offline.idempotent_server_application",
  ] satisfies readonly MinimumInvariantId[]),
  multi_org: Object.freeze([
    "multi_org.data_owner_boundary",
    "multi_org.server_side_isolation",
  ] satisfies readonly MinimumInvariantId[]),
  payments: Object.freeze([
    "payments.callback_authenticity",
    "payments.idempotent_processing",
    "payments.reconciliation",
    "payments.failure_recovery",
  ] satisfies readonly MinimumInvariantId[]),
  sensitive: Object.freeze([
    "sensitive.server_side_authorization",
    "sensitive.auditability",
    "sensitive.retention_deletion",
    "sensitive.storage_transit_protection",
  ] satisfies readonly MinimumInvariantId[]),
});

export type MinimumInvariantFamilyId = keyof typeof MINIMUM_INVARIANTS_BY_FAMILY;
