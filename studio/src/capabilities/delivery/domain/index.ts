export type { DeliveryIntent, DeliveryState, NotificationRecipient, NotificationTarget, StudioScenarioNotificationV1 } from '../../../shared/contracts.js';

export const DELIVERY_INVARIANTS = Object.freeze([
  'only the current confirmed Summary revision can be submitted',
  'idempotency binds job, Summary revision and Target version',
  'payload excludes audio and full Transcript by default',
]);
